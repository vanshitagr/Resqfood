const express = require('express');
const db = require('../db');
const cfg = require('../config');
const { HttpError, now, tx, parseId, str, CATEGORIES } = require('../lib');
const { authenticate, requireRole, rateLimit } = require('../auth');
const { resolveLocation, haversineKm } = require('../geo');
const { recipientOut, DELIVERY_SQL, deliveryById, deliveryOut, involvedWithRecipient } = require('../serialize');
const svc = require('../service');
const ops = require('../deliveryOps');
const { parseDonationText, parseDonationImage } = require('../ai');

// ---------------------------------------------------------------- recipients
const recipients = express.Router();
recipients.use(authenticate);

const RECIPIENT_SQL =
  'SELECT r.*, u.address, u.lat, u.lng, u.name AS contact_name, u.phone FROM recipients r JOIN users u ON u.id = r.user_id';

// Public directory: organisation, capacity, verification and an approximate area only.
// No contact details and no exact coordinates for organisations you are not working with.
recipients.get('/', async (req, res) => {
  const rows = await db.all(RECIPIENT_SQL);
  const list = [];
  for (const r of rows) {
    const full = r.user_id === req.user.id || (await involvedWithRecipient(req.user.id, r.id));
    list.push(recipientOut(r, full));
  }
  res.json({ recipients: list });
});

recipients.get('/me', requireRole('RECIPIENT'), async (req, res) => {
  const r = await db.get(RECIPIENT_SQL + ' WHERE r.user_id = ?', [req.user.id]);
  res.json({ recipient: recipientOut(r, true) });
});

recipients.put('/me', requireRole('RECIPIENT'), async (req, res) => {
  const b = req.body || {};
  const cur = await db.get(RECIPIENT_SQL + ' WHERE r.user_id = ?', [req.user.id]);

  const org = b.organizationName !== undefined
    ? str(b.organizationName, 'Organization name', { min: 2, max: 120 })
    : cur.organization_name;

  let capacity = cur.capacity;
  if (b.capacity !== undefined) {
    capacity = Number(b.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000) {
      throw new HttpError(400, 'Capacity must be a whole number of meals between 1 and 100000');
    }
    if (capacity < cur.current_load) {
      throw new HttpError(422, `Capacity cannot be below meals already committed (${cur.current_load})`);
    }
  }

  const need = b.currentNeed !== undefined ? b.currentNeed : cur.current_need;
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(need)) throw new HttpError(400, 'Invalid need level');

  let types = JSON.parse(cur.accepted_food_types);
  if (b.acceptedFoodTypes !== undefined) {
    types = b.acceptedFoodTypes;
    if (!Array.isArray(types) || !types.every((t) => CATEGORIES.includes(t))) {
      throw new HttpError(400, 'Invalid food type preference');
    }
  }

  let isAvailable = cur.is_available;
  if (b.isAvailable !== undefined) {
    if (typeof b.isAvailable !== 'boolean') throw new HttpError(400, 'isAvailable must be true or false');
    isAvailable = b.isAvailable ? 1 : 0;
  }
  const note = b.availabilityNote !== undefined
    ? str(b.availabilityNote, 'Availability note', { max: 200, required: false })
    : cur.availability_note;

  let loc = null;
  if (b.address !== undefined && b.address !== cur.address) {
    loc = await resolveLocation({ address: str(b.address, 'Location', { min: 2, max: 300 }), lat: b.lat, lng: b.lng });
  }

  // A change that could turn an earlier "no suitable recipient" into a match.
  const widened =
    capacity > cur.capacity ||
    (isAvailable && !cur.is_available) ||
    JSON.stringify([...new Set(types)].sort()) !== JSON.stringify(JSON.parse(cur.accepted_food_types).sort()) ||
    !!loc;

  await tx(async () => {
    await db.run(
      `UPDATE recipients SET organization_name = ?, capacity = ?, current_need = ?, accepted_food_types = ?,
         is_available = ?, availability_note = ? WHERE id = ?`,
      [org, capacity, need, JSON.stringify([...new Set(types)]), isAvailable, note, cur.id]
    );
    if (loc) {
      await db.run('UPDATE users SET address = ?, lat = ?, lng = ?, updated_at = ? WHERE id = ?',
        [b.address, loc.lat, loc.lng, now(), req.user.id]);
    }
  });

  const fresh = await db.get(RECIPIENT_SQL + ' WHERE r.id = ?', [cur.id]);
  let rematched = 0;
  if (widened) {
    rematched = await svc.rematchNear(fresh.lat, fresh.lng, 'a nearby organisation updated its capacity or availability');
  }
  res.json({ recipient: recipientOut(fresh, true), rematched });
});

recipients.get('/:id', async (req, res) => {
  const r = await db.get(RECIPIENT_SQL + ' WHERE r.id = ?', [parseId(req.params.id)]);
  if (!r) throw new HttpError(404, 'Recipient not found');
  const full = r.user_id === req.user.id || (await involvedWithRecipient(req.user.id, r.id));
  res.json({ recipient: recipientOut(r, full) });
});

// ---------------------------------------------------------------- deliveries
const deliveries = express.Router();
deliveries.use(authenticate);

deliveries.get('/', async (req, res) => {
  await svc.expireStale();
  const u = req.user;

  if (u.role === 'DRIVER') {
    const rows = await db.all(
      DELIVERY_SQL + " WHERE dl.status = 'PENDING' OR dl.driver_id = ? ORDER BY dl.created_at DESC",
      [u.id]
    );
    const list = rows.map((x) => {
      // Exact addresses only once this driver owns the task; open tasks show an area.
      const mine = x.driver_id === u.id;
      const out = deliveryOut(x, mine);
      out.mine = mine;
      if (u.lat != null && !out.mine) {
        out.distanceFromYouKm =
          Math.round(haversineKm({ lat: u.lat, lng: u.lng }, { lat: x.pickup_lat, lng: x.pickup_lng }) * 10) / 10;
      }
      return out;
    });
    list.sort((a, b) => (a.distanceFromYouKm ?? 0) - (b.distanceFromYouKm ?? 0));
    return res.json({ deliveries: list });
  }

  const rows = u.role === 'DONOR'
    ? await db.all(DELIVERY_SQL + ' WHERE d.donor_id = ? ORDER BY dl.created_at DESC', [u.id])
    : await db.all(DELIVERY_SQL + ' WHERE r.user_id = ? ORDER BY dl.created_at DESC', [u.id]);
  res.json({ deliveries: rows.map((x) => deliveryOut(x, true)) }); // their own donation or drop-off
});

deliveries.get('/:id', async (req, res) => {
  await svc.expireStale();
  const x = await deliveryById(parseId(req.params.id));
  if (!x) throw new HttpError(404, 'Delivery not found');
  const u = req.user;
  const ok =
    (u.role === 'DONOR' && x.donor_id === u.id) ||
    (u.role === 'RECIPIENT' && x.recipient_user_id === u.id) ||
    (u.role === 'DRIVER' && (x.driver_id === u.id || x.status === 'PENDING'));
  if (!ok) throw new HttpError(403, 'You are not allowed to view this delivery');

  // A driver browsing the open pool sees an approximate pickup area until they accept it.
  const full = u.role !== 'DRIVER' || x.driver_id === u.id;
  const out = deliveryOut(x, full);
  if (!x.driver_id) { out.driverLat = null; out.driverLng = null; }
  res.json({ delivery: out });
});

const driverAction = (fn) => async (req, res) => {
  const id = await fn(parseId(req.params.id), req.user);
  res.json({ delivery: deliveryOut(await deliveryById(id), true) });
};
deliveries.post('/:id/accept', requireRole('DRIVER'), driverAction(ops.acceptDelivery));
deliveries.post('/:id/release', requireRole('DRIVER'), driverAction(ops.dropDelivery));
deliveries.post('/:id/pickup', requireRole('DRIVER'), driverAction(ops.markPickedUp));
deliveries.post('/:id/deliver', requireRole('DRIVER'), driverAction(ops.markDelivered));
// The driver collected the food but could not hand it over (expired in transit, shelter closed).
deliveries.post('/:id/fail', requireRole('DRIVER'), async (req, res) => {
  const reason = str(req.body?.reason, 'Reason', { min: 3, max: 200 });
  const id = await ops.failDelivery(parseId(req.params.id), req.user, reason);
  res.json({ delivery: deliveryOut(await deliveryById(id), true) });
});

// -------------------------------------------------------------------- stats
const stats = express.Router();

const PERIODS = {
  today: () => new Date(new Date().setHours(0, 0, 0, 0)).toISOString(),
  week: () => new Date(Date.now() - 7 * 86400000).toISOString(),
  month: () => new Date(Date.now() - 30 * 86400000).toISOString(),
  all: () => '1970-01-01T00:00:00.000Z',
};

// Every figure below is derived from donation rows; nothing is hardcoded.
stats.get('/impact', async (req, res) => {
  await svc.expireStale();
  const period = Object.keys(PERIODS).includes(req.query.period) ? req.query.period : 'all';
  const since = PERIODS[period]();
  const one = (sql, params = []) => db.get(sql, params);

  const delivered = await one(
    `SELECT COALESCE(SUM(meals),0) AS meals, COALESCE(SUM(weight_kg),0) AS kg, COUNT(*) AS n,
            COUNT(DISTINCT matched_recipient_id) AS orgs
     FROM donations WHERE status = 'DELIVERED' AND delivered_at >= ?`, [since]);

  // CASE WHEN rather than SUM(boolean): SQLite yields 0/1 but Postgres yields a boolean,
  // which SUM() rejects. This form is correct on both engines.
  const created = await one(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired,
            SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN matched_at IS NOT NULL THEN 1 ELSE 0 END) AS matched,
            COUNT(DISTINCT donor_id) AS donors
     FROM donations WHERE created_at >= ?`, [since]);

  const active = (await one(
    "SELECT COUNT(*) AS n FROM donations WHERE status IN ('AVAILABLE','MATCHED','DRIVER_ASSIGNED','PICKED_UP')")).n;
  const unmatched = (await one(
    "SELECT COUNT(*) AS n FROM donations WHERE status = 'AVAILABLE' AND expiry_time > ?", [now()])).n;

  // Average durations in seconds, from the lifecycle timestamps (dialect-specific date math).
  const timing = await one(
    `SELECT AVG(${db.sql.epochDiff('matched_at', 'created_at')}) AS match_secs,
            AVG(CASE WHEN status = 'DELIVERED'
                     THEN ${db.sql.epochDiff('delivered_at', 'matched_at')} END) AS deliver_secs
     FROM donations WHERE matched_at IS NOT NULL AND created_at >= ?`, [since]);

  const daily = await db.all(
    `SELECT substr(delivered_at,1,10) AS day, SUM(meals) AS meals FROM donations
     WHERE status = 'DELIVERED' AND delivered_at >= ? GROUP BY substr(delivered_at,1,10) ORDER BY 1`,
    [new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10)]
  );

  const byCategory = await db.all(
    `SELECT category, SUM(meals) AS meals, SUM(weight_kg) AS kg FROM donations
     WHERE status = 'DELIVERED' AND delivered_at >= ? GROUP BY category ORDER BY 2 DESC`,
    [since]
  );

  const kg = Math.round(Number(delivered.kg) * 10) / 10;
  // Donations that reached a terminal outcome, used as the denominator for the success rate.
  // Postgres returns COUNT/SUM as strings for bigint/numeric, so normalise everything here.
  const num = (v) => (v == null ? 0 : Number(v));
  const concluded = num(delivered.n) + num(created.expired) + num(created.cancelled);
  const round1 = (x) => Math.round(x * 10) / 10;

  res.json({
    period,
    mealsRescued: num(delivered.meals),
    weightKg: kg,
    co2eKg: round1(kg * cfg.CO2E_KG_PER_KG_FOOD),
    waterLitres: Math.round(kg * cfg.WATER_L_PER_KG_FOOD),
    successfulDeliveries: num(delivered.n),
    organizationsHelped: num(delivered.orgs),
    totalDonations: num(created.total),
    activeDonations: num(active),
    unmatchedDonations: num(unmatched),
    expiredDonations: num(created.expired),
    cancelledDonations: num(created.cancelled),
    successfulMatches: num(created.matched),
    donorsParticipating: num(created.donors),
    pickupSuccessRate: concluded ? Math.round((num(delivered.n) / concluded) * 100) : null,
    avgMatchingSeconds: timing.match_secs != null ? Math.round(Number(timing.match_secs)) : null,
    avgDeliveryMinutes: timing.deliver_secs != null ? Math.round(Number(timing.deliver_secs) / 60) : null,
    daily: daily.map((d) => ({ day: d.day, meals: num(d.meals) })),
    byCategory: byCategory.map((c) => ({ category: c.category, meals: num(c.meals), kg: num(c.kg) })),
    methodology: {
      meals: `Quantity is converted to comparable meal portions: 1 kg = ${cfg.UNIT_MEALS.kg} meals, 1 tray = ${cfg.UNIT_MEALS.trays}, 1 litre = ${cfg.UNIT_MEALS.liters}, 1 box = ${cfg.UNIT_MEALS.boxes}. Only DELIVERED donations are counted.`,
      weight: `Weight uses the same table in reverse (1 meal ≈ ${cfg.UNIT_KG.meals} kg). Where the donor entered kilograms directly, that figure is used unchanged.`,
      co2e: `Estimated as rescued weight × ${cfg.CO2E_KG_PER_KG_FOOD} kg CO2e per kg. The factor covers emissions embodied in producing the food plus landfill methane avoided, and is configurable via CO2E_KG_PER_KG_FOOD.`,
      water: `Estimated as rescued weight × ${cfg.WATER_L_PER_KG_FOOD} litres per kg (mixed-diet average), configurable via WATER_L_PER_KG_FOOD.`,
      caveat: 'CO2e and water figures are order-of-magnitude estimates derived from average conversion factors, not measurements of these specific donations.',
    },
  });
});

stats.get('/me', authenticate, async (req, res) => {
  const u = req.user;
  const one = (sql, params = []) => db.get(sql, params);
  const num = (v) => (v == null ? 0 : Number(v));

  if (u.role === 'DONOR') {
    const s = await one(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN status IN ('AVAILABLE','MATCHED','DRIVER_ASSIGNED','PICKED_UP') THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) AS expired,
              SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
              COALESCE(SUM(CASE WHEN status = 'DELIVERED' THEN meals END),0) AS meals,
              COALESCE(SUM(CASE WHEN status = 'DELIVERED' THEN weight_kg END),0) AS kg
       FROM donations WHERE donor_id = ?`, [u.id]);
    const kg = Math.round(num(s.kg) * 10) / 10;
    return res.json({
      total: num(s.total), delivered: num(s.delivered), active: num(s.active),
      expired: num(s.expired), cancelled: num(s.cancelled),
      meals: num(s.meals), weightKg: kg, co2eKg: Math.round(kg * cfg.CO2E_KG_PER_KG_FOOD * 10) / 10,
    });
  }

  if (u.role === 'RECIPIENT') {
    const r = await one('SELECT * FROM recipients WHERE user_id = ?', [u.id]);
    const s = await one(
      `SELECT SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN status IN ('MATCHED','DRIVER_ASSIGNED','PICKED_UP') THEN 1 ELSE 0 END) AS incoming,
              COALESCE(SUM(CASE WHEN status = 'DELIVERED' THEN meals END),0) AS meals
       FROM donations WHERE matched_recipient_id = ?`, [r.id]);
    return res.json({
      delivered: num(s.delivered), incoming: num(s.incoming), mealsReceived: num(s.meals),
      capacity: r.capacity, committed: r.current_load, isAvailable: !!r.is_available,
    });
  }

  const s = await one(
    `SELECT SUM(CASE WHEN status = 'DELIVERED' THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status IN ('ASSIGNED','PICKED_UP') THEN 1 ELSE 0 END) AS active,
            COALESCE(SUM(CASE WHEN status = 'DELIVERED' THEN distance_km END),0) AS km
     FROM deliveries WHERE driver_id = ?`, [u.id]);
  res.json({ completed: num(s.done), active: num(s.active), distanceKm: Math.round(num(s.km) * 10) / 10 });
});

// ------------------------------------------------------------ notifications
const notifications = express.Router();
notifications.use(authenticate);

notifications.get('/', async (req, res) => {
  const rows = await db.all(
    `SELECT id, type, message, donation_id, severity, channels, is_read, created_at
     FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30`,
    [req.user.id]
  );
  const items = rows.map((n) => ({
    id: n.id, type: n.type, message: n.message, donationId: n.donation_id,
    severity: n.severity, channels: (n.channels || '').split(',').filter(Boolean),
    read: !!n.is_read, createdAt: n.created_at,
  }));
  const unread = (await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id])).n;
  res.json({ notifications: items, unread: Number(unread) });
});

// Which outbound channels this deployment has configured. No keys or addresses are returned.
notifications.get('/channels', (req, res) => {
  res.json({ channels: require('../channels').enabledChannels() });
});

notifications.post('/read', async (req, res) => {
  await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true });
});

// ----------------------------------------------------------------------- ai
const ai = express.Router();
ai.post('/parse-donation', authenticate, requireRole('DONOR'), rateLimit(20, 60 * 1000), async (req, res) => {
  const text = str(req.body?.text, 'Description', { min: 3, max: 1000 });
  res.json(await parseDonationText(text)); // never throws: falls back to the rule-based parser
});

ai.post('/parse-image', authenticate, requireRole('DONOR'), rateLimit(10, 60 * 1000), async (req, res) => {
  const { imageBase64, mimeType } = req.body;
  if (!imageBase64) throw new HttpError(400, 'Missing image');
  res.json(await parseDonationImage(imageBase64, mimeType));
});

module.exports = { recipients, deliveries, stats, notifications, ai };
