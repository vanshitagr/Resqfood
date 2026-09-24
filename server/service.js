// Donation lifecycle logic. Unless noted, functions here assume the caller wraps them in tx().
const db = require('./db');
const cfg = require('./config');
const { HttpError, now, tx, notify, expiryRisk } = require('./lib');
const { haversineKm, etaMinutes, boundingBox } = require('./geo');
const { evaluateRecipients, scoreRecipient, summariseFailure } = require('./matching');
const { setStatus, recordEvent } = require('./status');

const getDonation = (id) => db.get('SELECT * FROM donations WHERE id = ?', [id]);

const getRecipient = (id) =>
  db.get(
    `SELECT r.*, u.id AS user_id, u.address, u.lat, u.lng
     FROM recipients r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
    [id]
  );

const declinedOf = (d) => {
  try {
    return JSON.parse(d.declined_recipients) || [];
  } catch {
    return [];
  }
};

async function recipientUserId(recipientId) {
  if (!recipientId) return null;
  const row = await db.get('SELECT user_id FROM recipients WHERE id = ?', [recipientId]);
  return row ? row.user_id : null;
}

// Atomically reserve capacity; returns false if it would overflow.
async function reserve(recipientId, meals) {
  const res = await db.run(
    'UPDATE recipients SET current_load = current_load + ? WHERE id = ? AND capacity - current_load >= ?',
    [meals, recipientId, meals]
  );
  return res.changes === 1;
}

async function release(recipientId, meals) {
  if (!recipientId) return;
  await db.run(
    `UPDATE recipients SET current_load = ${db.sql.greatest('0', 'current_load - ?')} WHERE id = ?`,
    [meals, recipientId]
  );
}

// Books `candidate` for `donation`. Returns false if its capacity was taken in the meantime.
async function assign(donation, candidate, actor) {
  if (!(await reserve(candidate.recipientId, donation.meals))) return false;
  const rec = await getRecipient(candidate.recipientId);
  try {
    await setStatus(donation.id, 'MATCHED', {
      actor,
      note: `Matched to ${rec.organization_name} with score ${Math.round(candidate.score)}/100`,
      extra: {
        matched_recipient_id: candidate.recipientId,
        match_score: candidate.score,
        match_breakdown: JSON.stringify(candidate.breakdown),
        match_failure_reason: null,
        recipient_accepted: 0,
      },
    });
  } catch (err) {
    await release(candidate.recipientId, donation.meals); // keep capacity consistent
    throw err;
  }
  await notify(rec.user_id, 'MATCH', `New donation matched to you: ${donation.food_type} (${donation.meals} meals) - please confirm.`, donation.id);
  await notify(donation.donor_id, 'MATCH', `Your donation was matched to ${rec.organization_name}.`, donation.id);
  return true;
}

// Frees the current match (if any) and returns the donation to AVAILABLE.
async function unassign(donation, actor, note) {
  await release(donation.matched_recipient_id, donation.meals);
  await setStatus(donation.id, 'AVAILABLE', {
    actor,
    note,
    extra: {
      matched_recipient_id: null,
      match_score: null,
      match_breakdown: null,
      recipient_accepted: 0,
    },
  });
}

/**
 * Runs the matching engine for a donation and records the outcome.
 * Always returns { matched, best, candidates, rejected, failureReason } - never throws when
 * nothing fits, because "no suitable recipient" is a normal result that must not lose the donation.
 */
async function runMatching(donationId, actor = null) {
  const donation = await getDonation(donationId);
  if (!donation) throw new HttpError(404, 'Donation not found');
  if (donation.status !== 'AVAILABLE') {
    return { matched: false, best: null, candidates: [], rejected: [], failureReason: `Donation is ${donation.status}` };
  }

  const { eligible, rejected } = await evaluateRecipients(donation, { exclude: declinedOf(donation) });

  for (const candidate of eligible) {
    if (await assign(donation, candidate, actor)) {
      return { matched: true, best: candidate, candidates: eligible, rejected, failureReason: null };
    }
  }

  const failureReason = summariseFailure(rejected);
  // Only write when the explanation actually changed, so the retry sweep does not churn
  // updated_at every minute for every donation that is still waiting.
  if (failureReason !== donation.match_failure_reason) {
    await db.run('UPDATE donations SET match_failure_reason = ?, updated_at = ? WHERE id = ?',
      [failureReason, now(), donationId]);
  }
  return { matched: false, best: null, candidates: eligible, rejected, failureReason };
}

async function createDelivery(donation) {
  const rec = await getRecipient(donation.matched_recipient_id);
  const km = haversineKm(
    { lat: donation.pickup_lat, lng: donation.pickup_lng },
    { lat: rec.lat, lng: rec.lng }
  );
  await db.run(
    `INSERT INTO deliveries (donation_id, pickup_address, pickup_lat, pickup_lng, drop_address, drop_lat, drop_lng,
       distance_km, eta_minutes, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?, 'PENDING', ?)`,
    [
      donation.id, donation.pickup_address, donation.pickup_lat, donation.pickup_lng,
      rec.address || rec.organization_name, rec.lat, rec.lng,
      Math.round(km * 10) / 10, etaMinutes(km), now(),
    ]
  );
}

// Recipient confirms a donation: either the one matched to them, or claims an AVAILABLE one.
async function acceptDonation(donation, recipientRow, actor) {
  if (expiryRisk(donation.expiry_time).risk === 'EXPIRED') throw new HttpError(422, 'Food has expired');

  if (donation.status === 'AVAILABLE') {
    const fit = scoreRecipient(donation, recipientRow);
    if (!fit.eligible) throw new HttpError(422, fit.reason);
    if (!(await assign(donation, fit, actor))) throw new HttpError(422, 'Not enough capacity');
  } else if (donation.status === 'MATCHED') {
    if (donation.matched_recipient_id !== recipientRow.id) {
      throw new HttpError(409, 'Donation is already matched to another organization');
    }
    if (donation.recipient_accepted) throw new HttpError(409, 'Donation already accepted');
  } else {
    throw new HttpError(409, `Donation is ${donation.status}`);
  }

  await db.run('UPDATE donations SET recipient_accepted = 1, updated_at = ? WHERE id = ?', [now(), donation.id]);
  await recordEvent(donation.id, 'MATCHED', 'MATCHED', {
    actor,
    note: `${recipientRow.organization_name} confirmed the donation`,
  });
  await createDelivery(await getDonation(donation.id));

  await notify(donation.donor_id, 'ACCEPTED', `${recipientRow.organization_name} confirmed your donation. Finding a driver.`, donation.id);
  for (const d of await db.all("SELECT id FROM users WHERE role = 'DRIVER'")) {
    await notify(d.id, 'TASK', `New pickup task: ${donation.food_type} (${donation.meals} meals).`, donation.id);
  }
}

// Donor withdraws a donation before it has been collected.
async function cancelDonation(donation, actor, reason) {
  if (donation.status === 'PICKED_UP') throw new HttpError(409, 'The food is already in transit and cannot be cancelled');
  await release(donation.matched_recipient_id, donation.meals);
  const recUser = await recipientUserId(donation.matched_recipient_id);
  await setStatus(donation.id, 'CANCELLED', {
    actor,
    note: reason || 'Cancelled by donor',
    extra: { cancel_reason: reason || null },
  });
  await cancelDelivery(donation, 'The donor cancelled this donation');
  if (recUser) await notify(recUser, 'CANCELLED', `The donor cancelled "${donation.food_type}".`, donation.id);
}

// Cancels an open delivery for a donation that is no longer collectable.
async function cancelDelivery(donation, message) {
  const dl = await db.get('SELECT * FROM deliveries WHERE donation_id = ?', [donation.id]);
  if (!dl || !['PENDING', 'ASSIGNED'].includes(dl.status)) return;
  await db.run("UPDATE deliveries SET status = 'CANCELLED' WHERE id = ?", [dl.id]);
  if (dl.driver_id) {
    await notify(dl.driver_id, 'CANCELLED', `Task cancelled: ${donation.food_type}. ${message}`, donation.id);
  }
}

// Marks stale, not-yet-collected donations EXPIRED and releases any reserved capacity.
async function expireStaleInner() {
  const stale = await db.all(
    "SELECT * FROM donations WHERE status IN ('AVAILABLE','MATCHED','DRIVER_ASSIGNED') AND expiry_time <= ?",
    [now()]
  );
  for (const d of stale) {
    await release(d.matched_recipient_id, d.meals);
    const recUser = await recipientUserId(d.matched_recipient_id);
    await setStatus(d.id, 'EXPIRED', { note: 'Usable time window passed before pickup' });
    await cancelDelivery(d, 'The food passed its usable time.');
    await notify(d.donor_id, 'EXPIRED', `Your donation "${d.food_type}" expired before pickup.`, d.id);
    if (recUser) await notify(recUser, 'EXPIRED', `"${d.food_type}" expired before it could be delivered.`, d.id);
  }
  return stale.length;
}

// Warns everyone involved once, when a donation is close to its expiry but still uncollected.
async function warnExpiringInner() {
  const cutoff = new Date(Date.now() + cfg.EXPIRY_WARN_MIN * 60000).toISOString();
  const soon = await db.all(
    `SELECT * FROM donations
     WHERE status IN ('AVAILABLE','MATCHED','DRIVER_ASSIGNED') AND expiry_warned = 0
       AND expiry_time > ? AND expiry_time <= ?`,
    [now(), cutoff]
  );
  for (const d of soon) {
    const { minutesLeft } = expiryRisk(d.expiry_time);
    await db.run('UPDATE donations SET expiry_warned = 1 WHERE id = ?', [d.id]);
    await notify(d.donor_id, 'EXPIRING', `"${d.food_type}" is usable for only ${minutesLeft} more minutes.`, d.id);

    const recUser = await recipientUserId(d.matched_recipient_id);
    if (recUser) await notify(recUser, 'EXPIRING', `"${d.food_type}" must be collected within ${minutesLeft} minutes.`, d.id);

    const dl = await db.get('SELECT * FROM deliveries WHERE donation_id = ?', [d.id]);
    if (dl && dl.driver_id && dl.status === 'ASSIGNED') {
      await notify(dl.driver_id, 'EXPIRING', `Hurry: "${d.food_type}" expires in ${minutesLeft} minutes.`, d.id);
    }
  }
  return soon.length;
}

/**
 * Reminds the assigned driver (and the donor) that a pickup is due before the food expires.
 * Sent once per donation, only while it is still uncollected.
 */
async function pickupRemindersInner() {
  const cutoff = new Date(Date.now() + cfg.PICKUP_REMINDER_MIN * 60000).toISOString();
  const due = await db.all(
    `SELECT * FROM donations
     WHERE status = 'DRIVER_ASSIGNED' AND pickup_reminder_sent = 0
       AND expiry_time > ? AND expiry_time <= ?`,
    [now(), cutoff]
  );
  for (const d of due) {
    const { minutesLeft } = expiryRisk(d.expiry_time);
    await db.run('UPDATE donations SET pickup_reminder_sent = 1 WHERE id = ?', [d.id]);
    if (d.driver_id) {
      await notify(d.driver_id, 'PICKUP_SOON', `Pickup due: "${d.food_type}" must be collected within ${minutesLeft} minutes.`, d.id);
    }
    await notify(d.donor_id, 'PICKUP_SOON', `Your driver should collect "${d.food_type}" within ${minutesLeft} minutes.`, d.id);
  }
  return due.length;
}

/**
 * Keeps looking for a recipient for donations that are still unmatched but inside their usable
 * window - capacity frees up as other deliveries complete, so an earlier failure is not final.
 */
async function retryUnmatchedInner() {
  const open = await db.all("SELECT id FROM donations WHERE status = 'AVAILABLE' AND expiry_time > ?", [now()]);
  let matched = 0;
  for (const { id } of open) {
    try {
      if ((await runMatching(id)).matched) matched++;
    } catch { /* one bad donation must not stop the sweep */ }
  }
  return matched;
}

/**
 * Re-runs matching for unmatched donations whose pickup point lies near `lat`/`lng`.
 * Called whenever something changes that could turn a previous failure into a match:
 * a recipient frees capacity, raises capacity, becomes available, widens its food types,
 * or a brand-new recipient registers. Index-backed bounding box, so it never scans the
 * whole donations table.
 */
async function rematchNearInner(lat, lng, reason = 'capacity or availability changed') {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 0;
  const b = boundingBox(lat, lng, cfg.MAX_MATCH_KM);
  const open = await db.all(
    `SELECT id FROM donations
     WHERE status = 'AVAILABLE' AND expiry_time > ?
       AND pickup_lat BETWEEN ? AND ? AND pickup_lng BETWEEN ? AND ?`,
    [now(), b.minLat, b.maxLat, b.minLng, b.maxLng]
  );

  let matched = 0;
  for (const { id } of open) {
    try {
      if ((await runMatching(id)).matched) {
        matched++;
        await recordEvent(id, 'AVAILABLE', 'MATCHED', { note: `Re-matched automatically after ${reason}` });
      }
    } catch { /* one bad donation must not stop the pass */ }
  }
  return matched;
}

// Each sweep is self-contained; never call these from inside another tx().
const expireStale = () => tx(expireStaleInner);
const warnExpiring = () => tx(warnExpiringInner);
const retryUnmatched = () => tx(retryUnmatchedInner);
const pickupReminders = () => tx(pickupRemindersInner);
const rematchNear = (lat, lng, reason) => tx(() => rematchNearInner(lat, lng, reason));

/**
 * Called after capacity is freed (a delivery completes, a donation is cancelled or declined):
 * donations that previously failed on capacity may now fit. Call OUTSIDE a transaction.
 */
async function rematchForRecipient(recipientId) {
  if (!recipientId) return 0;
  const r = await getRecipient(recipientId);
  if (!r || !r.is_available) return 0;
  return rematchNear(r.lat, r.lng, 'capacity was freed nearby');
}

// Runs every SWEEP_INTERVAL_MS from app.js.
async function sweep() {
  const expired = await expireStale();
  const warned = await warnExpiring();
  const reminded = await pickupReminders();
  const rematched = await retryUnmatched();
  return { expired, warned, reminded, rematched };
}

module.exports = {
  getDonation, getRecipient, declinedOf, recipientUserId, reserve, release, assign, unassign,
  runMatching, acceptDonation, cancelDonation, cancelDelivery,
  expireStale, warnExpiring, retryUnmatched, pickupReminders, rematchNear, rematchNearInner,
  rematchForRecipient, sweep,
};
