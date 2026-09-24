const db = require('./db');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();

// Runs fn inside a write transaction. Do not nest.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function parseId(value, name = 'id') {
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(n) || n <= 0 || n > 2147483647) {
    throw new HttpError(400, `Invalid ${name}`);
  }
  return n;
}

function str(value, field, { min = 1, max = 200, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
  const v = value.trim();
  if (v.length < min || v.length > max) {
    throw new HttpError(400, `${field} must be ${min}-${max} characters`);
  }
  return v;
}

function notify(userId, type, message, donationId = null) {
  if (!userId) return;
  db.prepare(
    'INSERT INTO notifications (user_id, type, message, donation_id, is_read, created_at) VALUES (?,?,?,?,0,?)'
  ).run(userId, type, message, donationId, now());
}

const CATEGORIES = ['cooked', 'produce', 'bakery', 'packaged', 'dairy', 'beverages'];
const UNITS = ['meals', 'boxes', 'kg', 'trays', 'liters'];

module.exports = { HttpError, now, tx, parseId, str, notify, CATEGORIES, UNITS };
