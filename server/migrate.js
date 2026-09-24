// Schema creation and forward-only migrations, for both engines.
//
// The DDL in schema.js always describes the LATEST schema and is written with
// CREATE TABLE IF NOT EXISTS, so:
//
//   * a brand-new database (either engine) is created at SCHEMA_VERSION and skips migrations;
//   * an existing SQLite file created before a migration existed still has the old tables,
//     so the numbered steps below bring it forward.
//
// Postgres only ever sees a fresh database here, so it needs no historical steps. If the
// schema changes again, add a step that handles both engines.
const { ddl, META_DDL, SCHEMA_VERSION } = require('./schema');

// ---------------------------------------------------------------- version I/O
async function readVersion(db) {
  if (db.dialect === 'sqlite') {
    return (await db.get('PRAGMA user_version')).user_version;
  }
  await db.exec(META_DDL);
  const row = await db.get('SELECT version FROM schema_meta WHERE id = 1');
  return row ? row.version : 0;
}

async function writeVersion(db, version) {
  if (db.dialect === 'sqlite') {
    await db.exec(`PRAGMA user_version = ${Number(version)}`);
    return;
  }
  await db.run(
    `INSERT INTO schema_meta (id, version) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version`,
    [version]
  );
}

// ------------------------------------------------------- SQLite-only history
const columns = (db, table) =>
  db.all(`PRAGMA table_info(${table})`).then((rows) => rows.map((c) => c.name));

async function addColumn(db, table, column, definition) {
  if (!(await columns(db, table)).includes(column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// v2: Google sign-in, recipient availability, lifecycle timestamps, the DRIVER_ASSIGNED and
//     CANCELLED statuses, and the donation_events history table.
async function v2(db) {
  await addColumn(db, 'recipients', 'is_available', 'INTEGER NOT NULL DEFAULT 1');
  await addColumn(db, 'recipients', 'availability_note', 'TEXT');
  for (const [col, def] of [
    ['match_failure_reason', 'TEXT'],
    ['expiry_warned', 'INTEGER NOT NULL DEFAULT 0'],
    ['matched_at', 'TEXT'],
    ['picked_up_at', 'TEXT'],
    ['cancelled_at', 'TEXT'],
    ['cancel_reason', 'TEXT'],
  ]) await addColumn(db, 'donations', col, def);

  // password_hash must become nullable and google_id must exist: needs a table rebuild.
  if (!(await columns(db, 'users')).includes('google_id')) {
    await db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT,
        google_id TEXT UNIQUE,
        email_verified INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL CHECK (role IN ('DONOR','RECIPIENT','DRIVER')),
        phone TEXT, address TEXT, lat REAL, lng REAL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK (password_hash IS NOT NULL OR google_id IS NOT NULL)
      );
      INSERT INTO users_new (id,name,email,password_hash,role,phone,address,lat,lng,created_at,updated_at)
        SELECT id,name,email,password_hash,role,phone,address,lat,lng,created_at,updated_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE INDEX IF NOT EXISTS idx_users_role_loc ON users(role, lat, lng);
    `);
  }

  // Widen the donation status CHECK constraint.
  const current = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='donations'");
  if (!current.sql.includes('DRIVER_ASSIGNED')) {
    await db.exec(`
      CREATE TABLE donations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        donor_id INTEGER NOT NULL REFERENCES users(id),
        food_type TEXT NOT NULL, category TEXT NOT NULL, description TEXT,
        quantity REAL NOT NULL CHECK (quantity > 0), unit TEXT NOT NULL,
        meals INTEGER NOT NULL, weight_kg REAL NOT NULL,
        pickup_address TEXT NOT NULL, pickup_lat REAL NOT NULL, pickup_lng REAL NOT NULL,
        expiry_time TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'AVAILABLE'
          CHECK (status IN ('AVAILABLE','MATCHED','DRIVER_ASSIGNED','PICKED_UP','DELIVERED','EXPIRED','CANCELLED')),
        matched_recipient_id INTEGER REFERENCES recipients(id),
        match_score REAL, match_breakdown TEXT, match_failure_reason TEXT,
        recipient_accepted INTEGER NOT NULL DEFAULT 0,
        declined_recipients TEXT NOT NULL DEFAULT '[]',
        driver_id INTEGER REFERENCES users(id),
        expiry_warned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        matched_at TEXT, picked_up_at TEXT, delivered_at TEXT, cancelled_at TEXT, cancel_reason TEXT
      );
      INSERT INTO donations_new SELECT
        id,donor_id,food_type,category,description,quantity,unit,meals,weight_kg,
        pickup_address,pickup_lat,pickup_lng,expiry_time,status,matched_recipient_id,
        match_score,match_breakdown,match_failure_reason,recipient_accepted,declined_recipients,
        driver_id,expiry_warned,created_at,updated_at,matched_at,picked_up_at,delivered_at,
        cancelled_at,cancel_reason
      FROM donations;
      DROP TABLE donations;
      ALTER TABLE donations_new RENAME TO donations;
      CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
      CREATE INDEX IF NOT EXISTS idx_donations_donor ON donations(donor_id);
      CREATE INDEX IF NOT EXISTS idx_donations_status_expiry ON donations(status, expiry_time);
      CREATE INDEX IF NOT EXISTS idx_donations_recipient ON donations(matched_recipient_id);
      CREATE INDEX IF NOT EXISTS idx_donations_driver ON donations(driver_id);
      CREATE INDEX IF NOT EXISTS idx_donations_delivered ON donations(status, delivered_at);
    `);
  }

  // Give pre-existing donations a history so the lifecycle panel is never blank.
  const missing = await db.all(
    'SELECT * FROM donations d WHERE NOT EXISTS (SELECT 1 FROM donation_events e WHERE e.donation_id = d.id)'
  );
  for (const d of missing) {
    await db.run(
      'INSERT INTO donation_events (donation_id, from_status, to_status, actor_role, note, created_at) VALUES (?,?,?,?,?,?)',
      [d.id, null, 'AVAILABLE', 'SYSTEM', 'Backfilled from existing record', d.created_at]
    );
    if (d.status !== 'AVAILABLE') {
      await db.run(
        'INSERT INTO donation_events (donation_id, from_status, to_status, actor_role, note, created_at) VALUES (?,?,?,?,?,?)',
        [d.id, 'AVAILABLE', d.status, 'SYSTEM', 'Backfilled from existing record', d.updated_at]
      );
    }
  }
}

// v3: organisation verification, pickup reminders, notification severity/channel audit trail
//     and the geographic index used for scoped re-matching.
async function v3(db) {
  await addColumn(db, 'recipients', 'is_verified', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'recipients', 'verified_at', 'TEXT');
  await addColumn(db, 'recipients', 'verification_note', 'TEXT');
  await addColumn(db, 'donations', 'pickup_reminder_sent', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'notifications', 'severity', "TEXT NOT NULL DEFAULT 'INFO'");
  await addColumn(db, 'notifications', 'channels', 'TEXT');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_donations_pickup_geo ON donations(status, pickup_lat, pickup_lng)');
}

const MIGRATIONS = [[2, v2], [3, v3]];

// ---------------------------------------------------------------------- run
module.exports = async function migrate(db) {
  // Did this database exist before we touched it?
  const existing = db.dialect === 'sqlite'
    ? await db.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='users'")
    : await db.get("SELECT 1 AS found FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'users'");
  const isNew = !existing;

  await db.exec(ddl(db.dialect));

  const current = await readVersion(db);
  if (isNew || current >= SCHEMA_VERSION) {
    if (current !== SCHEMA_VERSION) await writeVersion(db, SCHEMA_VERSION);
    console.log(`[db] ${db.describe} ready at schema v${SCHEMA_VERSION}`);
    return db;
  }

  const pending = MIGRATIONS.filter(([v]) => v > current);
  if (!pending.length) return db;

  // SQLite table rebuilds need foreign keys off, and the pragma cannot run inside a transaction.
  if (db.dialect === 'sqlite') await db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const [version, step] of pending) {
      await db.tx(async () => {
        await step(db);
        await writeVersion(db, version);
      });
      console.log(`[db] migrated to schema v${version}`);
    }
    if (db.dialect === 'sqlite') {
      const broken = await db.all('PRAGMA foreign_key_check');
      if (broken.length) throw new Error(`migration left ${broken.length} broken foreign key(s)`);
    }
  } finally {
    if (db.dialect === 'sqlite') await db.exec('PRAGMA foreign_keys = ON');
  }

  console.log(`[db] ${db.describe} ready at schema v${SCHEMA_VERSION}`);
  return db;
};

module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
