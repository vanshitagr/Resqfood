const { HttpError } = require('./lib');
const { AVG_SPEED_KMH } = require('./config');

const R_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

const etaMinutes = (km) => Math.max(1, Math.round((km / AVG_SPEED_KMH) * 60));

/**
 * Lat/lng window that certainly contains every point within `km` of the centre.
 * Used as an index-backed pre-filter before the exact haversine check, so matching never
 * has to read recipients on the other side of the country.
 */
function boundingBox(lat, lng, km) {
  const dLat = km / 111.32;
  // Degrees of longitude shrink towards the poles; guard against division by ~0.
  const dLng = km / Math.max(1e-6, 111.32 * Math.cos(rad(lat)));
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLng: Math.max(-180, lng - dLng),
    maxLng: Math.min(180, lng + dLng),
  };
}

const validCoord = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// Last-resort offline fallback so the demo still works with no internet access. Online
// geocoding (below) covers the whole world; this table only helps when that call fails.
// Nothing in the matching logic depends on these entries. Longest key wins.
const PLACES = {
  'malviya nagar': [26.8549, 75.8243],
  'vaishali nagar': [26.9126, 75.7422],
  'c-scheme': [26.9092, 75.8],
  'c scheme': [26.9092, 75.8],
  mansarovar: [26.8535, 75.7627],
  jhotwara: [26.9466, 75.7403],
  sanganer: [26.8226, 75.7967],
  'raja park': [26.8996, 75.8306],
  'tonk road': [26.8697, 75.8009],
  'civil lines': [26.9138, 75.7873],
  jaipur: [26.9124, 75.7873],
  delhi: [28.6139, 77.209],
  mumbai: [19.076, 72.8777],
  bengaluru: [12.9716, 77.5946],
  bangalore: [12.9716, 77.5946],
  hyderabad: [17.385, 78.4867],
  chennai: [13.0827, 80.2707],
  kolkata: [22.5726, 88.3639],
  pune: [18.5204, 73.8567],
  ahmedabad: [23.0225, 72.5714],
  lucknow: [26.8467, 80.9462],
  chandigarh: [30.7333, 76.7794],
  udaipur: [24.5854, 73.7125],
  jodhpur: [26.2389, 73.0243],
  kota: [25.2138, 75.8648],
  'new york': [40.7128, -74.006],
  london: [51.5074, -0.1278],
  'san francisco': [37.7749, -122.4194],
};

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function offlineGeocode(query) {
  const q = query.toLowerCase();
  const key = Object.keys(PLACES)
    .filter((k) => q.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  let [lat, lng] = PLACES[key];
  if (q.trim() !== key) {
    // Spread distinct addresses within the same area so they don't all collapse to one point.
    const h = hash(q);
    lat += ((h % 1000) / 1000 - 0.5) * 0.03;
    lng += (((h >> 10) % 1000) / 1000 - 0.5) * 0.03;
  }
  return { lat, lng, approximate: true };
}

async function geocode(query) {
  if (process.env.GEOCODE_ONLINE !== '0') {
    try {
      const url =
        'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'resqfood-hackathon/1.0' },
        signal: AbortSignal.timeout(3500),
      });
      if (res.ok) {
        const data = await res.json();
        if (data[0]) return { lat: Number(data[0].lat), lng: Number(data[0].lon), approximate: false };
      }
    } catch {
      /* fall through to offline table */
    }
  }
  return offlineGeocode(query);
}

const has = (v) => v !== undefined && v !== null && v !== '';

// Accepts explicit coordinates (validated) or an address to geocode.
async function resolveLocation({ address, lat, lng }) {
  if (has(lat) && has(lng)) {
    const la = Number(lat);
    const ln = Number(lng);
    if (!validCoord(la, ln)) throw new HttpError(400, 'Invalid coordinates');
    return { lat: la, lng: ln };
  }
  if (!has(address)) throw new HttpError(400, 'Location is required');
  const g = await geocode(String(address));
  if (!g) {
    throw new HttpError(400, 'Could not find that location. Try a more specific address or use "Use my location".');
  }
  return g;
}

module.exports = { haversineKm, etaMinutes, boundingBox, resolveLocation, validCoord, AVG_SPEED_KMH };
