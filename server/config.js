// Tunable domain constants in one place. Every value can be overridden with an environment
// variable so the methodology can be changed without touching code. Values are read once at
// startup; see TRACK_A_REQUIREMENTS_AUDIT.md for the reasoning behind each default.
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

module.exports = {
  APP_NAME: process.env.APP_NAME || 'ResQFood',

  // ---- matching ----------------------------------------------------------
  // Score weights must add up to 100 so the result reads as "x / 100".
  WEIGHTS: {
    distance: num('WEIGHT_DISTANCE', 30),
    capacity: num('WEIGHT_CAPACITY', 25),
    preference: num('WEIGHT_PREFERENCE', 20),
    urgency: num('WEIGHT_URGENCY', 25),
  },
  MAX_MATCH_KM: num('MAX_MATCH_KM', 40), // hard cut-off: beyond this a recipient is never eligible
  MAX_SCORE_KM: num('MAX_SCORE_KM', 25), // distance score reaches 0 here
  SAFETY_BUFFER_MIN: num('SAFETY_BUFFER_MIN', 30), // loading/handling time reserved before expiry
  NEED_FACTOR: { HIGH: 1, MEDIUM: 0.75, LOW: 0.5 },
  AVG_SPEED_KMH: num('AVG_SPEED_KMH', 28), // urban delivery van including traffic

  // ---- quantity conversion ----------------------------------------------
  // Rough serving sizes used to turn any unit into comparable "meals" and kilograms.
  // A meal is assumed to be ~400 g of food (a standard cooked portion).
  UNIT_MEALS: { meals: 1, boxes: 1, kg: 2.5, trays: 20, liters: 4 },
  UNIT_KG: { meals: 0.4, boxes: 0.5, kg: 1, trays: 8, liters: 1 },

  // ---- impact estimation -------------------------------------------------
  // Kilograms of CO2e avoided per kilogram of food rescued rather than wasted.
  // Default 2.5 is a mid-range figure for mixed food waste: it covers the emissions already
  // embodied in producing/transporting the food plus the methane avoided by keeping it out of
  // landfill. Published averages for mixed food waste sit roughly between 1.9 and 3.0, so this
  // is deliberately conservative. It is an ESTIMATE, not a measurement.
  CO2E_KG_PER_KG_FOOD: num('CO2E_KG_PER_KG_FOOD', 2.5),
  // Litres of water embodied per kilogram of food rescued (rough mixed-diet average).
  WATER_L_PER_KG_FOOD: num('WATER_L_PER_KG_FOOD', 1000),

  // ---- expiry risk -------------------------------------------------------
  // Minutes of usable time remaining that separate the risk bands.
  EXPIRY_HIGH_RISK_MIN: num('EXPIRY_HIGH_RISK_MIN', 60),
  EXPIRY_MEDIUM_RISK_MIN: num('EXPIRY_MEDIUM_RISK_MIN', 180),
  EXPIRY_WARN_MIN: num('EXPIRY_WARN_MIN', 45), // send the "expiring soon" notification at this point
  PICKUP_REMINDER_MIN: num('PICKUP_REMINDER_MIN', 90), // nudge an assigned driver this long before expiry
  MAX_EXPIRY_HORIZON_MS: num('MAX_EXPIRY_HOURS', 168) * 3600 * 1000, // reject absurd expiry dates

  // ---- auth rate limiting ------------------------------------------------
  // Attempts allowed per IP per window. Generous enough that a live demo switching
  // between three roles never trips it, tight enough to stop credential stuffing.
  LOGIN_ATTEMPTS: num('LOGIN_ATTEMPTS', 25),
  LOGIN_WINDOW_MIN: num('LOGIN_WINDOW_MIN', 15),

  // ---- dispatch ----------------------------------------------------------
  MAX_ACTIVE_PER_DRIVER: num('MAX_ACTIVE_PER_DRIVER', 2),

  // ---- background sweeps -------------------------------------------------
  SWEEP_INTERVAL_MS: num('SWEEP_INTERVAL_MS', 60000),
};
