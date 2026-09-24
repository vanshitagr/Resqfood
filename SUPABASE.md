# Connecting this backend to Supabase

The app runs on **SQLite by default** and on **Postgres/Supabase when `DATABASE_URL` is set**.
Nothing else changes: same API, same schema, same tests. Switching is one environment variable.

## Your connection string

This repository is public, so the project reference is written as <PROJECT_REF> below.
Substitute your own (Supabase dashboard -> Connect) and keep the result in .env, which is
git-ignored and must never be committed.

## What the publishable key cannot do

The publishable key you sent (`sb_publishable_...`) **cannot connect to the database**. It is a
browser key for Supabase's REST API and is governed by Row Level Security — Supabase itself
rejected it for schema access ("Secret API key required"). A Node backend talks to Postgres
directly, which needs the **database password**.

I already worked out the rest of your connection string by probing your project:

```
postgresql://postgres.<PROJECT_REF>:[YOUR-DB-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
```

* project ref `<PROJECT_REF>` — from what you sent
* region **ap-southeast-1** — confirmed: the pooler accepted this tenant and then asked for a password
* the **session pooler** host, not `db.<PROJECT_REF>.supabase.co`, which resolves to
  IPv6 only (`2406:da18:...`) and is unreachable from most networks and hosting providers

### Getting the password

Supabase dashboard → **Project Settings → Database → Database password → Reset database password**.
It is shown once. If it contains `@ : / ? # %`, percent-encode it inside the URL
(`@` → `%40`, `#` → `%23`, and so on).

## Then run

```bash
echo 'DATABASE_URL=postgresql://postgres.<PROJECT_REF>:PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres' >> .env

npm run db:check   # connects, creates the schema, round-trips a row, rolls it back
npm run seed       # demo accounts, now written to Supabase
npm start          # start-up prints: Storage: Postgres (aws-0-ap-southeast-1...)
```

`npm run db:check` explains the exact cause of any failure (wrong region, wrong password,
IPv6-only host, unencoded special characters) rather than printing a raw driver error.

## What changed in the code

| File | Purpose |
|---|---|
| `server/database.js` | Driver abstraction. One async API over both engines; rewrites `?` placeholders to `$1, $2` for Postgres; transactions via `AsyncLocalStorage`. |
| `server/schema.js` | The schema for both dialects, differing only where the engines require it. |
| `server/migrate.js` | Creates the schema and runs migrations on either engine. |
| `scripts/check-db.js` | `npm run db:check` connectivity and diagnostics. |

The whole data layer became **async** (80 call sites). Application code never branches on the
engine — the three genuine differences are isolated in `db.sql.*`:

| Difference | SQLite | Postgres |
|---|---|---|
| Parameters | `?` | `$1, $2` (rewritten automatically) |
| New row id | `lastInsertRowid` | `RETURNING id` (via `db.insert()`) |
| Date arithmetic | `julianday()` | `EXTRACT(EPOCH FROM ...)` |
| Scalar max | `MAX(a, b)` | `GREATEST(a, b)` |
| Boolean sums | `SUM(status = 'X')` | rewritten as `SUM(CASE WHEN ... THEN 1 ELSE 0 END)`, valid on both |
| Schema version | `PRAGMA user_version` | `schema_meta` table |

A test (`tests/dialect.test.js`) fails the build if SQLite-only syntax reappears in application
code, so this cannot silently regress.

## Row Level Security

Supabase enables RLS on tables created through its dashboard. These tables are created by this
backend over a direct Postgres connection as the table owner, so RLS does not block it.

**Do not enable RLS and then expose the publishable key to the browser for these tables.**
Authorization in this app is enforced server-side (ownership checks on every donation and
delivery route, roles re-read from the database on each request). The browser never talks to
Supabase directly, and no Supabase key is sent to the frontend.

## Rolling back

Remove or comment out `DATABASE_URL` and restart — the app returns to the local SQLite file,
which is left untouched.
