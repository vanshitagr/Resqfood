const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { HttpError, tx } = require('../lib');
const { setSession, clearSession, authenticate, rateLimit } = require('../auth');
const { validEmail, validPassword, validateProfile, createUser, afterSignup } = require('../profile');
const { userOut } = require('../serialize');
const { googleEnabled } = require('./oauth');
const cfg = require('../config');

const router = express.Router();
// Comparing against a real hash makes an unknown email cost the same as a wrong password,
// so response timing does not reveal which accounts exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// Lets the frontend show the Google button only when the server is actually configured for it.
router.get('/config', (req, res) => {
  res.json({ google: googleEnabled() });
});

router.post('/register', rateLimit(cfg.LOGIN_ATTEMPTS, cfg.LOGIN_WINDOW_MIN * 60 * 1000), async (req, res) => {
  const email = validEmail(req.body?.email);
  const password = validPassword(req.body?.password);
  const profile = await validateProfile(req.body);
  const passwordHash = await bcrypt.hash(password, 10);

  const userId = await tx(() => createUser({ profile, email, passwordHash }));
  await afterSignup(profile);
  setSession(res, userId);
  res.status(201).json({ user: await userOut(await db.get('SELECT * FROM users WHERE id = ?', [userId])) });
});

router.post('/login', rateLimit(cfg.LOGIN_ATTEMPTS, cfg.LOGIN_WINDOW_MIN * 60 * 1000), async (req, res) => {
  const b = req.body || {};
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const user = email ? await db.get('SELECT * FROM users WHERE email = ?', [email]) : null;

  const ok = await bcrypt.compare(password, user && user.password_hash ? user.password_hash : DUMMY_HASH);
  if (!user || !user.password_hash || !ok) {
    // A Google-only account has no password; say so without confirming the address exists.
    throw new HttpError(401, 'Invalid email or password');
  }
  setSession(res, user.id);
  res.json({ user: await userOut(user) });
});

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get('/me', authenticate, async (req, res) => {
  res.json({ user: await userOut(req.user) });
});

router.put('/me', authenticate, async (req, res) => {
  await tx(() => require('../profile').updateProfile(req.user.id, req.body));
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json({ user: await userOut(user) });
});

module.exports = router;
