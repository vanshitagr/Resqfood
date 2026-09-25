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
// the process is frozen between requests. See DEPLOY.md.
//
// The requires below are wrapped because server/auth.js and server/database.js deliberately
// throw at import when a required production variable is missing. Uncaught, that surfaces as an
// opaque FUNCTION_INVOCATION_FAILED on every single route with nothing in the response to say
// why. Catching it lets the function answer with the name of the variable to set.
let app = null;
let db = null;
let bootError = null;

try {
  db = require('../server/db');
  app = require('../server/app');
} catch (err) {
  bootError = err;
  console.error('[vercel] startup failed:', err && err.message);
}

// db.init() is memoised inside server/db.js, so this is a no-op after the first call in a warm
// instance. It is awaited before the first request so the schema is guaranteed to exist.
let ready = null;

module.exports = async (req, res) => {
  if (bootError) {
    // Only messages this project raises itself are echoed back, and they name variables, never
    // values. Anything else stays generic so an unexpected stack trace cannot leak.
    const safe = bootError.code === 'CONFIG'
      ? bootError.message
      : 'The server failed to start. Check the deployment logs.';
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    return res.end(JSON.stringify({ error: safe, code: 'STARTUP_FAILED' }));
  }

  try {
    ready = ready || db.init();
    await ready;
  } catch (err) {
    // A failed connection must not take the whole function down: /api/health still needs to
    // answer so the UI can report "degraded". Anything touching the database surfaces its own
    // 500 through the normal error handler.
    ready = null; // let the next invocation retry rather than caching the failure forever
    console.error('[vercel] database init failed:', err.message);
  }
  return app(req, res);
};
