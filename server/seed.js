// Demo data (Jaipur). Idempotent: skips users that already exist. All passwords: demo1234
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
    r: { organizationName: 'Hope Shelter', capacity: 60, need: 'HIGH', types: ['cooked', 'bakery'] },
  },
  {
    role: 'RECIPIENT', name: 'Seva Food Bank Contact', email: 'ngo2@demo.com', address: 'Sanganer, Jaipur', lat: 26.8226, lng: 75.7967, phone: '+91 98290 00006',
    r: { organizationName: 'Seva Food Bank', capacity: 300, need: 'MEDIUM', types: [] },
  },
  {
    role: 'RECIPIENT', name: 'Asha Kiran Contact', email: 'ngo3@demo.com', address: 'Jhotwara, Jaipur', lat: 26.9466, lng: 75.7403, phone: '+91 98290 00007',
    r: { organizationName: 'Asha Kiran Orphanage', capacity: 40, need: 'LOW', types: ['cooked', 'dairy', 'produce'] },
  },
];

let created = 0;
for (const u of users) {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(u.email)) continue;
  const t = now();
  const res = db
    .prepare('INSERT INTO users (name,email,password_hash,role,phone,address,lat,lng,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(u.name, u.email, hash, u.role, u.phone, u.address, u.lat, u.lng, t, t);
  if (u.r) {
    db.prepare('INSERT INTO recipients (user_id, organization_name, capacity, current_need, accepted_food_types, created_at) VALUES (?,?,?,?,?,?)')
      .run(Number(res.lastInsertRowid), u.r.organizationName, u.r.capacity, u.r.need, JSON.stringify(u.r.types), t);
  }
  created++;
}

console.log(`Seeded ${created} new demo users (password for all: ${PASSWORD})`);
for (const u of users) console.log(`  ${u.role.padEnd(9)} ${u.email}`);
