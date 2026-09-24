// Driver-side state transitions. Each one is atomic and guarded by a status precondition, so
// duplicate, late, out-of-order or unauthorized calls fail with 403/409/422 instead of
// corrupting state. Donation status always moves through status.js, which rejects illegal hops.
const db = require('./db');
const cfg = require('./config');
const { HttpError, now, tx, notify, expiryRisk } = require('./lib');
const { setStatus } = require('./status');
const svc = require('./service');
const { getDonation, release, recipientUserId, expireStale } = svc;

async function load(id) {
  const dl = await db.get('SELECT * FROM deliveries WHERE id = ?', [id]);
  if (!dl) throw new HttpError(404, 'Delivery not found');
  return dl;
}

async function ownDelivery(id, driver) {
  const dl = await load(id);
  if (dl.driver_id !== driver.id) throw new HttpError(403, 'This delivery is not assigned to you');
  return dl;
}

// Re-checked at every stage, not only at creation: food can expire between two driver taps.
function assertNotExpired(donation, dl, message) {
  if (dl.status === 'CANCELLED' || donation.status === 'EXPIRED' || donation.status === 'CANCELLED') {
    throw new HttpError(422, `This task is no longer active (${donation.status.toLowerCase()})`);
  }
  if (expiryRisk(donation.expiry_time).risk === 'EXPIRED') throw new HttpError(422, message);
}

async function acceptDelivery(id, driver) {
  await expireStale();
  return tx(async () => {
    const dl = await load(id);
    const donation = await getDonation(dl.donation_id);
    assertNotExpired(donation, dl, 'Food has expired - this task was cancelled');
    if (dl.status !== 'PENDING') throw new HttpError(409, 'This delivery has already been taken');

    const active = (await db.get(
      "SELECT COUNT(*) AS n FROM deliveries WHERE driver_id = ? AND status IN ('ASSIGNED','PICKED_UP')",
      [driver.id]
    )).n;
    if (Number(active) >= cfg.MAX_ACTIVE_PER_DRIVER) {
      throw new HttpError(409, 'Finish your current deliveries before taking another');
    }

    const r = await db.run(
      "UPDATE deliveries SET driver_id = ?, status = 'ASSIGNED' WHERE id = ? AND status = 'PENDING'",
      [driver.id, id]
    );
    if (r.changes !== 1) throw new HttpError(409, 'This delivery has already been taken');

    await setStatus(donation.id, 'DRIVER_ASSIGNED', {
      actor: driver,
      note: `${driver.name} accepted the pickup task`,
      extra: { driver_id: driver.id },
    });
    await notify(donation.donor_id, 'DRIVER', `${driver.name} is on the way to pick up your donation.`, donation.id);
    await notify(await recipientUserId(donation.matched_recipient_id), 'DRIVER',
      `${driver.name} will deliver ${donation.food_type} to you.`, donation.id);
    return id;
  });
}

// Driver gives an accepted task back to the pool without collecting it.
async function dropDelivery(id, driver) {
  return tx(async () => {
    const dl = await ownDelivery(id, driver);
    if (dl.status !== 'ASSIGNED') throw new HttpError(409, `Cannot release a delivery that is ${dl.status}`);
    const donation = await getDonation(dl.donation_id);

    await db.run("UPDATE deliveries SET driver_id = NULL, status = 'PENDING' WHERE id = ? AND status = 'ASSIGNED'", [id]);
    await setStatus(donation.id, 'MATCHED', {
      actor: driver,
      note: `${driver.name} released the task`,
      extra: { driver_id: null },
    });
    await notify(donation.donor_id, 'DRIVER', 'The driver released your pickup. Looking for another driver.', donation.id);
    return id;
  });
}

async function markPickedUp(id, driver) {
  await expireStale();
  return tx(async () => {
    const dl = await ownDelivery(id, driver);
    const donation = await getDonation(dl.donation_id);
    assertNotExpired(donation, dl, 'Food has expired - do not collect it');
    if (dl.status !== 'ASSIGNED') throw new HttpError(409, `Cannot mark picked up: delivery is ${dl.status}`);

    const r = await db.run(
      "UPDATE deliveries SET status = 'PICKED_UP', pickup_time = ? WHERE id = ? AND status = 'ASSIGNED'",
      [now(), id]
    );
    if (r.changes !== 1) throw new HttpError(409, 'Delivery already picked up');

    await setStatus(donation.id, 'PICKED_UP', { actor: driver, note: `Collected by ${driver.name}` });
    await notify(donation.donor_id, 'PICKED_UP', `Your donation "${donation.food_type}" has been picked up.`, donation.id);
    await notify(await recipientUserId(donation.matched_recipient_id), 'PICKED_UP',
      `${donation.food_type} is on its way to you.`, donation.id);
    return id;
  });
}

async function markDelivered(id, driver) {
  const freedRecipient = await tx(async () => {
    const dl = await ownDelivery(id, driver);
    const donation = await getDonation(dl.donation_id);
    if (dl.status !== 'PICKED_UP') throw new HttpError(409, `Cannot mark delivered: delivery is ${dl.status}`);

    // Final expiry gate. Food that passed its usable window while in transit must not be
    // recorded as a successful hand-over - it would inflate the rescued totals and imply the
    // shelter received usable food. The driver reports the outcome with /fail instead.
    if (expiryRisk(donation.expiry_time).risk === 'EXPIRED') {
      throw new HttpError(422,
        'This food passed its usable time during transit. Do not hand it over - report it as not delivered instead.');
    }

    const r = await db.run(
      "UPDATE deliveries SET status = 'DELIVERED', delivery_time = ? WHERE id = ? AND status = 'PICKED_UP'",
      [now(), id]
    );
    if (r.changes !== 1) throw new HttpError(409, 'Delivery already completed');

    await setStatus(donation.id, 'DELIVERED', { actor: driver, note: `Delivered by ${driver.name}` });
    await release(donation.matched_recipient_id, donation.meals); // food handed over; capacity freed
    await notify(donation.donor_id, 'DELIVERED', `Delivered! ${donation.meals} meals reached their destination.`, donation.id);
    await notify(await recipientUserId(donation.matched_recipient_id), 'DELIVERED',
      `${donation.food_type} (${donation.meals} meals) delivered.`, donation.id);
    return donation.matched_recipient_id;
  });

  // Capacity just came back, so donations that failed on capacity may now fit.
  await svc.rematchForRecipient(freedRecipient);
  return id;
}

/**
 * The driver collected the food but could not hand it over (it expired in transit, the shelter
 * was closed, an accident). Closes the donation as CANCELLED with the stated reason so it is
 * never counted as rescued and never left stuck in PICKED_UP.
 */
async function failDelivery(id, driver, reason) {
  const freedRecipient = await tx(async () => {
    const dl = await ownDelivery(id, driver);
    const donation = await getDonation(dl.donation_id);
    if (!['ASSIGNED', 'PICKED_UP'].includes(dl.status)) {
      throw new HttpError(409, `Cannot report a failure: delivery is ${dl.status}`);
    }
    const note = reason || 'Driver reported the delivery could not be completed';

    await db.run("UPDATE deliveries SET status = 'CANCELLED' WHERE id = ?", [id]);
    await release(donation.matched_recipient_id, donation.meals);
    await setStatus(donation.id, 'CANCELLED', { actor: driver, note, extra: { cancel_reason: note } });

    await notify(donation.donor_id, 'CANCELLED', `"${donation.food_type}" could not be delivered: ${note}`, donation.id);
    await notify(await recipientUserId(donation.matched_recipient_id), 'CANCELLED',
      `"${donation.food_type}" could not be delivered: ${note}`, donation.id);
    return donation.matched_recipient_id;
  });

  await svc.rematchForRecipient(freedRecipient);
  return id;
}

module.exports = { acceptDelivery, dropDelivery, markPickedUp, markDelivered, failDelivery };
