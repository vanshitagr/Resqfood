// Vercel serverless entry point.
//
// vercel.json rewrites every /api/* request here. The destination there must be the function
// ROUTE ("/api"), not the file path ("/api/index.js"): a destination carrying a .js extension
// does not resolve, and every API call comes back 404 while the static UI still loads - which
// looks like the backend is missing rather than misrouted.
//
// Vercel preserves the original request URL through a rewrite, so the Express app below still
// sees /api/auth/login and routes it exactly as it does locally. No business logic changes.
//
// Note: this is a serverless function. The background sweep registered in server/app.js
// (expiry warnings, pickup reminders, retrying unmatched donations) does NOT run here, because
// the process is frozen between requests. See DEPLOY.md for the cron endpoint that replaces it.
const db = require('../server/db');
const app = require('../server/app');

// db.init() is memoised inside server/db.js, so this is a no-op after the first call in a warm
// instance. It is awaited before the first request so the schema is guaranteed to exist.
let ready = null;

module.exports = async (req, res) => {
  try {
    ready = ready || db.init();
    await ready;
  } catch (err) {
    // A failed init must not take the whole function down: /api/health still needs to answer so
    // the UI can report "degraded" rather than hanging. Anything touching the database will
    // surface its own 500 through the normal error handler.
    ready = null; // let the next invocation retry rather than caching the failure forever
    console.error('[vercel] database init failed:', err.message);
  }
  return app(req, res);
};
