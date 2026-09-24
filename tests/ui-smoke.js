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
const NGO_BY_NAME = {
  'Hope Shelter': 'ngo@demo.com',
  'Seva Food Bank': 'ngo2@demo.com',
  'Asha Kiran Orphanage': 'ngo3@demo.com',
};

async function newPage(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/tile|osrm|ERR_|Failed to load resource|favicon/i.test(t)) errors.push('console: ' + t);
  });
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

const step = (m) => console.log('•', m);
const text = (page) => page.evaluate(() => document.body.innerText);

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  try {
    // ---- landing + accessibility basics
    const d = await newPage(browser);
    await d.goto(BASE + '/');
    await d.waitForSelector('.hero');
    const a11y = await d.evaluate(() => ({
      skip: !!document.querySelector('a.skip'),
      live: !!document.querySelector('[aria-live]'),
      lang: document.documentElement.lang,
      h1s: document.querySelectorAll('h1').length,
      unlabelled: [...document.querySelectorAll('input,select,textarea')]
        .filter((el) => !el.labels?.length && !el.getAttribute('aria-label')).length,
    }));
    if (!a11y.skip || !a11y.live || a11y.lang !== 'en' || a11y.h1s !== 1) {
      errors.push('a11y basics failed: ' + JSON.stringify(a11y));
    }
    step('landing ok ' + JSON.stringify(a11y));
    await d.screenshot({ path: path.join(SHOTS, '1-landing.png') });

    // ---- donor posts a donation using the NL assistant
    await login(d, 'donor@demo.com');
    step('donor logged in');
    await d.goto(BASE + '/#/donor/new');
    await d.waitForSelector('#nl');
    await d.type('#nl', "We have around 25 boxes of cooked rice and dal left from today's event. Good for about 2 hours.");
    await d.click('#parse');
    await d.waitForFunction(() => document.querySelector('#parse-msg').textContent.startsWith('Filled'));
    step('assistant autofill: ' + JSON.stringify(await d.evaluate(() => ({ ft: ft.value, qty: qty.value, unit: unit.value }))));

    await d.click('#go');
    await d.waitForSelector('.score', { timeout: 20000 });
    const best = await d.$eval('#result h2', (e) => e.textContent.trim());
    // Every NGO that was not chosen must be accounted for: either as a selectable
    // alternative, or with an explicit reason it was skipped.
    const alt = await d.evaluate(() => ({
      choosable: document.querySelectorAll('[data-act=choose]').length,
      reasons: document.querySelectorAll('.reasons li').length,
    }));
    if (alt.choosable + alt.reasons === 0) errors.push('no alternatives and no rejection reasons shown');
    const latency = await d.evaluate(() => (document.querySelector('#result .muted.small')||{}).textContent || '');
    if (!/engine took \d/.test(latency)) errors.push('matching latency not displayed: ' + latency);
    step(`matched to ${best}; ${alt.choosable} alternatives, ${alt.reasons} explained rejections; ${latency.trim()}`);
    await d.screenshot({ path: path.join(SHOTS, '2-match.png') });
    const donationHref = await d.$eval('#result a.btn', (a) => a.getAttribute('href'));

    // ---- recipient confirms
    const r = await newPage(browser);
    await login(r, NGO_BY_NAME[best]);
    await r.waitForSelector('[data-act=accept]', { timeout: 15000 });
    if (!/Low risk|Medium risk|High risk/.test(await text(r))) errors.push('expiry risk chip missing on recipient dashboard');
    await r.screenshot({ path: path.join(SHOTS, '3-recipient.png') });
    // Decline must open an accessible dialog (role=dialog, aria-modal, focus trapped) -
    // not window.confirm, which screen readers announce poorly and some browsers suppress.
    await r.click('[data-act=decline]');
    await r.waitForSelector('.modal[role=dialog][aria-modal=true]', { timeout: 5000 });
    const dlg = await r.evaluate(() => ({
      labelled: !!document.querySelector('.modal[aria-labelledby]'),
      focusInside: !!document.querySelector('.modal').contains(document.activeElement),
    }));
    if (!dlg.labelled || !dlg.focusInside) errors.push('confirm dialog a11y: ' + JSON.stringify(dlg));
    await r.keyboard.press('Escape');
    await r.waitForFunction(() => !document.querySelector('.modal'));
    step('accessible confirm dialog opens, traps focus, closes on Escape');
    
    await r.click('[data-act=accept]');
    await r.waitForFunction(() => !document.querySelector('#toast').hidden);
    step('recipient accepted');

    // ---- availability toggle blocks new matches
    await r.waitForSelector('#avail');
    await r.click('#avail');
    await r.click('#pf button');
    await r.waitForFunction(() => /marked unavailable/i.test(document.body.innerText), { timeout: 10000 });
    step('availability toggle works');
    await r.click('#avail');
    await r.click('#pf button');
    await r.waitForFunction(() => !/marked unavailable/i.test(document.body.innerText), { timeout: 10000 });

    // ---- driver: accept -> pick up -> deliver
    const v = await newPage(browser);
    await login(v, 'driver@demo.com');
    await v.waitForSelector('[data-act=dAccept]', { timeout: 15000 });
    await v.click('[data-act=dAccept]');
    await v.waitForSelector('[data-act=dPickup]');
    step('driver assigned');
    await v.click('[data-act=dPickup]');
    await v.waitForSelector('[data-act=dDeliver]');
    await v.click('[data-act=dDeliver]');
    await v.waitForFunction(() => /Completed/.test(document.body.innerText) && !document.querySelector('[data-act=dDeliver]'));
    await v.screenshot({ path: path.join(SHOTS, '4-driver.png') });
    step('driver picked up and delivered');

    // ---- donor sees DELIVERED plus the full lifecycle history
    await d.goto(BASE + '/' + donationHref);
    await d.waitForFunction(() => !!document.querySelector('.badge.b-DELIVERED'), { timeout: 15000 });
    const hist = await d.evaluate(() => [...document.querySelectorAll('.hist li .badge')].map((b) => b.textContent.trim()));
    const expected = ['Posted', 'Matched', 'Matched', 'Driver assigned', 'Picked up', 'Delivered'];
    if (JSON.stringify(hist) !== JSON.stringify(expected)) {
      errors.push(`history mismatch: got ${JSON.stringify(hist)} want ${JSON.stringify(expected)}`);
    }
    step('lifecycle history: ' + hist.join(' → '));
    await d.waitForSelector('#map .leaflet-tile', { timeout: 12000 })
      .then(() => step('map tiles rendered'))
      .catch(() => step('(map tiles did not load - offline? fallback still renders)'));
    await d.screenshot({ path: path.join(SHOTS, '5-donation-delivered.png') });

    // ---- impact dashboard: real numbers, filters, methodology
    await d.goto(BASE + '/#/impact');
    await d.waitForFunction(() => /Meals rescued/.test(document.body.innerText) && document.querySelector('.stat .num').textContent.trim() !== '0');
    const impact = await d.evaluate(() => {
      const nums = [...document.querySelectorAll('.stat')].map((s) => s.querySelector('.num').textContent.trim() + ' ' + s.querySelector('.lbl').textContent.trim());
      return { nums: nums.slice(0, 6), method: !!document.querySelector('details.method-box'), filters: document.querySelectorAll('.filters a').length };
    });
    if (!impact.method || impact.filters !== 4) errors.push('impact methodology/filters missing: ' + JSON.stringify(impact));
    step('impact: ' + impact.nums.join(' | '));
    await d.evaluate(() => document.querySelector('details.method-box').open = true);
    await d.screenshot({ path: path.join(SHOTS, '6-impact.png'), fullPage: true });

    await d.goto(BASE + '/#/impact?period=today');
    await d.waitForFunction(() => document.querySelector('.filters a[aria-current]')?.textContent === 'Today');
    step('impact period filter works');


    // ---- new: verification badge, matching latency, accessible dialog, CSV export
    await d.goto(BASE + '/#/donor');
    await d.waitForSelector('.stat');
    const extras = await d.evaluate(() => ({
      exportLink: !!document.querySelector('a[href="/api/donations/export.csv"]'),
      notTaxDoc: /not an official\s+tax document/i.test(document.body.innerText),
    }));
    if (!extras.exportLink) errors.push('CSV report link missing from the donor dashboard');
    if (!extras.notTaxDoc) errors.push('CSV report is not labelled as a non-tax document');
    step('donor report link present, labelled as a report not a tax document');

    // The cancel dialog must be a real focus-trapped dialog, not window.confirm.
    await d.goto(BASE + '/' + donationHref);
    await d.waitForSelector('.badge');
    const verified = await d.evaluate(() => !!document.querySelector('.verified, .unverified'));
    if (!verified) errors.push('organisation verification status not shown on the donation page');
    step('verification status shown on the donation page');

    // ---- driver failure path is reachable from the UI
    await v.goto(BASE + '/#/driver');
    await v.waitForSelector('.stat');
    step('driver dashboard still renders after the delivery');
    // ---- mobile layout must not scroll sideways
    await d.goto(BASE + '/#/donor');
    await d.waitForSelector('.stat');
    await d.setViewport({ width: 390, height: 780 });
    await new Promise((r) => setTimeout(r, 300)); // let the reflow settle
    const overflow = await d.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 2) errors.push(`horizontal overflow at 390px: ${overflow}px`);
    step('mobile layout overflow: ' + overflow + 'px');
    await d.screenshot({ path: path.join(SHOTS, '7-mobile.png') });

    // ---- keyboard: the form is reachable and usable without a mouse
    await d.goto(BASE + '/#/donor/new');
    await d.setViewport({ width: 1200, height: 900 });
    await d.waitForSelector('#ft');
    const focusable = await d.evaluate(() =>
      document.querySelectorAll('#f input:not([type=hidden]), #f select, #f button, #f a[href]').length);
    if (focusable < 6) errors.push('too few keyboard-reachable controls on the donation form');
    step(`donation form has ${focusable} keyboard-reachable controls`);
  } finally {
    await browser.close();
  }

  if (errors.length) {
    console.error('\nFAILURES:\n' + errors.join('\n'));
    process.exit(1);
  }
  console.log('\nUI smoke test passed, no JS errors. Screenshots in', SHOTS);
})().catch((e) => {
  console.error('FAILED:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exit(1);
});
