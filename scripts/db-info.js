#!/usr/bin/env node
// READ-ONLY view of what is stored: which database this process talks to, how many rows each
// table holds, and who has registered. It never writes, and never prints password hashes,
// the connection string or any other credential.
//
//   npm run db:info
//
// With DATABASE_URL set (in .env or the environment) it inspects Postgres/Supabase; without it,
// the local SQLite file. The first line says which, so there is no guessing.
const db = require('../server/db');

const TABLES = ['users', 'recipients', 'donations', 'deliveries', 'donation_events', 'notifications'];
const pad = (v, n) => String(v).padEnd(n);

(async () => {
  try {
    await db.init();
    console.log(`\nDatabase : ${db.describe}`);
    console.log(`Engine   : ${db.dialect === 'postgres' ? 'PostgreSQL (DATABASE_URL is set)' : 'SQLite file (DATABASE_URL is not set)'}\n`);

    console.log('Rows per table');
    for (const t of TABLES) {
      const { n } = await db.get(`SELECT COUNT(*) AS n FROM ${t}`);
      console.log(`  ${pad(t, 17)}${String(n).padStart(6)}`);
    }

    const byRole = await db.all('SELECT role, COUNT(*) AS n FROM users GROUP BY role ORDER BY role');
    console.log('\nAccounts by role');
    if (!byRole.length) console.log('  none yet - the first person to sign up creates the first account');
    for (const r of byRole) console.log(`  ${pad(r.role, 11)}${r.n}`);

    const users = await db.all(
      `SELECT id, role, name, email, google_id IS NOT NULL AS google, created_at FROM users ORDER BY id DESC LIMIT 25`
    );
    if (users.length) {
      console.log('\nMost recent accounts (up to 25)');
      for (const u of users) {
        const how = u.google === true || u.google === 1 ? 'google' : 'password';
        console.log(`  #${pad(u.id, 4)}${pad(u.role, 11)}${pad(u.email, 34)}${pad(how, 10)}${String(u.created_at).slice(0, 10)}`);
      }
    }

    const status = await db.all('SELECT status, COUNT(*) AS n FROM donations GROUP BY status ORDER BY status');
    if (status.length) {
      console.log('\nDonations by status');
      for (const s of status) console.log(`  ${pad(s.status, 17)}${s.n}`);
    }
    console.log();
    await db.close();
  } catch (err) {
    console.error(`\nCould not read the database: ${err.message}\n`);
    process.exit(1);
  }
})();
