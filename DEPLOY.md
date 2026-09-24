# Deploying ResQFood

The app is a single Node process that serves both the API and the UI, so there is one service
to deploy — no separate frontend build or host.

## Before you deploy: two things that will bite

**1. Use Postgres, not SQLite.** Render, Railway, Fly and Vercel all have ephemeral
filesystems: the SQLite file is wiped on every restart and redeploy, silently losing every
donation. Set `DATABASE_URL` (see [SUPABASE.md](SUPABASE.md)) and confirm it works *before*
deploying:

```bash
npm run db:check
```

**2. Node 22 or newer is required.** `server/database.js` uses the built-in `node:sqlite`
module and the start command uses `--env-file-if-exists`; neither exists in Node 18 or 20.
`package.json` pins `engines.node >= 22.5.0`, and `render.yaml` sets `NODE_VERSION`. On any
other host, set the Node version explicitly.

## Required environment variables

| Variable | Notes |
|---|---|
| `NODE_ENV=production` | Enables secure cookies and HSTS, and makes a missing `JWT_SECRET` a hard start-up failure. |
| `JWT_SECRET` | **Mandatory.** The app refuses to start without it in production. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `DATABASE_URL` | Supabase session pooler string. Without it the app falls back to SQLite, which does not persist. |

Everything else is optional — see `.env.example`. Never commit `.env`; it is git-ignored and
excluded from the Docker image.

## Render (blueprint included)

```bash
git add -A && git commit -m "Add deployment configuration" && git push
```

Then Render → **New → Blueprint** → point at this repo. [render.yaml](render.yaml) sets the
Node version, health check and build/start commands, and generates `JWT_SECRET` for you.
Add `DATABASE_URL` in the dashboard (it is marked `sync: false`, so it is never stored in the
repo).

## Docker (Railway, Fly.io, or anywhere else)

```bash
docker build -t resqfood .
docker run --rm -p 3000:3000 \
  -e NODE_ENV=production \
  -e JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')" \
  -e DATABASE_URL="postgresql://..." \
  --init resqfood
```

`--init` gives the container a proper init process so `SIGTERM` reaches Node and the database
pool closes cleanly. Most platforms do this for you.

## Health check

`GET /api/health` returns `200` with `{"status":"ok","storage":"postgres"}` when the database
answers, and `503` otherwise. It is unauthenticated and deliberately exposes no configuration,
credentials or data. Point your platform's health check at it.

## After the first deploy

1. Seed the demo accounts (optional, but it makes the app demonstrable immediately):
   ```bash
   DATABASE_URL="postgresql://..." npm run seed
   ```
   This is idempotent — running it twice creates nothing extra.

2. If you use Google sign-in, add the production callback to the Google console **exactly**:
   `https://<your-domain>/api/auth/google/callback`, and set `GOOGLE_REDIRECT_URI` to the same
   string. A mismatch of even a trailing slash breaks the login.

3. Check `GET /api/health` reports `"storage":"postgres"`. If it says `sqlite`, `DATABASE_URL`
   did not reach the process and your data will not survive a restart.

## Known production limitations

These are fine for a hackathon and for judging, but are not production-grade:

- **Routing uses `router.project-osrm.org`**, a public demo server whose usage policy prohibits
  production use and which is rate-limited. The map degrades to a straight line and the stored
  haversine distance when it fails, so nothing breaks — but for real traffic, self-host OSRM or
  use a commercial routing API.
- **Geocoding uses Nominatim**, which has a strict usage policy (1 request/second). There is an
  offline city fallback, but real volume needs a paid geocoder.
- **Rate limiting is in-memory**, so it is per-instance. Running more than one instance needs a
  shared store such as Redis.
- **Notifications are polled** every 10 seconds by the browser rather than pushed.
