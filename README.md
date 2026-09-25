# ResQFood (AmiHacks Track A)

Real-time food rescue routing: a donor posts surplus food → an explainable rule-based matching
engine picks the best nearby shelter → the NGO confirms → a volunteer driver picks up and
delivers → a live impact dashboard counts the result.

## Run it

```bash
npm install
npm start        # http://localhost:3000  - the schema is created and migrated automatically
```

There is no separate frontend build: the API server also serves the UI from `public/`.
There are no built-in accounts: open the app and **sign up** as a donor, a shelter/NGO or a driver
(email + password, or Google if configured).

```bash
npm test         # 41 backend tests (in-memory DB, no network needed)
npm run check    # syntax + module load check
npm run test:ui  # drives the real UI in headless Chrome against a running server
npm run db:check # verifies the configured database and reports what is in it
npm run db:info  # read-only: which database, row counts, registered accounts
```

Optional configuration lives in `.env` — see `.env.example`. Only `JWT_SECRET` is required, and
only in production. The app runs fully with no `.env` at all.

## Trying the whole flow

Open three windows (one normal, two private) and sign up once in each:
a **donor**, a **shelter / NGO** (set a capacity) and a **driver**. Use nearby locations, because
distance decides matching.

1. **Donor** → *Post surplus* → type *"We have around 25 boxes of cooked rice and dal left from
   today's event. Good for about 2 hours."* → **Auto-fill the form** → **Find match**.
   Show the match score, its four-part breakdown and the alternatives.
2. **NGO** → the match appears under *Awaiting your confirmation* → **Accept**.
3. **Driver** → the task appears → **Accept task** → open the map →
   **Mark picked up** → **Mark delivered**.
4. **Donor** → the donation page shows DELIVERED with the full lifecycle history.
5. **Impact** → meals, weight, CO2e and the operational metrics have all moved.

Worth showing too: expiry-risk chips, toggling *Currently accepting donations* off on the NGO
profile so the next donation fails to match **with reasons**, and **Cancel donation**.

## How matching works (`server/matching.js`)

**Hard filters** — a recipient is skipped if any fails, and the reason is returned:
food not expired · recipient available · within 40 km · accepts the food category ·
free capacity ≥ meals · reachable before expiry (travel + 30 min handling buffer).

**Score, 0–100** — Distance 30 (linear to 25 km) + Capacity 25 (headroom × need level) +
Food preference 20 (explicit 20 / accepts-all 12) + Urgency 25 (usable time left after travel).

Capacity is reserved atomically on match and released on decline, cancel, expiry or delivery.
If nothing fits, the donation stays posted, the donor is told why, and the engine retries every
minute until it expires. Weights and thresholds are env-configurable in `server/config.js`.

## Donation lifecycle

`AVAILABLE` (posted) → `MATCHED` → `DRIVER_ASSIGNED` → `PICKED_UP` → `DELIVERED`, with
`EXPIRED` and `CANCELLED` as alternative terminals. Transitions are enforced by a table in
`server/status.js` — illegal hops are rejected with 409 — and every change is appended to
`donation_events`, which is what the "Lifecycle history" panel shows.

## Stack

Express 5 · Node's built-in SQLite (`node:sqlite`) with versioned migrations · bcrypt + JWT in an
httpOnly cookie · optional Google OAuth · vanilla-JS SPA (no build step) · Leaflet/OpenStreetMap
with OSRM road routing (falls back to straight-line) · Nominatim geocoding (falls back to an
offline table).

`server/` API · `public/` UI · `tests/` tests.

## Security

Roles are re-read from the database on every request, never taken from the client. Every
donation and delivery route checks ownership server-side. IDs are strictly validated, all SQL is
parameterised, status changes are atomic compare-and-set, passwords are bcrypt-hashed, auth
endpoints are rate-limited, cross-origin writes are blocked, a tight CSP is set, and errors never
leak stack traces. Full detail in [TRACK_A_REQUIREMENTS_AUDIT.md](TRACK_A_REQUIREMENTS_AUDIT.md).

## Impact methodology

Meals and weight come from a documented unit-conversion table (1 kg = 2.5 meals, 1 tray = 20,
1 litre = 4, 1 box = 1). CO2e avoided is `rescued kg × 2.5`, configurable via
`CO2E_KG_PER_KG_FOOD`. Every figure is computed from delivered-donation rows — none are
hardcoded — and the dashboard shows a "How this is calculated" panel with an explicit caveat that
CO2e and water are estimates.

## Notifications

In-app notifications are the reliable base and always work. Email (Resend or SendGrid), SMS
(Twilio) and a generic push webhook are each optional, enabled purely by environment variables,
and fire-and-forget so a provider outage can never fail a request. Severity decides the mix:
routine updates stay in-app, while time-critical ones (no match found, pickup due, expiring
soon, expired) also go out by email and SMS. See [server/channels.js](server/channels.js).

## Privacy

Exact coordinates, street addresses and phone numbers are released only to the people actually
involved in a donation — its donor, the matched organisation and the assigned driver. Everyone
else sees an area name and a location rounded to about 1 km, which is enough to judge distance
and decide whether to claim a donation, but not enough to identify a doorstep. A driver browsing
the open task pool sees the approximate area; the exact address appears once they accept.

## Reports

Donors, shelters and drivers can download a CSV of their own records from their dashboard:
timestamps, quantities, outcome and estimated meals, weight and CO2e. It is labelled a donation
and impact report, **not** a tax document — for tax substantiation, ask the receiving
organisation for a receipt.

## Deploying

One service serves both the API and the UI. See [DEPLOY.md](DEPLOY.md) for Render, Docker and
the required environment variables, and [SUPABASE.md](SUPABASE.md) for the database.

Two things matter: set `DATABASE_URL` (hosts have ephemeral filesystems, so SQLite would be
wiped on every restart) and use Node 22+ (the app uses the built-in `node:sqlite` module).
Verify the database with `npm run db:check` before deploying.

## Known limitations

Google OAuth is implemented and tested but has not been run against live Google servers (needs
your own credentials — see the audit). Driver dispatch is claim-based rather than auto-assigned,
and driver location is the signup address, not live GPS. Notifications are polled every 10 s
in-app. Rate limiting is per-process. Expiry handling enforces the application's own time-window
rules; it does not replace real-world food-safety regulation.
