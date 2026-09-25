// The shared database handle.
//
// Engine is chosen by environment: set DATABASE_URL and it talks to Postgres (Supabase),
// otherwise it uses the local SQLite file. The API is identical either way - see database.js.
//
// require('./db') gives the handle immediately, but it is not usable until init() has run.
// server/index.js, scripts/check-db.js and the test bootstrap all await init() before doing work.
const { createDatabase } = require('./database');

const db = createDatabase();

let ready = null;

/**
 * Creates the schema if needed and applies pending migrations. Safe to call more than once -
 * concurrent callers await the same promise.
 */
db.init = function init() {
  if (!ready) ready = require('./migrate')(db);
  return ready;
};

module.exports = db;
