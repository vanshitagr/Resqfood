process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.GEOCODE_ONLINE = '0';
process.env.JWT_SECRET = 'test-secret';
delete process.env.ANTHROPIC_API_KEY;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../server/app');
const db = require('../server/db');

let server, base;
before(async () => {
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
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].startsWith('token=;') || sc.includes('token=;') ? '' : sc.split(';')[0];
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const JAIPUR = { lat: 26.9124, lng: 75.7873 };

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

test('auth: validation, duplicates, invalid login, session', async () => {
  const c = client();
  assert.equal((await c.get('/auth/me')).status, 401);
  assert.equal((await c.post('/auth/register', { name: 'x', email: 'bad', password: 'short', role: 'DONOR' })).status, 400);
  assert.equal((await c.post('/auth/register', { name: 'Admin Guy', email: 'a@b.co', password: 'password123', role: 'ADMIN', address: 'Jaipur' })).status, 400);
  const dup = await c.post('/auth/register', { name: 'Dup', email: 'RASOI.RESTAURANT@test.dev', password: 'password123', role: 'DONOR', address: 'Jaipur' });
  assert.equal(dup.status, 409);
  assert.equal((await c.post('/auth/login', { email: 'rasoi.restaurant@test.dev', password: 'wrong-password' })).status, 401);
  assert.equal((await c.post('/auth/login', { email: 'nobody@test.dev', password: 'password123' })).status, 401);
  const ok = await c.post('/auth/login', { email: 'rasoi.restaurant@test.dev', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.password_hash, undefined);
  assert.equal((await c.get('/auth/me')).data.user.role, 'DONOR');
  await c.post('/auth/logout');
  assert.equal((await c.get('/auth/me')).status, 401);
  // password is stored hashed
  const row = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('rasoi.restaurant@test.dev');
  assert.match(row.password_hash, /^\$2[aby]\$/);
});

test('donation validation', async () => {
  const bad = async (over, status) => assert.equal((await donor.post('/donations', donationBody(over))).status, status, JSON.stringify(over));
  await bad({ quantity: 0 }, 400);
  await bad({ quantity: -5 }, 400);
  await bad({ quantity: 'abc' }, 400);
  await bad({ foodType: '' }, 400);
  await bad({ unit: 'bushels' }, 400);
  await bad({ category: 'poison' }, 400);
  await bad({ expiryTime: 'not a date' }, 400);
  await bad({ expiryTime: undefined }, 400);
  await bad({ expiryTime: inHours(-1) }, 422);
  await bad({ expiryTime: inHours(24 * 30) }, 400);
  await bad({ pickupLat: 999, pickupLng: 0 }, 400);
  // only donors may donate
  assert.equal((await hope.post('/donations', donationBody())).status, 403);
  assert.equal((await client().post('/donations', donationBody())).status, 401);
});

let donationId, deliveryId;

test('full flow: donate -> match -> accept -> driver -> deliver -> impact', async () => {
  const before = (await client().get('/stats/impact')).data;
  assert.equal(before.successfulDeliveries, 0);

  const r = await donor.post('/donations', donationBody());
  assert.equal(r.status, 201, JSON.stringify(r.data));
  donationId = r.data.donation.id;
  assert.equal(r.data.donation.status, 'MATCHED');
  assert.ok(r.data.matching.matched);
  // Veg Only refuses cooked food; Hope (60 free, cooked, HIGH need) vs Tiny (only 10 free < 30) -> Hope
  assert.equal(r.data.donation.recipientName, 'Hope Shelter');
  assert.ok(r.data.donation.matchScore > 0 && r.data.donation.matchScore <= 100);
  const names = r.data.matching.candidates.map((c) => c.organizationName);
  assert.deepEqual(names, ['Hope Shelter']);
  const b = r.data.donation.matchBreakdown;
  const sum = Object.values(b).reduce((s, x) => s + x.points, 0);
  assert.ok(Math.abs(sum - r.data.donation.matchScore) < 0.3);

  // capacity reserved
  assert.equal(db.prepare("SELECT current_load FROM recipients WHERE organization_name='Hope Shelter'").get().current_load, 30);

  // stored in DB
  const row = db.prepare('SELECT * FROM donations WHERE id = ?').get(donationId);
  assert.equal(row.meals, 30);

  // donor sees it in list
  const list = await donor.get('/donations');
  assert.equal(list.data.donations.length, 1);

  // recipient sees it and it is not yet driver-visible
  assert.equal((await driver.get('/deliveries')).data.deliveries.length, 0);
  const rl = await hope.get('/donations');
  assert.equal(rl.data.donations[0].mine, true);

  // recipient accepts
  const acc = await hope.post(`/donations/${donationId}/accept`);
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.equal(acc.data.donation.recipientAccepted, true);
  assert.equal((await hope.post(`/donations/${donationId}/accept`)).status, 409); // duplicate

  // driver sees task
  const dl = (await driver.get('/deliveries')).data.deliveries;
  assert.equal(dl.length, 1);
  deliveryId = dl[0].id;
  assert.equal(dl[0].status, 'PENDING');
  assert.ok(dl[0].distanceKm > 0);

  // can't pick up before accepting
  assert.equal((await driver.post(`/deliveries/${deliveryId}/pickup`)).status, 403);
  // only drivers accept
  assert.equal((await donor.post(`/deliveries/${deliveryId}/accept`)).status, 403);
  assert.equal((await hope.post(`/deliveries/${deliveryId}/accept`)).status, 403);

  assert.equal((await driver.post(`/deliveries/${deliveryId}/accept`)).status, 200);
  assert.equal((await driver.post(`/deliveries/${deliveryId}/accept`)).status, 409); // duplicate
  assert.equal((await driver2.post(`/deliveries/${deliveryId}/accept`)).status, 409); // taken
  // other driver cannot move it
  assert.equal((await driver2.post(`/deliveries/${deliveryId}/pickup`)).status, 403);
  assert.equal((await driver.post(`/deliveries/${deliveryId}/deliver`)).status, 409); // skip step

  assert.equal((await driver.post(`/deliveries/${deliveryId}/pickup`)).status, 200);
  assert.equal((await driver.post(`/deliveries/${deliveryId}/pickup`)).status, 409); // duplicate
  assert.equal((await donor.get(`/donations/${donationId}`)).data.donation.status, 'PICKED_UP');

  assert.equal((await driver.post(`/deliveries/${deliveryId}/deliver`)).status, 200);
  assert.equal((await driver.post(`/deliveries/${deliveryId}/deliver`)).status, 409);

  const final = (await donor.get(`/donations/${donationId}`)).data.donation;
  assert.equal(final.status, 'DELIVERED');
  assert.equal(final.driverName, 'Dev Driver');

  // capacity released after delivery
  assert.equal(db.prepare("SELECT current_load FROM recipients WHERE organization_name='Hope Shelter'").get().current_load, 0);

  const after = (await client().get('/stats/impact')).data;
  assert.equal(after.mealsRescued, 30);
  assert.equal(after.successfulDeliveries, 1);
  assert.equal(after.organizationsHelped, 1);
  assert.equal(after.activeDonations, 0);
  assert.ok(after.weightKg > 0);

  // notifications were generated for the donor
  const n = (await donor.get('/notifications')).data;
  assert.ok(n.unread >= 3);
  assert.ok(n.notifications.some((x) => x.type === 'DELIVERED'));
  await donor.post('/notifications/read');
  assert.equal((await donor.get('/notifications')).data.unread, 0);
});

test('authorization: donors cannot touch each other, bad IDs rejected', async () => {
  assert.equal((await donor2.get(`/donations/${donationId}`)).status, 403);
  assert.equal((await donor2.post(`/donations/${donationId}/match`, {})).status, 403);
  assert.equal((await donor2.get(`/donations/${donationId}/candidates`)).status, 403);
  assert.equal((await driver2.get(`/donations/${donationId}`)).status, 403);
  assert.equal((await donor2.get(`/deliveries/${deliveryId}`)).status, 403);
  assert.equal((await tiny.get(`/deliveries/${deliveryId}`)).status, 403);
  assert.equal((await driver2.patch(`/donations/${donationId}/status`, { status: 'DELIVERED' })).status, 403);
  assert.equal((await donor.patch(`/donations/${donationId}/status`, { status: 'DELIVERED' })).status, 403);
  assert.equal((await donor.get('/donations/999999')).status, 404);
  assert.equal((await donor.get('/donations/abc')).status, 400);
  assert.equal((await donor.get('/donations/1;DROP TABLE users')).status, 400);
  assert.equal((await donor.get('/donations/-1')).status, 400);
  assert.equal((await driver.get('/deliveries/0')).status, 400);
  assert.equal((await driver.post('/deliveries/999999/accept')).status, 404);
  // role cannot be forged through the body
  assert.equal((await donor.put('/recipients/me', { capacity: 5 })).status, 403);
  assert.equal((await donor.get('/recipients/me')).status, 403);
});

test('capacity exceeded: no eligible recipient leaves donation AVAILABLE', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Big Batch', quantity: 5000 }));
  assert.equal(r.status, 201);
  assert.equal(r.data.donation.status, 'AVAILABLE');
  assert.equal(r.data.matching.matched, false);
  const id = r.data.donation.id;
  // an NGO cannot claim it either
  const claim = await hope.post(`/donations/${id}/accept`);
  assert.equal(claim.status, 422);
  assert.match(claim.data.error, /capacity/i);
});

test('category preference: produce goes to the produce-only NGO', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Vegetables', category: 'produce', quantity: 20, unit: 'kg' }));
  assert.equal(r.status, 201);
  assert.equal(r.data.donation.meals, 50); // 20 kg * 2.5
  // Tiny (accepts all, 10 cap) too small; Hope refuses produce; Veg Only fits.
  assert.equal(r.data.donation.recipientName, 'Veg Only');
});

test('recipient decline triggers re-match; declined NGO cannot reclaim', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Dal', quantity: 8 }));
  const id = r.data.donation.id;
  const first = r.data.donation.recipientName;
  assert.ok(['Hope Shelter', 'Tiny Home'].includes(first), first);
  const decliner = first === 'Hope Shelter' ? hope : tiny;
  assert.equal((await veg.post(`/donations/${id}/decline`)).status, 403); // not matched to them
  const d = await decliner.post(`/donations/${id}/decline`);
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const after = (await donor.get(`/donations/${id}`)).data.donation;
  assert.notEqual(after.recipientName, first);
  assert.equal((await decliner.post(`/donations/${id}/accept`)).status, 409);
  // donor can manually pick a specific candidate
  const cands = (await donor.get(`/donations/${id}/candidates`)).data.candidates;
  assert.ok(cands.length >= 1);
  assert.equal((await donor.post(`/donations/${id}/match`, { recipientId: 99999 })).status, 422);
  assert.equal((await donor.post(`/donations/${id}/match`, { recipientId: 'x' })).status, 400);
});

test('expired food is never matched and is swept to EXPIRED', async () => {
  const r = await donor.post('/donations', donationBody({ foodType: 'Soon Gone', quantity: 5, expiryTime: inHours(0.3) }));
  assert.equal(r.status, 201);
  // 18 minutes left < travel + 30 min safety buffer -> unsafe, not matched
  assert.equal(r.data.donation.status, 'AVAILABLE');
  assert.equal(r.data.matching.matched, false);
  const id = r.data.donation.id;
  // force expiry
  db.prepare('UPDATE donations SET expiry_time = ? WHERE id = ?').run(inHours(-1), id);
  const d = await donor.get(`/donations/${id}`);
  assert.equal(d.data.donation.status, 'EXPIRED');
  assert.equal((await hope.post(`/donations/${id}/accept`)).status, 422);
  assert.equal((await donor.post(`/donations/${id}/match`, {})).status, 422);
});

test('expiry after match releases capacity and cancels the delivery', async () => {
  const before = db.prepare("SELECT current_load FROM recipients WHERE organization_name='Hope Shelter'").get().current_load;
  const r = await donor.post('/donations', donationBody({ foodType: 'Khichdi', quantity: 12 }));
  const id = r.data.donation.id;
  const rec = r.data.donation.recipientName;
  const ngo = rec === 'Hope Shelter' ? hope : tiny;
  await ngo.post(`/donations/${id}/accept`);
  const dl = (await driver.get('/deliveries')).data.deliveries.find((x) => x.donationId === id);
  assert.ok(dl);
  db.prepare('UPDATE donations SET expiry_time = ? WHERE id = ?').run(inHours(-1), id);
  const acc = await driver.post(`/deliveries/${dl.id}/accept`);
  assert.equal(acc.status, 422);
  assert.equal((await donor.get(`/donations/${id}`)).data.donation.status, 'EXPIRED');
  assert.equal(db.prepare("SELECT current_load FROM recipients WHERE organization_name='Hope Shelter'").get().current_load, before);
});

test('recipient profile update + validation', async () => {
  const ok = await hope.put('/recipients/me', { capacity: 80, currentNeed: 'LOW', acceptedFoodTypes: ['cooked', 'bakery'] });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.recipient.capacity, 80);
  assert.equal((await hope.put('/recipients/me', { capacity: 0 })).status, 400);
  assert.equal((await hope.put('/recipients/me', { currentNeed: 'EXTREME' })).status, 400);
  assert.equal((await hope.put('/recipients/me', { acceptedFoodTypes: ['rocks'] })).status, 400);
  assert.equal((await hope.get('/recipients')).status, 200);
});

test('AI parse endpoint falls back to rules and validates', async () => {
  const r = await donor.post('/ai/parse-donation', {
    text: "We have around 25 boxes of cooked rice and dal left from today's event. Good for about 2 hours.",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.source, 'rules');
  assert.equal(r.data.data.quantity, 25);
  assert.equal(r.data.data.unit, 'boxes');
  assert.equal(r.data.data.expiryMinutes, 120);
  assert.equal(r.data.data.urgency, 'HIGH');
  assert.equal(r.data.data.category, 'cooked');
  assert.equal((await donor.post('/ai/parse-donation', { text: '' })).status, 400);
  assert.equal((await hope.post('/ai/parse-donation', { text: 'hello there' })).status, 403);
});

test('malformed bodies and unknown routes give clean errors', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  assert.equal((await client().get('/nope')).status, 404);
  const cross = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(cross.status, 403);
});
