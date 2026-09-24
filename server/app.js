const express = require('express');
const path = require('path');
const cfg = require('./config');
const { HttpError } = require('./lib');
const svc = require('./service');
const misc = require('./routes/misc');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Content-Security-Policy allow-list. Only the map library, its tiles and the routing API are
// third-party; everything else must be same-origin. 'unsafe-inline' is needed for style
// attributes only - no inline <script> exists anywhere in the app.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' https://unpkg.com 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://unpkg.com",
  "connect-src 'self' https://router.project-osrm.org",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '50kb' }));

// CORS: the UI is served from the same origin, so by default NO cross-origin access is granted.
// Set CORS_ORIGINS (comma-separated) only if a separate frontend host needs API access.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE',
      Vary: 'Origin',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  // Reject cross-site state changes from any origin that is not explicitly allowed.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.headers.host && !ALLOWED_ORIGINS.includes(origin)) {
      return next(new HttpError(403, 'Cross-origin request blocked'));
    }
  }
  res.set('Cache-Control', 'no-store');
  next();
});

// Liveness/readiness probe for the host's health checks and uptime monitoring.
// Unauthenticated by design, so it reports only whether the database answers - never
// configuration, credentials or row contents.
app.get('/api/health', async (req, res) => {
  const db = require('./db');
  try {
    await db.get('SELECT 1 AS ok');
    res.json({ status: 'ok', storage: db.dialect, uptimeSeconds: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ status: 'degraded', storage: db.dialect, error: 'database unavailable' });
  }
});

app.use('/api/auth', require('./routes/oauth')); // /google, /google/callback, /google/complete
app.use('/api/auth', require('./routes/auth'));
app.use('/api/donations', require('./routes/donations'));
app.use('/api/recipients', misc.recipients);
app.use('/api/deliveries', misc.deliveries);
app.use('/api/stats', misc.stats);
app.use('/api/notifications', misc.notifications);
app.use('/api/ai', misc.ai);
app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));

app.use(express.static(path.join(__dirname, '..', 'public')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  // Full detail stays in the server log; the client gets a generic message and no stack trace.
  console.error('[error]', req.method, req.path, err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Background sweep: expires stale donations, warns about ones close to expiry, and retries
// matching for donations still looking for a recipient. unref() so it never holds tests open.
setInterval(async () => {
  try {
    const r = await svc.sweep();
    if (r.expired || r.warned || r.reminded || r.rematched) {
      console.log(`[sweep] expired=${r.expired} warned=${r.warned} reminded=${r.reminded} rematched=${r.rematched}`);
    }
  } catch (e) {
    console.error('[sweep]', e.message);
  }
}, cfg.SWEEP_INTERVAL_MS).unref();

module.exports = app;
