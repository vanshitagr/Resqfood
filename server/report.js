// Donation & impact report export.
//
// This is a record of activity on the platform, NOT an official tax document: the platform does
// not appraise donated goods, issue receipts on behalf of any organisation, or represent any tax
// authority. The wording below is deliberate - it says "report", never "receipt" or "deduction".
// A donor's accountant can use the underlying data, but the substantiation is between the donor
// and the receiving organisation.
const db = require('./db');
const cfg = require('./config');

const COLUMNS = [
  'donation_id', 'status', 'created_at', 'matched_at', 'picked_up_at', 'delivered_at', 'expiry_time',
  'food_type', 'category', 'quantity', 'unit', 'estimated_meals', 'estimated_weight_kg',
  'estimated_co2e_kg', 'donor', 'recipient_organization', 'driver', 'pickup_area', 'dropoff_area',
];

// RFC 4180 quoting: wrap in quotes and double any embedded quote. A leading =, +, - or @ is
// prefixed with a quote so spreadsheet software cannot execute it as a formula.
function cell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

const SQL = `
SELECT d.*, du.name AS donor_name, r.organization_name AS recipient_name,
       ru.address AS recipient_address, dr.name AS driver_name
FROM donations d
JOIN users du ON du.id = d.donor_id
LEFT JOIN recipients r ON r.id = d.matched_recipient_id
LEFT JOIN users ru ON ru.id = r.user_id
LEFT JOIN users dr ON dr.id = d.driver_id`;

// Each role exports only the rows it is entitled to see.
async function rowsFor(user) {
  if (user.role === 'DONOR') {
    return db.all(SQL + ' WHERE d.donor_id = ? ORDER BY d.created_at DESC', [user.id]);
  }
  if (user.role === 'RECIPIENT') {
    const rec = await db.get('SELECT id FROM recipients WHERE user_id = ?', [user.id]);
    if (!rec) return [];
    return db.all(SQL + ' WHERE d.matched_recipient_id = ? ORDER BY d.created_at DESC', [rec.id]);
  }
  return db.all(SQL + ' WHERE d.driver_id = ? ORDER BY d.created_at DESC', [user.id]);
}

// Street addresses are reduced to an area even in the owner's own export, so a shared
// spreadsheet never carries someone else's doorstep.
const area = (address) => {
  if (!address) return '';
  const parts = String(address).split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join(', ') : parts.join(', ');
};

async function exportCsv(user) {
  const rows = await rowsFor(user);
  const lines = [COLUMNS.join(',')];

  for (const d of rows) {
    // CO2e is only attributed to donations that were actually delivered.
    const co2e = d.status === 'DELIVERED' ? Math.round(d.weight_kg * cfg.CO2E_KG_PER_KG_FOOD * 100) / 100 : 0;
    lines.push([
      d.id, d.status, d.created_at, d.matched_at, d.picked_up_at, d.delivered_at, d.expiry_time,
      d.food_type, d.category, d.quantity, d.unit, d.meals, d.weight_kg, co2e,
      d.donor_name, d.recipient_name, d.driver_name, area(d.pickup_address), area(d.recipient_address),
    ].map(cell).join(','));
  }

  const delivered = rows.filter((d) => d.status === 'DELIVERED');
  const totalMeals = delivered.reduce((n, d) => n + d.meals, 0);
  const totalKg = Math.round(delivered.reduce((n, d) => n + d.weight_kg, 0) * 10) / 10;

  lines.push('');
  lines.push(cell(`Summary for ${user.name} (${user.role.toLowerCase()})`));
  lines.push([cell('Donations listed'), cell(rows.length)].join(','));
  lines.push([cell('Successfully delivered'), cell(delivered.length)].join(','));
  lines.push([cell('Meals delivered (estimated)'), cell(totalMeals)].join(','));
  lines.push([cell('Weight delivered kg (estimated)'), cell(totalKg)].join(','));
  lines.push([cell('CO2e avoided kg (estimated)'), cell(Math.round(totalKg * cfg.CO2E_KG_PER_KG_FOOD * 10) / 10)].join(','));
  lines.push('');
  lines.push(cell(`Generated ${new Date().toISOString()} by ${cfg.APP_NAME}.`));
  lines.push(cell(
    'This is a donation and impact REPORT, not an official tax document or donation receipt. ' +
    'Meal, weight and CO2e figures are estimates produced from standard conversion factors ' +
    `(${cfg.CO2E_KG_PER_KG_FOOD} kg CO2e per kg of food rescued), not measurements. ` +
    'For tax substantiation, obtain a receipt directly from the receiving organisation.'
  ));

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    filename: `donation-report-${user.role.toLowerCase()}-${stamp}.csv`,
    csv: lines.join('\r\n'),
    rowCount: rows.length,
  };
}

module.exports = { exportCsv, COLUMNS };
