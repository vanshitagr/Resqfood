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
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

const clearSession = (res) => res.clearCookie(COOKIE, { path: '/' });

// The role always comes from the database, never from the token or the client.
function authenticate(req, res, next) {
  const token = readCookie(req, COOKIE);
  if (!token) return next(new HttpError(401, 'Not authenticated'));
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return next(new HttpError(401, 'Session expired, please log in again'));
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
  if (!user) return next(new HttpError(401, 'Not authenticated'));
  req.user = user;
  next();
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role)
    ? next()
    : next(new HttpError(403, 'You are not allowed to do this'));

// Tiny in-memory limiter for login/register brute force.
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

module.exports = { setSession, clearSession, authenticate, requireRole, rateLimit };
