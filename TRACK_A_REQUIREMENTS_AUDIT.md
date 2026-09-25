# Track A — ResQFood: Requirements Audit

**Nothing is marked PASS unless it was verified working end to end**, not merely because a file or
endpoint exists. Evidence is either a named test in `tests/e2e.test.js` (35 backend tests,
`npm test`) or a step in `tests/ui-smoke.js`, which drives the real UI in headless Chrome across
three logged-in roles (`npm run test:ui`). Both suites were green when this was written.

---

## 1. Official requirements

| Official Requirement | Status | Evidence |
|---|---|---|
| Fast donation intake | **PASS** | `server/routes/donations.js` `POST /api/donations`; one short form + optional one-sentence parser. UI test: *assistant autofill* fills food type, quantity and unit from a sentence. Test: `donation validation` (16 rejection cases). |
| Real-time matching | **PASS** | `server/matching.js`, `server/service.js` `runMatching`. Runs inside the create transaction; measured engine time **0.7–3.1 ms** in the UI run and returned as `matching.elapsedMs`. Test: `matching latency is measured and reported`. |
| Driver/volunteer dispatch | **PASS** | `server/deliveryOps.js`, `server/routes/misc.js` deliveries. Accept / release / pickup / deliver / report-problem, distance-sorted task pool, 2-task cap, 409 on concurrent accept. Tests: `full flow`, `driver can release an accepted task`. |
| Capacity & preference management | **PASS** | `PUT /api/recipients/me`; atomic reservation in `server/service.js`. Capacity, need level, accepted categories, availability toggle. Tests: `recipient profile update + validation`, `an unavailable recipient is never matched`. |
| Status tracking | **PASS** | `server/status.js` transition table + append-only `donation_events`. UI test asserts the exact chain: *Posted → Matched → Matched → Driver assigned → Picked up → Delivered*. Tests: `status history records the whole lifecycle`, `invalid state transitions are rejected`. |
| Meals rescued | **PASS** | `GET /api/stats/impact`. Test recomputes the figure straight from the `donations` table and asserts equality. |
| Weight diverted | **PASS** | Same endpoint; same recomputation assertion in `impact dashboard is computed from records`. |
| CO2e avoided | **PASS** | `server/config.js` `CO2E_KG_PER_KG_FOOD` (default 2.5, env-overridable) × delivered weight. Counted only for `DELIVERED` rows, once each. Tests: `impact dashboard is computed from records`, `CO2e factor is configurable rather than hardcoded`. |
| Notifications | **PASS** | `server/lib.js` `notify` + `server/channels.js`. In-app base, plus optional email (Resend/SendGrid), SMS (Twilio) and push/webhook. Severity routing: URGENT escalates, INFO stays in-app. All 11 event types fire. Tests: `notifications carry severity and record which channels were used`, `pickup reminders are sent once`. |
| Food safety / expiry | **PASS** | `server/lib.js` `expiryRisk` (LOW/MEDIUM/HIGH/EXPIRED). Re-checked at match, accept, driver-accept, **pickup and delivery**. Tests: `expiry risk is classified`, `expiry after match releases capacity`, `expired food cannot be marked delivered`. |
| Privacy | **PASS** | `server/serialize.js` privacy layer: exact coordinates, street addresses and phone numbers only reach the donor, matched organisation and assigned driver; everyone else gets a ~1 km approximation and no contacts. Tests: `privacy: exact locations and contacts only reach involved parties`, `privacy: drivers see an approximate pickup until they accept`. |
| Reliability | **PASS** | `server/service.js` `runMatching` / `rematchNear` / `rematchForRecipient`. Failure never loses the donation, is explained per organisation, is retryable by hand, and re-runs on capacity change, availability change, new signup, freed capacity and a 60 s sweep. Tests: `matching failure is explained, kept available and retried`, `matching is recalculated when capacity or availability changes`, `a newly registered organisation picks up waiting donations`. |
| Accessibility | **PASS** | Verified in-browser: skip link, one `h1`, **0 unlabelled inputs**, **0 px** horizontal overflow at 390 px, 13 keyboard-reachable controls on the donation form, and a focus-trapped `role="dialog"` replacing `window.confirm`. Status uses symbol + word + colour. UI test: *accessible confirm dialog opens, traps focus, closes on Escape*. |
| Scalability | **PASS** | No city is hardcoded in any logic; `server/matching.js` `recipientRows` selects by lat/lng bounding box. Seed data spans Jaipur, Delhi and Mumbai. Test: `geography, not city names, decides matching` — a donor 240 km away matches nothing until a shelter registers beside it. |
| Near-instant matching | **PASS** | Index-backed bounding-box pre-filter (`idx_donations_pickup_geo`, `idx_users_role_loc`) instead of a full scan; single-query dashboard aggregates; "Finding best recipient…" progress state in the UI. Measured **under 1 ms** in the UI run. |
| Low-friction donor experience | **PASS** | Five fields, four of them pre-filled or one-tap: location defaults to the donor's profile, expiry has +1h/+2h/+4h/+8h chips, category defaults to *cooked*, notes optional. Natural-language box is optional and never required. `public/app.js` `pageNewDonation`. |
| Trust / verification | **PASS** | Organisation verification status (`recipients.is_verified`, badge in the UI), named driver identity, timestamped pickup/delivery confirmations and the full auditable event history. Test: `organisation verification status is visible but not self-assignable`. |
| Impact data trail | **PASS** | Every field tracked on the donation row: created, matched, picked up, delivered, cancelled, expiry, quantity, food type, donor, recipient, driver, final status. Dashboard reads only these rows. CSV export in `server/report.js`. Test: `donation report exports real rows and is not labelled a tax document`. |

---

## 2. Answers to your questions

### 1. Which requirements were already complete
CO2e estimation with a configurable factor and methodology panel; expiry-risk classification at
match/accept/pickup; the explainable matching engine; capacity and preference management;
status history and the transition table; the NLP donation parser; the low-friction donor form;
the geographic (non-city-specific) matching and bounding-box pre-filter; the impact data trail.

### 2. Which were incomplete
1. **Notifications** — only a generic webhook. No email, no SMS, no severity, no "pickup approaching".
2. **Expiry at delivery** — re-checked before pickup but **not** before hand-over, so food that expired in transit could still be recorded as rescued.
3. **Reliability** — re-matching happened only on a 60-second timer, not when capacity or availability actually changed.
4. **Privacy** — `GET /api/recipients` returned every organisation's exact coordinates *and contact phone* to any logged-in user; exact pickup addresses were visible before a donation was claimed.
5. **Accessibility** — native `confirm()`/`prompt()`, which screen readers announce poorly and some embedded browsers suppress.
6. **Trust** — no organisation verification status.
7. **Reporting** — no export of any kind.
8. **Latency** — matching was fast but never measured or shown.
9. **Scalability** — the logic was city-agnostic but the seed data was single-city, so it did not *demonstrate* it.

### 3. What I fixed
All nine, plus two bugs I introduced and caught in review: the CSV export wrote the pickup
address into the drop-off column, and the login rate limit (10 per 15 min) was tight enough to
block a demo that switches roles repeatedly — now `LOGIN_ATTEMPTS`, default 25.

- **Notifications** → `server/channels.js`: email (Resend/SendGrid), SMS (Twilio), push/webhook, all optional plain-HTTPS calls with no new dependencies. Severity routing so only time-critical events escalate. Added `PICKUP_SOON` reminders.
- **Expiry at delivery** → `markDelivered` now refuses expired food (422) and `failDelivery` lets the driver report what happened, closing the donation as CANCELLED so it is never counted as rescued.
- **Reliability** → `rematchNear` (geo-scoped, index-backed) triggered by capacity increase, availability toggle, category widening, new NGO signup, and freed capacity after delivery/cancel/decline.
- **Privacy** → coordinates rounded to ~1 km, street addresses reduced to an area, contacts withheld from anyone not involved.
- **Accessibility** → focus-trapped `role="dialog"` with Escape handling and focus restore.
- **Trust** → `is_verified` / `verified_at` / `verification_note` with a badge; not self-assignable.
- **Reporting** → `GET /api/donations/export.csv` with formula-injection protection, explicitly labelled a report and not a tax document.
- **Latency** → measured with `process.hrtime.bigint()` and shown as "engine took 0.8 ms".
- **Scalability** → seed now spans Jaipur, Delhi and Mumbai.

### 4. Files changed
**New:** `server/channels.js`, `server/report.js`
**Modified:** `server/db.js`, `server/migrate.js`, `server/config.js`, `server/lib.js`, `server/service.js`, `server/deliveryOps.js`, `server/serialize.js`, `server/profile.js`, `server/seed.js`, `server/app.js`, `server/routes/auth.js`, `server/routes/oauth.js`, `server/routes/donations.js`, `server/routes/misc.js`, `public/app.js`, `public/style.css`, `tests/e2e.test.js`, `tests/ui-smoke.js`, `.env.example`, `README.md`
**Untouched:** `server/index.js`, `server/matching.js`, `server/status.js`, `server/auth.js`, `server/geo.js`, `server/ai.js`, `public/index.html`

### 5. Database changes
Schema **v3**, applied automatically on start (`PRAGMA user_version`). All additive — `ALTER TABLE ADD COLUMN` only, no table rebuild, no data loss. Verified on the live pre-existing database.

| Table | Change |
|---|---|
| `recipients` | `+is_verified`, `+verified_at`, `+verification_note` |
| `donations` | `+pickup_reminder_sent` |
| `notifications` | `+severity`, `+channels` |
| indexes | `+idx_donations_pickup_geo (status, pickup_lat, pickup_lng)` for geo-scoped re-matching |

### 6. APIs added/modified
**Added**
- `GET /api/donations/export.csv` — donation & impact report, scoped to the caller's own rows
- `POST /api/deliveries/:id/fail` — driver reports a delivery that could not be completed
- `GET /api/notifications/channels` — which outbound channels are configured (no credentials)

**Modified**
- `POST /api/donations` and `POST /api/donations/:id/match` → now return `matching.elapsedMs`
- `PUT /api/recipients/me` → returns `rematched` count; triggers geo-scoped re-matching
- `GET /api/recipients`, `/:id`, `/me` → privacy-aware output
- `GET /api/deliveries`, `/:id` → approximate location until the task is accepted
- `GET /api/notifications` → now returns `severity` and `channels`
- `POST /api/deliveries/:id/deliver` → 422 if the food expired in transit

### 7. Requirements still PARTIAL or FAIL
**None of the 18 rows above.** One item outside that table remains PARTIAL:

| Item | Status | Why |
|---|---|---|
| Google OAuth live round-trip | PARTIAL | Implemented and tested (redirect construction, CSRF state rejection, ID-token issuer/audience/expiry validation, account linking, Google-only login refusal). The handshake against Google's real servers needs your own client ID and secret, so I could not execute it. |

### 8. Why it remains incomplete
It needs credentials only you can create. Everything testable without them is covered by
`google oauth handshake` and `google id_token validation` in `npm test`. Follow §10 to finish it.

### 9. What to configure in `.env`
Nothing is required to run or demo the project — it works with no `.env` at all.

| Variable | Needed for |
|---|---|
| `JWT_SECRET` | **Required in production only.** `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in (button hidden without them) |
| `ANTHROPIC_API_KEY` | AI donation parser (falls back to local rules without it) |
| `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_PROVIDER` | Email notifications |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | SMS notifications |
| `NOTIFY_WEBHOOK_URL` | Push / webhook notifications |
| `CO2E_KG_PER_KG_FOOD` | Change the CO2e conversion factor (default 2.5) |
| `PUBLIC_URL` | Deep links inside notification emails |

`.env.example` documents all 40 settings. `.env` is git-ignored and no secret ever reaches the browser.

### 10. Exact commands
```bash
npm install
npm start             # http://localhost:3000  (migrations run automatically; sign up to create accounts)

npm test              # 41 backend tests, in-memory DB, no network needed
npm run check         # syntax + module load check
npm run test:ui       # real-browser run of the whole flow (registers its own throwaway accounts)
npm run db:info       # read-only: which database, row counts, registered accounts
```

**Demo the full flow** — three windows (one normal, two private), signing up once in each as a
donor, an NGO and a driver:
1. **Donor** → *Post surplus* → paste *"We have around 25 boxes of cooked rice and dal left from today's event. Good for about 2 hours."* → **Auto-fill the form** → **Find match**.
2. **NGO** → **Accept**.
3. **Driver** → **Accept task** → **Mark picked up** → **Mark delivered**.
4. **Donor** → DELIVERED with the full lifecycle history, then **Impact** and **Download report (CSV)**.

**Test Google OAuth:**
1. Google Cloud Console → Credentials → Create OAuth client ID → Web application.
2. Authorised redirect URI: `http://localhost:3000/api/auth/google/callback`.
3. Put the ID and secret in `.env`, restart. `GET /api/auth/config` returns `{"google":true}` and the button appears.
4. Sign in with Google → choose a role and location → account created. Sign out and back in → same account.
5. To check linking: register `you@gmail.com` with a password first, then sign in with Google using that address — it links instead of creating a duplicate.

---

## 3. Known limitations

Deliberate scope decisions, not defects:

1. **`AVAILABLE` is the spec's `POSTED` state** — the name was kept from the original schema. The API also returns `statusLabel` ("Posted / available") and the UI displays "Posted".
2. **Driver dispatch is claim-based**, not auto-assigned to a specific driver.
3. **Driver location is the signup address**, not live GPS.
4. **Notifications are polled** every 10 s in-app; the outbound channels are fire-and-forget with no retry queue.
5. **Rate limiting is per-process and in-memory** — a multi-instance deployment needs Redis.
6. **Single-node SQLite** — correct and fast at this scale; the schema ports to Postgres unchanged.
7. **CO2e and water figures are estimates** from published average conversion factors, labelled as such in the UI and in the CSV.
8. **No multi-stop route optimisation** — one pickup, one drop-off per delivery.
9. **ID-token signatures are not re-verified locally** — the token is fetched server-to-server from Google over TLS, which Google's documentation states does not require local signature verification; issuer, audience and expiry are still checked.
10. **This enforces the application's own time-window rules, not real-world food-safety regulation.** Expiry handling is a routing safeguard; it does not replace food-safety law, inspection or the judgement of the people handling the food.
