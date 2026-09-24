// Driver-side state transitions. Each is atomic and guarded by a status precondition,
// so duplicate/late/unauthorized calls fail with 409/403 instead of corrupting state.
const db = require('./db');
const { HttpError, now, tx, notify } = require('./lib');
const { getDonation, release, expireStale } = require('./service');

const MAX_ACTIVE_PER_DRIVER = 2;

function load(id) {
  const dl = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id);
  if (!dl) throw new HttpError(404, 'Delivery not found');
  return dl;
}

const recipientUserId = (donation) =>
  db
    .prepare('SELECT user_id FROM recipients WHERE id = ?')
    .get(donation.matched_recipient_id)?.user_id;

function acceptDelivery(id, driver) {
  expireStale();
  return tx(() => {
    const dl = load(id);
    const donation = getDonation(dl.donation_id);
    if (dl.status === 'CANCELLED' || donation.status === 'EXPIRED') {
      throw new HttpError(422, 'Food has expired - this task was cancelled');
    }
    if (dl.status !== 'PENDING') throw new HttpError(409, 'This delivery has already been taken');
    const active = db
      .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE driver_id = ? AND status IN ('ASSIGNED','PICKED_UP')")
      .get(driver.id).n;
    if (active >= MAX_ACTIVE_PER_DRIVER) {
      throw new HttpError(409, 'Finish your current deliveries before taking another');
    }
    const r = db
      .prepare("UPDATE deliveries SET driver_id = ?, status = 'ASSIGNED' WHERE id = ? AND status = 'PENDING'")
      .run(driver.id, id);
    if (r.changes !== 1) throw new HttpError(409, 'This delivery has already been taken');
    db.prepare('UPDATE donations SET driver_id = ?, updated_at = ? WHERE id = ?').run(driver.id, now(), donation.id);
    notify(donation.donor_id, 'DRIVER', `${driver.name} is on the way to pick up your donation.`, donation.id);
    notify(recipientUserId(donation), 'DRIVER', `${driver.name} will deliver ${donation.food_type} to you.`, donation.id);
    return id;
  });
}

function ownDelivery(id, driver) {
  const dl = load(id);
  if (dl.driver_id !== driver.id) throw new HttpError(403, 'This delivery is not assigned to you');
  return dl;
}

function markPickedUp(id, driver) {
  expireStale();
  return tx(() => {
    const dl = ownDelivery(id, driver);
    const donation = getDonation(dl.donation_id);
    if (dl.status === 'CANCELLED' || donation.status === 'EXPIRED') {
      throw new HttpError(422, 'Food has expired - do not collect it');
    }
    if (dl.status !== 'ASSIGNED') throw new HttpError(409, `Cannot mark picked up: delivery is ${dl.status}`);
    const r = db
      .prepare("UPDATE deliveries SET status='PICKED_UP', pickup_time=? WHERE id=? AND status='ASSIGNED'")
      .run(now(), id);
    if (r.changes !== 1) throw new HttpError(409, 'Delivery already picked up');
    db.prepare("UPDATE donations SET status='PICKED_UP', updated_at=? WHERE id=?").run(now(), donation.id);
    notify(donation.donor_id, 'PICKED_UP', `Your donation "${donation.food_type}" has been picked up.`, donation.id);
    notify(recipientUserId(donation), 'PICKED_UP', `${donation.food_type} is on its way to you.`, donation.id);
    return id;
  });
}

function markDelivered(id, driver) {
  return tx(() => {
    const dl = ownDelivery(id, driver);
    const donation = getDonation(dl.donation_id);
    if (dl.status !== 'PICKED_UP') throw new HttpError(409, `Cannot mark delivered: delivery is ${dl.status}`);
    const t = now();
    const r = db
      .prepare("UPDATE deliveries SET status='DELIVERED', delivery_time=? WHERE id=? AND status='PICKED_UP'")
      .run(t, id);
    if (r.changes !== 1) throw new HttpError(409, 'Delivery already completed');
    db.prepare("UPDATE donations SET status='DELIVERED', delivered_at=?, updated_at=? WHERE id=?").run(t, t, donation.id);
    release(donation.matched_recipient_id, donation.meals); // food handed over; capacity freed
    notify(donation.donor_id, 'DELIVERED', `Delivered! ${donation.meals} meals reached their destination.`, donation.id);
    notify(recipientUserId(donation), 'DELIVERED', `${donation.food_type} (${donation.meals} meals) delivered.`, donation.id);
    return id;
  });
}

module.exports = { acceptDelivery, markPickedUp, markDelivered };
