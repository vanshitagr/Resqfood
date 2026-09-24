// Shared signup validation + user creation, used by BOTH password registration and Google
// sign-up so the two paths can never drift apart in what they accept or how they store it.
const db = require('./db');
const { HttpError, now, str, CATEGORIES } = require('./lib');
const { resolveLocation } = require('./geo');

const ROLES = ['DONOR', 'RECIPIENT', 'DRIVER'];
const NEEDS = ['LOW', 'MEDIUM', 'HIGH'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validEmail(value) {
  const email = str(value, 'Email', { max: 200 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Invalid email address');
  return email;
}

function validPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new HttpError(400, 'Password must be 8-128 characters');
  }
  return value;
}

/**
 * Validates the shared profile fields and resolves the location to coordinates.
 * Never trusts a client-supplied role beyond checking it is one of the three known values.
 */
async function validateProfile(body) {
  const b = body || {};
  if (!ROLES.includes(b.role)) throw new HttpError(400, 'Role must be DONOR, RECIPIENT or DRIVER');

  const profile = {
    role: b.role,
    name: str(b.name, 'Name', { min: 2, max: 100 }),
    phone: str(b.phone, 'Phone', { min: 5, max: 30, required: false }),
    address: str(b.address, 'Location', { min: 2, max: 300 }),
  };

  if (b.role === 'RECIPIENT') {
    profile.organizationName = str(b.organizationName, 'Organization name', { min: 2, max: 120 });
    const capacity = Number(b.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000) {
      throw new HttpError(400, 'Capacity must be a whole number of meals between 1 and 100000');
    }
    profile.capacity = capacity;
    profile.currentNeed = NEEDS.includes(b.currentNeed) ? b.currentNeed : 'MEDIUM';
    const types = Array.isArray(b.acceptedFoodTypes) ? b.acceptedFoodTypes : [];
    if (!types.every((t) => CATEGORIES.includes(t))) throw new HttpError(400, 'Invalid food type preference');
    profile.acceptedFoodTypes = [...new Set(types)];
  }

  const loc = await resolveLocation({ address: profile.address, lat: b.lat, lng: b.lng });
  profile.lat = loc.lat;
  profile.lng = loc.lng;
  return profile;
}

/**
 * Inserts the user (and recipient row). Call inside a transaction.
 * Exactly one of passwordHash / googleId must be supplied.
 */
async function createUser({ profile, email, passwordHash = null, googleId = null, emailVerified = 0 }) {
  if (await db.get('SELECT 1 AS found FROM users WHERE email = ?', [email])) {
    throw new HttpError(409, 'An account with this email already exists');
  }
  const t = now();
  const { id } = await db.insert(
    `INSERT INTO users (name, email, password_hash, google_id, email_verified, role, phone, address, lat, lng, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [profile.name, email, passwordHash, googleId, emailVerified ? 1 : 0, profile.role,
      profile.phone, profile.address, profile.lat, profile.lng, t, t]
  );

  if (profile.role === 'RECIPIENT') {
    await db.run(
      `INSERT INTO recipients (user_id, organization_name, capacity, current_need, accepted_food_types, is_available, created_at)
       VALUES (?,?,?,?,?,1,?)`,
      [id, profile.organizationName, profile.capacity, profile.currentNeed, JSON.stringify(profile.acceptedFoodTypes), t]
    );
  }
  return id;
}

/**
 * Run after a signup transaction commits. A newly registered organisation may be exactly what
 * donations that previously found no recipient were waiting for, so matching is re-run for
 * donations near it straight away rather than on the next sweep.
 */
async function afterSignup(profile) {
  if (profile.role !== 'RECIPIENT') return 0;
  try {
    return await require('./service').rematchNear(profile.lat, profile.lng, 'a new organisation registered nearby');
  } catch (err) {
    console.error('[signup] re-match failed:', err.message); // never blocks the signup response
    return 0;
  }
}

module.exports = { ROLES, NEEDS, validEmail, validPassword, validateProfile, createUser, afterSignup };
