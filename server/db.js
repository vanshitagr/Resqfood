const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('DONOR','RECIPIENT','DRIVER')),
  phone TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  organization_name TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  current_load INTEGER NOT NULL DEFAULT 0 CHECK (current_load >= 0),
  current_need TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (current_need IN ('LOW','MEDIUM','HIGH')),
  accepted_food_types TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL REFERENCES users(id),
  food_type TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL,
  meals INTEGER NOT NULL,
  weight_kg REAL NOT NULL,
  pickup_address TEXT NOT NULL,
  pickup_lat REAL NOT NULL,
  pickup_lng REAL NOT NULL,
  expiry_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE','MATCHED','PICKED_UP','DELIVERED','EXPIRED')),
  matched_recipient_id INTEGER REFERENCES recipients(id),
  match_score REAL,
  match_breakdown TEXT,
  recipient_accepted INTEGER NOT NULL DEFAULT 0,
  declined_recipients TEXT NOT NULL DEFAULT '[]',
  driver_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
CREATE INDEX IF NOT EXISTS idx_donations_donor ON donations(donor_id);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donation_id INTEGER NOT NULL UNIQUE REFERENCES donations(id),
  driver_id INTEGER REFERENCES users(id),
  pickup_address TEXT NOT NULL,
  pickup_lat REAL NOT NULL,
  pickup_lng REAL NOT NULL,
  drop_address TEXT NOT NULL,
  drop_lat REAL NOT NULL,
  drop_lng REAL NOT NULL,
  distance_km REAL NOT NULL,
  eta_minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','ASSIGNED','PICKED_UP','DELIVERED','CANCELLED')),
  pickup_time TEXT,
  delivery_time TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  donation_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
`);

module.exports = db;
