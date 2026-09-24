// Donation lifecycle logic. Functions here assume the caller wraps them in tx().
const db = require('./db');
const { HttpError, now, tx, notify } = require('./lib');
const { haversineKm, etaMinutes } = require('./geo');
const { rankRecipients, scoreRecipient, recipientRows } = require('./matching');

const getDonation = (id) => db.prepare('SELECT * FROM donations WHERE id = ?').get(id);
const getRecipient = (id) =>
  db.prepare('SELECT r.*, u.id AS user_id, u.address, u.lat, u.lng FROM recipients r JOIN users u ON u.id = r.user_id WHERE r.id = ?').get(id);
const declinedOf = (d) => {
  try {
    return JSON.parse(d.declined_recipients) || [];
  } catch {
    return [];
  }
};

// Atomically reserve capacity; returns false if it would overflow.
function reserve(recipientId, meals) {
  const res = db
    .prepare('UPDATE recipients SET current_load = current_load + ? WHERE id = ? AND capacity - current_load >= ?')
    .run(meals, recipientId, meals);
  return res.changes === 1;
}

function release(recipientId, meals) {
  db.prepare('UPDATE recipients SET current_load = MAX(0, current_load - ?) WHERE id = ?').run(meals, recipientId);
}

function assign(donation, candidate) {
  if (!reserve(candidate.recipientId, donation.meals)) return false;
  db.prepare(
    `UPDATE donations SET status='MATCHED', matched_recipient_id=?, match_score=?, match_breakdown=?,
       recipient_accepted=0, updated_at=? WHERE id=? AND status='AVAILABLE'`
  ).run(candidate.recipientId, candidate.score, JSON.stringify(candidate.breakdown), now(), donation.id);
  const rec = getRecipient(candidate.recipientId);
  notify(rec.user_id, 'MATCH', `New donation matched to you: ${donation.food_type} (${donation.meals} meals) - please confirm.`, donation.id);
  notify(donation.donor_id, 'MATCH', `Your donation was matched to ${rec.organization_name}.`, donation.id);
  return true;
}

// Frees the current match (if any) and returns the donation to AVAILABLE.
function unassign(donation) {
  if (donation.matched_recipient_id) release(donation.matched_recipient_id, donation.meals);
  db.prepare(
    `UPDATE donations SET status='AVAILABLE', matched_recipient_id=NULL, match_score=NULL, match_breakdown=NULL,
       recipient_accepted=0, updated_at=? WHERE id=?`
  ).run(now(), donation.id);
}

// Picks the best eligible recipient with capacity. Returns the candidate or null.
function autoMatch(donationId) {
  const donation = getDonation(donationId);
  if (!donation || donation.status !== 'AVAILABLE') return null;
  const ranked = rankRecipients(donation, { exclude: declinedOf(donation) });
  for (const cand of ranked) {
    if (assign(donation, cand)) return cand;
  }
  return null;
}

function createDelivery(donation) {
  const rec = getRecipient(donation.matched_recipient_id);
  const km = haversineKm(
    { lat: donation.pickup_lat, lng: donation.pickup_lng },
    { lat: rec.lat, lng: rec.lng }
  );
  db.prepare(
    `INSERT INTO deliveries (donation_id, pickup_address, pickup_lat, pickup_lng, drop_address, drop_lat, drop_lng,
       distance_km, eta_minutes, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?, 'PENDING', ?)`
  ).run(
    donation.id, donation.pickup_address, donation.pickup_lat, donation.pickup_lng,
    rec.address || rec.organization_name, rec.lat, rec.lng,
    Math.round(km * 10) / 10, etaMinutes(km), now()
  );
}

// Recipient confirms a donation: either the one matched to them, or claims an AVAILABLE one.
function acceptDonation(donation, recipientRow) {
  if (donation.status === 'AVAILABLE') {
    const fit = scoreRecipient(donation, recipientRow);
    if (!fit.eligible) throw new HttpError(422, fit.reason);
    if (!assign(donation, fit)) throw new HttpError(422, 'Not enough capacity');
  } else if (donation.status === 'MATCHED') {
    if (donation.matched_recipient_id !== recipientRow.id) {
      throw new HttpError(409, 'Donation is already matched to another organization');
    }
    if (donation.recipient_accepted) throw new HttpError(409, 'Donation already accepted');
  } else {
    throw new HttpError(409, `Donation is ${donation.status}`);
  }
  db.prepare('UPDATE donations SET recipient_accepted=1, updated_at=? WHERE id=?').run(now(), donation.id);
  createDelivery(getDonation(donation.id));
  notify(donation.donor_id, 'ACCEPTED', `${recipientRow.organization_name} confirmed your donation. Finding a driver.`, donation.id);
  const drivers = db.prepare("SELECT id FROM users WHERE role='DRIVER'").all();
  for (const d of drivers) notify(d.id, 'TASK', `New pickup task: ${donation.food_type} (${donation.meals} meals).`, donation.id);
}

// Marks stale, not-yet-collected donations EXPIRED and releases reserved capacity.
function expireStaleInner() {
  const stale = db
    .prepare("SELECT * FROM donations WHERE status IN ('AVAILABLE','MATCHED') AND expiry_time <= ?")
    .all(now());
  for (const d of stale) {
    if (d.matched_recipient_id) release(d.matched_recipient_id, d.meals);
    db.prepare("UPDATE donations SET status='EXPIRED', updated_at=? WHERE id=?").run(now(), d.id);
    const dl = db.prepare('SELECT * FROM deliveries WHERE donation_id=?').get(d.id);
    if (dl && ['PENDING', 'ASSIGNED'].includes(dl.status)) {
      db.prepare("UPDATE deliveries SET status='CANCELLED' WHERE id=?").run(dl.id);
      if (dl.driver_id) notify(dl.driver_id, 'EXPIRED', `Task cancelled: ${d.food_type} expired.`, d.id);
    }
    notify(d.donor_id, 'EXPIRED', `Your donation "${d.food_type}" expired before pickup.`, d.id);
  }
  return stale.length;
}

// Self-contained transaction; never call from inside another tx().
const expireStale = () => tx(expireStaleInner);

module.exports = {
  getDonation, getRecipient, declinedOf, reserve, release, assign, unassign,
  autoMatch, acceptDonation, expireStale, recipientRows,
};
