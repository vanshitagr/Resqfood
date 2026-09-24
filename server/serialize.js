const db = require('./db');
const { parseTypes } = require('./matching');
const { expiryRisk } = require('./lib');

// ---------------------------------------------------------------- privacy
// Exact coordinates, street addresses and phone numbers are only released to the people
// actually involved in a donation (its donor, the matched organisation, the assigned driver).
// Everyone else sees a ~1 km approximation and a general area name, which is enough to judge
// distance and decide whether to claim a donation, but not enough to identify a doorstep.
const COARSE_DP = 2; // 2 decimal places of latitude is roughly 1.1 km
const coarse = (v) => (v == null ? null : Math.round(v * 10 ** COARSE_DP) / 10 ** COARSE_DP);

// "12 Foo Street, Malviya Nagar, Jaipur" -> "Malviya Nagar, Jaipur"
function generalArea(address) {
  if (!address) return null;
  const parts = String(address).split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join(', ') : parts.join(', ');
}

// True when this user is the donor, the matched organisation, or the assigned driver.
async function involvedWithRecipient(userId, recipientId) {
  if (!recipientId) return false;
  const row = await db.get(
    `SELECT 1 AS found FROM donations d
     LEFT JOIN recipients r ON r.id = d.matched_recipient_id
     WHERE d.matched_recipient_id = ? AND (d.donor_id = ? OR d.driver_id = ? OR r.user_id = ?)
     LIMIT 1`,
    [recipientId, userId, userId, userId]
  );
  return !!row;
}

const DONATION_SQL = `
SELECT d.*, du.name AS donor_name, du.phone AS donor_phone,
       r.organization_name AS recipient_name, r.is_verified AS recipient_verified, ru.address AS recipient_address,
       ru.lat AS recipient_lat, ru.lng AS recipient_lng, ru.phone AS recipient_phone,
       ru.id AS recipient_user_id, dr.name AS driver_name, dr.phone AS driver_phone,
       dl.id AS delivery_id, dl.status AS delivery_status
FROM donations d
JOIN users du ON du.id = d.donor_id
LEFT JOIN recipients r ON r.id = d.matched_recipient_id
LEFT JOIN users ru ON ru.id = r.user_id
LEFT JOIN users dr ON dr.id = d.driver_id
LEFT JOIN deliveries dl ON dl.donation_id = d.id`;

const donationById = (id) => db.get(DONATION_SQL + ' WHERE d.id = ?', [id]);

// AVAILABLE is the spec's POSTED state; surfaced under both names so either vocabulary works.
const STATUS_LABEL = {
  AVAILABLE: 'Posted / available',
  MATCHED: 'Matched',
  DRIVER_ASSIGNED: 'Driver assigned',
  PICKED_UP: 'Picked up',
  DELIVERED: 'Delivered',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

/**
 * `full` releases the exact pickup point and street address. Callers must only pass true for
 * the donor, the matched organisation or the assigned driver (see detailFor in routes).
 */
function donationOut(row, full = true) {
  const risk = expiryRisk(row.expiry_time);
  return {
    id: row.id,
    donorId: row.donor_id,
    donorName: row.donor_name,
    foodType: row.food_type,
    category: row.category,
    description: row.description,
    quantity: row.quantity,
    unit: row.unit,
    meals: row.meals,
    weightKg: row.weight_kg,
    pickupAddress: full ? row.pickup_address : generalArea(row.pickup_address),
    pickupLat: full ? row.pickup_lat : coarse(row.pickup_lat),
    pickupLng: full ? row.pickup_lng : coarse(row.pickup_lng),
    approximateLocation: !full,
    expiryTime: row.expiry_time,
    expiryRisk: row.status === 'DELIVERED' ? 'NONE' : risk.risk,
    minutesLeft: risk.minutesLeft,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    matchedRecipientId: row.matched_recipient_id,
    recipientName: row.recipient_name,
    recipientVerified: !!row.recipient_verified,
    recipientAddress: full ? row.recipient_address : generalArea(row.recipient_address),
    recipientLat: full ? row.recipient_lat : coarse(row.recipient_lat),
    recipientLng: full ? row.recipient_lng : coarse(row.recipient_lng),
    matchScore: row.match_score,
    matchBreakdown: row.match_breakdown ? JSON.parse(row.match_breakdown) : null,
    matchFailureReason: row.match_failure_reason,
    recipientAccepted: !!row.recipient_accepted,
    driverId: row.driver_id,
    driverName: row.driver_name,
    deliveryId: row.delivery_id,
    deliveryStatus: row.delivery_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    matchedAt: row.matched_at,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
  };
}

// `full` releases the street address and contact details - own profile or involved parties only.
const recipientOut = (r, full = false) => ({
  id: r.id,
  userId: r.user_id,
  organizationName: r.organization_name,
  capacity: r.capacity,
  currentLoad: r.current_load,
  available: r.capacity - r.current_load,
  currentNeed: r.current_need,
  acceptedFoodTypes: parseTypes(r.accepted_food_types),
  isAvailable: !!r.is_available,
  availabilityNote: r.availability_note,
  isVerified: !!r.is_verified,
  verifiedAt: r.verified_at,
  address: full ? r.address : generalArea(r.address),
  lat: full ? r.lat : coarse(r.lat),
  lng: full ? r.lng : coarse(r.lng),
  approximateLocation: !full,
  ...(full ? { contactName: r.contact_name, contactPhone: r.phone } : {}),
});

const userOut = async (u) => {
  const out = {
    id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone,
    address: u.address, lat: u.lat, lng: u.lng,
    authProvider: u.google_id ? 'google' : 'password',
    hasPassword: !!u.password_hash,
    createdAt: u.created_at,
  };
  if (u.role === 'RECIPIENT') {
    const r = await db.get(
      'SELECT r.*, u.address, u.lat, u.lng, u.name AS contact_name, u.phone FROM recipients r JOIN users u ON u.id = r.user_id WHERE r.user_id = ?',
      [u.id]
    );
    if (r) out.recipient = recipientOut(r, true); // own profile: full detail
  }
  return out;
};

const DELIVERY_SQL = `
SELECT dl.*, d.food_type, d.category, d.meals, d.weight_kg, d.expiry_time, d.donor_id,
       d.status AS donation_status, d.matched_recipient_id,
       du.name AS donor_name, du.phone AS donor_phone,
       r.organization_name AS recipient_name, r.is_verified AS recipient_verified,
       r.user_id AS recipient_user_id, ru.phone AS recipient_phone,
       dr.name AS driver_name, dr.phone AS driver_phone, dr.lat AS driver_lat, dr.lng AS driver_lng
FROM deliveries dl
JOIN donations d ON d.id = dl.donation_id
JOIN users du ON du.id = d.donor_id
JOIN recipients r ON r.id = d.matched_recipient_id
JOIN users ru ON ru.id = r.user_id
LEFT JOIN users dr ON dr.id = dl.driver_id`;

const deliveryById = (id) => db.get(DELIVERY_SQL + ' WHERE dl.id = ?', [id]);

// `full` releases exact pickup/drop points - the assigned driver, donor and recipient only.
// An open task in the pool shows an approximate area until a driver accepts it.
const deliveryOut = (x, full = true) => {
  const risk = expiryRisk(x.expiry_time);
  return {
    id: x.id,
    donationId: x.donation_id,
    driverId: x.driver_id,
    driverName: x.driver_name,
    driverLat: x.driver_lat,
    driverLng: x.driver_lng,
    foodType: x.food_type,
    category: x.category,
    meals: x.meals,
    weightKg: x.weight_kg,
    expiryTime: x.expiry_time,
    expiryRisk: x.status === 'DELIVERED' ? 'NONE' : risk.risk,
    minutesLeft: risk.minutesLeft,
    donorName: x.donor_name,
    recipientName: x.recipient_name,
    recipientVerified: !!x.recipient_verified,
    pickupAddress: full ? x.pickup_address : generalArea(x.pickup_address),
    pickupLat: full ? x.pickup_lat : coarse(x.pickup_lat),
    pickupLng: full ? x.pickup_lng : coarse(x.pickup_lng),
    dropAddress: full ? x.drop_address : generalArea(x.drop_address),
    dropLat: full ? x.drop_lat : coarse(x.drop_lat),
    dropLng: full ? x.drop_lng : coarse(x.drop_lng),
    approximateLocation: !full,
    distanceKm: x.distance_km,
    etaMinutes: x.eta_minutes,
    status: x.status,
    donationStatus: x.donation_status,
    pickupTime: x.pickup_time,
    deliveryTime: x.delivery_time,
    createdAt: x.created_at,
  };
};

module.exports = {
  DONATION_SQL, donationById, donationOut, recipientOut, userOut, STATUS_LABEL,
  DELIVERY_SQL, deliveryById, deliveryOut, involvedWithRecipient, generalArea, coarse,
};
