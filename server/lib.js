const db = require('./db');
const cfg = require('./config');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// All timestamps are stored as UTC ISO-8601 strings, so comparisons are timezone-safe
// regardless of where the donor, recipient or server is. Clients convert to local time
// for display only.
const now = () => new Date().toISOString();

// Runs fn inside a transaction. Nested calls join the enclosing one (see database.js).
const tx = (fn) => db.tx(fn);

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

/**
 * Writes the in-app notification (the reliable base) and then fans out to any configured
 * external channel. External delivery is best-effort and can never fail the caller.
 */
async function notify(userId, type, message, donationId = null) {
  if (!userId) return;
  const { dispatch, severityOf } = require('./channels');
  const user = await db.get('SELECT id, name, email, phone FROM users WHERE id = ?', [userId]);
  if (!user) return;

  const severity = severityOf(type);
  let channels = ['inApp'];
  try {
    channels = dispatch({ user, type, message, donationId, severity });
  } catch (err) {
    console.error('[notify] channel dispatch failed:', err.message);
  }

  await db.run(
    `INSERT INTO notifications (user_id, type, message, donation_id, severity, channels, is_read, created_at)
     VALUES (?,?,?,?,?,?,0,?)`,
    [userId, type, message, donationId, severity, channels.join(','), now()]
  );
}

/**
 * Classifies how much usable time a donation has left.
 * EXPIRED -> HIGH -> MEDIUM -> LOW, based on minutes remaining.
 * This enforces the application's own time-window rules; it is not a food-safety guarantee.
 */
function expiryRisk(expiryIso, nowMs = Date.now()) {
  const minutesLeft = Math.floor((Date.parse(expiryIso) - nowMs) / 60000);
  if (!Number.isFinite(minutesLeft)) return { risk: 'EXPIRED', minutesLeft: 0, label: 'Unknown expiry' };
  if (minutesLeft <= 0) return { risk: 'EXPIRED', minutesLeft: 0, label: 'Expired' };
  if (minutesLeft <= cfg.EXPIRY_HIGH_RISK_MIN) return { risk: 'HIGH', minutesLeft, label: 'Expires very soon' };
  if (minutesLeft <= cfg.EXPIRY_MEDIUM_RISK_MIN) return { risk: 'MEDIUM', minutesLeft, label: 'Expires soon' };
  return { risk: 'LOW', minutesLeft, label: 'Plenty of time' };
}

const CATEGORIES = ['cooked', 'produce', 'bakery', 'packaged', 'dairy', 'beverages'];
const UNITS = ['meals', 'boxes', 'kg', 'trays', 'liters'];

module.exports = { HttpError, now, tx, parseId, str, notify, expiryRisk, CATEGORIES, UNITS };
