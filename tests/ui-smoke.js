// Drives the real UI in headless Chrome against a running, seeded server (npm run seed && npm start).
// Usage: node tests/ui-smoke.js [baseUrl] [screenshotDir]
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://localhost:3000';
const SHOTS = process.argv[3] || path.join(__dirname, '..', 'data', 'shots');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
fs.mkdirSync(SHOTS, { recursive: true });

const errors = [];
const NGO_BY_NAME = { 'Hope Shelter': 'ngo@demo.com', 'Seva Food Bank': 'ngo2@demo.com', 'Asha Kiran Orphanage': 'ngo3@demo.com' };

async function newPage(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/tile|osrm|ERR_|Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text()); });
  return page;
}
async function login(page, email) {
  await page.goto(BASE + '/#/login');
  await page.waitForSelector('#email');
  await page.type('#email', email);
  await page.type('#pw', 'demo1234');
  await page.click('#f button');
  await page.waitForFunction(() => /#\/(donor|recipient|driver)$/.test(location.hash));
}
const clickText = async (page, sel, text) => {
  await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].some((e) => e.textContent.includes(t)), { timeout: 10000 }, sel, text);
  await page.evaluate((s, t) => [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t)).click(), sel, text);
};
const step = (m) => console.log('•', m);

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    // ---- donor
    const d = await newPage(browser);
    await d.goto(BASE + '/'); await d.waitForSelector('.hero');
    await d.screenshot({ path: path.join(SHOTS, '1-landing.png') });
    await login(d, 'donor@demo.com'); step('donor logged in');
    await d.goto(BASE + '/#/donor/new'); await d.waitForSelector('#nl', { timeout: 5000 }).catch(async (e) => { console.log('DEBUG', location_dump = await d.evaluate(() => location.hash + ' | ' + document.querySelector('#app').innerText.slice(0, 200))); throw e; });
    await d.type('#nl', "We have around 25 boxes of cooked rice and dal left from today's event. Good for about 2 hours.");
    await d.click('#parse');
    await d.waitForFunction(() => document.querySelector('#parse-msg').textContent.startsWith('Filled'));
    const filled = await d.evaluate(() => ({ ft: ft.value, qty: qty.value, unit: unit.value }));
    step('AI/rule autofill: ' + JSON.stringify(filled));
    await d.click('#go');
    await d.waitForSelector('.score', { timeout: 15000 });
    const best = await d.$eval('#result h2', (e) => e.textContent);
    await d.screenshot({ path: path.join(SHOTS, '2-match.png') });
    step('matched to ' + best);
    const donationHref = await d.$eval('#result a.btn', (a) => a.getAttribute('href'));

    // ---- recipient
    const r = await newPage(browser);
    await login(r, NGO_BY_NAME[best]); step('recipient logged in');
    await r.waitForSelector('[data-act=accept]', { timeout: 15000 });
    await r.screenshot({ path: path.join(SHOTS, '3-recipient.png') });
    await r.click('[data-act=accept]');
    await r.waitForFunction(() => document.querySelector('#toast') && !document.querySelector('#toast').hidden);
    step('recipient accepted');

    // ---- driver
    const v = await newPage(browser);
    await login(v, 'driver@demo.com'); step('driver logged in');
    await v.waitForSelector('[data-act=dAccept]', { timeout: 15000 });
    await v.click('[data-act=dAccept]');
    await v.waitForSelector('[data-act=dPickup]'); await v.click('[data-act=dPickup]');
    await v.waitForSelector('[data-act=dDeliver]'); await v.click('[data-act=dDeliver]');
    await v.waitForFunction(() => /Completed/.test(document.body.innerText) && !document.querySelector('[data-act=dDeliver]'));
    await v.screenshot({ path: path.join(SHOTS, '4-driver.png') });
    step('driver picked up + delivered');

    // ---- donor sees final status; impact updates
    await d.goto(BASE + '/' + donationHref);
    await d.waitForFunction(() => document.querySelector('.badge.b-DELIVERED'), { timeout: 10000 });
    await d.waitForSelector('#map .leaflet-tile', { timeout: 10000 }).catch(() => step('(map tiles not loaded - offline?)'));
    await d.screenshot({ path: path.join(SHOTS, '5-donation-delivered.png') });
    step('donor sees DELIVERED');
    await d.goto(BASE + '/#/impact');
    await d.waitForFunction(() => /Meals rescued/.test(document.body.innerText) && !/^0$/.test(document.querySelector('.stat .num').textContent.trim()));
    await d.screenshot({ path: path.join(SHOTS, '6-impact.png') });
    step('impact dashboard shows ' + (await d.$eval('.stat .num', (e) => e.textContent)) + ' meals');
  } finally {
    await browser.close();
  }
  if (errors.length) { console.error('JS ERRORS:\n' + errors.join('\n')); process.exit(1); }
  console.log('UI smoke test passed, no JS errors. Screenshots in', SHOTS);
})().catch((e) => { console.error('FAILED:', e.message); if (errors.length) console.error(errors.join('\n')); process.exit(1); });
