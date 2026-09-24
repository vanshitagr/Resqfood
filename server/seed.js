// Demo data. Idempotent: skips users that already exist. All passwords: demo1234
//
// Deliberately spans three cities (Jaipur, Delhi, Mumbai) to show that nothing in the matching
// logic is tied to one place: distance is pure geography, so the Delhi donor matches Delhi
// shelters and never a Jaipur one 240 km away.
const bcrypt = require('bcryptjs');
const db = require('./db');
const { now } = require('./lib');

const PASSWORD = 'demo1234';
const hash = bcrypt.hashSync(PASSWORD, 10);

const users = [
  { role: 'DONOR', name: 'Rasoi Restaurant', email: 'donor@demo.com', address: 'Malviya Nagar, Jaipur', lat: 26.8549, lng: 75.8243, phone: '+91 98290 00001' },
  { role: 'DONOR', name: 'Spice Route Caterers', email: 'donor2@demo.com', address: 'C-Scheme, Jaipur', lat: 26.9092, lng: 75.8, phone: '+91 98290 00002' },
  { role: 'DRIVER', name: 'Ravi Kumar', email: 'driver@demo.com', address: 'Tonk Road, Jaipur', lat: 26.8697, lng: 75.8009, phone: '+91 98290 00003' },
  { role: 'DRIVER', name: 'Meera Singh', email: 'driver2@demo.com', address: 'Mansarovar, Jaipur', lat: 26.8535, lng: 75.7627, phone: '+91 98290 00004' },
  {
    role: 'RECIPIENT', name: 'Hope Shelter Contact', email: 'ngo@demo.com', address: 'Raja Park, Jaipur', lat: 26.8996, lng: 75.8306, phone: '+91 98290 00005',
    r: { organizationName: 'Hope Shelter', capacity: 60, need: 'HIGH', types: ['cooked', 'bakery'], verified: true },
  },
  {
    role: 'RECIPIENT', name: 'Seva Food Bank Contact', email: 'ngo2@demo.com', address: 'Sanganer, Jaipur', lat: 26.8226, lng: 75.7967, phone: '+91 98290 00006',
    r: { organizationName: 'Seva Food Bank', capacity: 300, need: 'MEDIUM', types: [], verified: false },
  },
  {
    role: 'RECIPIENT', name: 'Asha Kiran Contact', email: 'ngo3@demo.com', address: 'Jhotwara, Jaipur', lat: 26.9466, lng: 75.7403, phone: '+91 98290 00007',
    r: { organizationName: 'Asha Kiran Orphanage', capacity: 40, need: 'LOW', types: ['cooked', 'dairy', 'produce'], verified: true },
  },

  // ---- second city: Delhi ----
  { role: 'DONOR', name: 'Connaught Grill', email: 'donor.delhi@demo.com', address: 'Connaught Place, New Delhi', lat: 28.6315, lng: 77.2167, phone: '+91 98110 00001' },
  { role: 'DRIVER', name: 'Arjun Mehta', email: 'driver.delhi@demo.com', address: 'Karol Bagh, New Delhi', lat: 28.6519, lng: 77.1909, phone: '+91 98110 00002' },
  {
    role: 'RECIPIENT', name: 'Delhi Annakshetra Contact', email: 'ngo.delhi@demo.com', address: 'Paharganj, New Delhi', lat: 28.6442, lng: 77.2167, phone: '+91 98110 00003',
    r: { organizationName: 'Delhi Annakshetra', capacity: 200, need: 'HIGH', types: [], verified: true },
  },

  // ---- third city: Mumbai ----
  { role: 'DONOR', name: 'Bandra Bakehouse', email: 'donor.mumbai@demo.com', address: 'Bandra West, Mumbai', lat: 19.0596, lng: 72.8295, phone: '+91 98200 00001' },
  {
    role: 'RECIPIENT', name: 'Roti Bank Contact', email: 'ngo.mumbai@demo.com', address: 'Dadar, Mumbai', lat: 19.0178, lng: 72.8478, phone: '+91 98200 00002',
    r: { organizationName: 'Mumbai Roti Bank', capacity: 150, need: 'MEDIUM', types: ['cooked', 'bakery'], verified: false },
  },
];

async function seed() {
  await db.init();

  let created = 0;
  for (const u of users) {
    if (await db.get('SELECT 1 AS found FROM users WHERE email = ?', [u.email])) continue;
    const t = now();
    const { id } = await db.insert(
      `INSERT INTO users (name, email, password_hash, role, phone, address, lat, lng, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [u.name, u.email, hash, u.role, u.phone, u.address, u.lat, u.lng, t, t]
    );
    if (u.r) {
      await db.run(
        `INSERT INTO recipients (user_id, organization_name, capacity, current_need, accepted_food_types,
           is_verified, verified_at, verification_note, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          id, u.r.organizationName, u.r.capacity, u.r.need, JSON.stringify(u.r.types),
          u.r.verified ? 1 : 0, u.r.verified ? t : null,
          u.r.verified ? 'Registration documents checked by the platform team' : null, t,
        ]
      );
    }
    created++;
  }

  console.log(`Seeded ${created} new demo users into ${db.describe} (password for all: ${PASSWORD})`);
  const city = (a) => a.split(',').pop().trim();
  for (const u of users) {
    console.log(`  ${u.role.padEnd(9)} ${u.email.padEnd(24)} ${city(u.address)}${u.r && u.r.verified ? '  [verified org]' : ''}`);
  }
  await db.close();
}

seed().catch((err) => {
  console.error('[seed] failed:', err.message);
  process.exit(1);
});
