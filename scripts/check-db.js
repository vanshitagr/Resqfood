#!/usr/bin/env node
// Verifies the configured database before you rely on it: connects, reports the engine and
// version, applies the schema, counts the rows and writes/rolls back a probe row.
//
//   npm run db:check
//
// With no DATABASE_URL this checks the local SQLite file instead, so the same command works
// in both modes.
const db = require('../server/db');

const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m   ${m}`);
const info = (m) => console.log(`       ${m}`);

function diagnose(err) {
  const m = err.message || String(err);
  const hints = [
    // Checked before the generic ENOTFOUND rule: Supavisor reports a wrong region/tenant
    // with an ENOTFOUND code, which would otherwise be mistaken for a bad hostname.
    [/tenant or user not found/i,
      'Wrong pooler region or username. The username must be postgres.<PROJECT_REF>, and the\n' +
      '       host region must match the project (Supabase dashboard -> Connect -> Session pooler).'],
    [/password authentication failed|SASL|SCRAM/i,
      'Wrong password. Copy it from Supabase: Project Settings -> Database -> Reset database password.\n' +
      '       If it contains @ : / ? # or %, percent-encode it inside the URL.'],
    [/ENETUNREACH|EHOSTUNREACH/i,
      'Network unreachable. db.<ref>.supabase.co is IPv6-only - use the IPv4 pooler host instead:\n' +
      '       postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<REGION>.pooler.supabase.com:6543/postgres'],
    [/getaddrinfo|ENOTFOUND/i, 'Host not found. Check the hostname in DATABASE_URL.'],
    [/self[- ]signed|certificate/i, 'TLS problem. Leave DATABASE_SSL_STRICT unset to relax certificate checks.'],
    [/ETIMEDOUT|timeout/i, 'Connection timed out. A firewall or the wrong port (use 6543 for the pooler).'],
    [/does not exist/i, 'That database or role does not exist. Check the end of the URL is /postgres.'],
  ];
  for (const [re, hint] of hints) if (re.test(m)) return hint;
  return null;
}

(async () => {
  console.log(`\nChecking ${db.describe}\n`);
  try {
    await db.init();
    ok('connected and schema applied');

    if (db.dialect === 'postgres') {
      const v = await db.get('SELECT version() AS v');
      info(v.v.split(',')[0]);
      const who = await db.get('SELECT current_database() AS d, current_user AS u');
      info(`database "${who.d}" as "${who.u}"`);
    } else {
      info('local file - no server required');
    }

    const version = db.dialect === 'sqlite'
      ? (await db.get('PRAGMA user_version')).user_version
      : (await db.get('SELECT version FROM schema_meta WHERE id = 1')).version;
    ok(`schema version ${version}`);

    console.log('\n  Row counts');
    for (const t of ['users', 'recipients', 'donations', 'deliveries', 'donation_events', 'notifications']) {
      const { n } = await db.get(`SELECT COUNT(*) AS n FROM ${t}`);
      info(`${String(n).padStart(6)}  ${t}`);
    }

    // Round-trip a real row through a rolled-back transaction: proves writes work without
    // leaving anything behind.
    const probeEmail = `__probe_${Date.now()}@check.local`;
    await db.tx(async () => {
      const t = new Date().toISOString();
      const { id } = await db.insert(
        `INSERT INTO users (name, email, password_hash, role, address, lat, lng, created_at, updated_at)
         VALUES (?,?,?,'DONOR','probe',0,0,?,?)`,
        ['Connection probe', probeEmail, 'x', t, t]
      );
      if (!id) throw new Error('insert did not return an id');
      const back = await db.get('SELECT email FROM users WHERE id = ?', [id]);
      if (!back || back.email !== probeEmail) throw new Error('row did not read back');
      throw Object.assign(new Error('__rollback__'), { expected: true });
    }).catch((e) => { if (!e.expected) throw e; });

    const leftover = await db.get('SELECT 1 AS found FROM users WHERE email = ?', [probeEmail]);
    if (leftover) throw new Error('probe row survived rollback - transactions are not working');
    ok('insert, read-back and rollback all work');

    console.log('\nDatabase is ready.\n');
    await db.close();
  } catch (err) {
    console.error(`\n  \x1b[31mFAILED\x1b[0m  ${err.message}`);
    const hint = diagnose(err);
    if (hint) console.error(`\n  Likely cause:\n       ${hint}`);
    console.error();
    process.exit(1);
  }
})();
