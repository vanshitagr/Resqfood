const express = require('express');
const db = require('../db');
const { HttpError, now, tx, parseId, str, CATEGORIES } = require('../lib');
const { authenticate, requireRole, rateLimit } = require('../auth');
const { resolveLocation } = require('../geo');
const { recipientOut, DELIVERY_SQL, deliveryById, deliveryOut } = require('../serialize');
const { haversineKm } = require('../geo');
const svc = require('../service');
const ops = require('../deliveryOps');
const { parseDonationText } = require('../ai');

// ---------------------------------------------------------------- recipients
const recipients = express.Router();
recipients.use(authenticate);

const RECIPIENT_SQL =
  'SELECT r.*, u.address, u.lat, u.lng FROM recipients r JOIN users u ON u.id = r.user_id';

recipients.get('/', (req, res) => {
  res.json({ recipients: db.prepare(RECIPIENT_SQL).all().map(recipientOut) });
});

recipients.get('/me', requireRole('RECIPIENT'), (req, res) => {
  const r = db.prepare(RECIPIENT_SQL + ' WHERE r.user_id = ?').get(req.user.id);
  res.json({ recipient: recipientOut(r) });
});

recipients.put('/me', requireRole('RECIPIENT'), async (req, res) => {
  const b = req.body || {};
  const cur = db.prepare(RECIPIENT_SQL + ' WHERE r.user_id = ?').get(req.user.id);
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
  let loc = null;
  if (b.address !== undefined && b.address !== cur.address) {
    loc = await resolveLocation({ address: str(b.address, 'Location', { min: 2, max: 300 }), lat: b.lat, lng: b.lng });
  }
  tx(() => {
    db.prepare('UPDATE recipients SET organization_name=?, capacity=?, current_need=?, accepted_food_types=? WHERE id=?')
      .run(org, capacity, need, JSON.stringify([...new Set(types)]), cur.id);
    if (loc) {
      db.prepare('UPDATE users SET address=?, lat=?, lng=?, updated_at=? WHERE id=?')
        .run(b.address, loc.lat, loc.lng, now(), req.user.id);
    }
  });
  res.json({ recipient: recipientOut(db.prepare(RECIPIENT_SQL + ' WHERE r.id = ?').get(cur.id)) });
});

recipients.get('/:id', (req, res) => {
  const r = db.prepare(RECIPIENT_SQL + ' WHERE r.id = ?').get(parseId(req.params.id));
  if (!r) throw new HttpError(404, 'Recipient not found');
  res.json({ recipient: recipientOut(r) });
});

// ---------------------------------------------------------------- deliveries
const deliveries = express.Router();
deliveries.use(authenticate);

deliveries.get('/', (req, res) => {
  svc.expireStale();
  const u = req.user;
  let rows;
  if (u.role === 'DRIVER') {
    rows = db
      .prepare(DELIVERY_SQL + " WHERE (dl.status = 'PENDING') OR dl.driver_id = ? ORDER BY dl.created_at DESC")
      .all(u.id);
    const list = rows.map((x) => {
      const out = deliveryOut(x);
      out.mine = x.driver_id === u.id;
      if (u.lat != null && !out.mine) {
        out.distanceFromYouKm = Math.round(haversineKm({ lat: u.lat, lng: u.lng }, { lat: x.pickup_lat, lng: x.pickup_lng }) * 10) / 10;
      }
      return out;
    });
    list.sort((a, b) => (a.distanceFromYouKm ?? 0) - (b.distanceFromYouKm ?? 0));
    return res.json({ deliveries: list });
  }
  if (u.role === 'DONOR') {
    rows = db.prepare(DELIVERY_SQL + ' WHERE d.donor_id = ? ORDER BY dl.created_at DESC').all(u.id);
  } else {
    rows = db.prepare(DELIVERY_SQL + ' WHERE r.user_id = ? ORDER BY dl.created_at DESC').all(u.id);
  }
  res.json({ deliveries: rows.map(deliveryOut) });
});

deliveries.get('/:id', (req, res) => {
  svc.expireStale();
  const x = deliveryById(parseId(req.params.id));
  if (!x) throw new HttpError(404, 'Delivery not found');
  const u = req.user;
  const ok =
    (u.role === 'DONOR' && x.donor_id === u.id) ||
    (u.role === 'RECIPIENT' && x.recipient_user_id === u.id) ||
    (u.role === 'DRIVER' && (x.driver_id === u.id || x.status === 'PENDING'));
  if (!ok) throw new HttpError(403, 'You are not allowed to view this delivery');
  const out = deliveryOut(x);
  if (u.role !== 'DRIVER' || x.driver_id !== u.id) {
    // Only the assigned driver's live position is relevant to other parties once assigned.
    if (!x.driver_id) { out.driverLat = null; out.driverLng = null; }
  }
  res.json({ delivery: out });
});

const driverAction = (fn) => (req, res) => {
  const id = fn(parseId(req.params.id), req.user);
  res.json({ delivery: deliveryOut(deliveryById(id)) });
};
deliveries.post('/:id/accept', requireRole('DRIVER'), driverAction(ops.acceptDelivery));
deliveries.post('/:id/pickup', requireRole('DRIVER'), driverAction(ops.markPickedUp));
deliveries.post('/:id/deliver', requireRole('DRIVER'), driverAction(ops.markDelivered));

// -------------------------------------------------------------------- stats
const stats = express.Router();

stats.get('/impact', (req, res) => {
  svc.expireStale();
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const t = one(
    `SELECT COALESCE(SUM(meals),0) AS meals, COALESCE(SUM(weight_kg),0) AS kg, COUNT(*) AS n,
            COUNT(DISTINCT matched_recipient_id) AS orgs
     FROM donations WHERE status = 'DELIVERED'`
  );
  const active = one("SELECT COUNT(*) AS n FROM donations WHERE status IN ('AVAILABLE','MATCHED','PICKED_UP')").n;
  const expired = one("SELECT COUNT(*) AS n FROM donations WHERE status = 'EXPIRED'").n;
  const donors = one("SELECT COUNT(DISTINCT donor_id) AS n FROM donations").n;
  const daily = db
    .prepare(
      `SELECT substr(delivered_at,1,10) AS day, SUM(meals) AS meals FROM donations
       WHERE status='DELIVERED' AND delivered_at >= ? GROUP BY day ORDER BY day`
    )
    .all(new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10));
  const byCategory = db
    .prepare("SELECT category, SUM(meals) AS meals FROM donations WHERE status='DELIVERED' GROUP BY category ORDER BY meals DESC")
    .all();
  res.json({
    mealsRescued: t.meals,
    weightKg: Math.round(t.kg * 10) / 10,
    successfulDeliveries: t.n,
    organizationsHelped: t.orgs,
    activeDonations: active,
    expiredDonations: expired,
    donorsParticipating: donors,
    daily,
    byCategory,
  });
});

stats.get('/me', authenticate, (req, res) => {
  const u = req.user;
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  if (u.role === 'DONOR') {
    const s = one(
      `SELECT COUNT(*) AS total,
              SUM(status='DELIVERED') AS delivered,
              SUM(status IN ('AVAILABLE','MATCHED','PICKED_UP')) AS active,
              SUM(status='EXPIRED') AS expired,
              COALESCE(SUM(CASE WHEN status='DELIVERED' THEN meals END),0) AS meals,
              COALESCE(SUM(CASE WHEN status='DELIVERED' THEN weight_kg END),0) AS kg
       FROM donations WHERE donor_id = ?`, u.id);
    return res.json({ total: s.total, delivered: s.delivered || 0, active: s.active || 0, expired: s.expired || 0, meals: s.meals, weightKg: Math.round(s.kg * 10) / 10 });
  }
  if (u.role === 'RECIPIENT') {
    const r = one('SELECT * FROM recipients WHERE user_id = ?', u.id);
    const s = one(
      `SELECT SUM(status='DELIVERED') AS delivered, SUM(status IN ('MATCHED','PICKED_UP')) AS incoming,
              COALESCE(SUM(CASE WHEN status='DELIVERED' THEN meals END),0) AS meals
       FROM donations WHERE matched_recipient_id = ?`, r.id);
    return res.json({ delivered: s.delivered || 0, incoming: s.incoming || 0, mealsReceived: s.meals, capacity: r.capacity, committed: r.current_load });
  }
  const s = one(
    `SELECT SUM(status='DELIVERED') AS done, SUM(status IN ('ASSIGNED','PICKED_UP')) AS active,
            COALESCE(SUM(CASE WHEN status='DELIVERED' THEN distance_km END),0) AS km
     FROM deliveries WHERE driver_id = ?`, u.id);
  res.json({ completed: s.done || 0, active: s.active || 0, distanceKm: Math.round(s.km * 10) / 10 });
});

// ------------------------------------------------------------ notifications
const notifications = express.Router();
notifications.use(authenticate);

notifications.get('/', (req, res) => {
  const items = db
    .prepare('SELECT id, type, message, donation_id, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30')
    .all(req.user.id)
    .map((n) => ({ id: n.id, type: n.type, message: n.message, donationId: n.donation_id, read: !!n.is_read, createdAt: n.created_at }));
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id).n;
  res.json({ notifications: items, unread });
});

notifications.post('/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ----------------------------------------------------------------------- ai
const ai = express.Router();
ai.post('/parse-donation', authenticate, requireRole('DONOR'), rateLimit(20, 60 * 1000), async (req, res) => {
  const text = str(req.body?.text, 'Description', { min: 3, max: 1000 });
  res.json(await parseDonationText(text)); // never throws: falls back to the rule-based parser
});

module.exports = { recipients, deliveries, stats, notifications, ai };
