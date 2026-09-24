// Transparent, rule-based matching. No AI involved.
//
// Hard filters (a recipient is skipped if ANY fails - "never match unsafe food"):
//   - donation not expired
//   - recipient within MAX_KM
//   - recipient accepts the food category
//   - free capacity >= meals
//   - delivery can complete before expiry: travel time + SAFETY_MIN buffer <= time left
//
// Score (0-100) for eligible recipients:
//   Distance   30  linear: 30 at 0 km, 0 at MAX_SCORE_KM
//   Capacity   25  headroom (free / 2x meals, capped) scaled by how much the NGO says it needs
//   Preference 20  20 = explicitly lists the category, 12 = accepts anything
//   Urgency    25  share of remaining shelf life left after travel + buffer
//                  (short-dated food strongly favours nearby recipients)
const db = require('./db');
const { haversineKm, etaMinutes } = require('./geo');

const WEIGHTS = { distance: 30, capacity: 25, preference: 20, urgency: 25 };
const MAX_KM = 40;
const MAX_SCORE_KM = 25;
const SAFETY_MIN = 30; // loading + handling buffer
const NEED_FACTOR = { HIGH: 1, MEDIUM: 0.75, LOW: 0.5 };

const UNIT_MEALS = { meals: 1, boxes: 1, kg: 2.5, trays: 20, liters: 4 };
const UNIT_KG = { meals: 0.4, boxes: 0.5, kg: 1, trays: 8, liters: 1 };
const toMeals = (q, unit) => Math.max(1, Math.round(q * UNIT_MEALS[unit]));
const toKg = (q, unit) => Math.round(q * UNIT_KG[unit] * 10) / 10;

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
  if (timeLeftMin <= 0) return { ...out, eligible: false, reason: 'Food has expired' };
  if (km > MAX_KM) return { ...out, eligible: false, reason: `Too far (${distanceKm} km)` };
  if (types.length && !types.includes(donation.category)) {
    return { ...out, eligible: false, reason: `Does not accept ${donation.category} food` };
  }
  if (available < donation.meals) {
    return { ...out, eligible: false, reason: `Not enough capacity (${Math.max(available, 0)} meals free)` };
  }
  if (timeLeftMin < eta + SAFETY_MIN) {
    return { ...out, eligible: false, reason: 'Cannot be delivered before the food expires' };
  }

  const distancePts = WEIGHTS.distance * clamp(1 - km / MAX_SCORE_KM);
  const headroom = clamp(available / (donation.meals * 2));
  const capacityPts = WEIGHTS.capacity * headroom * (NEED_FACTOR[r.current_need] ?? 0.75);
  const explicit = types.includes(donation.category);
  const preferencePts = explicit ? WEIGHTS.preference : WEIGHTS.preference * 0.6;
  const slack = timeLeftMin - (eta + SAFETY_MIN);
  const urgencyPts = WEIGHTS.urgency * clamp(slack / timeLeftMin);

  const breakdown = {
    distance: {
      label: 'Distance',
      max: WEIGHTS.distance,
      points: round1(distancePts),
      detail: `${distanceKm} km away (~${eta} min)`,
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
      detail: `${Math.round(slack)} min of shelf life to spare after delivery`,
    },
  };
  const score = round1(distancePts + capacityPts + preferencePts + urgencyPts);
  return { ...out, eligible: true, score, breakdown };
}

const recipientRows = () =>
  db
    .prepare(
      `SELECT r.*, u.address, u.lat, u.lng, u.name AS contact_name, u.phone
       FROM recipients r JOIN users u ON u.id = r.user_id
       WHERE u.lat IS NOT NULL AND u.lng IS NOT NULL`
    )
    .all();

// Ranked eligible recipients, best first.
// If the donation already holds a reservation, credit it back so the current match isn't penalised by itself.
function rankRecipients(donation, { exclude = [] } = {}) {
  return recipientRows()
    .filter((r) => !exclude.includes(r.id))
    .map((r) =>
      donation.status === 'MATCHED' && r.id === donation.matched_recipient_id
        ? { ...r, current_load: Math.max(0, r.current_load - donation.meals) }
        : r
    )
    .map((r) => scoreRecipient(donation, r))
    .filter((c) => c.eligible)
    .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm);
}

module.exports = { scoreRecipient, rankRecipients, recipientRows, toMeals, toKg, parseTypes, WEIGHTS };
