const express = require('express');
const db = require('../db');
const cfg = require('../config');
const { HttpError, now, tx, parseId, str, notify, expiryRisk, CATEGORIES, UNITS } = require('../lib');
const { authenticate, requireRole } = require('../auth');
const { resolveLocation } = require('../geo');
const { evaluateRecipients, scoreRecipient, toMeals, toKg } = require('../matching');
const { history } = require('../status');
const svc = require('../service');
const ops = require('../deliveryOps');
const { DONATION_SQL, donationById, donationOut } = require('../serialize');
const { exportCsv } = require('../report');

const router = express.Router();
router.use(authenticate);

async function recipientOf(user) {
  const r = await db.get(
    'SELECT r.*, u.address, u.lat, u.lng FROM recipients r JOIN users u ON u.id = r.user_id WHERE r.user_id = ?',
    [user.id]
  );
  if (!r) throw new HttpError(404, 'Recipient profile not found');
  return r;
}

// Existence -> 404, no permission -> 403. Never leaks another user's data through either path.
async function loadForUser(id, user) {
  const row = await donationById(id);
  if (!row) throw new HttpError(404, 'Donation not found');
  let ok = false;
  if (user.role === 'DONOR') ok = row.donor_id === user.id;
  else if (user.role === 'RECIPIENT') ok = row.recipient_user_id === user.id || row.status === 'AVAILABLE';
  else ok = row.driver_id === user.id || row.delivery_status === 'PENDING';
  if (!ok) throw new HttpError(403, 'You are not allowed to view this donation');
  return row;
}

async function ownedByDonor(id, user) {
  const row = await donationById(id);
  if (!row) throw new HttpError(404, 'Donation not found');
  if (row.donor_id !== user.id) throw new HttpError(403, 'This is not your donation');
  return row;
}

// Exact addresses, coordinates and phone numbers go only to the donor, the matched
// organisation and the assigned driver. Everyone else gets a ~1 km approximation.
const isInvolved = (row, user) =>
  (user.role === 'DONOR' && row.donor_id === user.id) ||
  (user.role === 'RECIPIENT' && row.recipient_user_id === user.id) ||
  (user.role === 'DRIVER' && row.driver_id === user.id);

async function detailFor(id, user) {
  const row = await donationById(id);
  const involved = isInvolved(row, user);
  const out = donationOut(row, involved);
  if (!involved) return out;

  if (user.role === 'DRIVER' || user.role === 'RECIPIENT') out.donorPhone = row.donor_phone;
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
  if (expiryMs - Date.now() > cfg.MAX_EXPIRY_HORIZON_MS) {
    throw new HttpError(400, `"Usable until" must be within ${Math.round(cfg.MAX_EXPIRY_HORIZON_MS / 3600000)} hours`);
  }

  const address = str(b.pickupAddress || req.user.address, 'Pickup location', { min: 2, max: 300 });
  const useProfile = !b.pickupAddress && !b.pickupLat;
  const loc = useProfile && req.user.lat != null
    ? { lat: req.user.lat, lng: req.user.lng }
    : await resolveLocation({ address, lat: b.pickupLat, lng: b.pickupLng });

  const meals = toMeals(quantity, b.unit);
  const weight = toKg(quantity, b.unit);

  const result = await tx(async () => {
    const t = now();
    const { id } = await db.insert(
      `INSERT INTO donations (donor_id, food_type, category, description, quantity, unit, meals, weight_kg,
         pickup_address, pickup_lat, pickup_lng, expiry_time, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'AVAILABLE', ?, ?)`,
      [req.user.id, foodType, category, description, quantity, b.unit, meals, weight,
        address, loc.lat, loc.lng, new Date(expiryMs).toISOString(), t, t]
    );
    await require('../status').recordEvent(id, null, 'AVAILABLE', { actor: req.user, note: 'Donation posted' });

    const startedAt = process.hrtime.bigint();
    const matching = await svc.runMatching(id, req.user);
    matching.elapsedMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
    if (!matching.matched) {
      await notify(req.user.id, 'NO_MATCH',
        `No recipient could take "${foodType}" yet. ${matching.failureReason} We keep trying until it expires.`, id);
    }
    return { id, matching };
  });

  res.status(201).json({
    donation: await detailFor(result.id, req.user),
    matching: {
      matched: result.matching.matched,
      best: result.matching.best,
      candidates: result.matching.candidates.slice(0, 5),
      rejected: result.matching.rejected.slice(0, 8),
      failureReason: result.matching.failureReason,
      elapsedMs: result.matching.elapsedMs, // engine time, shown in the UI as proof it is instant
    },
  });
});

// ---- list -----------------------------------------------------------------
router.get('/', async (req, res) => {
  await svc.expireStale();
  const u = req.user;

  if (u.role === 'DONOR') {
    const rows = await db.all(DONATION_SQL + ' WHERE d.donor_id = ? ORDER BY d.created_at DESC, d.id DESC', [u.id]);
    return res.json({ donations: rows.map((r) => donationOut(r, true)) }); // own donations
  }

  if (u.role === 'RECIPIENT') {
    const rec = await recipientOf(u);
    const rows = await db.all(
      DONATION_SQL + " WHERE d.status = 'AVAILABLE' OR d.matched_recipient_id = ? ORDER BY d.expiry_time ASC",
      [rec.id]
    );
    const donations = rows
      .filter((r) => !(r.status === 'AVAILABLE' && svc.declinedOf(r).includes(rec.id)))
      .map((r) => {
        // Full detail only once this organisation is the matched recipient.
        const out = donationOut(r, r.matched_recipient_id === rec.id);
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

  const rows = await db.all(DONATION_SQL + ' WHERE d.driver_id = ? ORDER BY d.updated_at DESC', [u.id]);
  res.json({ donations: rows.map((r) => donationOut(r, true)) }); // own assigned deliveries
});

// Donation & impact report. Deliberately not called a tax document - see report.js.
router.get('/export.csv', async (req, res) => {
  const { filename, csv } = await exportCsv(req.user);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.send(csv);
});

router.get('/:id', async (req, res) => {
  await svc.expireStale();
  const id = parseId(req.params.id);
  await loadForUser(id, req.user);
  res.json({ donation: await detailFor(id, req.user), history: await history(id) });
});

// Full lifecycle history of one donation.
router.get('/:id/history', async (req, res) => {
  const id = parseId(req.params.id);
  await loadForUser(id, req.user);
  res.json({ history: await history(id) });
});

// ---- matching -------------------------------------------------------------
// Eligible candidates plus the rejected ones and why, so "no match" is never unexplained.
router.get('/:id/candidates', requireRole('DONOR'), async (req, res) => {
  const row = await ownedByDonor(parseId(req.params.id), req.user);
  const donation = await svc.getDonation(row.id);
  const { eligible, rejected } = await evaluateRecipients(donation, { exclude: svc.declinedOf(donation) });
  res.json({
    candidates: eligible.slice(0, 10),
    rejected: rejected.slice(0, 10),
    failureReason: eligible.length ? null : donation.match_failure_reason,
  });
});

// Donor re-runs matching, or picks a specific recipient.
router.post('/:id/match', requireRole('DONOR'), async (req, res) => {
  const id = parseId(req.params.id);
  await ownedByDonor(id, req.user);
  const wanted = req.body?.recipientId !== undefined && req.body?.recipientId !== null
    ? parseId(req.body.recipientId, 'recipientId')
    : null;

  const startedAt = process.hrtime.bigint();
  const out = await tx(async () => {
    const donation = await svc.getDonation(id);
    if (expiryRisk(donation.expiry_time).risk === 'EXPIRED') throw new HttpError(422, 'Food has expired');
    if (!['AVAILABLE', 'MATCHED'].includes(donation.status)) throw new HttpError(409, `Donation is ${donation.status}`);
    if (donation.recipient_accepted) throw new HttpError(409, 'The recipient already confirmed this donation');

    // Release the current booking first so the engine sees the real free capacity.
    if (donation.status === 'MATCHED') {
      await svc.unassign(donation, req.user, wanted ? 'Donor chose a different recipient' : 'Donor re-ran matching');
    }

    if (!wanted) return svc.runMatching(id, req.user);

    const fresh = await svc.getDonation(id);
    const { eligible, rejected } = await evaluateRecipients(fresh, { exclude: svc.declinedOf(fresh) });
    const cand = eligible.find((c) => c.recipientId === wanted);
    if (!cand) {
      const why = rejected.find((c) => c.recipientId === wanted);
      throw new HttpError(422, why ? why.reason : 'That recipient cannot take this donation');
    }
    if (!(await svc.assign(fresh, cand, req.user))) throw new HttpError(409, 'That recipient just ran out of capacity');
    return { matched: true, best: cand, candidates: eligible, rejected, failureReason: null };
  });
  out.elapsedMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;

  res.json({
    matching: {
      matched: out.matched,
      best: out.best,
      candidates: (out.candidates || []).slice(0, 5),
      rejected: (out.rejected || []).slice(0, 8),
      failureReason: out.failureReason,
      elapsedMs: out.elapsedMs,
    },
    donation: await detailFor(id, req.user),
  });
});

router.post('/:id/accept', requireRole('RECIPIENT'), async (req, res) => {
  await svc.expireStale();
  const id = parseId(req.params.id);
  const rec = await recipientOf(req.user);
  await tx(async () => {
    const donation = await svc.getDonation(id);
    if (!donation) throw new HttpError(404, 'Donation not found');
    if (svc.declinedOf(donation).includes(rec.id)) throw new HttpError(409, 'You already declined this donation');
    await svc.acceptDonation(donation, rec, req.user);
  });
  res.json({ donation: await detailFor(id, req.user) });
});

router.post('/:id/decline', requireRole('RECIPIENT'), async (req, res) => {
  const id = parseId(req.params.id);
  const rec = await recipientOf(req.user);
  const result = await tx(async () => {
    const donation = await svc.getDonation(id);
    if (!donation) throw new HttpError(404, 'Donation not found');
    if (donation.status !== 'MATCHED' || donation.matched_recipient_id !== rec.id) {
      throw new HttpError(403, 'This donation is not matched to you');
    }
    if (donation.recipient_accepted) throw new HttpError(409, 'Already accepted - it can no longer be declined');

    const declined = [...svc.declinedOf(donation), rec.id];
    await svc.unassign(donation, req.user, `${rec.organization_name} declined`);
    await db.run('UPDATE donations SET declined_recipients = ? WHERE id = ?', [JSON.stringify(declined), id]);

    const next = await svc.runMatching(id, req.user); // immediately try the next best recipient
    if (!next.matched) {
      await notify(donation.donor_id, 'NO_MATCH',
        `${rec.organization_name} declined "${donation.food_type}" and no other recipient fits yet. ${next.failureReason}`, id);
    }
    return { rematched: next.matched, failureReason: next.failureReason, recipientId: rec.id };
  });
  await svc.rematchForRecipient(result.recipientId);
  res.json({ ok: true, rematched: result.rematched, failureReason: result.failureReason });
});

// Donor withdraws a donation that has not been collected yet.
router.post('/:id/cancel', requireRole('DONOR'), async (req, res) => {
  const id = parseId(req.params.id);
  await ownedByDonor(id, req.user);
  const reason = str(req.body?.reason, 'Reason', { max: 200, required: false });
  const freed = await tx(async () => {
    const d = await svc.getDonation(id);
    await svc.cancelDonation(d, req.user, reason);
    return d.matched_recipient_id;
  });
  await svc.rematchForRecipient(freed); // released capacity may unblock another donation
  res.json({ donation: await detailFor(id, req.user) });
});

// Drivers move a donation along through its delivery.
router.patch('/:id/status', requireRole('DRIVER'), async (req, res) => {
  const id = parseId(req.params.id);
  const row = await donationById(id);
  if (!row) throw new HttpError(404, 'Donation not found');
  if (!row.delivery_id) throw new HttpError(409, 'No delivery exists for this donation yet');

  const status = req.body?.status;
  if (status === 'PICKED_UP') await ops.markPickedUp(row.delivery_id, req.user);
  else if (status === 'DELIVERED') await ops.markDelivered(row.delivery_id, req.user);
  else throw new HttpError(400, 'Status must be PICKED_UP or DELIVERED');

  res.json({ donation: await detailFor(id, req.user) });
});

module.exports = router;
