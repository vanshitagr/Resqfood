const db = require('./db');
const { parseTypes } = require('./matching');

const DONATION_SQL = `
SELECT d.*, du.name AS donor_name, du.phone AS donor_phone,
       r.organization_name AS recipient_name, ru.address AS recipient_address,
       ru.lat AS recipient_lat, ru.lng AS recipient_lng, ru.phone AS recipient_phone,
       ru.id AS recipient_user_id, dr.name AS driver_name, dr.phone AS driver_phone,
       dl.id AS delivery_id, dl.status AS delivery_status
FROM donations d
JOIN users du ON du.id = d.donor_id
LEFT JOIN recipients r ON r.id = d.matched_recipient_id
LEFT JOIN users ru ON ru.id = r.user_id
LEFT JOIN users dr ON dr.id = d.driver_id
LEFT JOIN deliveries dl ON dl.donation_id = d.id`;

const donationById = (id) => db.prepare(DONATION_SQL + ' WHERE d.id = ?').get(id);

function donationOut(row) {
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
    pickupAddress: row.pickup_address,
    pickupLat: row.pickup_lat,
    pickupLng: row.pickup_lng,
    expiryTime: row.expiry_time,
    status: row.status,
    matchedRecipientId: row.matched_recipient_id,
    recipientName: row.recipient_name,
    recipientAddress: row.recipient_address,
    recipientLat: row.recipient_lat,
    recipientLng: row.recipient_lng,
    matchScore: row.match_score,
    matchBreakdown: row.match_breakdown ? JSON.parse(row.match_breakdown) : null,
    recipientAccepted: !!row.recipient_accepted,
    driverId: row.driver_id,
    driverName: row.driver_name,
    deliveryId: row.delivery_id,
    deliveryStatus: row.delivery_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

const recipientOut = (r) => ({
  id: r.id,
  userId: r.user_id,
  organizationName: r.organization_name,
  capacity: r.capacity,
  currentLoad: r.current_load,
  available: r.capacity - r.current_load,
  currentNeed: r.current_need,
  acceptedFoodTypes: parseTypes(r.accepted_food_types),
  address: r.address,
  lat: r.lat,
  lng: r.lng,
});

const userOut = (u) => {
  const out = {
    id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone,
    address: u.address, lat: u.lat, lng: u.lng, createdAt: u.created_at,
  };
  if (u.role === 'RECIPIENT') {
    const r = db
      .prepare('SELECT r.*, u.address, u.lat, u.lng FROM recipients r JOIN users u ON u.id = r.user_id WHERE r.user_id = ?')
      .get(u.id);
    if (r) out.recipient = recipientOut(r);
  }
  return out;
};

const DELIVERY_SQL = `
SELECT dl.*, d.food_type, d.category, d.meals, d.weight_kg, d.expiry_time, d.donor_id,
       d.status AS donation_status, d.matched_recipient_id,
       du.name AS donor_name, du.phone AS donor_phone,
       r.organization_name AS recipient_name, r.user_id AS recipient_user_id, ru.phone AS recipient_phone,
       dr.name AS driver_name, dr.phone AS driver_phone, dr.lat AS driver_lat, dr.lng AS driver_lng
FROM deliveries dl
JOIN donations d ON d.id = dl.donation_id
JOIN users du ON du.id = d.donor_id
JOIN recipients r ON r.id = d.matched_recipient_id
JOIN users ru ON ru.id = r.user_id
LEFT JOIN users dr ON dr.id = dl.driver_id`;

const deliveryById = (id) => db.prepare(DELIVERY_SQL + ' WHERE dl.id = ?').get(id);

const deliveryOut = (x) => ({
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
  donorName: x.donor_name,
  recipientName: x.recipient_name,
  pickupAddress: x.pickup_address,
  pickupLat: x.pickup_lat,
  pickupLng: x.pickup_lng,
  dropAddress: x.drop_address,
  dropLat: x.drop_lat,
  dropLng: x.drop_lng,
  distanceKm: x.distance_km,
  etaMinutes: x.eta_minutes,
  status: x.status,
  donationStatus: x.donation_status,
  pickupTime: x.pickup_time,
  deliveryTime: x.delivery_time,
  createdAt: x.created_at,
});

module.exports = {
  DONATION_SQL, donationById, donationOut, recipientOut, userOut,
  DELIVERY_SQL, deliveryById, deliveryOut,
};
