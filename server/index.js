const app = require('./app');
const db = require('./db');

const port = Number(process.env.PORT) || 3000;

// The schema must exist before the first request is served, so start-up waits for it.
db.init()
  .then(() => {
    app.listen(port, () => {
      console.log(`Surplus-to-Shelter running on http://localhost:${port}`);
      console.log(`Storage: ${db.describe}`);
    });
  })
  .catch((err) => {
    console.error('[startup] database initialisation failed:', err.message);
    if (process.env.DATABASE_URL) {
      console.error('[startup] check DATABASE_URL - host, password and that the pooler host is used for IPv4 networks.');
    }
    process.exit(1);
  });

const shutdown = async () => {
  try { await db.close(); } catch { /* already closing */ }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
