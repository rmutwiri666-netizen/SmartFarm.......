const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { after, before, test } = require('node:test');
const { createServer } = require('./server');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartfarm-test-'));
const server = createServer({ dataDir });
let baseUrl;
let sessionCookie;
let registeredUser;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, cookie, token } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
}

test('only signed-in sellers can publish listings visible to everyone', async () => {
  const listing = {
    name: 'Fresh beans', category: 'Vegetables', location: 'Meru', price: 250,
    unit: 'per kg', quantity: 15, description: 'Harvested this week.'
  };
  const blocked = await request('/api/products', { method: 'POST', body: listing });
  assert.equal(blocked.status, 401);

  const register = await request('/api/register', {
    method: 'POST',
    body: { name: 'Green Valley Farm', email: 'seller@example.com', password: 'harvest123' }
  });
  assert.equal(register.status, 201);
  const registerResult = await register.json();
  registeredUser = registerResult.user;
  assert.equal(registeredUser.name, 'Green Valley Farm');
  assert.equal('passwordHash' in registerResult, false);
  assert.equal(typeof registerResult.token, 'string');
  sessionCookie = register.headers.get('set-cookie').split(';')[0];

  const session = await request('/api/session', { token: registerResult.token });
  assert.deepEqual((await session.json()).user, registeredUser);

  const publish = await request('/api/products', { method: 'POST', body: listing, token: registerResult.token });
  assert.equal(publish.status, 201);
  const saved = (await publish.json()).product;
  assert.equal(saved.seller, 'Green Valley Farm');
  assert.equal(saved.ownerId, registeredUser.id);

  const publicRead = await request('/api/products');
  const publicProducts = (await publicRead.json()).products;
  assert.equal(publicProducts.some((product) => product.id === saved.id), true);
});

test('accounts persist and can sign in again', async () => {
  const login = await request('/api/login', {
    method: 'POST',
    body: { email: 'seller@example.com', password: 'harvest123' }
  });
  assert.equal(login.status, 200);
  assert.deepEqual((await login.json()).user, registeredUser);

  const restartedServer = createServer({ dataDir });
  await new Promise((resolve) => restartedServer.listen(0, '127.0.0.1', resolve));
  try {
    const restartedUrl = `http://127.0.0.1:${restartedServer.address().port}`;
    const publicRead = await fetch(`${restartedUrl}/api/products`);
    const products = (await publicRead.json()).products;
    assert.equal(products.some((product) => product.seller === 'Green Valley Farm'), true);
  } finally {
    await new Promise((resolve, reject) => restartedServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('stores accounts and adverts in relational SQLite tables', () => {
  const database = new DatabaseSync(path.join(dataDir, 'smartfarm.sqlite'));
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
    assert.deepEqual(tables.sort(), ['migrations', 'products', 'sessions', 'users']);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM products').get().count, 5);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM products WHERE id = 'sf-maize-001' AND own = 1").get().count, 1);
  } finally {
    database.close();
  }
});

test('imports legacy JSON accounts, sessions, and adverts without deleting the backup', async () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartfarm-legacy-'));
  const legacyFile = path.join(legacyDir, 'smartfarm.json');
  const salt = crypto.randomBytes(16).toString('hex');
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const user = {
    id: 'legacy-user-1',
    name: 'Legacy Farm',
    email: 'legacy@example.com',
    salt,
    passwordHash: crypto.scryptSync('legacy-pass-123', salt, 64).toString('hex'),
    createdAt: Date.now()
  };
  const product = {
    id: 'legacy-product-1',
    name: 'Legacy tomatoes',
    category: 'Vegetables',
    location: 'Meru',
    seller: user.name,
    price: 700,
    unit: 'per crate',
    quantity: 12,
    description: 'Imported from the previous data store.',
    image: 'https://images.unsplash.com/legacy.jpg',
    ownerId: user.id,
    createdAt: Date.now()
  };
  fs.writeFileSync(legacyFile, JSON.stringify({
    users: [user],
    products: [product],
    sessions: {
      [crypto.createHash('sha256').update(sessionToken).digest('hex')]: {
        userId: user.id,
        expiresAt: Date.now() + 60_000
      }
    }
  }));

  const migrationServer = createServer({ dataDir: legacyDir });
  await new Promise((resolve) => migrationServer.listen(0, '127.0.0.1', resolve));
  try {
    const migrationUrl = `http://127.0.0.1:${migrationServer.address().port}`;
    const productsResponse = await fetch(`${migrationUrl}/api/products`);
    const products = (await productsResponse.json()).products;
    assert.equal(products.some((item) => item.id === product.id), true);

    const sessionResponse = await fetch(`${migrationUrl}/api/session`, {
      headers: { cookie: `smartfarm_session=${sessionToken}` }
    });
    assert.deepEqual((await sessionResponse.json()).user, {
      id: user.id,
      name: user.name,
      email: user.email
    });
    assert.equal(fs.existsSync(legacyFile), true);
  } finally {
    await new Promise((resolve, reject) => migrationServer.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

test('allows preflight only from the configured GitHub Pages origin', async () => {
  const corsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartfarm-cors-'));
  const corsServer = createServer({ dataDir: corsDir, allowedOrigins: 'https://farm-owner.github.io' });
  await new Promise((resolve) => corsServer.listen(0, '127.0.0.1', resolve));
  try {
    const corsUrl = `http://127.0.0.1:${corsServer.address().port}`;
    const allowed = await fetch(`${corsUrl}/api/products`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://farm-owner.github.io',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type'
      }
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://farm-owner.github.io');
    assert.match(allowed.headers.get('access-control-allow-headers'), /Authorization/i);

    const denied = await fetch(`${corsUrl}/api/products`, {
      method: 'OPTIONS',
      headers: { origin: 'https://untrusted.example', 'access-control-request-method': 'POST' }
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally {
    await new Promise((resolve, reject) => corsServer.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(corsDir, { recursive: true, force: true });
  }
});

test('starts M-Pesa checkout and activates a subscription only after a verified callback', async () => {
  const paymentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartfarm-payment-'));
  let verificationCount = 0;
  const mpesaClient = {
    initiateStkPush: async ({ phone, amount, accountReference }) => {
      assert.equal(phone, '254712345678');
      assert.equal(amount, 500);
      assert.match(accountReference, /^SF-/);
      return {
        checkoutRequestId: 'checkout-payment-test',
        merchantRequestId: 'merchant-payment-test',
        customerMessage: 'Prompt sent'
      };
    },
    verifyCheckout: async (checkoutRequestId) => {
      verificationCount += 1;
      assert.equal(checkoutRequestId, 'checkout-payment-test');
      return { confirmed: true, resultCode: '0', resultDescription: 'Payment confirmed.' };
    }
  };
  const paymentServer = createServer({ dataDir: paymentDir, mpesaClient });
  await new Promise((resolve) => paymentServer.listen(0, '127.0.0.1', resolve));
  try {
    const paymentUrl = `http://127.0.0.1:${paymentServer.address().port}`;
    const register = await fetch(`${paymentUrl}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Payment Test Farm', email: 'billing@example.test', password: 'secure-pass-123' })
    });
    const registered = await register.json();
    const authHeaders = { authorization: `Bearer ${registered.token}`, 'content-type': 'application/json' };

    const invalidAmountAttempt = await fetch(`${paymentUrl}/api/payments/mpesa`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ planId: 'grower', period: 'monthly', phone: '0712 345 678', amount: 1 })
    });
    assert.equal(invalidAmountAttempt.status, 202);
    const started = await invalidAmountAttempt.json();
    assert.equal(started.payment.amount, 500);
    assert.equal(started.payment.status, 'pending');

    const callback = await fetch(`${paymentUrl}/api/payments/mpesa/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        Body: {
          stkCallback: {
            CheckoutRequestID: 'checkout-payment-test',
            MerchantRequestID: 'merchant-payment-test',
            ResultCode: 0,
            CallbackMetadata: { Item: [
              { Name: 'Amount', Value: 500 },
              { Name: 'MpesaReceiptNumber', Value: 'TEST123' },
              { Name: 'PhoneNumber', Value: 254712345678 }
            ] }
          }
        }
      })
    });
    assert.equal(callback.status, 200);
    const paymentStatus = await fetch(`${paymentUrl}/api/payments/${started.payment.id}`, { headers: authHeaders });
    const result = await paymentStatus.json();
    assert.equal(result.payment.status, 'succeeded');
    assert.equal(result.payment.receiptNumber, 'TEST123');
    assert.equal(result.subscription.planId, 'grower');
    assert.equal(result.subscription.status, 'active');

    const repeatedCallback = await fetch(`${paymentUrl}/api/payments/mpesa/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Body: { stkCallback: {
        CheckoutRequestID: 'checkout-payment-test',
        MerchantRequestID: 'merchant-payment-test',
        ResultCode: 0,
        CallbackMetadata: { Item: [
          { Name: 'Amount', Value: 500 },
          { Name: 'MpesaReceiptNumber', Value: 'TEST123' },
          { Name: 'PhoneNumber', Value: 254712345678 }
        ] }
      } } })
    });
    assert.equal(repeatedCallback.status, 200);
    assert.equal(verificationCount, 2);
  } finally {
    await new Promise((resolve, reject) => paymentServer.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(paymentDir, { recursive: true, force: true });
  }
});
