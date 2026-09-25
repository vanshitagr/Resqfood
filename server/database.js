// Database abstraction over two back ends:
//
//   SQLite   (default)  - node:sqlite, zero setup, the file in data/app.db
//   Postgres (Supabase) - enabled by setting DATABASE_URL
//
// Both expose the SAME async API, so application code never branches on the engine:
//
//   await db.get(sql, params)      one row or undefined
//   await db.all(sql, params)      array of rows
//   await db.run(sql, params)      { changes }
//   await db.insert(sql, params)   { id, changes }   - the new primary key
//   await db.exec(ddl)             multi-statement DDL, no parameters
//   await db.tx(async () => {...}) transaction
//
// Two details make this work without threading a handle through 80 call sites:
//
//  1. Placeholders are always written as `?`. The Postgres driver rewrites them to $1, $2...
//     while skipping anything inside a quoted string literal.
//  2. tx() publishes its connection through AsyncLocalStorage, so every db.get/run executed
//     inside the callback automatically joins that transaction. Nested tx() calls join the
//     outer transaction instead of dead-locking on a second connection.
const { AsyncLocalStorage } = require('node:async_hooks');

const txContext = new AsyncLocalStorage();

/**
 * Rewrites `?` placeholders to Postgres `$n`, ignoring `?` inside '...' literals,
 * "..." identifiers and -- line comments.
 */
function toPositional(sql) {
  let out = '';
  let n = 0;
  let quote = null; // "'" , '"' or '--'
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote === '--') {
      if (c === '\n') quote = null;
    } else if (quote) {
      if (c === quote) {
        if (sql[i + 1] === quote) { out += c; i++; } // escaped quote inside the literal
        else quote = null;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '-' && sql[i + 1] === '-') {
      quote = '--';
    } else if (c === '?') {
      out += '$' + ++n;
      continue;
    }
    out += c;
  }
  return out;
}

// ------------------------------------------------------------------ SQLite
function sqliteDriver() {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('fs');
  const path = require('path');

  const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  // node:sqlite rejects undefined; normalise to null so both engines behave alike.
  const clean = (params) => params.map((p) => (p === undefined ? null : p));

  return {
    dialect: 'sqlite',
    raw,
    describe: file === ':memory:' ? 'SQLite (in-memory)' : `SQLite (${file})`,
    async get(sql, params) { return raw.prepare(sql).get(...clean(params)); },
    async all(sql, params) { return raw.prepare(sql).all(...clean(params)); },
    async run(sql, params) {
      const r = raw.prepare(sql).run(...clean(params));
      return { changes: r.changes, id: Number(r.lastInsertRowid) };
    },
    async exec(sql) { raw.exec(sql); },
    async begin() { raw.exec('BEGIN IMMEDIATE'); },
    async commit() { raw.exec('COMMIT'); },
    async rollback() { raw.exec('ROLLBACK'); },
    async close() { raw.close(); },
    // Same single connection for everything: SQLite has no pool.
    async acquire() { return null; },
    release() {},
  };
}

// ---------------------------------------------------------------- Postgres
function postgresDriver() {
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;

  // Supabase terminates TLS with its own CA. Verifying it needs the CA bundle, which is not
  // shipped here, so certificate verification is relaxed for that host only unless
  // DATABASE_SSL_STRICT=1. The connection is still encrypted.
  const strict = process.env.DATABASE_SSL_STRICT === '1';
  const pool = new Pool({
    connectionString: url,
    ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: strict },
    max: Number(process.env.DATABASE_POOL_MAX) || 8,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));

  const host = (() => {
    try { return new URL(url).host; } catch { return 'postgres'; }
  })();

  const exec = async (sql, params = []) => {
    const client = txContext.getStore();
    const text = toPositional(sql);
    if (client) return client.query(text, params);
    return pool.query(text, params);
  };

  return {
    dialect: 'postgres',
    raw: pool,
    describe: `Postgres (${host})`,
    async get(sql, params) { return (await exec(sql, params)).rows[0]; },
    async all(sql, params) { return (await exec(sql, params)).rows; },
    async run(sql, params) {
      const r = await exec(sql, params);
      return { changes: r.rowCount, id: r.rows[0] ? r.rows[0].id : undefined };
    },
    async exec(sql) { await exec(sql); },
    async acquire() { return pool.connect(); },
    release(client) { client.release(); },
    async close() { await pool.end(); },
  };
}

// --------------------------------------------------------------- public API
function createDatabase() {
  // In production the SQLite fallback is always wrong: a serverless or container filesystem is
  // read-only, so sqliteDriver() throws EROFS while creating data/, and even where the write
  // succeeds the file is discarded on the next deploy. Fail loudly and name the variable rather
  // than crashing deep inside fs.mkdirSync with an unrelated-looking error.
  if (!process.env.DATABASE_URL && process.env.NODE_ENV === 'production') {
    throw Object.assign(
      new Error('DATABASE_URL must be set in production (the local SQLite fallback cannot be used there)'),
      { code: 'CONFIG' }
    );
  }
  const driver = process.env.DATABASE_URL ? postgresDriver() : sqliteDriver();
  const pg = driver.dialect === 'postgres';

  const db = {
    dialect: driver.dialect,
    describe: driver.describe,
    raw: driver.raw,

    get: (sql, params = []) => driver.get(sql, params),
    all: (sql, params = []) => driver.all(sql, params),
    run: (sql, params = []) => driver.run(sql, params),
    exec: (sql) => driver.exec(sql),
    close: () => driver.close(),

    /**
     * INSERT returning the new primary key in `id` on both engines.
     * Postgres needs an explicit RETURNING clause; SQLite reports lastInsertRowid.
     */
    async insert(sql, params = [], idColumn = 'id') {
      const text = pg && !/returning/i.test(sql) ? `${sql} RETURNING ${idColumn}` : sql;
      const r = await driver.run(text, params);
      return { id: r.id, changes: r.changes };
    },

    /**
     * Runs fn inside a transaction. Nested calls join the enclosing transaction rather than
     * opening a second connection, which would dead-lock against the first one's locks.
     */
    async tx(fn) {
      if (txContext.getStore()) return fn(); // already inside a transaction

      if (!pg) {
        await driver.begin();
        try {
          const result = await txContext.run(Symbol('sqlite-tx'), fn);
          await driver.commit();
          return result;
        } catch (err) {
          try { await driver.rollback(); } catch { /* rollback of a failed tx */ }
          throw err;
        }
      }

      const client = await driver.acquire();
      try {
        await client.query('BEGIN');
        const result = await txContext.run(client, fn);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
        throw err;
      } finally {
        driver.release(client);
      }
    },

    // Small dialect differences that cannot be papered over in plain SQL.
    sql: {
      // Seconds between two ISO-8601 timestamp columns.
      epochDiff: (later, earlier) => pg
        ? `EXTRACT(EPOCH FROM (${later}::timestamptz - ${earlier}::timestamptz))`
        : `((julianday(${later}) - julianday(${earlier})) * 86400.0)`,
      // Scalar max of two values (SQLite MAX vs Postgres GREATEST).
      greatest: (a, b) => (pg ? `GREATEST(${a}, ${b})` : `MAX(${a}, ${b})`),
      // Case-insensitive equality on a column that may not be stored lower-cased.
      caseInsensitive: (col) => (pg ? `lower(${col})` : col),
    },
  };

  return db;
}

module.exports = { createDatabase, toPositional };
