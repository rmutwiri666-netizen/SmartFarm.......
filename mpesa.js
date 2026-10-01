const environments = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke'
};

function createMpesaClient({ settings = process.env, fetchImpl = globalThis.fetch } = {}) {
  let cachedToken = '';
  let tokenExpiresAt = 0;

  function config() {
    return {
      environment: settings.MPESA_ENV || 'sandbox',
      consumerKey: settings.MPESA_CONSUMER_KEY || '',
      consumerSecret: settings.MPESA_CONSUMER_SECRET || '',
      shortcode: settings.MPESA_SHORTCODE || '',
      partyB: settings.MPESA_PARTY_B || settings.MPESA_SHORTCODE || '',
      passkey: settings.MPESA_PASSKEY || '',
      callbackUrl: settings.MPESA_CALLBACK_URL || '',
      transactionType: settings.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline'
    };
  }

  function baseUrl(values) {
    const url = environments[values.environment];
    if (!url) throw new Error('MPESA_ENV must be sandbox or production.');
    return url;
  }

  function validateConfig(values) {
    if (!values.consumerKey || !values.consumerSecret || !values.shortcode || !values.partyB || !values.passkey) {
      throw new Error('M-Pesa is not configured. Add the Daraja credentials to the backend environment.');
    }
    let callback;
    try {
      callback = new URL(values.callbackUrl);
    } catch {
      throw new Error('MPESA_CALLBACK_URL must be a public HTTPS callback URL.');
    }
    if (callback.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(callback.hostname)) {
      throw new Error('MPESA_CALLBACK_URL must be a public HTTPS callback URL.');
    }
  }

  async function requestJson(url, options) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
    if (!response.ok) {
      throw new Error(body.errorMessage || body.error_description || `Safaricom returned HTTP ${response.status}.`);
    }
    return body;
  }

  async function accessToken(values) {
    if (cachedToken && tokenExpiresAt > Date.now() + 30000) return cachedToken;
    const credentials = Buffer.from(`${values.consumerKey}:${values.consumerSecret}`).toString('base64');
    const response = await requestJson(`${baseUrl(values)}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { authorization: `Basic ${credentials}` }
    });
    if (!response.access_token) throw new Error('Safaricom did not return an access token.');
    cachedToken = response.access_token;
    tokenExpiresAt = Date.now() + Number(response.expires_in || 3599) * 1000;
    return cachedToken;
  }

  function timestamp() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Nairobi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
  }

  function password(values, time) {
    return Buffer.from(`${values.shortcode}${values.passkey}${time}`).toString('base64');
  }

  async function initiateStkPush({ phone, amount, accountReference, description }) {
    const values = config();
    validateConfig(values);
    const time = timestamp();
    const token = await accessToken(values);
    const response = await requestJson(`${baseUrl(values)}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: values.shortcode,
        Password: password(values, time),
        Timestamp: time,
        TransactionType: values.transactionType,
        Amount: amount,
        PartyA: phone,
        PartyB: values.partyB,
        PhoneNumber: phone,
        CallBackURL: values.callbackUrl,
        AccountReference: accountReference,
        TransactionDesc: description
      })
    });
    if (String(response.ResponseCode) !== '0' || !response.CheckoutRequestID || !response.MerchantRequestID) {
      throw new Error(response.errorMessage || 'Safaricom did not accept the M-Pesa payment request.');
    }
    return {
      checkoutRequestId: response.CheckoutRequestID,
      merchantRequestId: response.MerchantRequestID,
      customerMessage: response.CustomerMessage || 'Check your phone and enter your M-Pesa PIN to approve the payment.'
    };
  }

  async function verifyCheckout(checkoutRequestId) {
    const values = config();
    validateConfig(values);
    const time = timestamp();
    const token = await accessToken(values);
    const response = await requestJson(`${baseUrl(values)}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: values.shortcode,
        Password: password(values, time),
        Timestamp: time,
        CheckoutRequestID: checkoutRequestId
      })
    });
    return {
      confirmed: String(response.ResultCode) === '0',
      resultCode: response.ResultCode == null ? null : String(response.ResultCode),
      resultDescription: response.ResultDesc || response.ResponseDescription || ''
    };
  }

  return { initiateStkPush, verifyCheckout };
}

function normalizeKenyanPhone(input) {
  const digits = String(input || '').replace(/[\s()+-]/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  throw new Error('Enter a valid Kenyan mobile number, for example 0712345678.');
}

module.exports = { createMpesaClient, normalizeKenyanPhone };
