const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { HttpError, now, tx, str, CATEGORIES } = require('../lib');
const { setSession, clearSession, authenticate, rateLimit } = require('../auth');
const { resolveLocation } = require('../geo');
const { userOut } = require('../serialize');

const router = express.Router();
const ROLES = ['DONOR', 'RECIPIENT', 'DRIVER'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Constant-time-ish dummy so unknown emails cost the same as wrong passwords.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

router.post('/register', rateLimit(20, 15 * 60 * 1000), async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 'Name', { min: 2, max: 100 });
  const email = str(b.email, 'Email', { max: 200 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Invalid email address');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 8 || password.length > 128) {
    throw new HttpError(400, 'Password must be 8-128 characters');
  }
  if (!ROLES.includes(b.role)) throw new HttpError(400, 'Role must be DONOR, RECIPIENT or DRIVER');
  const phone = str(b.phone, 'Phone', { min: 5, max: 30, required: false });
  const address = str(b.address, 'Location', { min: 2, max: 300 });

  let org, capacity, need, types;
  if (b.role === 'RECIPIENT') {
    org = str(b.organizationName, 'Organization name', { min: 2, max: 120 });
    capacity = Number(b.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000) {
      throw new HttpError(400, 'Capacity must be a whole number of meals between 1 and 100000');
    }
    need = ['LOW', 'MEDIUM', 'HIGH'].includes(b.currentNeed) ? b.currentNeed : 'MEDIUM';
    types = Array.isArray(b.acceptedFoodTypes) ? b.acceptedFoodTypes : [];
    if (!types.every((t) => CATEGORIES.includes(t))) throw new HttpError(400, 'Invalid food type preference');
  }

  const loc = await resolveLocation({ address, lat: b.lat, lng: b.lng });
  const hash = await bcrypt.hash(password, 10);

  const userId = tx(() => {
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with this email already exists');
    }
    const t = now();
    const r = db
      .prepare(
        'INSERT INTO users (name,email,password_hash,role,phone,address,lat,lng,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(name, email, hash, b.role, phone, address, loc.lat, loc.lng, t, t);
    const id = Number(r.lastInsertRowid);
    if (b.role === 'RECIPIENT') {
      db.prepare(
        'INSERT INTO recipients (user_id, organization_name, capacity, current_need, accepted_food_types, created_at) VALUES (?,?,?,?,?,?)'
      ).run(id, org, capacity, need, JSON.stringify([...new Set(types)]), t);
    }
    return id;
  });

  setSession(res, userId);
  res.status(201).json({ user: userOut(db.prepare('SELECT * FROM users WHERE id=?').get(userId)) });
});

router.post('/login', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  const b = req.body || {};
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Invalid email or password');
  setSession(res, user.id);
  res.json({ user: userOut(user) });
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: userOut(req.user) });
});

module.exports = router;
