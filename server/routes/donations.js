const express = require('express');
const db = require('../db');
const { HttpError, now, tx, parseId, str, CATEGORIES, UNITS } = require('../lib');
const { authenticate, requireRole } = require('../auth');
const { resolveLocation } = require('../geo');
const { rankRecipients, scoreRecipient, toMeals, toKg } = require('../matching');
const svc = require('../service');
const ops = require('../deliveryOps');
const { DONATION_SQL, donationById, donationOut } = require('../serialize');

const router = express.Router();
router.use(authenticate);

const MAX_HORIZON_MS = 7 * 24 * 3600 * 1000;

function recipientOf(user) {
  const r = db
    .prepare('SELECT r.*, u.address, u.lat, u.lng FROM recipients r JOIN users u ON u.id = r.user_id WHERE r.user_id = ?')
    .get(user.id);
  if (!r) throw new HttpError(404, 'Recipient profile not found');
  return r;
}

// Existence -> 404, no permission -> 403.
function loadForUser(id, user) {
  const row = donationById(id);
  if (!row) throw new HttpError(404, 'Donation not found');
  let ok = false;
  if (user.role === 'DONOR') ok = row.donor_id === user.id;
  else if (user.role === 'RECIPIENT') ok = row.recipient_user_id === user.id || row.status === 'AVAILABLE';
  else ok = row.driver_id === user.id || row.delivery_status === 'PENDING';
  if (!ok) throw new HttpError(403, 'You are not allowed to view this donation');
  return row;
}

function ownedByDonor(id, user) {
  const row = donationById(id);
  if (!row) throw new HttpError(404, 'Donation not found');
  if (row.donor_id !== user.id) throw new HttpError(403, 'This is not your donation');
  return row;
}

function detailFor(id, user) {
  const row = donationById(id);
  const out = donationOut(row);
  // Contact details only for the parties actually involved.
  if (user.role === 'DRIVER' && row.driver_id === user.id) out.donorPhone = row.donor_phone;
  if (user.role === 'RECIPIENT' && row.recipient_user_id === user.id) out.donorPhone = row.donor_phone;
  if (user.role === 'DONOR') {
    out.driverPhone = row.driver_phone;
    out.recipientPhone = row.recipient_phone;
  }
  return out;
}

// ---- create ---------------------------------------------------------------
router.post('/', requireRole('DONOR'), async (req, res) => {
  const b = req.body || {};
  const foodType = str(b.foodType, 'Food type', { min: 2, max: 100 });
  const description = str(b.description, 'Description', { max: 500, required: false });
  const category = b.category === undefined || b.category === '' ? 'cooked' : b.category;
  if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Invalid food category');
  const quantity = Number(b.quantity);
  if (b.quantity === '' || b.quantity == null || !Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) {
    throw new HttpError(400, 'Quantity must be a number greater than 0');
  }
  if (!UNITS.includes(b.unit)) throw new HttpError(400, `Unit must be one of: ${UNITS.join(', ')}`);
  if (!b.expiryTime || typeof b.expiryTime !== 'string' || Number.isNaN(Date.parse(b.expiryTime))) {
    throw new HttpError(400, 'A valid "usable until" time is required');
  }
  const expiryMs = Date.parse(b.expiryTime);
  if (expiryMs <= Date.now()) throw new HttpError(422, 'Food has expired: "usable until" must be in the future');
  if (expiryMs - Date.now() > MAX_HORIZON_MS) throw new HttpError(400, '"Usable until" must be within 7 days');

  const address = str(b.pickupAddress || req.user.address, 'Pickup location', { min: 2, max: 300 });
  const useProfile = !b.pickupAddress && !b.pickupLat;
  const loc = useProfile && req.user.lat != null
    ? { lat: req.user.lat, lng: req.user.lng }
    : await resolveLocation({ address, lat: b.pickupLat, lng: b.pickupLng });

  const meals = toMeals(quantity, b.unit);
  const weight = toKg(quantity, b.unit);

  const result = tx(() => {
    const t = now();
    const ins = db
      .prepare(
        `INSERT INTO donations (donor_id, food_type, category, description, quantity, unit, meals, weight_kg,
           pickup_address, pickup_lat, pickup_lng, expiry_time, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'AVAILABLE', ?, ?)`
      )
      .run(req.user.id, foodType, category, description, quantity, b.unit, meals, weight,
        address, loc.lat, loc.lng, new Date(expiryMs).toISOString(), t, t);
    const id = Number(ins.lastInsertRowid);
    const donation = svc.getDonation(id);
    const candidates = rankRecipients(donation).slice(0, 5);
    const best = svc.autoMatch(id);
    return { id, candidates, best };
  });

  res.status(201).json({
    donation: detailFor(result.id, req.user),
    matching: { matched: !!result.best, best: result.best, candidates: result.candidates },
  });
});

// ---- list -----------------------------------------------------------------
router.get('/', (req, res) => {
  svc.expireStale();
  const u = req.user;
  let rows;
  if (u.role === 'DONOR') {
    rows = db.prepare(DONATION_SQL + ' WHERE d.donor_id = ? ORDER BY d.created_at DESC, d.id DESC').all(u.id);
    return res.json({ donations: rows.map(donationOut) });
  }
  if (u.role === 'RECIPIENT') {
    const rec = recipientOf(u);
    rows = db
      .prepare(DONATION_SQL + " WHERE d.status = 'AVAILABLE' OR d.matched_recipient_id = ? ORDER BY d.expiry_time ASC")
      .all(rec.id);
    const donations = rows
      .filter((r) => !(r.status === 'AVAILABLE' && svc.declinedOf(r).includes(rec.id)))
      .map((r) => {
        const out = donationOut(r);
        if (r.status === 'AVAILABLE') {
          const fit = scoreRecipient(r, rec);
          out.fit = { eligible: fit.eligible, reason: fit.reason || null, score: fit.score ?? null, distanceKm: fit.distanceKm };
        } else {
          out.mine = true;
        }
        return out;
      });
    return res.json({ donations });
  }
  rows = db.prepare(DONATION_SQL + ' WHERE d.driver_id = ? ORDER BY d.updated_at DESC').all(u.id);
  res.json({ donations: rows.map(donationOut) });
});

router.get('/:id', (req, res) => {
  svc.expireStale();
  const id = parseId(req.params.id);
  loadForUser(id, req.user);
  res.json({ donation: detailFor(id, req.user) });
});

// ---- matching -------------------------------------------------------------
router.get('/:id/candidates', requireRole('DONOR'), (req, res) => {
  const row = ownedByDonor(parseId(req.params.id), req.user);
  const donation = svc.getDonation(row.id);
  const exclude = svc.declinedOf(donation);
  res.json({ candidates: rankRecipients(donation, { exclude }).slice(0, 10) });
});

// Donor (re)selects a recipient, or lets the engine pick the best one.
router.post('/:id/match', requireRole('DONOR'), (req, res) => {
  const id = parseId(req.params.id);
  ownedByDonor(id, req.user);
  const wanted = req.body?.recipientId !== undefined ? parseId(req.body.recipientId, 'recipientId') : null;

  const out = tx(() => {
    const donation = svc.getDonation(id);
    if (donation.status === 'EXPIRED') throw new HttpError(422, 'Food has expired');
    if (!['AVAILABLE', 'MATCHED'].includes(donation.status) || donation.recipient_accepted) {
      throw new HttpError(409, donation.recipient_accepted
        ? 'The recipient already confirmed this donation'
        : `Donation is ${donation.status}`);
    }
    if (donation.status === 'MATCHED') svc.unassign(donation);
    const fresh = svc.getDonation(id);
    const ranked = rankRecipients(fresh, { exclude: svc.declinedOf(fresh) });
    const cand = wanted ? ranked.find((c) => c.recipientId === wanted) : ranked[0];
    if (wanted && !cand) throw new HttpError(422, 'That recipient cannot take this donation (capacity, food type, distance or time)');
    if (!cand || !svc.assign(fresh, cand)) return { matched: false, best: null };
    return { matched: true, best: cand };
  });
  res.json({ matching: out, donation: detailFor(id, req.user) });
});

router.post('/:id/accept', requireRole('RECIPIENT'), (req, res) => {
  svc.expireStale();
  const id = parseId(req.params.id);
  const rec = recipientOf(req.user);
  tx(() => {
    const donation = svc.getDonation(id);
    if (!donation) throw new HttpError(404, 'Donation not found');
    if (donation.status === 'EXPIRED') throw new HttpError(422, 'Food has expired');
    if (svc.declinedOf(donation).includes(rec.id)) throw new HttpError(409, 'You already declined this donation');
    svc.acceptDonation(donation, rec);
  });
  res.json({ donation: detailFor(id, req.user) });
});

router.post('/:id/decline', requireRole('RECIPIENT'), (req, res) => {
  const id = parseId(req.params.id);
  const rec = recipientOf(req.user);
  const result = tx(() => {
    const donation = svc.getDonation(id);
    if (!donation) throw new HttpError(404, 'Donation not found');
    if (donation.status !== 'MATCHED' || donation.matched_recipient_id !== rec.id) {
      throw new HttpError(403, 'This donation is not matched to you');
    }
    if (donation.recipient_accepted) throw new HttpError(409, 'Already accepted - it can no longer be declined');
    const declined = [...svc.declinedOf(donation), rec.id];
    svc.unassign(donation);
    db.prepare('UPDATE donations SET declined_recipients = ? WHERE id = ?').run(JSON.stringify(declined), id);
    const next = svc.autoMatch(id); // try the next best recipient
    return { rematched: !!next };
  });
  res.json({ ok: true, ...result });
});

// Drivers move a donation along via its delivery.
router.patch('/:id/status', requireRole('DRIVER'), (req, res) => {
  const id = parseId(req.params.id);
  const row = donationById(id);
  if (!row) throw new HttpError(404, 'Donation not found');
  if (!row.delivery_id) throw new HttpError(409, 'No delivery exists for this donation yet');
  const status = req.body?.status;
  if (status === 'PICKED_UP') ops.markPickedUp(row.delivery_id, req.user);
  else if (status === 'DELIVERED') ops.markDelivered(row.delivery_id, req.user);
  else throw new HttpError(400, 'Status must be PICKED_UP or DELIVERED');
  res.json({ donation: detailFor(id, req.user) });
});

module.exports = router;
