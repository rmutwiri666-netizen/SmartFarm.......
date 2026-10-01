const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const { platformProducts } = require('./platform-products');

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    salt: row.salt,
    passwordHash: row.password_hash,
    createdAt: Number(row.created_at)
  };
}

function mapProduct(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    location: row.location,
    seller: row.seller,
    price: Number(row.price),
    unit: row.unit,
    quantity: Number(row.quantity),
    description: row.description,
    image: row.image,
    own: Boolean(row.own),
    ownerId: row.owner_id,
    createdAt: Number(row.created_at)
  };
}

function mapPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    period: row.period,
    amount: Number(row.amount),
    phone: row.phone,
    status: row.status,
    merchantRequestId: row.merchant_request_id,
    checkoutRequestId: row.checkout_request_id,
    receiptNumber: row.receipt_number,
    resultCode: row.result_code,
    resultDescription: row.result_description,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function mapSubscription(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    planId: row.plan_id,
    period: row.period,
    status: row.status,
    paymentId: row.payment_id,
    startsAt: Number(row.starts_at),
    expiresAt: Number(row.expires_at),
    updatedAt: Number(row.updated_at)
  };
}

function createPostgresStore(connectionString, dataDir) {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 5),
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
  });

  async function migrateLegacyJson() {
    const { rows: migrations } = await pool.query('SELECT id FROM migrations WHERE id = $1', ['legacy-json-v1']);
    if (migrations.length) return;

    const legacyFile = path.join(dataDir, 'smartfarm.json');
    let legacy = { users: [], products: [], sessions: {} };
    if (fs.existsSync(legacyFile)) {
      try {
        legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      } catch (error) {
        throw new Error(`Could not migrate ${legacyFile}: ${error.message}`);
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const user of legacy.users || []) {
        if (!user.id || !user.email || !user.salt || !user.passwordHash) continue;
        await client.query(
          'INSERT INTO users (id, name, email, salt, password_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
          [user.id, user.name || 'SmartFarm seller', user.email, user.salt, user.passwordHash, Number(user.createdAt) || Date.now()]
        );
      }
      for (const [tokenHash, session] of Object.entries(legacy.sessions || {})) {
        if (!session.userId) continue;
        await client.query(
          'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO NOTHING',
          [tokenHash, session.userId, Number(session.expiresAt) || 0]
        );
      }
      for (const product of legacy.products || []) {
        if (!product.id || !product.ownerId) continue;
        await client.query(
          `INSERT INTO products (id, name, category, location, seller, price, unit, quantity, description, image, owner_id, own, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (id) DO NOTHING`,
          [
            product.id,
            String(product.name || 'Farm listing'),
            String(product.category || 'Services'),
            String(product.location || 'Kenya'),
            String(product.seller || 'SmartFarm seller'),
            Number(product.price) || 0,
            String(product.unit || 'per item'),
            Number(product.quantity) || 0,
            String(product.description || ''),
            String(product.image || ''),
            product.ownerId,
            Boolean(product.own),
            Number(product.createdAt) || Date.now()
          ]
        );
      }
      await client.query(
        'INSERT INTO migrations (id, applied_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        ['legacy-json-v1', Date.now()]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const ready = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id TEXT PRIMARY KEY,
        applied_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        location TEXT NOT NULL,
        seller TEXT NOT NULL,
        price DOUBLE PRECISION NOT NULL,
        unit TEXT NOT NULL,
        quantity BIGINT NOT NULL,
        description TEXT NOT NULL,
        image TEXT NOT NULL,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        own BOOLEAN NOT NULL DEFAULT FALSE,
        created_at BIGINT NOT NULL
      );
      ALTER TABLE products ADD COLUMN IF NOT EXISTS own BOOLEAN NOT NULL DEFAULT FALSE;
      CREATE INDEX IF NOT EXISTS products_created_idx ON products(created_at DESC);
      CREATE INDEX IF NOT EXISTS products_owner_idx ON products(owner_id);
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        period TEXT NOT NULL CHECK (period IN ('monthly', 'annual')),
        amount INTEGER NOT NULL CHECK (amount > 0),
        phone TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
        merchant_request_id TEXT,
        checkout_request_id TEXT UNIQUE,
        receipt_number TEXT,
        result_code TEXT,
        result_description TEXT NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payments_owner_idx ON payments(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        period TEXT NOT NULL,
        status TEXT NOT NULL,
        payment_id TEXT REFERENCES payments(id),
        starts_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);
    await migrateLegacyJson();
    const platformId = 'smartfarm-platform';
    await pool.query(
      'INSERT INTO users (id, name, email, salt, password_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
      [platformId, 'SmartFarm Wholesale', 'platform@invalid', crypto.randomBytes(16).toString('hex'), crypto.randomBytes(64).toString('hex'), Date.now()]
    );
    for (const product of platformProducts) {
      await pool.query(
        `INSERT INTO products (id, name, category, location, seller, price, unit, quantity, description, image, owner_id, own, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12) ON CONFLICT (id) DO NOTHING`,
        [product.id, product.name, product.category, product.location, product.seller, product.price, product.unit,
          product.quantity, product.description, product.image, platformId, Date.now()]
      );
    }
    await pool.query('DELETE FROM sessions WHERE expires_at <= $1', [Date.now()]);
  })();

  async function query(sql, values = []) {
    await ready;
    return pool.query(sql, values);
  }

  async function completePayment(checkoutRequestId, receiptNumber, resultCode, resultDescription) {
    await ready;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM payments WHERE checkout_request_id = $1 FOR UPDATE', [checkoutRequestId]);
      const payment = rows[0];
      if (!payment) {
        await client.query('COMMIT');
        return null;
      }
      if (payment.status === 'pending') {
        const now = Date.now();
        const updated = await client.query(
          `UPDATE payments SET status = 'succeeded', receipt_number = $1, result_code = $2,
           result_description = $3, updated_at = $4 WHERE id = $5 AND status = 'pending' RETURNING id`,
          [receiptNumber || null, String(resultCode), resultDescription || '', now, payment.id]
        );
        if (updated.rowCount) {
          const duration = payment.period === 'annual' ? 365 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
          await client.query(
            `INSERT INTO subscriptions (user_id, plan_id, period, status, payment_id, starts_at, expires_at, updated_at)
             VALUES ($1, $2, $3, 'active', $4, $5, $6, $7)
             ON CONFLICT(user_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, period = EXCLUDED.period,
             status = EXCLUDED.status, payment_id = EXCLUDED.payment_id, starts_at = EXCLUDED.starts_at,
             expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at`,
            [payment.user_id, payment.plan_id, payment.period, payment.id, now, now + duration, now]
          );
        }
      }
      const finalPayment = await client.query('SELECT * FROM payments WHERE id = $1', [payment.id]);
      await client.query('COMMIT');
      return mapPayment(finalPayment.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    getUserById: async (id) => mapUser((await query('SELECT * FROM users WHERE id = $1', [id])).rows[0]),
    getUserByEmail: async (email) => mapUser((await query('SELECT * FROM users WHERE email = $1', [email])).rows[0]),
    createUser: async (user) => query(
      'INSERT INTO users (id, name, email, salt, password_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [user.id, user.name, user.email, user.salt, user.passwordHash, user.createdAt]
    ),
    getSessionUser: async (tokenHash) => {
      const { rows } = await query(
        'SELECT sessions.expires_at, users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = $1',
        [tokenHash]
      );
      if (!rows[0]) return null;
      if (Number(rows[0].expires_at) <= Date.now()) {
        await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
        return null;
      }
      return mapUser(rows[0]);
    },
    saveSession: async (tokenHash, userId, expiresAt) => query(
      'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at',
      [tokenHash, userId, expiresAt]
    ),
    deleteSession: async (tokenHash) => query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]),
    listProducts: async () => (await query('SELECT * FROM products ORDER BY created_at DESC')).rows.map(mapProduct),
    listProductsByOwner: async (userId) => (await query('SELECT * FROM products WHERE owner_id = $1 ORDER BY created_at DESC', [userId])).rows.map(mapProduct),
    createProduct: async (product) => query(
      `INSERT INTO products (id, name, category, location, seller, price, unit, quantity, description, image, owner_id, own, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [product.id, product.name, product.category, product.location, product.seller, product.price, product.unit,
        product.quantity, product.description, product.image, product.ownerId, Boolean(product.own), product.createdAt]
    ),
    createPayment: async (payment) => mapPayment((await query(
      `INSERT INTO payments (id, user_id, plan_id, period, amount, phone, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8) RETURNING *`,
      [payment.id, payment.userId, payment.planId, payment.period, payment.amount, payment.phone, payment.createdAt, payment.updatedAt]
    )).rows[0]),
    getPaymentById: async (id) => mapPayment((await query('SELECT * FROM payments WHERE id = $1', [id])).rows[0]),
    getPaymentByCheckout: async (checkoutId) => mapPayment((await query('SELECT * FROM payments WHERE checkout_request_id = $1', [checkoutId])).rows[0]),
    listPaymentsByOwner: async (userId) => (await query('SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC', [userId])).rows.map(mapPayment),
    attachPaymentCheckout: async (id, merchantRequestId, checkoutRequestId) => mapPayment((await query(
      `UPDATE payments SET merchant_request_id = $1, checkout_request_id = $2, updated_at = $3
       WHERE id = $4 AND status = 'pending' RETURNING *`,
      [merchantRequestId, checkoutRequestId, Date.now(), id]
    )).rows[0]),
    failPayment: async (id, resultCode, resultDescription) => mapPayment((await query(
      `UPDATE payments SET status = 'failed', result_code = $1, result_description = $2, updated_at = $3
       WHERE id = $4 AND status = 'pending' RETURNING *`,
      [String(resultCode), resultDescription || '', Date.now(), id]
    )).rows[0]),
    completePayment,
    getSubscriptionByOwner: async (userId) => mapSubscription((await query('SELECT * FROM subscriptions WHERE user_id = $1', [userId])).rows[0]),
    activateFreeSubscription: async (userId) => {
      const now = Date.now();
      const result = await query(
        `INSERT INTO subscriptions (user_id, plan_id, period, status, payment_id, starts_at, expires_at, updated_at)
         VALUES ($1, 'starter', 'monthly', 'active', NULL, $2, $3, $2)
         ON CONFLICT(user_id) DO UPDATE SET plan_id = 'starter', period = 'monthly', status = 'active',
         payment_id = NULL, starts_at = EXCLUDED.starts_at, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [userId, now, now + 30 * 24 * 60 * 60 * 1000]
      );
      return mapSubscription(result.rows[0]);
    },
    health: async () => {
      await query('SELECT 1');
      return 'postgres';
    },
    close: () => pool.end()
  };
}

module.exports = { createPostgresStore };
