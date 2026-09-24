// Single source of truth for the donation lifecycle.
//
//   AVAILABLE (the spec's POSTED state)
//     -> MATCHED           a recipient was selected by the engine or claimed the donation
//     -> EXPIRED           usable window passed before anyone took it
//     -> CANCELLED         donor withdrew it
//   MATCHED
//     -> AVAILABLE         recipient declined, or donor re-ran matching
//     -> DRIVER_ASSIGNED   a driver accepted the pickup task
//     -> EXPIRED | CANCELLED
//   DRIVER_ASSIGNED
//     -> PICKED_UP         driver collected the food
//     -> MATCHED           driver dropped the task before collecting
//     -> EXPIRED | CANCELLED
//   PICKED_UP
//     -> DELIVERED | CANCELLED     (never EXPIRED: the food is already in transit)
//   DELIVERED / EXPIRED / CANCELLED are terminal.
//
// Everything that changes a donation's status must go through setStatus(), which performs the
// change as a guarded compare-and-set and appends a donation_events row. That gives both the
// "invalid transitions are rejected by the backend" guarantee and the full audit history.
const db = require('./db');
const { HttpError, now } = require('./lib');

const TRANSITIONS = {
  AVAILABLE: ['MATCHED', 'EXPIRED', 'CANCELLED'],
  MATCHED: ['AVAILABLE', 'DRIVER_ASSIGNED', 'EXPIRED', 'CANCELLED'],
  DRIVER_ASSIGNED: ['MATCHED', 'PICKED_UP', 'EXPIRED', 'CANCELLED'],
  PICKED_UP: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  EXPIRED: [],
  CANCELLED: [],
};

const ALL_STATUSES = Object.keys(TRANSITIONS);
const TERMINAL = ALL_STATUSES.filter((s) => TRANSITIONS[s].length === 0);
const ACTIVE = ['AVAILABLE', 'MATCHED', 'DRIVER_ASSIGNED', 'PICKED_UP'];

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

// Timestamp columns stamped when a status is entered.
const STAMP = {
  MATCHED: 'matched_at',
  PICKED_UP: 'picked_up_at',
  DELIVERED: 'delivered_at',
  CANCELLED: 'cancelled_at',
};

function recordEvent(donationId, from, to, { actor, note } = {}) {
  return db.run(
    `INSERT INTO donation_events (donation_id, from_status, to_status, actor_user_id, actor_role, note, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [donationId, from, to, actor ? actor.id : null, actor ? actor.role : 'SYSTEM', note || null, now()]
  );
}

/**
 * Moves a donation to `to`, enforcing the transition table.
 * Must be called inside a transaction. Returns the updated row.
 * Throws 409 if the donation moved underneath us (concurrent request) or the hop is illegal.
 */
async function setStatus(donationId, to, { actor, note, extra = {} } = {}) {
  const current = await db.get('SELECT * FROM donations WHERE id = ?', [donationId]);
  if (!current) throw new HttpError(404, 'Donation not found');
  const from = current.status;
  if (from === to) throw new HttpError(409, `Donation is already ${to}`);
  if (!canTransition(from, to)) {
    throw new HttpError(409, `Cannot change a donation from ${from} to ${to.replace('_', ' ')}`);
  }

  const sets = ['status = ?', 'updated_at = ?'];
  const values = [to, now()];
  if (STAMP[to]) { sets.push(`${STAMP[to]} = ?`); values.push(now()); }
  for (const [col, val] of Object.entries(extra)) { sets.push(`${col} = ?`); values.push(val); }

  // Guarded by the status we read, so two concurrent requests cannot both win.
  const res = await db.run(
    `UPDATE donations SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
    [...values, donationId, from]
  );
  if (res.changes !== 1) throw new HttpError(409, 'This donation was just updated by someone else. Please refresh.');

  await recordEvent(donationId, from, to, { actor, note });
  return db.get('SELECT * FROM donations WHERE id = ?', [donationId]);
}

const history = async (donationId) =>
  (await db.all('SELECT * FROM donation_events WHERE donation_id = ? ORDER BY id ASC', [donationId]))
    .map((e) => ({
      id: e.id,
      from: e.from_status,
      to: e.to_status,
      actorRole: e.actor_role,
      note: e.note,
      at: e.created_at,
    }));

module.exports = { TRANSITIONS, ALL_STATUSES, TERMINAL, ACTIVE, canTransition, setStatus, recordEvent, history };
