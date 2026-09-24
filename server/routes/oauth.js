// Google Sign-In (OAuth 2.0 authorization-code flow).
//
// The client secret and the code->token exchange live entirely on the server; the browser only
// ever sees the redirect. The whole feature is optional: with GOOGLE_CLIENT_ID/SECRET unset the
// routes return 503 and the frontend hides the button, so password login keeps working.
//
// CSRF: a signed, short-lived `oauth_state` cookie must match the `state` query parameter that
// comes back from Google.
//
// Token validation: the ID token is fetched by this server directly from Google over TLS
// (a server-to-server call), which is the case where Google's own documentation says local
// signature verification can be skipped. We still check issuer, audience and expiry, and we
// refuse identities whose email is not verified.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { HttpError, now, tx } = require('../lib');
const { setSession, setTempCookie, readTempCookie, clearTempCookie, rateLimit, authenticate } = require('../auth');
const { validateProfile, createUser, afterSignup, ROLES } = require('../profile');
const { userOut } = require('../serialize');

const router = express.Router();

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const STATE_COOKIE = 'oauth_state';
const PENDING_COOKIE = 'pending_google';

const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

// Explicit GOOGLE_REDIRECT_URI wins (it must match the Google console exactly in production);
// otherwise derive it from the incoming request so localhost works with no configuration.
const redirectUri = (req) =>
  process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/auth/google/callback`;

const HOME = { DONOR: '#/donor', RECIPIENT: '#/recipient', DRIVER: '#/driver' };
const appRedirect = (res, hash) => res.redirect('/' + hash);
const failRedirect = (res, code) => res.redirect('/#/login?error=' + encodeURIComponent(code));

function requireEnabled() {
  if (!googleEnabled()) {
    throw new HttpError(503, 'Google sign-in is not configured on this server');
  }
}

// ---------------------------------------------------------------- step 1: start
router.get('/google', rateLimit(30, 15 * 60 * 1000), (req, res) => {
  requireEnabled();
  const role = ROLES.includes(req.query.role) ? req.query.role : null;
  const nonce = crypto.randomBytes(16).toString('hex');
  setTempCookie(res, STATE_COOKIE, { nonce, role }, 'oauth-state', 600);

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state: nonce,
    prompt: 'select_account',
  });
  res.redirect(`${AUTH_URL}?${params}`);
});

// ---------------------------------------------------------------- step 2: callback
router.get('/google/callback', async (req, res) => {
  requireEnabled();
  const state = readTempCookie(req, STATE_COOKIE, 'oauth-state');
  clearTempCookie(res, STATE_COOKIE);

  if (req.query.error) return failRedirect(res, 'google_cancelled');
  if (!state || !req.query.state || req.query.state !== state.nonce) return failRedirect(res, 'bad_state');
  if (typeof req.query.code !== 'string' || !req.query.code) return failRedirect(res, 'missing_code');

  let identity;
  try {
    identity = await exchangeCode(req.query.code, redirectUri(req));
  } catch (err) {
    console.error('[oauth] token exchange failed:', err.message); // never logs the code or secret
    return failRedirect(res, 'google_failed');
  }
  if (!identity.email_verified) return failRedirect(res, 'email_unverified');

  const existing =
    (await db.get('SELECT * FROM users WHERE google_id = ?', [identity.sub])) ||
    (await db.get('SELECT * FROM users WHERE email = ?', [identity.email]));

  if (existing) {
    // Link the Google identity to the matching account exactly once, so signing in with
    // Google and with a password lands on the same account instead of creating a duplicate.
    if (!existing.google_id) {
      await db.run('UPDATE users SET google_id = ?, email_verified = 1, updated_at = ? WHERE id = ? AND google_id IS NULL',
        [identity.sub, now(), existing.id]);
    } else if (existing.google_id !== identity.sub) {
      return failRedirect(res, 'account_conflict');
    }
    setSession(res, existing.id);
    return appRedirect(res, HOME[existing.role]);
  }

  // Unknown person: hold the verified identity in a short-lived signed cookie while they
  // choose a role and location. No account exists until they finish.
  setTempCookie(res, PENDING_COOKIE, { sub: identity.sub, email: identity.email, name: identity.name, role: state.role }, 'google-pending', 900);
  return appRedirect(res, '#/complete-profile');
});

async function exchangeCode(code, uri) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: uri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);
  const data = await res.json();
  if (!data.id_token) throw new Error('no id_token in response');
  return verifyIdToken(data.id_token);
}

function verifyIdToken(idToken) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!ISSUERS.includes(claims.iss)) throw new Error('unexpected issuer');
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error('audience mismatch');
  if (!claims.exp || claims.exp * 1000 <= Date.now()) throw new Error('id_token expired');
  if (!claims.sub || !claims.email) throw new Error('id_token missing subject or email');
  return {
    sub: String(claims.sub),
    email: String(claims.email).toLowerCase(),
    name: claims.name || String(claims.email).split('@')[0],
    email_verified: claims.email_verified === true || claims.email_verified === 'true',
  };
}

// ---------------------------------------------------------------- step 3: finish signup
// Tells the frontend which fields the pending Google user still has to provide.
router.get('/google/pending', (req, res) => {
  const pending = readTempCookie(req, PENDING_COOKIE, 'google-pending');
  if (!pending) throw new HttpError(401, 'Your Google sign-in expired. Please start again.');
  res.json({ pending: { email: pending.email, name: pending.name, role: pending.role || null } });
});

router.post('/google/complete', rateLimit(20, 15 * 60 * 1000), async (req, res) => {
  const pending = readTempCookie(req, PENDING_COOKIE, 'google-pending');
  if (!pending) throw new HttpError(401, 'Your Google sign-in expired. Please start again.');

  // Identity comes from the signed cookie, never from the request body.
  const profile = await validateProfile({ ...req.body, name: req.body?.name || pending.name });

  const userId = await tx(async () => {
    if (await db.get('SELECT 1 AS found FROM users WHERE google_id = ?', [pending.sub])) {
      throw new HttpError(409, 'This Google account is already registered');
    }
    return createUser({ profile, email: pending.email, googleId: pending.sub, emailVerified: 1 });
  });

  await afterSignup(profile);
  clearTempCookie(res, PENDING_COOKIE);
  setSession(res, userId);
  res.status(201).json({ user: await userOut(await db.get('SELECT * FROM users WHERE id = ?', [userId])) });
});

// Lets a signed-in password user detach Google, and vice versa is prevented (never leave an
// account with no way to log in).
router.post('/google/unlink', authenticate, async (req, res) => {
  if (!req.user.password_hash) {
    throw new HttpError(409, 'Set a password before unlinking Google, otherwise you could not sign in');
  }
  await db.run('UPDATE users SET google_id = NULL, updated_at = ? WHERE id = ?', [now(), req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
module.exports.googleEnabled = googleEnabled;
module.exports.verifyIdToken = verifyIdToken;
