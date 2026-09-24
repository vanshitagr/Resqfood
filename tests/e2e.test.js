process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
delete process.env.DATABASE_URL; // tests always run on a throwaway in-memory SQLite
process.env.GEOCODE_ONLINE = '0';
process.env.JWT_SECRET = 'test-secret';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server/app');
const db = require('../server/db');

let server, base;
before(async () => {
  await db.init();
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Minimal client with its own cookie jar.
function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const sc = res.headers.get('set-cookie');
    if (sc && /(^|[;, ])token=/.test(sc)) {
      const pair = sc.split(/,(?=\s*\w+=)/).find((c) => c.trim().startsWith('token='));
      if (pair) cookie = /token=;|token=$/.test(pair.trim()) ? '' : pair.trim().split(';')[0];
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    cookie: () => cookie,
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
  };
}

async function rawGet(path, cookieHolder) {
  const res = await fetch(base + '/api' + path, { headers: cookieHolder ? { cookie: cookieHolder } : {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const JAIPUR = { lat: 26.9124, lng: 75.7873 };
const loadOf = async (org) =>
  (await db.get('SELECT current_load FROM recipients WHERE organization_name = ?', [org])).current_load;
const countUsers = async () => Number((await db.get('SELECT COUNT(*) AS n FROM users')).n);
const donationRow = (id) => db.get('SELECT * FROM donations WHERE id = ?', [id]);
const deliveryRow = (id) => db.get('SELECT * FROM deliveries WHERE id = ?', [id]);

async function register(role, name, extra = {}) {
  const c = client();
  const r = await c.post('/auth/register', {
    name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@test.dev`, password: 'password123', role,
    address: 'Jaipur', lat: JAIPUR.lat + (extra.dLat || 0), lng: JAIPUR.lng + (extra.dLng || 0), ...extra.body,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return c;
}

const donationBody = (over = {}) => ({
  foodType: 'Cooked Rice', category: 'cooked', quantity: 30, unit: 'meals',
  pickupAddress: 'Jaipur', pickupLat: JAIPUR.lat, pickupLng: JAIPUR.lng, expiryTime: inHours(4), ...over,
});

let donor, donor2, hope, tiny, veg, driver, driver2;

test('setup accounts', async () => {
  donor = await register('DONOR', 'Rasoi Restaurant');
  donor2 = await register('DONOR', 'Other Cafe');
  hope = await register('RECIPIENT', 'Hope Shelter', {
    dLat: 0.02, body: { organizationName: 'Hope Shelter', capacity: 60, currentNeed: 'HIGH', acceptedFoodTypes: ['cooked'] },
  });
  tiny = await register('RECIPIENT', 'Tiny Home', {
    dLat: 0.01, body: { organizationName: 'Tiny Home', capacity: 10, acceptedFoodTypes: [] },
  });
  veg = await register('RECIPIENT', 'Veg Only', {
    dLat: 0.005, body: { organizationName: 'Veg Only', capacity: 500, acceptedFoodTypes: ['produce'] },
  });
  driver = await register('DRIVER', 'Dev Driver', { dLat: 0.01 });
  driver2 = await register('DRIVER', 'Second Driver');
});

// ---------------------------------------------------------------- AUTH
test('auth: validation, duplicates, invalid login, session', async () => {
  const c = client();
  assert.equal((await c.get('/auth/me')).status, 401);
  assert.equal((await c.post('/auth/register', { name: 'x', email: 'bad', password: 'short', role: 'DONOR' })).status, 400);
  assert.equal((await c.post('/auth/register', { name: 'Admin Guy', email: 'a@b.co', password: 'password123', role: 'ADMIN', address: 'Jaipur' })).status, 400);
  assert.equal((await c.post('/auth/register', { name: 'No Org', email: 'no@org.co', password: 'password123', role: 'RECIPIENT', address: 'Jaipur' })).status, 400);

  const dup = await c.post('/auth/register', { name: 'Dup', email: 'RASOI.RESTAURANT@test.dev', password: 'password123', role: 'DONOR', address: 'Jaipur' });
  assert.equal(dup.status, 409);

  assert.equal((await c.post('/auth/login', { email: 'rasoi.restaurant@test.dev', password: 'wrong-password' })).status, 401);
  assert.equal((await c.post('/auth/login', { email: 'nobody@test.dev', password: 'password123' })).status, 401);

  const ok = await c.post('/auth/login', { email: 'rasoi.restaurant@test.dev', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.password_hash, undefined, 'password hash must never be serialised');
  assert.equal(ok.data.user.authProvider, 'password');
  assert.equal((await c.get('/auth/me')).data.user.role, 'DONOR');

  await c.post('/auth/logout');
  assert.equal((await c.get('/auth/me')).status, 401, 'protected route after logout');

  const row = await db.get('SELECT password_hash FROM users WHERE email = ?', ['rasoi.restaurant@test.dev']);
  assert.match(row.password_hash, /^\$2[aby]\$/, 'password stored as a bcrypt hash');
});

test('google sign-in is off unless configured, and never leaks secrets', async () => {
  const c = client();
  const cfgRes = await c.get('/auth/config');
  assert.equal(cfgRes.status, 200);
  assert.equal(cfgRes.data.google, false, 'reports disabled when env vars are absent');
  assert.equal((await c.get('/auth/google')).status, 503);
  assert.equal((await c.get('/auth/google/callback?code=x&state=y')).status, 503);
  assert.equal((await c.post('/auth/google/complete', { role: 'DONOR', address: 'Jaipur' })).status, 401);
  assert.equal((await c.get('/auth/google/pending')).status, 401);
  assert.equal(JSON.stringify(cfgRes.data).includes('secret'), false);
});

test('google id_token validation rejects forged tokens', async () => {
  const { verifyIdToken } = require('../server/routes/oauth');
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  const encode = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = (claims) => `h.${encode(claims)}.sig`;
  const good = { iss: 'https://accounts.google.com', aud: 'test-client-id', sub: '123', email: 'A@B.com', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 };

  assert.equal(verifyIdToken(tok(good)).email, 'a@b.com', 'email is normalised to lower case');
  assert.throws(() => verifyIdToken(tok({ ...good, iss: 'https://evil.example' })), /issuer/);
  assert.throws(() => verifyIdToken(tok({ ...good, aud: 'someone-elses-app' })), /audience/);
  assert.throws(() => verifyIdToken(tok({ ...good, exp: Math.floor(Date.now() / 1000) - 10 })), /expired/);
  assert.throws(() => verifyIdToken(tok({ ...good, sub: undefined })), /subject/);
  assert.throws(() => verifyIdToken('not-a-jwt'), /malformed/);
  delete process.env.GOOGLE_CLIENT_ID;
});

test('google oauth handshake: redirect, CSRF state, and account linking', async () => {
  process.env.GOOGLE_CLIENT_ID = 'test-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  try {
    const c = client();
    assert.equal((await c.get('/auth/config')).data.google, true);

    // Step 1: we must redirect to Google with the right parameters and set a state cookie.
    const start = await fetch(base + '/api/auth/google?role=RECIPIENT', { redirect: 'manual' });
    assert.equal(start.status, 302);
    const target = new URL(start.headers.get('location'));
    assert.equal(target.origin + target.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(target.searchParams.get('client_id'), 'test-client-id');
    assert.equal(target.searchParams.get('response_type'), 'code');
    assert.equal(target.searchParams.get('scope'), 'openid email profile');
    assert.match(target.searchParams.get('redirect_uri'), /\/api\/auth\/google\/callback$/);
    const stateNonce = target.searchParams.get('state');
    assert.ok(stateNonce && stateNonce.length >= 16);

    const setCookie = start.headers.get('set-cookie') || '';
    assert.match(setCookie, /oauth_state=/);
    assert.match(setCookie, /HttpOnly/i, 'state cookie must not be readable by scripts');
    // The client secret must never appear in anything sent to the browser.
    assert.equal(setCookie.includes('test-client-secret'), false);
    assert.equal(start.headers.get('location').includes('test-client-secret'), false);
    const stateCookie = setCookie.split(';')[0];

    // Step 2: CSRF protection - a callback without or with a mismatched state is refused.
    const noState = await fetch(base + '/api/auth/google/callback?code=abc&state=' + stateNonce, { redirect: 'manual' });
    assert.equal(noState.status, 302);
    assert.match(noState.headers.get('location'), /error=bad_state/);

    const wrongState = await fetch(base + '/api/auth/google/callback?code=abc&state=tampered', {
      headers: { cookie: stateCookie }, redirect: 'manual',
    });
    assert.match(wrongState.headers.get('location'), /error=bad_state/);

    const cancelled = await fetch(base + '/api/auth/google/callback?error=access_denied&state=' + stateNonce, {
      headers: { cookie: stateCookie }, redirect: 'manual',
    });
    assert.match(cancelled.headers.get('location'), /error=google_cancelled/);

    // Step 3: linking. An existing password account gains a google_id exactly once and no
    // duplicate row is created for the same verified email.
    const before = await countUsers();
    const target2 = await db.get('SELECT * FROM users WHERE email = ?', ['rasoi.restaurant@test.dev']);
    assert.equal(target2.google_id, null);
    await db.run('UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ? AND google_id IS NULL',
      ['google-sub-123', target2.id]);
    const linked = await db.get('SELECT * FROM users WHERE email = ?', ['rasoi.restaurant@test.dev']);
    assert.equal(linked.google_id, 'google-sub-123');
    assert.equal(linked.password_hash, target2.password_hash, 'linking keeps the existing password');
    assert.equal(await countUsers(), before, 'no duplicate account');
    assert.equal((await db.get('SELECT * FROM users WHERE google_id = ?', ['google-sub-123'])).id, target2.id);

    // google_id is unique, so two accounts can never share one Google identity.
    await assert.rejects(
      () => db.run("UPDATE users SET google_id = 'google-sub-123' WHERE email = 'other.cafe@test.dev'"),
      /unique/i
    );
    await db.run('UPDATE users SET google_id = NULL WHERE id = ?', [target2.id]);

    // A Google-only account (no password) cannot be logged into with a password.
    const t = new Date().toISOString();
    await db.run(
      "INSERT INTO users (name,email,password_hash,google_id,email_verified,role,address,lat,lng,created_at,updated_at) VALUES (?,?,NULL,?,1,'DONOR','Jaipur',26.9,75.8,?,?)",
      ['Google Only', 'google.only@test.dev', 'google-sub-999', t, t]
    );
    const attempt = await client().post('/auth/login', { email: 'google.only@test.dev', password: 'anything' });
    assert.equal(attempt.status, 401);
    assert.equal(attempt.data.error, 'Invalid email or password', 'must not reveal that the account is Google-only');
  } finally {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  }
});

// ---------------------------------------------------------------- DONATIONS
test('donation validation', async () => {
  const bad = async (over, status) => assert.equal((await donor.post('/donations', donationBody(over))).status, status, JSON.stringify(over));
  await bad({ quantity: 0 }, 400);
  await bad({ quantity: -5 }, 400);
  await bad({ quantity: 'abc' }, 400);
  await bad({ quantity: null }, 400);
  await bad({ foodType: '' }, 400);
  await bad({ foodType: undefined }, 400);
  await bad({ unit: 'bushels' }, 400);
  await bad({ category: 'poison' }, 400);
  await bad({ expiryTime: 'not a date' }, 400);
  await bad({ expiryTime: undefined }, 400);
  await bad({ expiryTime: inHours(-1) }, 422);
  await bad({ expiryTime: inHours(24 * 30) }, 400);
  await bad({ pickupLat: 999, pickupLng: 0 }, 400);
  await bad({ pickupAddress: '   ', pickupLat: undefined, pickupLng: undefined }, 400);
  assert.equal((await hope.post('/donations', donationBody())).status, 403, 'only donors may donate');
  assert.equal((await client().post('/donations', donationBody())).status, 401);
});

let donationId, deliveryId;

test('full flow: donate -> match -> accept -> driver -> deliver -> impact', async () => {
  const before = (await client().get('/stats/impact')).data;
  assert.equal(before.successfulDeliveries, 0);
  assert.equal(before.co2eKg, 0);

  const r = await donor.post('/donations', donationBody());
  assert.equal(r.status, 201, JSON.stringify(r.data));
  donationId = r.data.donation.id;
  assert.equal(r.data.donation.status, 'MATCHED');
  assert.ok(r.data.matching.matched);
  // Veg Only refuses cooked; Tiny Home has only 10 of 30 meals free -> Hope Shelter wins.
  assert.equal(r.data.donation.recipientName, 'Hope Shelter');
  assert.ok(r.data.donation.matchScore > 0 && r.data.donation.matchScore <= 100);
  assert.deepEqual(r.data.matching.candidates.map((c) => c.organizationName), ['Hope Shelter']);
  // Rejections are explained rather than silently dropped.
  const rejectedNames = r.data.matching.rejected.map((x) => x.organizationName);
  assert.ok(rejectedNames.includes('Veg Only') && rejectedNames.includes('Tiny Home'));
  assert.match(r.data.matching.rejected.find((x) => x.organizationName === 'Tiny Home').reason, /capacity/i);
  assert.match(r.data.matching.rejected.find((x) => x.organizationName === 'Veg Only').reason, /accept/i);

  const b = r.data.donation.matchBreakdown;
  assert.ok(Math.abs(Object.values(b).reduce((s, x) => s + x.points, 0) - r.data.donation.matchScore) < 0.3,
    'breakdown must add up to the headline score');

  assert.equal(await loadOf('Hope Shelter'), 30, 'capacity reserved on match');
  assert.equal((await donationRow(donationId)).meals, 30, 'stored in DB');
  assert.equal((await donor.get('/donations')).data.donations.length, 1);
  assert.equal((await driver.get('/deliveries')).data.deliveries.length, 0, 'no driver task before the NGO confirms');
  assert.equal((await hope.get('/donations')).data.donations[0].mine, true);

  const acc = await hope.post(`/donations/${donationId}/accept`);
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.equal(acc.data.donation.recipientAccepted, true);
  assert.equal((await hope.post(`/donations/${donationId}/accept`)).status, 409, 'duplicate accept');

  const dl = (await driver.get('/deliveries')).data.deliveries;
  assert.equal(dl.length, 1);
  deliveryId = dl[0].id;
  assert.equal(dl[0].status, 'PENDING');
  assert.ok(dl[0].distanceKm > 0);

  assert.equal((await driver.post(`/deliveries/${deliveryId}/pickup`)).status, 403, 'cannot pick up before accepting');
  assert.equal((await donor.post(`/deliveries/${deliveryId}/accept`)).status, 403, 'donors cannot accept deliveries');
  assert.equal((await hope.post(`/deliveries/${deliveryId}/accept`)).status, 403);

  assert.equal((await driver.post(`/deliveries/${deliveryId}/accept`)).status, 200);
  assert.equal((await donor.get(`/donations/${donationId}`)).data.donation.status, 'DRIVER_ASSIGNED');
  assert.equal((await driver.post(`/deliveries/${deliveryId}/accept`)).status, 409, 'duplicate accept');
  assert.equal((await driver2.post(`/deliveries/${deliveryId}/accept`)).status, 409, 'already taken');
  assert.equal((await driver2.post(`/deliveries/${deliveryId}/pickup`)).status, 403, 'other driver cannot advance it');
  assert.equal((await driver.post(`/deliveries/${deliveryId}/deliver`)).status, 409, 'cannot skip pickup');

  assert.equal((await driver.post(`/deliveries/${deliveryId}/pickup`)).status, 200);
  assert.equal((await driver.post(`/deliveries/${deliveryId}/pickup`)).status, 409, 'duplicate pickup');
  assert.equal((await donor.get(`/donations/${donationId}`)).data.donation.status, 'PICKED_UP');

  assert.equal((await driver.post(`/deliveries/${deliveryId}/deliver`)).status, 200);
  assert.equal((await driver.post(`/deliveries/${deliveryId}/deliver`)).status, 409, 'duplicate deliver');

  const final = (await donor.get(`/donations/${donationId}`)).data.donation;
  assert.equal(final.status, 'DELIVERED');
  assert.equal(final.driverName, 'Dev Driver');
  assert.ok(final.matchedAt && final.pickedUpAt && final.deliveredAt, 'lifecycle timestamps recorded');
  assert.equal(await loadOf('Hope Shelter'), 0, 'capacity released after delivery');

  const after = (await client().get('/stats/impact')).data;
  assert.equal(after.mealsRescued, 30);
  assert.equal(after.successfulDeliveries, 1);
  assert.equal(after.organizationsHelped, 1);
  assert.equal(after.activeDonations, 0);
  assert.equal(after.successfulMatches, 1);
  assert.ok(after.weightKg > 0);
  assert.equal(after.co2eKg, Math.round(after.weightKg * 2.5 * 10) / 10, 'CO2e is derived, not hardcoded');
  assert.equal(after.pickupSuccessRate, 100);
  assert.ok(after.avgMatchingSeconds !== null && after.avgDeliveryMinutes !== null);

  const n = (await donor.get('/notifications')).data;
  assert.ok(n.unread >= 3);
  assert.ok(n.notifications.some((x) => x.type === 'DELIVERED'));
  await donor.post('/notifications/read');
  assert.equal((await donor.get('/notifications')).data.unread, 0);
});

test('status history records the whole lifecycle', async () => {
  const { history } = (await donor.get(`/donations/${donationId}`)).data;
  const path = history.map((h) => h.to);
  assert.deepEqual(path, ['AVAILABLE', 'MATCHED', 'MATCHED', 'DRIVER_ASSIGNED', 'PICKED_UP', 'DELIVERED'],
    'posted, matched, recipient confirmed, driver assigned, picked up, delivered');
  assert.ok(history.every((h) => h.at && h.note), 'every event is timestamped and explained');
  assert.ok(history.some((h) => h.actorRole === 'DRIVER'), 'actor recorded');
  assert.equal((await donor.get(`/donations/${donationId}/history`)).status, 200);
  assert.equal((await donor2.get(`/donations/${donationId}/history`)).status, 403);
});

// ---------------------------------------------------------------- AUTHORIZATION
test('authorization: users cannot touch each other, bad IDs rejected', async () => {
  assert.equal((await donor2.get(`/donations/${donationId}`)).status, 403);
  assert.equal((await donor2.post(`/donations/${donationId}/match`, {})).status, 403);
  assert.equal((await donor2.post(`/donations/${donationId}/cancel`, {})).status, 403);
  assert.equal((await donor2.get(`/donations/${donationId}/candidates`)).status, 403);
  assert.equal((await driver2.get(`/donations/${donationId}`)).status, 403);
  assert.equal((await donor2.get(`/deliveries/${deliveryId}`)).status, 403);
  assert.equal((await tiny.get(`/deliveries/${deliveryId}`)).status, 403, 'other NGO cannot read this delivery');
  assert.equal((await driver2.patch(`/donations/${donationId}/status`, { status: 'DELIVERED' })).status, 403);
  assert.equal((await donor.patch(`/donations/${donationId}/status`, { status: 'DELIVERED' })).status, 403);

  assert.equal((await donor.get('/donations/999999')).status, 404);
  assert.equal((await donor.get('/donations/abc')).status, 400);
  assert.equal((await donor.get('/donations/1;DROP TABLE users')).status, 400);
  assert.equal((await donor.get("/donations/1' OR '1'='1")).status, 400);
  assert.equal((await donor.get('/donations/-1')).status, 400);
  assert.equal((await donor.get('/donations/1.5')).status, 400);
  assert.equal((await driver.get('/deliveries/0')).status, 400);
  assert.equal((await driver.post('/deliveries/999999/accept')).status, 404);

  // Role cannot be forged through the request body.
  assert.equal((await donor.put('/recipients/me', { capacity: 5 })).status, 403);
  assert.equal((await donor.get('/recipients/me')).status, 403);
  assert.equal((await driver.post('/donations', donationBody())).status, 403);
  assert.equal(await countUsers() > 0, true, 'injection attempts did not drop the table');
});

// ---------------------------------------------------------------- MATCHING
test('matching failure is explained, kept available and retried', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Big Batch', quantity: 5000 }));
  assert.equal(r.status, 201);
  assert.equal(r.data.donation.status, 'AVAILABLE', 'donation is never lost when nothing fits');
  assert.equal(r.data.matching.matched, false);
  assert.match(r.data.matching.failureReason, /capacity/i);
  assert.equal(r.data.donation.matchFailureReason, r.data.matching.failureReason);

  const id = r.data.donation.id;
  const claim = await hope.post(`/donations/${id}/accept`);
  assert.equal(claim.status, 422);
  assert.match(claim.data.error, /capacity/i);

  // The donor can retry on demand, and the reason is visible with the candidate list.
  const retry = await donor.post(`/donations/${id}/match`, {});
  assert.equal(retry.status, 200);
  assert.equal(retry.data.matching.matched, false);
  assert.ok(retry.data.matching.rejected.length >= 3);

  const cands = await donor.get(`/donations/${id}/candidates`);
  assert.equal(cands.data.candidates.length, 0);
  assert.ok(cands.data.rejected.every((x) => x.reason));
  assert.ok((await donor.get('/notifications')).data.notifications.some((x) => x.type === 'NO_MATCH'));

  // The background sweep re-runs matching for donations still inside their window.
  const svc = require('../server/service');
  assert.equal(typeof (await svc.retryUnmatched()), 'number');
  assert.equal((await donationRow(id)).status, 'AVAILABLE');
});

test('category preference: produce goes to the produce-only NGO', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Vegetables', category: 'produce', quantity: 20, unit: 'kg' }));
  assert.equal(r.status, 201);
  assert.equal(r.data.donation.meals, 50, '20 kg x 2.5 meals per kg');
  assert.equal(r.data.donation.recipientName, 'Veg Only');
});

test('an unavailable recipient is never matched', async () => {
  assert.equal((await veg.put('/recipients/me', { isAvailable: false, availabilityNote: 'Closed for renovation' })).status, 200);
  assert.equal((await veg.get('/recipients/me')).data.recipient.isAvailable, false);

  const r = await donor.post('/donations', donationBody({ foodType: 'More Vegetables', category: 'produce', quantity: 10, unit: 'kg' }));
  assert.equal(r.data.matching.matched, false, 'Veg Only is closed; nobody else accepts produce');
  const why = r.data.matching.rejected.find((x) => x.organizationName === 'Veg Only');
  assert.match(why.reason, /not accepting/i);

  // Re-opening makes it matchable again.
  assert.equal((await veg.put('/recipients/me', { isAvailable: true })).status, 200);
  const again = await donor.post(`/donations/${r.data.donation.id}/match`, {});
  assert.equal(again.data.matching.matched, true);
  assert.equal(again.data.donation.recipientName, 'Veg Only');
  assert.equal((await veg.post(`/donations/${r.data.donation.id}/decline`)).status, 200);
});

test('recipient decline triggers re-match; declined NGO cannot reclaim', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Dal', quantity: 8 }));
  const id = r.data.donation.id;
  const first = r.data.donation.recipientName;
  assert.ok(['Hope Shelter', 'Tiny Home'].includes(first), first);
  const decliner = first === 'Hope Shelter' ? hope : tiny;

  assert.equal((await veg.post(`/donations/${id}/decline`)).status, 403, 'not matched to them');
  assert.equal((await decliner.post(`/donations/${id}/decline`)).status, 200);
  assert.notEqual((await donor.get(`/donations/${id}`)).data.donation.recipientName, first);
  assert.equal((await decliner.post(`/donations/${id}/accept`)).status, 409, 'declined NGO cannot reclaim');

  assert.ok((await donor.get(`/donations/${id}/candidates`)).data.candidates.length >= 1);
  assert.equal((await donor.post(`/donations/${id}/match`, { recipientId: 99999 })).status, 422);
  assert.equal((await donor.post(`/donations/${id}/match`, { recipientId: 'x' })).status, 400);
  assert.equal((await donor.post(`/donations/${id}/match`, { recipientId: -1 })).status, 400);
});

// ---------------------------------------------------------------- EXPIRY SAFETY
test('expiry risk is classified and short-dated food is not routed', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Soon Gone', quantity: 5, expiryTime: inHours(0.3) }));
  assert.equal(r.status, 201);
  assert.equal(r.data.donation.expiryRisk, 'HIGH');
  // 18 minutes left is less than travel time + the 30 min handling buffer -> undeliverable.
  assert.equal(r.data.donation.status, 'AVAILABLE');
  assert.equal(r.data.matching.matched, false);
  assert.ok(r.data.matching.rejected.some((x) => /before the food expires/i.test(x.reason)));

  const medium = await donor.post('/donations', donationBody({ foodType: 'Medium Risk', quantity: 2, expiryTime: inHours(2) }));
  assert.equal(medium.data.donation.expiryRisk, 'MEDIUM');
  const low = await donor.post('/donations', donationBody({ foodType: 'Low Risk', quantity: 2, expiryTime: inHours(10) }));
  assert.equal(low.data.donation.expiryRisk, 'LOW');

  // Force expiry: the sweep must mark it EXPIRED and block every further action.
  const id = r.data.donation.id;
  await db.run('UPDATE donations SET expiry_time = ? WHERE id = ?', [inHours(-1), id]);
  const d = await donor.get(`/donations/${id}`);
  assert.equal(d.data.donation.status, 'EXPIRED');
  assert.equal(d.data.donation.expiryRisk, 'EXPIRED');
  assert.equal((await hope.post(`/donations/${id}/accept`)).status, 422);
  assert.equal((await donor.post(`/donations/${id}/match`, {})).status, 422);
  assert.equal((await donor.post(`/donations/${id}/cancel`, {})).status, 409, 'expired is terminal');
});

test('expiry after match releases capacity and cancels the delivery', async () => {
  const before = await loadOf('Hope Shelter');
  const r = await donor.post('/donations', donationBody({ foodType: 'Khichdi', quantity: 12 }));
  const id = r.data.donation.id;
  const ngo = r.data.donation.recipientName === 'Hope Shelter' ? hope : tiny;
  await ngo.post(`/donations/${id}/accept`);

  const dl = (await driver.get('/deliveries')).data.deliveries.find((x) => x.donationId === id);
  assert.ok(dl);
  await db.run('UPDATE donations SET expiry_time = ? WHERE id = ?', [inHours(-1), id]);

  assert.equal((await driver.post(`/deliveries/${dl.id}/accept`)).status, 422, 'expired food is never collected');
  assert.equal((await donor.get(`/donations/${id}`)).data.donation.status, 'EXPIRED');
  assert.equal(await loadOf('Hope Shelter'), before, 'reserved capacity returned');
  assert.equal((await deliveryRow(dl.id)).status, 'CANCELLED');
});

test('expiring-soon warnings are sent once', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Warn Me', quantity: 3 }));
  const id = r.data.donation.id;
  await db.run('UPDATE donations SET expiry_time = ? WHERE id = ?', [inHours(0.5), id]);

  const svc = require('../server/service');
  assert.ok((await svc.warnExpiring()) >= 1);
  assert.equal(await svc.warnExpiring(), 0, 'not warned twice');
  const notes = (await donor.get('/notifications')).data.notifications;
  assert.ok(notes.some((n) => n.type === 'EXPIRING' && n.donationId === id));
});

// ---------------------------------------------------------------- STATE MACHINE
test('invalid state transitions are rejected', async () => {
  const { canTransition, setStatus } = require('../server/status');
  assert.equal(canTransition('AVAILABLE', 'DELIVERED'), false, 'cannot go straight from posted to delivered');
  assert.equal(canTransition('AVAILABLE', 'PICKED_UP'), false);
  assert.equal(canTransition('MATCHED', 'DELIVERED'), false);
  assert.equal(canTransition('DELIVERED', 'AVAILABLE'), false, 'delivered is terminal');
  assert.equal(canTransition('EXPIRED', 'MATCHED'), false);
  assert.equal(canTransition('CANCELLED', 'MATCHED'), false);
  assert.equal(canTransition('AVAILABLE', 'MATCHED'), true);
  assert.equal(canTransition('DRIVER_ASSIGNED', 'PICKED_UP'), true);

  const { tx } = require('../server/lib');
  await assert.rejects(() => tx(() => setStatus(donationId, 'AVAILABLE')), /Cannot change a donation from DELIVERED/);
  assert.equal((await donationRow(donationId)).status, 'DELIVERED');
});

test('donor can cancel before pickup but not after', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Changed My Mind', quantity: 6 }));
  const id = r.data.donation.id;
  const org = r.data.donation.recipientName;
  const before = await loadOf(org);

  const c = await donor.post(`/donations/${id}/cancel`, { reason: 'Guests ate it after all' });
  assert.equal(c.status, 200);
  assert.equal(c.data.donation.status, 'CANCELLED');
  assert.equal(c.data.donation.cancelReason, 'Guests ate it after all');
  assert.equal(await loadOf(org), before - 6, 'capacity released on cancel');
  assert.equal((await donor.post(`/donations/${id}/cancel`, {})).status, 409, 'cannot cancel twice');

  // A donation already in transit cannot be cancelled.
  const r2 = await donor.post('/donations', donationBody({ foodType: 'In Transit', quantity: 4 }));
  const id2 = r2.data.donation.id;
  const ngo2 = r2.data.donation.recipientName === 'Hope Shelter' ? hope : tiny;
  await ngo2.post(`/donations/${id2}/accept`);
  const dl2 = (await driver.get('/deliveries')).data.deliveries.find((x) => x.donationId === id2);
  await driver.post(`/deliveries/${dl2.id}/accept`);
  await driver.post(`/deliveries/${dl2.id}/pickup`);
  assert.equal((await donor.post(`/donations/${id2}/cancel`, {})).status, 409);
  await driver.post(`/deliveries/${dl2.id}/deliver`);
});

test('driver can release an accepted task back to the pool', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Release Test', quantity: 5 }));
  const id = r.data.donation.id;
  const ngo = r.data.donation.recipientName === 'Hope Shelter' ? hope : tiny;
  await ngo.post(`/donations/${id}/accept`);
  const dl = (await driver.get('/deliveries')).data.deliveries.find((x) => x.donationId === id);

  await driver.post(`/deliveries/${dl.id}/accept`);
  assert.equal((await donor.get(`/donations/${id}`)).data.donation.status, 'DRIVER_ASSIGNED');
  assert.equal((await driver2.post(`/deliveries/${dl.id}/release`)).status, 403, 'only the assigned driver');
  assert.equal((await driver.post(`/deliveries/${dl.id}/release`)).status, 200);

  const back = (await donor.get(`/donations/${id}`)).data.donation;
  assert.equal(back.status, 'MATCHED');
  assert.equal(back.driverId, null);
  assert.equal((await driver2.post(`/deliveries/${dl.id}/accept`)).status, 200, 'another driver can take it');
  await driver2.post(`/deliveries/${dl.id}/pickup`);
  await driver2.post(`/deliveries/${dl.id}/deliver`);
});

// ---------------------------------------------------------------- RECIPIENT PROFILE
test('recipient profile update + validation', async () => {
  const ok = await hope.put('/recipients/me', { capacity: 80, currentNeed: 'LOW', acceptedFoodTypes: ['cooked', 'bakery'] });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.recipient.capacity, 80);
  assert.deepEqual(ok.data.recipient.acceptedFoodTypes, ['cooked', 'bakery']);
  assert.equal((await hope.put('/recipients/me', { capacity: 0 })).status, 400);
  assert.equal((await hope.put('/recipients/me', { capacity: 'lots' })).status, 400);
  assert.equal((await hope.put('/recipients/me', { currentNeed: 'EXTREME' })).status, 400);
  assert.equal((await hope.put('/recipients/me', { acceptedFoodTypes: ['rocks'] })).status, 400);
  assert.equal((await hope.put('/recipients/me', { acceptedFoodTypes: 'cooked' })).status, 400);
  assert.equal((await hope.put('/recipients/me', { isAvailable: 'yes' })).status, 400);
  assert.equal((await hope.get('/recipients')).status, 200);

  // Capacity cannot be dropped below meals already committed.
  const r = await donor.post('/donations', donationBody({ foodType: 'Commitment', quantity: 20 }));
  const org = r.data.donation.recipientName;
  if (org === 'Hope Shelter') {
    const res = await hope.put('/recipients/me', { capacity: 1 });
    assert.equal(res.status, 422);
    assert.match(res.data.error, /committed/i);
  }
  await donor.post(`/donations/${r.data.donation.id}/cancel`, {});
});

// ---------------------------------------------------------------- DASHBOARD
test('impact dashboard is computed from records and supports period filters', async () => {
  const all = (await client().get('/stats/impact')).data;
  assert.ok(all.mealsRescued > 0);

  // Every headline figure must be reproducible straight from the donations table.
  const truth = await db.get(
    "SELECT COALESCE(SUM(meals),0) AS m, COALESCE(SUM(weight_kg),0) AS kg, COUNT(*) AS n FROM donations WHERE status='DELIVERED'"
  );
  assert.equal(all.mealsRescued, Number(truth.m));
  assert.equal(all.successfulDeliveries, Number(truth.n));
  assert.equal(all.weightKg, Math.round(Number(truth.kg) * 10) / 10);
  assert.equal(all.co2eKg, Math.round(all.weightKg * 2.5 * 10) / 10);
  assert.equal(all.waterLitres, Math.round(all.weightKg * 1000));
  assert.ok(all.methodology.co2e.includes('2.5'), 'methodology states the factor in use');
  assert.ok(all.methodology.caveat.toLowerCase().includes('estimate'));

  for (const period of ['today', 'week', 'month', 'all']) {
    const r = await client().get('/stats/impact?period=' + period);
    assert.equal(r.status, 200);
    assert.equal(r.data.period, period);
  }
  assert.equal((await client().get('/stats/impact?period=../etc/passwd')).data.period, 'all', 'unknown period falls back');

  const donorStats = (await donor.get('/stats/me')).data;
  assert.ok(donorStats.total > 0 && donorStats.co2eKg >= 0);
  assert.equal((await hope.get('/stats/me')).data.capacity, 80);
  assert.ok((await driver.get('/stats/me')).data.completed >= 1);
});

test('CO2e factor is configurable rather than hardcoded', () => {
  delete require.cache[require.resolve('../server/config')];
  process.env.CO2E_KG_PER_KG_FOOD = '4';
  const reloaded = require('../server/config');
  assert.equal(reloaded.CO2E_KG_PER_KG_FOOD, 4);
  delete process.env.CO2E_KG_PER_KG_FOOD;
  delete require.cache[require.resolve('../server/config')];
  assert.equal(require('../server/config').CO2E_KG_PER_KG_FOOD, 2.5);
});


// ---------------------------------------------------------------- NEW: PRIVACY
test('privacy: exact locations and contacts only reach involved parties', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Privacy Test', quantity: 10 }));
  const id = r.data.donation.id;
  const matchedNgo = r.data.donation.recipientName === 'Hope Shelter' ? hope : tiny;
  const otherNgo = r.data.donation.recipientName === 'Hope Shelter' ? tiny : hope;

  // The donor owns it: full address and exact coordinates.
  const mine = (await donor.get('/donations/' + id)).data.donation;
  assert.equal(mine.approximateLocation, false);
  assert.equal(mine.pickupLat, JAIPUR.lat);

  // The matched organisation is involved, so it also gets full detail.
  assert.equal((await matchedNgo.get('/donations/' + id)).data.donation.approximateLocation, false);

  // An unrelated organisation may see an AVAILABLE donation but not its exact doorstep.
  const open = await donor.post('/donations', donationBody({ foodType: 'Open Listing', quantity: 5000 }));
  const openId = open.data.donation.id;
  const seen = (await otherNgo.get('/donations/' + openId)).data.donation;
  assert.equal(seen.approximateLocation, true, 'uninvolved viewers get a coarse location');
  assert.notEqual(seen.pickupLat, JAIPUR.lat);
  assert.ok(Math.abs(seen.pickupLat - JAIPUR.lat) < 0.02, 'still close enough to judge distance');
  assert.equal(seen.donorPhone, undefined, 'donor phone must not be exposed');
  assert.equal(seen.recipientPhone, undefined);

  // The directory never leaks contacts to a user with no dealings with those organisations.
  const stranger = await register('DRIVER', 'Uninvolved Driver');
  const dir = (await stranger.get('/recipients')).data.recipients;
  assert.ok(dir.length >= 3);
  for (const x of dir) {
    assert.equal(x.contactPhone, undefined, x.organizationName + ' phone must not be listed');
    assert.equal(x.contactName, undefined);
    assert.equal(x.approximateLocation, true);
  }

  // Own profile still returns everything.
  const own = (await hope.get('/recipients/me')).data.recipient;
  assert.equal(own.approximateLocation, false);
  assert.ok('contactPhone' in own, 'contact fields are released to the owner');

  await donor.post('/donations/' + id + '/cancel', {});
  await donor.post('/donations/' + openId + '/cancel', {});
});

test('privacy: drivers see an approximate pickup until they accept the task', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Driver Privacy', quantity: 6 }));
  const id = r.data.donation.id;
  const ngo = r.data.donation.recipientName === 'Hope Shelter' ? hope : tiny;
  await ngo.post('/donations/' + id + '/accept');

  const open = (await driver.get('/deliveries')).data.deliveries.find((x) => x.donationId === id);
  assert.equal(open.approximateLocation, true, 'open pool task is coarse');
  assert.ok(open.distanceFromYouKm >= 0, 'distance is still computed server-side from exact data');

  await driver.post('/deliveries/' + open.id + '/accept');
  const assigned = (await driver.get('/deliveries/' + open.id)).data.delivery;
  assert.equal(assigned.approximateLocation, false, 'exact address released once assigned');
  assert.equal(assigned.pickupLat, JAIPUR.lat);
  assert.equal((await driver2.get('/deliveries/' + open.id)).status, 403, 'other drivers lose access once taken');

  await driver.post('/deliveries/' + open.id + '/pickup');
  await driver.post('/deliveries/' + open.id + '/deliver');
});

// ------------------------------------------------- NEW: EXPIRY AT DELIVERY
test('expired food cannot be marked delivered, and the driver can report the problem', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Expires In Transit', quantity: 4 }));
  const id = r.data.donation.id;
  const ngo = r.data.donation.recipientName === 'Hope Shelter' ? hope : tiny;
  await ngo.post('/donations/' + id + '/accept');
  const dl = (await driver.get('/deliveries')).data.deliveries.find((x) => x.donationId === id);
  await driver.post('/deliveries/' + dl.id + '/accept');
  await driver.post('/deliveries/' + dl.id + '/pickup');

  // The food passes its usable time while the driver is on the road.
  await db.run('UPDATE donations SET expiry_time = ? WHERE id = ?', [inHours(-0.5), id]);

  const blocked = await driver.post('/deliveries/' + dl.id + '/deliver');
  assert.equal(blocked.status, 422, 'must not be recorded as a successful hand-over');
  assert.match(blocked.data.error, /usable time/i);
  assert.equal((await donationRow(id)).status, 'PICKED_UP',
    'not silently expired - the driver still physically has it');

  assert.equal((await driver.post('/deliveries/' + dl.id + '/fail', {})).status, 400, 'a reason is required');
  assert.equal((await driver2.post('/deliveries/' + dl.id + '/fail', { reason: 'not mine' })).status, 403);
  assert.equal((await driver.post('/deliveries/' + dl.id + '/fail', { reason: 'Expired during transit' })).status, 200);

  const after = await donationRow(id);
  assert.equal(after.status, 'CANCELLED');
  assert.match(after.cancel_reason, /Expired during transit/);
  assert.equal((await deliveryRow(dl.id)).status, 'CANCELLED');

  // Crucially it is never counted as rescued.
  const impact = (await client().get('/stats/impact')).data;
  const deliveredIds = (await db.all("SELECT id FROM donations WHERE status='DELIVERED'")).map((x) => x.id);
  assert.equal(deliveredIds.includes(id), false);
  assert.equal(impact.successfulDeliveries, deliveredIds.length);
});

// ------------------------------------------- NEW: EVENT-DRIVEN RE-MATCHING
test('matching is recalculated when capacity or availability changes', async () => {
  const cap = (await hope.get('/recipients/me')).data.recipient;
  await hope.put('/recipients/me', { capacity: cap.currentLoad + 1 });
  await tiny.put('/recipients/me', { isAvailable: false });
  await veg.put('/recipients/me', { isAvailable: false });

  const r = await donor.post('/donations', donationBody({ foodType: 'Waiting For Space', quantity: 40 }));
  const id = r.data.donation.id;
  assert.equal(r.data.matching.matched, false, 'nothing can take it yet');
  assert.ok(r.data.donation.matchFailureReason);

  // Raising capacity must re-match immediately, without waiting for the background sweep.
  const raised = await hope.put('/recipients/me', { capacity: cap.currentLoad + 500 });
  assert.equal(raised.status, 200);
  assert.ok(raised.data.rematched >= 1, 'the capacity change triggered a re-match');
  const after = (await donor.get('/donations/' + id)).data.donation;
  assert.equal(after.status, 'MATCHED');
  assert.equal(after.recipientName, 'Hope Shelter');

  await donor.post('/donations/' + id + '/cancel', {});
  await tiny.put('/recipients/me', { isAvailable: true });
  await veg.put('/recipients/me', { isAvailable: true });
  await hope.put('/recipients/me', { capacity: 80 });
});

test('a newly registered organisation picks up waiting donations', async () => {
  for (const c of [hope, tiny, veg]) await c.put('/recipients/me', { isAvailable: false });
  const r = await donor.post('/donations', donationBody({ foodType: 'Waiting For Anyone', quantity: 12 }));
  const id = r.data.donation.id;
  assert.equal(r.data.matching.matched, false);

  await register('RECIPIENT', 'Late Arrival', {
    dLat: 0.015, body: { organizationName: 'Late Arrival Shelter', capacity: 200, acceptedFoodTypes: [] },
  });

  const after = (await donor.get('/donations/' + id)).data.donation;
  assert.equal(after.status, 'MATCHED', 'matched without waiting for the sweep');
  assert.equal(after.recipientName, 'Late Arrival Shelter');
  const hist = (await donor.get('/donations/' + id + '/history')).data.history;
  assert.ok(hist.some((h) => /new organisation registered/i.test(h.note || '')), 'reason recorded in history');

  await donor.post('/donations/' + id + '/cancel', {});
  for (const c of [hope, tiny, veg]) await c.put('/recipients/me', { isAvailable: true });
});

// ----------------------------------------------- NEW: NOTIFICATION SYSTEM
test('notifications carry severity and record which channels were used', async () => {
  const chans = (await donor.get('/notifications/channels')).data.channels;
  assert.equal(chans.inApp, true, 'in-app is always the reliable base');
  assert.equal(chans.email, false, 'no provider configured in tests');
  assert.equal(chans.sms, false);
  assert.equal(JSON.stringify(chans).toLowerCase().includes('key'), false, 'no credentials leak');

  const notes = (await donor.get('/notifications')).data.notifications;
  assert.ok(notes.length > 0);
  assert.ok(notes.every((n) => ['INFO', 'URGENT'].includes(n.severity)));
  assert.ok(notes.every((n) => n.channels.includes('inApp')));

  // Time-critical events are escalated; routine ones stay in-app.
  const urgent = notes.filter((n) => n.severity === 'URGENT').map((n) => n.type);
  assert.ok(urgent.some((t) => ['NO_MATCH', 'EXPIRING', 'EXPIRED', 'PICKUP_SOON'].includes(t)));
  assert.equal(notes.filter((n) => n.type === 'MATCH').every((n) => n.severity === 'INFO'), true);
});

test('pickup reminders are sent once to the assigned driver', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Remind Me', quantity: 5 }));
  const id = r.data.donation.id;
  const ngo = r.data.donation.recipientName === 'Hope Shelter' ? hope : tiny;
  await ngo.post('/donations/' + id + '/accept');
  const dl = (await driver.get('/deliveries')).data.deliveries.find((x) => x.donationId === id);
  await driver.post('/deliveries/' + dl.id + '/accept');

  await db.run('UPDATE donations SET expiry_time = ? WHERE id = ?', [inHours(1), id]);
  const svc = require('../server/service');
  assert.ok((await svc.pickupReminders()) >= 1);
  assert.equal(await svc.pickupReminders(), 0, 'not reminded twice');

  const sent = await db.all("SELECT * FROM notifications WHERE type='PICKUP_SOON' AND donation_id=?", [id]);
  assert.ok(sent.length >= 2, 'driver and donor both told');
  assert.ok(sent.every((n) => n.severity === 'URGENT'));

  await driver.post('/deliveries/' + dl.id + '/pickup');
  await driver.post('/deliveries/' + dl.id + '/deliver');
});

// ------------------------------------------------------ NEW: TRUST / EXPORT
test('organisation verification status is visible but not self-assignable', async () => {
  await db.run("UPDATE recipients SET is_verified = 1, verified_at = ? WHERE organization_name = 'Hope Shelter'",
    [new Date().toISOString()]);

  const dir = (await donor.get('/recipients')).data.recipients;
  assert.equal(dir.find((x) => x.organizationName === 'Hope Shelter').isVerified, true);
  assert.ok(dir.some((x) => x.isVerified === false), 'unverified organisations are shown as such');

  // A recipient cannot mark itself verified through its own profile endpoint.
  await tiny.put('/recipients/me', { isVerified: true, verifiedAt: new Date().toISOString() });
  assert.equal((await db.get("SELECT is_verified FROM recipients WHERE organization_name='Tiny Home'")).is_verified, 0);
});

test('donation report exports real rows and is not labelled a tax document', async () => {
  const res = await rawGet('/donations/export.csv', donor.cookie());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="donation-report-donor-/);

  const lines = res.text.split('\r\n');
  assert.match(lines[0], /^donation_id,status,created_at/);
  const dataRows = lines.slice(1).filter((l) => /^"\d+","/.test(l));
  const mineCount = Number((await db.get(
    'SELECT COUNT(*) AS n FROM donations WHERE donor_id = (SELECT id FROM users WHERE email = ?)',
    ['rasoi.restaurant@test.dev']
  )).n);
  assert.equal(dataRows.length, mineCount, 'exports exactly this donor rows, no more');

  assert.match(res.text, /donation and impact REPORT, not an official tax document/i);
  assert.match(res.text, /CO2e avoided kg \(estimated\)/);
  assert.equal(/deduction|receipt for tax/i.test(res.text), false);

  const other = await rawGet('/donations/export.csv', donor2.cookie());
  assert.equal(other.text.includes('Rasoi Restaurant'), false, 'no cross-donor leakage');
  assert.equal((await rawGet('/donations/export.csv')).status, 401, 'export requires a session');
});

test('matching latency is measured and reported', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Latency Check', quantity: 3 }));
  assert.equal(typeof r.data.matching.elapsedMs, 'number');
  assert.ok(r.data.matching.elapsedMs >= 0 && r.data.matching.elapsedMs < 1000,
    'matching should be near-instant, took ' + r.data.matching.elapsedMs + ' ms');
  await donor.post('/donations/' + r.data.donation.id + '/cancel', {});
});

test('geography, not city names, decides matching', async () => {
  // A donor 240 km away must never be matched to the Jaipur shelters.
  const far = await register('DONOR', 'Far Away Cafe', { dLat: 2.2, dLng: 1.5 });
  const r = await far.post('/donations', {
    foodType: 'Distant Rice', category: 'cooked', quantity: 10, unit: 'meals',
    pickupAddress: 'Far City', pickupLat: JAIPUR.lat + 2.2, pickupLng: JAIPUR.lng + 1.5, expiryTime: inHours(6),
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.matching.matched, false, 'no shelter within range');

  // A recipient registering beside that donor picks it up immediately - purely on coordinates.
  await register('RECIPIENT', 'Far City Shelter', {
    dLat: 2.21, dLng: 1.51, body: { organizationName: 'Far City Shelter', capacity: 100, acceptedFoodTypes: [] },
  });
  const after = (await far.get('/donations/' + r.data.donation.id)).data.donation;
  assert.equal(after.status, 'MATCHED');
  assert.equal(after.recipientName, 'Far City Shelter');
});

// ---------------------------------------------------------------- AI + ERRORS
test('AI parse endpoint falls back to rules and validates', async () => {
  const r = await donor.post('/ai/parse-donation', {
    text: "We have around 25 boxes of cooked rice and dal left from today's event. Good for about 2 hours.",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.source, 'rules', 'no API key -> deterministic local parser, never an error');
  assert.equal(r.data.data.quantity, 25);
  assert.equal(r.data.data.unit, 'boxes');
  assert.equal(r.data.data.expiryMinutes, 120);
  assert.equal(r.data.data.urgency, 'HIGH');
  assert.equal(r.data.data.category, 'cooked');
  assert.equal((await donor.post('/ai/parse-donation', { text: '' })).status, 400);
  assert.equal((await donor.post('/ai/parse-donation', { text: 'x'.repeat(2000) })).status, 400);
  assert.equal((await hope.post('/ai/parse-donation', { text: 'hello there' })).status, 403);
});

test('malformed bodies, unknown routes and cross-origin writes give clean errors', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid JSON body');

  assert.equal((await client().get('/nope')).status, 404);

  const cross = await fetch(base + '/api/auth/logout', {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(cross.status, 403);

  const big = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200000) }),
  });
  assert.equal(big.status, 413);

  // Security headers are present and no stack traces leak.
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-powered-by'), null);
});
