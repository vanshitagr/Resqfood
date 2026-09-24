const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { HttpError } = require('./lib');

let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  SECRET = crypto.randomBytes(32).toString('hex'); // dev only: sessions reset on restart
  if (process.env.NODE_ENV !== 'test') {
    console.warn('[auth] JWT_SECRET not set - using a temporary secret (sessions reset on restart)');
  }
}

const COOKIE = 'token';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const isProd = () => process.env.NODE_ENV === 'production';

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSession(res, userId) {
  const token = jwt.sign({ sub: userId }, SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd(),
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

const clearSession = (res) => res.clearCookie(COOKIE, { path: '/' });

// Short-lived signed cookies used by the OAuth handshake (CSRF state, pending signup).
// Same secret, but a distinct `kind` claim so one can never be replayed as the other.
function setTempCookie(res, name, payload, kind, seconds) {
  const token = jwt.sign({ ...payload, kind }, SECRET, { expiresIn: seconds });
  res.cookie(name, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd(),
    maxAge: seconds * 1000,
    path: '/',
  });
  return token;
}

function readTempCookie(req, name, kind) {
  const raw = readCookie(req, name);
  if (!raw) return null;
  try {
    const payload = jwt.verify(raw, SECRET);
    return payload.kind === kind ? payload : null;
  } catch {
    return null;
  }
}

const clearTempCookie = (res, name) => res.clearCookie(name, { path: '/' });

// The role always comes from the database, never from the token or the client.
async function authenticate(req, res, next) {
  const token = readCookie(req, COOKIE);
  if (!token) return next(new HttpError(401, 'Not authenticated'));
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return next(new HttpError(401, 'Session expired, please log in again'));
  }
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.sub]);
    if (!user) return next(new HttpError(401, 'Not authenticated'));
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role)
    ? next()
    : next(new HttpError(403, 'You are not allowed to do this'));

// Tiny in-memory limiter. Enough for a single-process hackathon deployment; a multi-instance
// deployment would move this to Redis.
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    const key = req.ip + ':' + req.path;
    const t = Date.now();
    const rec = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (rec.length >= max) return next(new HttpError(429, 'Too many attempts, please wait and try again'));
    rec.push(t);
    hits.set(key, rec);
    next();
  };
}
// Bounded cleanup so the map cannot grow forever.
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [k, v] of hits) if (!v.some((t) => t > cutoff)) hits.delete(k);
}, 600_000).unref();

module.exports = {
  setSession, clearSession, authenticate, requireRole, rateLimit,
  readCookie, setTempCookie, readTempCookie, clearTempCookie,
};
