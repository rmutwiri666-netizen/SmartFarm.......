const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('./storage');
const { createPostgresStore } = require('./postgres-storage');
const { createMpesaClient, normalizeKenyanPhone } = require('./mpesa');

const SESSION_COOKIE = 'smartfarm_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const allowedCategories = new Set(['Cereals', 'Vegetables', 'Fruits', 'Livestock', 'Flowers', 'Services']);
const subscriptionPlans = new Map([
  ['starter', { monthly: 0 }],
  ['grower', { monthly: 500 }],
  ['harvest', { monthly: 1200 }]
]);
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/api-config.js', ['api-config.js', 'text/javascript; charset=utf-8']],
  ['/script.js', ['script.js', 'text/javascript; charset=utf-8']],
  ['/database.js', ['database.js', 'text/javascript; charset=utf-8']]
]);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  });
  response.end(JSON.stringify(value));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'Request is too large.'));
        request.resume();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(httpError(400, 'Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function safeUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function cookieToken(request) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return cookie ? cookie.slice(SESSION_COOKIE.length + 1) : '';
}

function sessionToken(request) {
  const authorization = request.headers.authorization || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : cookieToken(request);
}

function cookieOptions(request) {
  const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function createServer({
  dataDir = process.env.SMARTFARM_DATA_DIR || path.join(__dirname, 'data'),
  allowedOrigins = process.env.SMARTFARM_ALLOWED_ORIGINS || '',
  mpesaClient = createMpesaClient()
} = {}) {
  const store = process.env.DATABASE_URL
    ? createPostgresStore(process.env.DATABASE_URL, dataDir)
    : createStore(dataDir);
  const corsOrigins = new Set(allowedOrigins.split(',').map((origin) => origin.trim()).filter(Boolean));

  async function currentUser(request) {
    const token = sessionToken(request);
    if (!token) return null;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    return store.getSessionUser(tokenHash);
  }

  async function createSession(response, request, user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL;
    await store.saveSession(crypto.createHash('sha256').update(token).digest('hex'), user.id, expiresAt);
    response.setHeader('set-cookie', `${SESSION_COOKIE}=${token}; ${cookieOptions(request)}; Max-Age=${SESSION_TTL / 1000}`);
    return token;
  }

  async function handleApi(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/session') {
      const user = await currentUser(request);
      return sendJson(response, 200, { user: user && safeUser(user) });
    }

    if (request.method === 'GET' && url.pathname === '/api/products') {
      return sendJson(response, 200, { products: await store.listProducts() });
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, { ok: true, database: await store.health() });
    }

    if (request.method === 'POST' && url.pathname === '/api/subscription/starter') {
      const user = await currentUser(request);
      if (!user) throw httpError(401, 'Sign in to activate a seller plan.');
      return sendJson(response, 200, { subscription: await store.activateFreeSubscription(user.id) });
    }

    if (request.method === 'GET' && url.pathname === '/api/subscription') {
      const user = await currentUser(request);
      if (!user) throw httpError(401, 'Sign in to view your subscription.');
      return sendJson(response, 200, { subscription: await store.getSubscriptionByOwner(user.id) });
    }

    if (request.method === 'POST' && url.pathname === '/api/payments/mpesa') {
      const user = await currentUser(request);
      if (!user) throw httpError(401, 'Sign in before starting an M-Pesa payment.');
      const body = await readJson(request);
      const plan = subscriptionPlans.get(String(body.planId || ''));
      const period = String(body.period || 'monthly');
      if (!plan || plan.monthly <= 0) throw httpError(400, 'Choose a paid subscription plan.');
      if (!['monthly', 'annual'].includes(period)) throw httpError(400, 'Choose a valid billing period.');
      let phone;
      try {
        phone = normalizeKenyanPhone(body.phone);
      } catch (error) {
        throw httpError(400, error.message);
      }
      const amount = period === 'annual' ? Math.round(plan.monthly * 12 * .85) : plan.monthly;
      const now = Date.now();
      const payment = await store.createPayment({
        id: crypto.randomUUID(),
        userId: user.id,
        planId: String(body.planId),
        period,
        amount,
        phone,
        createdAt: now,
        updatedAt: now
      });
      try {
        const result = await mpesaClient.initiateStkPush({
          phone,
          amount,
          accountReference: `SF-${payment.id.slice(0, 8)}`,
          description: `${String(body.planId).toUpperCase()} ${period} subscription`
        });
        const updatedPayment = await store.attachPaymentCheckout(payment.id, result.merchantRequestId, result.checkoutRequestId);
        return sendJson(response, 202, { payment: updatedPayment, customerMessage: result.customerMessage });
      } catch (error) {
        await store.failPayment(payment.id, 'REQUEST_FAILED', 'Safaricom did not accept the payment request.');
        const status = /not configured|callback url|MPESA_ENV/i.test(error.message) ? 503 : 502;
        throw httpError(status, status === 503 ? error.message : 'Could not start M-Pesa checkout. Check the number and try again.');
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/payments/mpesa/callback') {
      const body = await readJson(request);
      const callback = body?.Body?.stkCallback;
      if (!callback?.CheckoutRequestID) throw httpError(400, 'Invalid Safaricom callback.');
      const payment = await store.getPaymentByCheckout(callback.CheckoutRequestID);
      if (!payment) return sendJson(response, 200, { ResultCode: 0, ResultDesc: 'Payment was not found.' });
      if (callback.MerchantRequestID && payment.merchantRequestId !== callback.MerchantRequestID) {
        return sendJson(response, 200, { ResultCode: 0, ResultDesc: 'Payment request did not match.' });
      }
      const verification = await mpesaClient.verifyCheckout(payment.checkoutRequestId);
      if (!verification.resultCode && !verification.confirmed) {
        return sendJson(response, 200, { ResultCode: 0, ResultDesc: 'Payment is still being verified.' });
      }
      if (!verification.confirmed) {
        await store.failPayment(payment.id, verification.resultCode || 'NOT_CONFIRMED', verification.resultDescription);
        return sendJson(response, 200, { ResultCode: 0, ResultDesc: 'Payment was not completed.' });
      }
      const items = callback.CallbackMetadata?.Item || [];
      const metadata = Object.fromEntries(items.map((item) => [item.Name, item.Value]));
      let callbackPhone = '';
      try {
        callbackPhone = normalizeKenyanPhone(metadata.PhoneNumber);
      } catch {
        return sendJson(response, 200, { ResultCode: 0, ResultDesc: 'Payment details were incomplete.' });
      }
      if (Number(metadata.Amount) !== payment.amount || callbackPhone !== payment.phone) {
        await store.failPayment(payment.id, 'DETAIL_MISMATCH', 'Safaricom payment details did not match the request.');
        return sendJson(response, 200, { ResultCode: 0, ResultDesc: 'Payment details did not match.' });
      }
      await store.completePayment(
        payment.checkoutRequestId,
        String(metadata.MpesaReceiptNumber || ''),
        verification.resultCode || '0',
        verification.resultDescription
      );
      return sendJson(response, 200, { ResultCode: 0, ResultDesc: 'Payment verified.' });
    }

    if (request.method === 'GET' && url.pathname === '/api/payments') {
      const user = await currentUser(request);
      if (!user) throw httpError(401, 'Sign in to view your payments.');
      return sendJson(response, 200, { payments: await store.listPaymentsByOwner(user.id) });
    }

    const paymentMatch = request.method === 'GET' && url.pathname.match(/^\/api\/payments\/([a-f0-9-]+)$/i);
    if (paymentMatch) {
      const user = await currentUser(request);
      if (!user) throw httpError(401, 'Sign in to view this payment.');
      const payment = await store.getPaymentById(paymentMatch[1]);
      if (!payment || payment.userId !== user.id) throw httpError(404, 'Payment was not found.');
      return sendJson(response, 200, {
        payment,
        subscription: await store.getSubscriptionByOwner(user.id)
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/register') {
      const body = await readJson(request);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (name.length < 2 || name.length > 60) throw httpError(400, 'Enter a farm or seller name between 2 and 60 characters.');
      if (email.length > 180 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Enter a valid email address.');
      if (password.length < 8 || password.length > 128) throw httpError(400, 'Use a password between 8 and 128 characters.');
      if (await store.getUserByEmail(email)) throw httpError(409, 'An account with this email already exists.');
      const salt = crypto.randomBytes(16).toString('hex');
      const user = { id: crypto.randomUUID(), name, email, salt, passwordHash: hashPassword(password, salt), createdAt: Date.now() };
      await store.createUser(user);
      const token = await createSession(response, request, user);
      return sendJson(response, 201, { user: safeUser(user), token });
    }

    if (request.method === 'POST' && url.pathname === '/api/login') {
      const body = await readJson(request);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = await store.getUserByEmail(email);
      const passwordHash = user ? hashPassword(password, user.salt) : '';
      const valid = user && passwordHash.length === user.passwordHash.length
        && crypto.timingSafeEqual(Buffer.from(passwordHash), Buffer.from(user.passwordHash));
      if (!valid) throw httpError(401, 'Email or password is incorrect.');
      const token = await createSession(response, request, user);
      return sendJson(response, 200, { user: safeUser(user), token });
    }

    if (request.method === 'POST' && url.pathname === '/api/logout') {
      const token = sessionToken(request);
      if (token) await store.deleteSession(crypto.createHash('sha256').update(token).digest('hex'));
      response.setHeader('set-cookie', `${SESSION_COOKIE}=; ${cookieOptions(request)}; Max-Age=0`);
      return sendJson(response, 200, { user: null });
    }

    if (request.method === 'POST' && url.pathname === '/api/products') {
      const user = await currentUser(request);
      if (!user) throw httpError(401, 'Sign in to publish a listing.');
      const body = await readJson(request);
      const name = String(body.name || '').trim();
      const category = String(body.category || '');
      const location = String(body.location || '').trim();
      const unit = String(body.unit || '').trim();
      const description = String(body.description || '').trim();
      const price = Number(body.price);
      const quantity = Number(body.quantity);
      const image = String(body.image || '');
      if (!name || name.length > 70) throw httpError(400, 'Product name must be between 1 and 70 characters.');
      if (!allowedCategories.has(category)) throw httpError(400, 'Choose a valid product category.');
      if (!location || location.length > 50) throw httpError(400, 'Enter a location under 50 characters.');
      if (!unit || unit.length > 30) throw httpError(400, 'Choose a valid unit.');
      if (!Number.isFinite(price) || price <= 0 || price > 1000000000) throw httpError(400, 'Enter a valid price.');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000000000) throw httpError(400, 'Enter a valid available quantity.');
      if (description.length > 220) throw httpError(400, 'Description must be 220 characters or less.');
      const validDataImage = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/i.test(image);
      const validRemoteImage = /^https:\/\/[a-z0-9.-]+(?:\/[a-z0-9._~:/?#[\]@!$&()*+,;=%-]*)?$/i.test(image);
      if (image.length > 2_200_000 || (image && !validDataImage && !validRemoteImage)) throw httpError(400, 'Choose a valid image smaller than 1.5 MB.');
      const product = {
        id: crypto.randomUUID(),
        name,
        category,
        location,
        seller: user.name,
        price,
        unit,
        quantity,
        description: description || 'Fresh farm listing. Contact the seller to ask about availability.',
        image: image || 'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&w=850&q=80',
        own: false,
        ownerId: user.id,
        createdAt: Date.now()
      };
      await store.createProduct(product);
      return sendJson(response, 201, { product });
    }

    return sendJson(response, 404, { error: 'API route not found.' });
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const origin = request.headers.origin;
      if (origin && corsOrigins.has(origin)) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        response.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
        response.setHeader('access-control-max-age', '600');
        response.setHeader('vary', 'Origin');
      }
      if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        if (!origin || !corsOrigins.has(origin)) throw httpError(403, 'This website is not allowed to access the SmartFarm API.');
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
      const file = staticFiles.get(url.pathname);
      if (request.method !== 'GET' || !file) return sendJson(response, 404, { error: 'Page not found.' });
      const [fileName, contentType] = file;
      const contents = fs.readFileSync(path.join(__dirname, fileName));
      response.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com https://images.unsplash.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
      });
      response.end(contents);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      sendJson(response, error.status || 500, { error: error.status ? error.message : 'The server could not complete the request.' });
    }
  });
  server.once('close', () => store.close());
  return server;
}

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, host, () => {
    console.log(`SmartFarm is running at http://${host}:${port}`);
  });
}

module.exports = { createServer };
