const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { platformProducts } = require('./platform-products');

function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const legacyFile = path.join(dataDir, 'smartfarm.json');
  const database = new DatabaseSync(path.join(dataDir, 'smartfarm.sqlite'));
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      location TEXT NOT NULL,
      seller TEXT NOT NULL,
      price REAL NOT NULL,
      unit TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      description TEXT NOT NULL,
      image TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      own INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payments_owner_idx ON payments(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL,
      period TEXT NOT NULL,
      status TEXT NOT NULL,
      payment_id TEXT REFERENCES payments(id),
      starts_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const productColumns = database.prepare('PRAGMA table_info(products)').all();
  if (!productColumns.some((column) => column.name === 'own')) {
    database.exec('ALTER TABLE products ADD COLUMN own INTEGER NOT NULL DEFAULT 0');
  }

  const statements = {
    migration: database.prepare('SELECT id FROM migrations WHERE id = ?'),
    markMigration: database.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)'),
    userById: database.prepare('SELECT * FROM users WHERE id = ?'),
    userByEmail: database.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
    insertUser: database.prepare('INSERT OR IGNORE INTO users (id, name, email, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    sessionByHash: database.prepare('SELECT sessions.expires_at, users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?'),
    insertSession: database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at'),
    deleteSession: database.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteExpiredSessions: database.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    insertLegacySession: database.prepare('INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    insertProduct: database.prepare('INSERT INTO products (id, name, category, location, seller, price, unit, quantity, description, image, owner_id, own, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    insertLegacyProduct: database.prepare('INSERT OR IGNORE INTO products (id, name, category, location, seller, price, unit, quantity, description, image, owner_id, own, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    allProducts: database.prepare('SELECT * FROM products ORDER BY created_at DESC'),
    productsByOwner: database.prepare('SELECT * FROM products WHERE owner_id = ? ORDER BY created_at DESC'),
    createPayment: database.prepare('INSERT INTO payments (id, user_id, plan_id, period, amount, phone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    paymentById: database.prepare('SELECT * FROM payments WHERE id = ?'),
    paymentByCheckout: database.prepare('SELECT * FROM payments WHERE checkout_request_id = ?'),
    paymentsByOwner: database.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC'),
    attachCheckout: database.prepare('UPDATE payments SET merchant_request_id = ?, checkout_request_id = ?, updated_at = ? WHERE id = ? AND status = \'pending\''),
    failPayment: database.prepare('UPDATE payments SET status = \'failed\', result_code = ?, result_description = ?, updated_at = ? WHERE id = ? AND status = \'pending\''),
    completePayment: database.prepare('UPDATE payments SET status = \'succeeded\', receipt_number = ?, result_code = ?, result_description = ?, updated_at = ? WHERE checkout_request_id = ? AND status = \'pending\''),
    upsertSubscription: database.prepare('INSERT INTO subscriptions (user_id, plan_id, period, status, payment_id, starts_at, expires_at, updated_at) VALUES (?, ?, ?, \'active\', ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET plan_id = excluded.plan_id, period = excluded.period, status = excluded.status, payment_id = excluded.payment_id, starts_at = excluded.starts_at, expires_at = excluded.expires_at, updated_at = excluded.updated_at'),
    subscriptionByOwner: database.prepare('SELECT * FROM subscriptions WHERE user_id = ?')
  };

  function migrateLegacyJson() {
    const migrationId = 'legacy-json-v1';
    if (statements.migration.get(migrationId)) return;
    let legacy = { users: [], products: [], sessions: {} };
    if (fs.existsSync(legacyFile)) {
      try {
        legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      } catch (error) {
        throw new Error(`Could not migrate ${legacyFile}: ${error.message}`);
      }
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      for (const user of legacy.users || []) {
        if (!user.id || !user.email || !user.salt || !user.passwordHash) continue;
        statements.insertUser.run(user.id, user.name || 'SmartFarm seller', user.email, user.salt, user.passwordHash, Number(user.createdAt) || Date.now());
      }
      for (const [tokenHash, session] of Object.entries(legacy.sessions || {})) {
        if (session.userId && statements.userById.get(session.userId)) {
          statements.insertLegacySession.run(tokenHash, session.userId, Number(session.expiresAt) || 0);
        }
      }
      for (const product of legacy.products || []) {
        if (!product.id || !product.ownerId || !statements.userById.get(product.ownerId)) continue;
        const owner = statements.userById.get(product.ownerId);
        statements.insertLegacyProduct.run(
          product.id,
          String(product.name || 'Farm listing'),
          String(product.category || 'Services'),
          String(product.location || 'Kenya'),
          String(product.seller || owner.name),
          Number(product.price) || 0,
          String(product.unit || 'per item'),
          Number(product.quantity) || 0,
          String(product.description || ''),
          String(product.image || ''),
          product.ownerId,
          Number(product.own) || 0,
          Number(product.createdAt) || Date.now()
        );
      }
      statements.markMigration.run(migrationId, Date.now());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  migrateLegacyJson();
  statements.deleteExpiredSessions.run(Date.now());
  const platformId = 'smartfarm-platform';
  statements.insertUser.run(
    platformId,
    'SmartFarm Wholesale',
    'platform@invalid',
    crypto.randomBytes(16).toString('hex'),
    crypto.randomBytes(64).toString('hex'),
    Date.now()
  );
  for (const product of platformProducts) {
    statements.insertLegacyProduct.run(
      product.id,
      product.name,
      product.category,
      product.location,
      product.seller,
      product.price,
      product.unit,
      product.quantity,
      product.description,
      product.image,
      platformId,
      1,
      Date.now()
    );
  }

  function mapUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      salt: row.salt,
      passwordHash: row.password_hash,
      createdAt: row.created_at
    };
  }

  function mapProduct(row) {
    return {
      id: row.id,
      name: row.name,
      category: row.category,
      location: row.location,
      seller: row.seller,
      price: row.price,
      unit: row.unit,
      quantity: row.quantity,
      description: row.description,
      image: row.image,
      own: Boolean(row.own),
      ownerId: row.owner_id,
      createdAt: row.created_at
    };
  }

  function mapPayment(row) {
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      planId: row.plan_id,
      period: row.period,
      amount: row.amount,
      phone: row.phone,
      status: row.status,
      merchantRequestId: row.merchant_request_id,
      checkoutRequestId: row.checkout_request_id,
      receiptNumber: row.receipt_number,
      resultCode: row.result_code,
      resultDescription: row.result_description,
      createdAt: row.created_at,
      updatedAt: row.updated_at
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
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at
    };
  }

  return {
    getUserById(id) {
      return mapUser(statements.userById.get(id));
    },
    getUserByEmail(email) {
      return mapUser(statements.userByEmail.get(email));
    },
    createUser(user) {
      database.prepare('INSERT INTO users (id, name, email, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, user.name, user.email, user.salt, user.passwordHash, user.createdAt);
    },
    getSessionUser(tokenHash) {
      const row = statements.sessionByHash.get(tokenHash);
      if (!row) return null;
      if (row.expires_at <= Date.now()) {
        statements.deleteSession.run(tokenHash);
        return null;
      }
      return mapUser(row);
    },
    saveSession(tokenHash, userId, expiresAt) {
      statements.insertSession.run(tokenHash, userId, expiresAt);
    },
    deleteSession(tokenHash) {
      statements.deleteSession.run(tokenHash);
    },
    listProducts() {
      return statements.allProducts.all().map(mapProduct);
    },
    listProductsByOwner(userId) {
      return statements.productsByOwner.all(userId).map(mapProduct);
    },
    createProduct(product) {
      statements.insertProduct.run(
        product.id,
        product.name,
        product.category,
        product.location,
        product.seller,
        product.price,
        product.unit,
        product.quantity,
        product.description,
        product.image,
        product.ownerId,
        Number(Boolean(product.own)),
        product.createdAt
      );
    },
    createPayment(payment) {
      statements.createPayment.run(
        payment.id, payment.userId, payment.planId, payment.period, payment.amount,
        payment.phone, 'pending', payment.createdAt, payment.updatedAt
      );
      return mapPayment(statements.paymentById.get(payment.id));
    },
    getPaymentById(id) {
      return mapPayment(statements.paymentById.get(id));
    },
    getPaymentByCheckout(checkoutId) {
      return mapPayment(statements.paymentByCheckout.get(checkoutId));
    },
    listPaymentsByOwner(userId) {
      return statements.paymentsByOwner.all(userId).map(mapPayment);
    },
    attachPaymentCheckout(id, merchantRequestId, checkoutRequestId) {
      statements.attachCheckout.run(merchantRequestId, checkoutRequestId, Date.now(), id);
      return mapPayment(statements.paymentById.get(id));
    },
    failPayment(id, resultCode, resultDescription) {
      statements.failPayment.run(String(resultCode), resultDescription, Date.now(), id);
      return mapPayment(statements.paymentById.get(id));
    },
    completePayment(checkoutRequestId, receiptNumber, resultCode, resultDescription) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const payment = statements.paymentByCheckout.get(checkoutRequestId);
        if (!payment) {
          database.exec('COMMIT');
          return null;
        }
        if (payment.status === 'pending') {
          const now = Date.now();
          const update = statements.completePayment.run(receiptNumber || null, String(resultCode), resultDescription || '', now, checkoutRequestId);
          if (update.changes) {
            const duration = payment.period === 'annual' ? 365 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
            statements.upsertSubscription.run(
              payment.user_id, payment.plan_id, payment.period, payment.id, now, now + duration, now
            );
          }
        }
        database.exec('COMMIT');
        return mapPayment(statements.paymentByCheckout.get(checkoutRequestId));
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    getSubscriptionByOwner(userId) {
      return mapSubscription(statements.subscriptionByOwner.get(userId));
    },
    activateFreeSubscription(userId) {
      const now = Date.now();
      const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
      statements.upsertSubscription.run(userId, 'starter', 'monthly', null, now, expiresAt, now);
      return mapSubscription(statements.subscriptionByOwner.get(userId));
    },
    health() {
      database.prepare('SELECT 1').get();
      return 'sqlite';
    },
    close() {
      database.close();
    }
  };
}

module.exports = { createStore };
