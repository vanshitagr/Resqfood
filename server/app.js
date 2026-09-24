const express = require('express');
const path = require('path');
const { HttpError } = require('./lib');
const svc = require('./service');
const misc = require('./routes/misc');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});
app.use(express.json({ limit: '50kb' }));

// Reject cross-site state changes and non-JSON bodies on the API.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) {
      return next(new HttpError(403, 'Cross-origin request blocked'));
    }
  }
  res.set('Cache-Control', 'no-store');
  next();
});

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
  console.error('[error]', err); // details stay in the server log
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Periodic expiry sweep (unref so it never keeps the process/tests alive).
setInterval(() => {
  try { svc.expireStale(); } catch (e) { console.error('[expire]', e.message); }
}, 60 * 1000).unref();

module.exports = app;
