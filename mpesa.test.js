const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMpesaClient, normalizeKenyanPhone } = require('./mpesa');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

test('normalizes Kenyan phone numbers for the STK request', () => {
  assert.equal(normalizeKenyanPhone('0712 345 678'), '254712345678');
  assert.equal(normalizeKenyanPhone('+254 712 345 678'), '254712345678');
  assert.throws(() => normalizeKenyanPhone('12345'), /valid Kenyan mobile number/);
});

test('starts and verifies an STK payment with Daraja', async () => {
  const calls = [];
  const settings = {
    MPESA_ENV: 'sandbox',
    MPESA_CONSUMER_KEY: 'test-key',
    MPESA_CONSUMER_SECRET: 'test-secret',
    MPESA_SHORTCODE: '174379',
    MPESA_PASSKEY: 'test-passkey',
    MPESA_CALLBACK_URL: 'https://api.example.test/api/payments/mpesa/callback'
  };
  const client = createMpesaClient({
    settings,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.includes('/oauth/')) return jsonResponse({ access_token: 'test-token', expires_in: '3600' });
      if (url.includes('/processrequest')) return jsonResponse({
        ResponseCode: '0',
        CheckoutRequestID: 'ws_CO_test',
        MerchantRequestID: 'mr_test',
        CustomerMessage: 'Prompt sent'
      });
      if (url.includes('/query')) return jsonResponse({ ResponseCode: '0', ResultCode: '0', ResultDesc: 'The service request is processed successfully.' });
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  const started = await client.initiateStkPush({
    phone: '254712345678',
    amount: 500,
    accountReference: 'SF-test',
    description: 'Grower plan'
  });
  assert.equal(started.checkoutRequestId, 'ws_CO_test');
  assert.equal(calls[1].url, 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest');
  const requestBody = JSON.parse(calls[1].options.body);
  assert.equal(requestBody.Amount, 500);
  assert.equal(requestBody.PhoneNumber, '254712345678');
  assert.equal(requestBody.AccountReference, 'SF-test');
  assert.equal(requestBody.TransactionType, 'CustomerPayBillOnline');

  const verified = await client.verifyCheckout(started.checkoutRequestId);
  assert.equal(verified.confirmed, true);
  assert.equal(calls[2].url, 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query');
});

test('refuses to start a payment without live Daraja credentials', async () => {
  const client = createMpesaClient({ settings: {}, fetchImpl: async () => { throw new Error('Should not call Safaricom.'); } });
  await assert.rejects(
    client.initiateStkPush({ phone: '254712345678', amount: 500, accountReference: 'SF-test', description: 'Test' }),
    /M-Pesa is not configured/
  );
});
