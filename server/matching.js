// Transparent, rule-based matching. No AI involved, and no external service is required.
//
// Hard filters (a recipient is skipped if ANY fails - "never route unsafe or undeliverable food"):
//   - donation not expired
//   - recipient currently marked available
//   - recipient within MAX_MATCH_KM
//   - recipient accepts the food category
//   - free capacity >= meals
//   - delivery can complete before expiry: travel time + SAFETY_BUFFER_MIN <= time left
//
// Score (0-100) for eligible recipients, weights from config.js:
//   Distance   30  linear: full marks at 0 km, 0 at MAX_SCORE_KM
//   Capacity   25  headroom (free / 2x meals, capped) scaled by how much the NGO says it needs
//   Preference 20  full marks if the category is explicitly listed, 60% if it accepts anything
//   Urgency    25  share of remaining shelf life still spare after travel + buffer
//                  (short-dated food therefore strongly favours nearby recipients)
//
// Ineligible recipients are returned too, each with a human-readable `reason`, so the donor UI
// can explain exactly why matching failed instead of silently showing nothing.
const db = require('./db');
const cfg = require('./config');
const { haversineKm, etaMinutes, boundingBox } = require('./geo');

const { WEIGHTS, MAX_MATCH_KM, MAX_SCORE_KM, SAFETY_BUFFER_MIN, NEED_FACTOR } = cfg;

const toMeals = (q, unit) => Math.max(1, Math.round(q * cfg.UNIT_MEALS[unit]));
const toKg = (q, unit) => Math.round(q * cfg.UNIT_KG[unit] * 10) / 10;

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const round1 = (x) => Math.round(x * 10) / 10;

function parseTypes(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// recipient: row from recipientRows(). donation: needs pickup_lat/lng, category, meals, expiry_time.
function scoreRecipient(donation, r, nowMs = Date.now()) {
  const available = r.capacity - r.current_load;
  const out = { recipientId: r.id, organizationName: r.organization_name, available };
  const timeLeftMin = (Date.parse(donation.expiry_time) - nowMs) / 60000;
  const km = haversineKm(
    { lat: donation.pickup_lat, lng: donation.pickup_lng },
    { lat: r.lat, lng: r.lng }
  );
  const distanceKm = round1(km);
  const eta = etaMinutes(km);
  Object.assign(out, { distanceKm, etaMinutes: eta, address: r.address });

  const types = parseTypes(r.accepted_food_types);
  const no = (code, reason) => ({ ...out, eligible: false, code, reason });

  if (timeLeftMin <= 0) return no('EXPIRED', 'Food has expired');
  if (!r.is_available) {
    return no('UNAVAILABLE', `${r.organization_name} is not accepting donations right now`);
  }
  if (km > MAX_MATCH_KM) return no('TOO_FAR', `Too far away (${distanceKm} km)`);
  if (types.length && !types.includes(donation.category)) {
    return no('CATEGORY', `Does not accept ${donation.category} food`);
  }
  if (available < donation.meals) {
    return no('CAPACITY', `Not enough capacity (${Math.max(available, 0)} of ${donation.meals} meals free)`);
  }
  if (timeLeftMin < eta + SAFETY_BUFFER_MIN) {
    return no('TOO_LATE', `Cannot reach them before the food expires (needs ~${Math.round(eta + SAFETY_BUFFER_MIN)} min, ${Math.round(timeLeftMin)} min left)`);
  }

  const distancePts = WEIGHTS.distance * clamp(1 - km / MAX_SCORE_KM);
  const headroom = clamp(available / (donation.meals * 2));
  const capacityPts = WEIGHTS.capacity * headroom * (NEED_FACTOR[r.current_need] ?? 0.75);
  const explicit = types.includes(donation.category);
  const preferencePts = explicit ? WEIGHTS.preference : WEIGHTS.preference * 0.6;
  const slack = timeLeftMin - (eta + SAFETY_BUFFER_MIN);
  const urgencyPts = WEIGHTS.urgency * clamp(slack / timeLeftMin);

  const breakdown = {
    distance: {
      label: 'Distance',
      max: WEIGHTS.distance,
      points: round1(distancePts),
      detail: `${distanceKm} km away (~${eta} min drive)`,
    },
    capacity: {
      label: 'Capacity',
      max: WEIGHTS.capacity,
      points: round1(capacityPts),
      detail: `${available} meals free, need level ${r.current_need}`,
    },
    preference: {
      label: 'Food preference',
      max: WEIGHTS.preference,
      points: round1(preferencePts),
      detail: explicit ? `Explicitly accepts ${donation.category}` : 'Accepts all food types',
    },
    urgency: {
      label: 'Urgency',
      max: WEIGHTS.urgency,
      points: round1(urgencyPts),
      detail: `${Math.round(slack)} min of usable time to spare after delivery`,
    },
  };
  const score = round1(distancePts + capacityPts + preferencePts + urgencyPts);
  return { ...out, eligible: true, score, breakdown };
}

const BASE_SQL = `SELECT r.*, u.address, u.lat, u.lng, u.name AS contact_name, u.phone
   FROM recipients r JOIN users u ON u.id = r.user_id
   WHERE u.lat IS NOT NULL AND u.lng IS NOT NULL`;

/**
 * Candidate recipients. When a pickup point is given, only rows inside the lat/lng bounding
 * box for MAX_MATCH_KM are read (index-backed), so matching does not scan every recipient in
 * the country - this is what keeps it fast as the dataset grows beyond one city.
 */
async function recipientRows(pickup = null) {
  if (!pickup || !Number.isFinite(pickup.lat) || !Number.isFinite(pickup.lng)) {
    return db.all(BASE_SQL);
  }
  const b = boundingBox(pickup.lat, pickup.lng, MAX_MATCH_KM);
  return db.all(
    BASE_SQL + ' AND u.lat BETWEEN ? AND ? AND u.lng BETWEEN ? AND ?',
    [b.minLat, b.maxLat, b.minLng, b.maxLng]
  );
}

// Scores every nearby recipient. Returns eligible ones sorted best-first, plus the rejected
// ones with the reason they were rejected.
async function evaluateRecipients(donation, { exclude = [] } = {}) {
  const nearby = await recipientRows({ lat: donation.pickup_lat, lng: donation.pickup_lng });
  const scored = nearby
    .filter((r) => !exclude.includes(r.id))
    // A donation that already holds a reservation should not be penalised by its own booking.
    .map((r) =>
      donation.status === 'MATCHED' && r.id === donation.matched_recipient_id
        ? { ...r, current_load: Math.max(0, r.current_load - donation.meals) }
        : r
    )
    .map((r) => scoreRecipient(donation, r));

  return {
    eligible: scored.filter((c) => c.eligible).sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm),
    rejected: scored.filter((c) => !c.eligible).sort((a, b) => a.distanceKm - b.distanceKm),
  };
}

// Ranked eligible recipients, best first.
const rankRecipients = async (donation, opts) => (await evaluateRecipients(donation, opts)).eligible;

// One-line explanation of why nothing matched, built from the rejection reasons.
function summariseFailure(rejected) {
  if (!rejected.length) return 'No recipient organisations are registered within range yet';
  const counts = rejected.reduce((acc, r) => ({ ...acc, [r.code]: (acc[r.code] || 0) + 1 }), {});
  const label = {
    CAPACITY: 'not enough free capacity',
    CATEGORY: 'does not accept this food category',
    TOO_FAR: 'too far away',
    TOO_LATE: 'cannot deliver before it expires',
    UNAVAILABLE: 'currently unavailable',
    EXPIRED: 'the food has expired',
  };
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${n} ${label[code] || code}`);
  return `Checked ${rejected.length} nearby organisation${rejected.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

module.exports = {
  scoreRecipient, rankRecipients, evaluateRecipients, recipientRows,
  summariseFailure, toMeals, toKg, parseTypes, WEIGHTS,
};
