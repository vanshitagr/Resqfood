(() => {
  'use strict';

  // ------------------------------------------------------------- helpers
  const $ = (s, r = document) => r.querySelector(s);
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CATS = { cooked: 'Cooked meals', produce: 'Fresh produce', bakery: 'Bakery', packaged: 'Packaged', dairy: 'Dairy', beverages: 'Beverages' };
  const HOME = { DONOR: '#/donor', RECIPIENT: '#/recipient', DRIVER: '#/driver' };
  const state = { me: null, gen: 0, timers: [], map: null, notifOpen: false, notifs: { items: [], unread: 0 } };

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');
  function timeLeft(iso) {
    const m = Math.round((Date.parse(iso) - Date.now()) / 60000);
    if (m <= 0) return 'expired';
    return (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`) + ' left';
  }
  const badge = (s) => `<span class="badge b-${esc(s)}">${esc(s.replace('_', ' '))}</span>`;
  const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const loading = () => (app.innerHTML = '<p class="muted"><span class="spinner"></span> Loading…</p>');
  const errBox = (e) => `<div class="err" role="alert">${esc(e.message || e)}</div>`;

  function clearTimers() {
    state.timers.forEach(clearInterval);
    state.timers = [];
  }

  // Re-fetch every few seconds; only re-render when the data actually changed.
  function poll(fetcher, render, ms = 8000) {
    let last = null;
    const gen = state.gen; // results that arrive after navigating away are dropped
    const run = async (force) => {
      try {
        const data = await fetcher();
        if (gen !== state.gen) return;
        const sig = JSON.stringify(data);
        if (force || sig !== last) {
          last = sig;
          render(data);
        }
      } catch (e) {
        if (gen !== state.gen) return;
        if (e.status === 401) return go('#/login');
        if (force) app.innerHTML = errBox(e);
      }
    };
    run(true);
    state.timers.push(setInterval(() => !document.hidden && run(false), ms));
  }

  const go = (hash) => {
    if (location.hash === hash) route();
    else location.hash = hash;
  };

  // ------------------------------------------------------------ nav + bell
  function renderNav() {
    const me = state.me;
    const link = (href, text) => `<a class="link ${location.hash.startsWith(href) ? 'active' : ''}" href="${href}">${text}</a>`;
    $('#nav').innerHTML = `
      <a class="brand" href="#/">🍲 Surplus-to-Shelter</a>
      ${me ? link(HOME[me.role], 'Dashboard') : ''}
      ${me && me.role === 'DONOR' ? link('#/donor/new', 'Donate food') : ''}
      ${link('#/impact', 'Impact')}
      <span class="right row">
        ${me
          ? `<button class="bell" data-act="bell" aria-label="Notifications">🔔${state.notifs.unread ? `<span class="dot">${state.notifs.unread}</span>` : ''}</button>
             <span class="small muted">${esc(me.name)} · ${esc(me.role.toLowerCase())}</span>
             <button class="btn ghost sm" data-act="logout">Log out</button>`
          : `${link('#/login', 'Log in')}<a class="btn sm" href="#/register">Sign up</a>`}
      </span>
      ${state.notifOpen ? notifPanel() : ''}`;
  }

  function notifPanel() {
    const items = state.notifs.items;
    return `<div class="notif-panel">${items.length
      ? items.map((n) => `<div class="n ${n.read ? '' : 'unread'}">${n.donationId ? `<a href="#/donation/${n.donationId}" data-act="closeNotif">${esc(n.message)}</a>` : esc(n.message)}<div class="small muted">${fmt(n.createdAt)}</div></div>`).join('')
      : '<p class="muted small" style="padding:8px">No notifications yet.</p>'}</div>`;
  }

  async function refreshNotifs() {
    if (!state.me) return;
    try {
      const d = await api('/notifications');
      const changed = d.unread !== state.notifs.unread || d.notifications.length !== state.notifs.items.length;
      state.notifs = { items: d.notifications, unread: d.unread };
      if (changed) renderNav();
    } catch { /* ignore */ }
  }
  setInterval(() => !document.hidden && refreshNotifs(), 10000);

  // --------------------------------------------------------------- actions
  const actions = {
    async logout() {
      await api('/auth/logout', { method: 'POST', body: {} });
      state.me = null;
      state.notifs = { items: [], unread: 0 };
      go('#/');
    },
    async bell() {
      state.notifOpen = !state.notifOpen;
      renderNav();
      if (state.notifOpen && state.notifs.unread) {
        await api('/notifications/read', { method: 'POST', body: {} });
        state.notifs.unread = 0;
        setTimeout(renderNav, 0);
      }
    },
    closeNotif() { state.notifOpen = false; renderNav(); },
    async accept(d) { await doAction(`/donations/${d.id}/accept`, 'Donation confirmed - drivers have been notified'); },
    async decline(d) {
      if (!confirm('Decline this donation? We will try the next best recipient.')) return;
      await doAction(`/donations/${d.id}/decline`, 'Declined');
    },
    async dAccept(d) { await doAction(`/deliveries/${d.id}/accept`, 'Delivery accepted'); },
    async dPickup(d) { await doAction(`/deliveries/${d.id}/pickup`, 'Marked as picked up'); },
    async dDeliver(d) { await doAction(`/deliveries/${d.id}/deliver`, 'Delivered - thank you!'); },
    async choose(d) {
      const r = await api(`/donations/${d.id}/match`, { method: 'POST', body: { recipientId: Number(d.rid) } });
      toast(r.matching.matched ? 'Recipient changed' : 'Could not match');
      if ($('#result')) renderMatchResult(r.donation, { ...r.matching, candidates: state.lastCands || [] }); // new-donation page
      else route();
    },
  };

  async function doAction(path, okMsg) {
    try {
      await api(path, { method: 'POST', body: {} });
      toast(okMsg);
    } catch (e) {
      toast(e.message, true);
    }
    route();
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) {
      if (state.notifOpen && !e.target.closest('.notif-panel')) { state.notifOpen = false; renderNav(); }
      return;
    }
    const fn = actions[el.dataset.act];
    if (!fn) return;
    el.disabled = true;
    try { await fn(el.dataset); } catch (err) { toast(err.message, true); }
    el.disabled = false;
  });

  // ------------------------------------------------------------------- map
  async function drawMap(elId, pts, onRoute) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (typeof L === 'undefined') {
      el.innerHTML = '<p class="muted small" style="padding:12px">Map unavailable offline.</p>';
      return;
    }
    if (state.map) { state.map.remove(); state.map = null; }
    const map = (state.map = L.map(el, { scrollWheelZoom: false }));
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
    const latlngs = pts.map((p) => [p.lat, p.lng]);
    pts.forEach((p) => {
      const icon = L.divIcon({ className: '', html: `<div class="pin ${p.cls || ''}">${p.icon}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
      L.marker([p.lat, p.lng], { icon }).addTo(map).bindTooltip(p.label, { permanent: false });
    });
    map.fitBounds(latlngs, { padding: [40, 40], maxZoom: 15 });
    const line = L.polyline(latlngs, { color: '#1f8f4e', weight: 4, dashArray: '8 8' }).addTo(map);
    try {
      const coords = pts.map((p) => `${p.lng},${p.lat}`).join(';');
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      const route = data.routes && data.routes[0];
      if (route && state.map === map) {
        line.remove();
        const geo = L.geoJSON(route.geometry, { style: { color: '#1f8f4e', weight: 5 } }).addTo(map);
        map.fitBounds(geo.getBounds(), { padding: [40, 40] });
        onRoute && onRoute({ km: Math.round(route.distance / 100) / 10, min: Math.max(1, Math.round(route.duration / 60)) });
      }
    } catch { /* keep straight dashed line */ }
  }

  // --------------------------------------------------------------- landing
  async function pageLanding() {
    let s = null;
    const gen = state.gen;
    try { s = await api('/stats/impact'); } catch { /* ignore */ }
    if (gen !== state.gen) return;
    const me = state.me;
    app.innerHTML = `
      <section class="hero">
        <h1>Rescue surplus food. Deliver it before it expires.</h1>
        <p>Restaurants, caterers and stores post leftovers in seconds. We instantly match them with the best nearby shelter and dispatch a volunteer driver.</p>
        <div class="row" style="justify-content:center">
          ${me ? `<a class="btn lg" href="${HOME[me.role]}">Go to my dashboard</a>` : `<a class="btn lg" href="#/register">Get started</a><a class="btn ghost lg" href="#/login">Log in</a>`}
          <a class="btn ghost lg" href="#/impact">See our impact</a>
        </div>
        <div class="flow">
          <span class="step">🍽️ Donor posts food</span><span class="arrow">→</span>
          <span class="step">🧠 Smart matching</span><span class="arrow">→</span>
          <span class="step">🏠 NGO confirms</span><span class="arrow">→</span>
          <span class="step">🚚 Driver picks up</span><span class="arrow">→</span>
          <span class="step">📈 Impact tracked</span>
        </div>
      </section>
      ${s ? `<section class="grid g3">
        ${stat(s.mealsRescued.toLocaleString(), 'Meals rescued')}
        ${stat(s.weightKg.toLocaleString() + ' kg', 'Food diverted from waste')}
        ${stat(s.organizationsHelped, 'Organizations helped')}
      </section>` : ''}
      <section class="grid g3" style="margin-top:24px">
        <div class="card"><h3>For donors</h3><p class="muted">Post surplus in under a minute - even by typing a sentence. Track it until it's delivered.</p></div>
        <div class="card"><h3>For shelters &amp; NGOs</h3><p class="muted">Set your capacity and food preferences. Get matched only with food you can use, in time.</p></div>
        <div class="card"><h3>For drivers</h3><p class="muted">See nearby pickups, follow the route on the map and update status in two taps.</p></div>
      </section>`;
  }
  const stat = (num, lbl) => `<div class="card stat"><div class="num">${esc(num)}</div><div class="lbl">${esc(lbl)}</div></div>`;

  // ------------------------------------------------------------ auth pages
  function pageLogin() {
    app.innerHTML = `
      <div class="grid g2">
        <form class="card" id="f">
          <h2>Welcome back</h2>
          <label for="email">Email</label><input id="email" type="email" required autocomplete="username">
          <label for="pw">Password</label><input id="pw" type="password" required autocomplete="current-password">
          <div id="msg"></div>
          <p><button class="btn" style="width:100%">Log in</button></p>
          <p class="muted small">New here? <a href="#/register">Create an account</a></p>
        </form>
        <div class="card flat demo-box">
          <h3>Demo accounts</h3>
          <p class="muted">After running <code>npm run seed</code>, password for all is <code>demo1234</code>.</p>
          <div class="stack">
            ${[['Donor', 'donor@demo.com'], ['NGO / Shelter', 'ngo@demo.com'], ['Driver', 'driver@demo.com']].map(([r, e]) => `<div><b>${r}</b><br><button type="button" class="chip" data-fill="${e}">${e}</button></div>`).join('')}
          </div>
        </div>
      </div>`;
    app.querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => {
      $('#email').value = b.dataset.fill; $('#pw').value = 'demo1234';
    }));
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/auth/login', { method: 'POST', body: { email: $('#email').value, password: $('#pw').value } });
        state.me = r.user;
        refreshNotifs();
        go(HOME[r.user.role]);
      } catch (err) { $('#msg').innerHTML = errBox(err); }
    });
  }

  function locationField(id, initial = '') {
    return `<label for="${id}">Location (address or area)</label>
      <div class="row" style="flex-wrap:nowrap"><input id="${id}" value="${esc(initial)}" placeholder="e.g. Malviya Nagar, Jaipur" required>
      <button type="button" class="btn ghost sm" id="${id}-gps" style="white-space:nowrap">📍 Use my location</button></div>`;
  }
  // Wires the GPS button; returns an object whose .lat/.lng are set only for exact coordinates.
  function wireLocation(id) {
    const c = { lat: null, lng: null };
    const input = $('#' + id);
    input.addEventListener('input', () => { c.lat = c.lng = null; });
    $(`#${id}-gps`).addEventListener('click', () => {
      if (!navigator.geolocation) return toast('Geolocation is not supported', true);
      navigator.geolocation.getCurrentPosition(
        (p) => {
          c.lat = p.coords.latitude; c.lng = p.coords.longitude;
          input.value = `Current location (${c.lat.toFixed(4)}, ${c.lng.toFixed(4)})`;
        },
        () => toast('Could not get your location - type an address instead', true),
        { timeout: 8000 }
      );
    });
    return c;
  }

  function pageRegister() {
    app.innerHTML = `
      <form class="card" id="f" style="max-width:640px;margin:0 auto">
        <h2>Create your account</h2>
        <label for="role">I am a…</label>
        <select id="role">
          <option value="DONOR">Donor (restaurant, store, caterer, cafeteria)</option>
          <option value="RECIPIENT">Shelter / NGO / Food bank</option>
          <option value="DRIVER">Volunteer driver</option>
        </select>
        <div class="form-row">
          <div><label for="name" id="name-l">Business / your name</label><input id="name" required minlength="2" maxlength="100"></div>
          <div><label for="phone">Phone</label><input id="phone" type="tel" maxlength="30"></div>
        </div>
        <div class="form-row">
          <div><label for="email">Email</label><input id="email" type="email" required autocomplete="username"></div>
          <div><label for="pw">Password (min 8)</label><input id="pw" type="password" required minlength="8" autocomplete="new-password"></div>
        </div>
        ${locationField('loc')}
        <div id="rec" hidden>
          <label for="org">Organization name</label><input id="org" maxlength="120">
          <div class="form-row">
            <div><label for="cap">Capacity (meals)</label><input id="cap" type="number" min="1" value="50"></div>
            <div><label for="need">Current need</label><select id="need"><option>LOW</option><option selected>MEDIUM</option><option>HIGH</option></select></div>
          </div>
          <label>Food you accept <span class="muted small">(none selected = everything)</span></label>
          <div class="checks">${Object.entries(CATS).map(([k, v]) => `<label><input type="checkbox" name="cat" value="${k}"> ${v}</label>`).join('')}</div>
        </div>
        <div id="msg"></div>
        <p><button class="btn" style="width:100%">Create account</button></p>
        <p class="muted small">Already registered? <a href="#/login">Log in</a></p>
      </form>`;
    const coords = wireLocation('loc');
    const role = $('#role');
    const sync = () => {
      $('#rec').hidden = role.value !== 'RECIPIENT';
      $('#org').required = role.value === 'RECIPIENT';
      $('#name-l').textContent = role.value === 'DONOR' ? 'Business name' : role.value === 'DRIVER' ? 'Your name' : 'Contact person';
    };
    role.addEventListener('change', sync); sync();
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        role: role.value, name: $('#name').value, phone: $('#phone').value || undefined, email: $('#email').value,
        password: $('#pw').value, address: $('#loc').value, lat: coords.lat ?? undefined, lng: coords.lng ?? undefined,
      };
      if (role.value === 'RECIPIENT') {
        body.organizationName = $('#org').value;
        body.capacity = Number($('#cap').value);
        body.currentNeed = $('#need').value;
        body.acceptedFoodTypes = [...app.querySelectorAll('[name=cat]:checked')].map((c) => c.value);
      }
      try {
        const r = await api('/auth/register', { method: 'POST', body });
        state.me = r.user;
        toast('Welcome aboard!');
        go(HOME[r.user.role]);
      } catch (err) { $('#msg').innerHTML = errBox(err); }
    });
  }

  // ----------------------------------------------------------- donor pages
  const donationRow = (d, extra = '') => `
    <div class="item">
      <div class="row between">
        <div><h3><a href="#/donation/${d.id}">${esc(d.foodType)}</a></h3>
          <div class="muted small">${esc(d.quantity)} ${esc(d.unit)} · ${d.meals} meals · ${esc(CATS[d.category] || d.category)}</div></div>
        ${badge(d.status)}
      </div>
      <div class="small muted" style="margin-top:6px">
        ${['AVAILABLE', 'MATCHED'].includes(d.status) ? `⏳ ${timeLeft(d.expiryTime)} · ` : ''}
        ${d.recipientName ? `→ ${esc(d.recipientName)}${d.matchScore != null ? ` (score ${Math.round(d.matchScore)})` : ''}` : 'Not matched yet'}
        ${d.driverName ? ` · 🚚 ${esc(d.driverName)}` : ''}
      </div>${extra}
    </div>`;

  function pageDonor() {
    loading();
    poll(async () => {
      const [s, d] = await Promise.all([api('/stats/me'), api('/donations')]);
      return { s, d: d.donations };
    }, ({ s, d }) => {
      app.innerHTML = `
        <div class="row between"><h1>Donor dashboard</h1><a class="btn lg" href="#/donor/new">＋ Donate food</a></div>
        <div class="grid g3" style="margin:16px 0">
          ${stat(s.total, 'Total donations')}${stat(s.active, 'In progress')}${stat(s.delivered, 'Delivered')}${stat(s.meals, 'Meals rescued')}
        </div>
        <h2>Donation history</h2>
        ${d.length ? d.map((x) => donationRow(x)).join('') : '<div class="card muted">No donations yet. <a href="#/donor/new">Post your first surplus food</a>.</div>'}`;
    });
  }

  function pageNewDonation() {
    const me = state.me;
    const defExpiry = localInput(new Date(Date.now() + 3 * 3600e3));
    app.innerHTML = `
      <h1>Donate surplus food</h1>
      <div class="grid g2">
        <div>
          <div class="card" style="margin-bottom:16px">
            <h3>✨ Describe it in your own words <span class="muted small">(optional)</span></h3>
            <textarea id="nl" placeholder="We have around 25 boxes of cooked rice and dal left from today's event. Good for about 2 hours."></textarea>
            <p class="row"><button type="button" class="btn ghost sm" id="parse">Auto-fill the form</button><span id="parse-msg" class="small muted"></span></p>
          </div>
          <form class="card" id="f">
            <label for="ft">Food type</label><input id="ft" required maxlength="100" placeholder="e.g. Cooked rice">
            <div class="form-row">
              <div><label for="cat">Category</label><select id="cat">${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
              <div></div>
            </div>
            <div class="form-row">
              <div><label for="qty">Quantity</label><input id="qty" type="number" min="0.1" step="any" required></div>
              <div><label for="unit">Unit</label><select id="unit"><option>meals</option><option>boxes</option><option>kg</option><option>trays</option><option>liters</option></select></div>
            </div>
            ${locationField('loc', me.address || '')}
            <label for="exp">Usable until</label>
            <input id="exp" type="datetime-local" value="${defExpiry}" required>
            <div class="row" style="margin-top:6px">${[1, 2, 4, 8].map((h) => `<button type="button" class="chip" data-h="${h}">+${h}h</button>`).join('')}</div>
            <label for="desc">Notes for the driver <span class="muted small">(optional)</span></label>
            <input id="desc" maxlength="500" placeholder="e.g. Ask for Sunil at the back door">
            <div id="msg"></div>
            <p><button class="btn lg" style="width:100%" id="go">Find best recipient</button></p>
          </form>
        </div>
        <div id="result"></div>
      </div>`;
    const coords = wireLocation('loc');
    if (me.lat != null) { coords.lat = me.lat; coords.lng = me.lng; }
    $('#loc').addEventListener('input', () => { if ($('#loc').value !== me.address) coords.lat = coords.lng = null; else { coords.lat = me.lat; coords.lng = me.lng; } });
    app.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => {
      $('#exp').value = localInput(new Date(Date.now() + Number(b.dataset.h) * 3600e3));
    }));

    $('#parse').addEventListener('click', async () => {
      const text = $('#nl').value.trim();
      if (text.length < 3) return;
      $('#parse-msg').textContent = 'Reading…';
      try {
        const r = await api('/ai/parse-donation', { method: 'POST', body: { text } });
        const d = r.data;
        $('#ft').value = d.foodType || '';
        if (CATS[d.category]) $('#cat').value = d.category;
        if (d.quantity) $('#qty').value = d.quantity;
        if (d.unit) $('#unit').value = d.unit;
        if (d.expiryMinutes) $('#exp').value = localInput(new Date(Date.now() + d.expiryMinutes * 60000));
        $('#desc').value = d.description || '';
        $('#parse-msg').textContent = `Filled in (${r.source === 'ai' ? 'AI' : 'quick parser'}). Urgency: ${d.urgency}${d.diet ? ' · ' + d.diet : ''}. Please check the details.`;
      } catch (e) { $('#parse-msg').textContent = e.message; }
    });

    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#msg').innerHTML = '';
      const exp = new Date($('#exp').value);
      const body = {
        foodType: $('#ft').value, category: $('#cat').value, quantity: $('#qty').value, unit: $('#unit').value,
        pickupAddress: $('#loc').value, expiryTime: isNaN(exp) ? '' : exp.toISOString(), description: $('#desc').value || undefined,
      };
      if (coords.lat != null) { body.pickupLat = coords.lat; body.pickupLng = coords.lng; }
      const btn = $('#go');
      btn.disabled = true;
      try {
        await showMatching(body);
      } catch (err) { $('#msg').innerHTML = errBox(err); $('#result').innerHTML = ''; }
      btn.disabled = false;
    });
  }

  async function showMatching(body) {
    const box = $('#result');
    const steps = ['Checking distance', 'Checking capacity', 'Checking food preference', 'Checking expiry'];
    box.innerHTML = `<div class="card"><h3><span class="spinner"></span> Finding best recipient…</h3>
      <ul class="checklist">${steps.map((s) => `<li><span class="tick">✓</span>${s}</li>`).join('')}</ul></div>`;
    const req = api('/donations', { method: 'POST', body }); // run in parallel with the animation
    req.catch(() => {});
    const items = box.querySelectorAll('li');
    for (const li of items) { await sleep(350); li.classList.add('on'); }
    const r = await req;
    renderMatchResult(r.donation, r.matching);
  }

  function breakdownHtml(b) {
    return `<div class="brk">${Object.values(b).map((x) => `
      <span>${esc(x.label)}</span><div class="hbar"><i style="width:${Math.round((x.points / x.max) * 100)}%"></i></div><b>${x.points}/${x.max}</b>
      <div class="d">${esc(x.detail)}</div>`).join('')}</div>`;
  }

  function renderMatchResult(donation, matching) {
    const box = $('#result');
    const best = matching.best;
    state.lastCands = matching.candidates || [];
    const others = (matching.candidates || []).filter((c) => !best || c.recipientId !== best.recipientId);
    if (!matching.matched) {
      box.innerHTML = `<div class="card"><h3>Donation posted ✓</h3>
        <div class="warn">No recipient can safely take this right now (capacity, food type, distance or time). It stays <b>AVAILABLE</b> so any shelter can claim it, and it expires automatically at ${fmt(donation.expiryTime)}.</div>
        <a class="btn" href="#/donation/${donation.id}">View status</a></div>`;
      return;
    }
    box.innerHTML = `<div class="card">
      <ul class="checklist">${['Distance', 'Capacity', 'Food preference', 'Expiry'].map((s) => `<li class="on"><span class="tick">✓</span>${s} checked</li>`).join('')}</ul>
      <div class="muted small">Best match</div>
      <h2 style="margin:0">${esc(best.organizationName)}</h2>
      <div class="muted">${best.distanceKm} km away · ~${best.etaMinutes} min · ${best.available} meals capacity available</div>
      <div class="score">${Math.round(best.score)}<small>/100</small></div>
      ${breakdownHtml(best.breakdown)}
      <div class="note" style="margin-top:14px">Waiting for <b>${esc(best.organizationName)}</b> to confirm. You'll be notified, and a driver is assigned once they do.</div>
      <div class="row"><a class="btn" href="#/donation/${donation.id}">Confirm &amp; track status</a></div>
      ${others.length ? `<h3 style="margin-top:18px">Other options</h3>${others.map((c) => `
        <div class="item row between"><div><b>${esc(c.organizationName)}</b><div class="small muted">${c.distanceKm} km · score ${Math.round(c.score)}</div></div>
        <button class="btn ghost sm" data-act="choose" data-id="${donation.id}" data-rid="${c.recipientId}">Choose this one</button></div>`).join('')}` : ''}
    </div>`;
  }

  // -------------------------------------------------------- donation detail
  const STEPS = ['AVAILABLE', 'MATCHED', 'PICKED_UP', 'DELIVERED'];
  function timelineHtml(d) {
    const idx = STEPS.indexOf(d.status);
    if (d.status === 'EXPIRED') {
      return `<div class="timeline expired">${STEPS.map((s, i) => `<div class="t ${i === 0 ? 'done' : ''} ${i === 1 ? 'bad' : ''}">${i === 1 ? 'EXPIRED' : s.replace('_', ' ')}</div>`).join('')}</div>`;
    }
    return `<div class="timeline">${STEPS.map((s, i) => `<div class="t ${i <= idx ? 'done' : ''}">${s.replace('_', ' ')}</div>`).join('')}</div>`;
  }

  function pageDonation(id) {
    loading();
    poll(async () => {
      const { donation } = await api('/donations/' + id);
      let candidates = null;
      if (state.me.role === 'DONOR' && donation.status === 'MATCHED' && !donation.recipientAccepted) {
        candidates = (await api(`/donations/${id}/candidates`)).candidates;
      }
      return { donation, candidates };
    }, ({ donation: d, candidates }) => {
      const role = state.me.role;
      const mine = role === 'RECIPIENT' && d.status === 'MATCHED' && !d.recipientAccepted;
      app.innerHTML = `
        <p><a href="${HOME[role]}">← Back</a></p>
        <div class="row between"><h1>${esc(d.foodType)}</h1>${badge(d.status)}</div>
        ${timelineHtml(d)}
        <div class="grid g2">
          <div class="card">
            <h3>Donation</h3>
            <dl class="kv">
              <dt>Quantity</dt><dd>${esc(d.quantity)} ${esc(d.unit)} (~${d.meals} meals, ${d.weightKg} kg)</dd>
              <dt>Category</dt><dd>${esc(CATS[d.category] || d.category)}</dd>
              <dt>Donor</dt><dd>${esc(d.donorName)}${d.donorPhone ? ` · ${esc(d.donorPhone)}` : ''}</dd>
              <dt>Pickup</dt><dd>${esc(d.pickupAddress)}</dd>
              <dt>Usable until</dt><dd>${fmt(d.expiryTime)} ${['AVAILABLE', 'MATCHED', 'PICKED_UP'].includes(d.status) ? `<span class="muted">(${timeLeft(d.expiryTime)})</span>` : ''}</dd>
              ${d.description ? `<dt>Notes</dt><dd>${esc(d.description)}</dd>` : ''}
              <dt>Posted</dt><dd>${fmt(d.createdAt)}</dd>
              ${d.deliveredAt ? `<dt>Delivered</dt><dd>${fmt(d.deliveredAt)}</dd>` : ''}
            </dl>
          </div>
          <div class="card">
            <h3>Recipient &amp; driver</h3>
            ${d.recipientName ? `<dl class="kv"><dt>Matched to</dt><dd><b>${esc(d.recipientName)}</b>${d.recipientPhone ? ` · ${esc(d.recipientPhone)}` : ''}</dd>
              <dt>Drop-off</dt><dd>${esc(d.recipientAddress || '-')}</dd>
              <dt>Confirmed</dt><dd>${d.recipientAccepted ? 'Yes ✓' : 'Waiting for confirmation'}</dd>
              <dt>Driver</dt><dd>${d.driverName ? `${esc(d.driverName)}${d.driverPhone ? ` · ${esc(d.driverPhone)}` : ''}` : 'Not assigned yet'}</dd></dl>
              ${d.matchScore != null ? `<div class="score">${Math.round(d.matchScore)}<small>/100 match score</small></div>${d.matchBreakdown ? breakdownHtml(d.matchBreakdown) : ''}` : ''}`
              : '<p class="muted">No recipient matched yet. We keep looking until the food expires.</p>'}
            ${mine ? `<div class="row" style="margin-top:14px"><button class="btn" data-act="accept" data-id="${d.id}">Accept donation</button><button class="btn danger" data-act="decline" data-id="${d.id}">Decline</button></div>` : ''}
            ${role === 'RECIPIENT' && d.status === 'AVAILABLE' ? `<div class="row" style="margin-top:14px"><button class="btn" data-act="accept" data-id="${d.id}">Claim this donation</button></div>` : ''}
            ${d.deliveryId ? `<div style="margin-top:14px"><a class="btn ghost" href="#/delivery/${d.deliveryId}">Track delivery →</a></div>` : ''}
          </div>
        </div>
        ${d.recipientLat != null ? `<div class="card" style="margin-top:16px"><h3>Route <span id="route-info" class="muted small"></span></h3><div id="map" class="map"></div></div>` : ''}
        ${candidates && candidates.length > 1 ? `<div class="card" style="margin-top:16px"><h3>Switch recipient</h3>${candidates.filter((c) => c.recipientId !== d.matchedRecipientId).map((c) => `
          <div class="item row between"><div><b>${esc(c.organizationName)}</b><div class="small muted">${c.distanceKm} km · score ${Math.round(c.score)}</div></div>
          <button class="btn ghost sm" data-act="choose" data-id="${d.id}" data-rid="${c.recipientId}">Choose</button></div>`).join('')}</div>` : ''}`;
      if (d.recipientLat != null) {
        drawMap('map', [
          { lat: d.pickupLat, lng: d.pickupLng, label: 'Pickup: ' + d.donorName, icon: '🍽️' },
          { lat: d.recipientLat, lng: d.recipientLng, label: 'Drop: ' + d.recipientName, icon: '🏠', cls: 'blue' },
        ], (r) => { const el = $('#route-info'); if (el) el.textContent = `· ${r.km} km · ~${r.min} min by road`; });
      }
    });
  }

  // ------------------------------------------------------- recipient page
  function pageRecipient() {
    loading();
    app.innerHTML = `
      <h1>Recipient dashboard</h1>
      <div id="stats"></div>
      <div class="grid g2" style="margin-top:16px">
        <div class="stack" id="sections"></div>
        <div id="profile"></div>
      </div>`;
    let profileDrawn = false;
    poll(async () => {
      const [rec, don, del, s] = await Promise.all([api('/recipients/me'), api('/donations'), api('/deliveries'), api('/stats/me')]);
      return { rec: rec.recipient, don: don.donations, del: del.deliveries, s };
    }, ({ rec, don, del, s }) => {
      $('#stats').innerHTML = `<div class="grid g3">
        ${stat(`${rec.available} / ${rec.capacity}`, 'Meals capacity free')}${stat(s.incoming, 'Incoming donations')}${stat(s.mealsReceived, 'Meals received')}</div>`;
      const awaiting = don.filter((d) => d.status === 'MATCHED' && d.mine && !d.recipientAccepted);
      const avail = don.filter((d) => d.status === 'AVAILABLE');
      $('#sections').innerHTML = `
        <div class="card"><h2>Awaiting your confirmation</h2>
          ${awaiting.length ? awaiting.map((d) => `<div class="item"><div class="row between"><h3><a href="#/donation/${d.id}">${esc(d.foodType)}</a></h3><span class="badge b-MATCHED">Score ${Math.round(d.matchScore)}</span></div>
            <div class="small muted">${d.meals} meals · from ${esc(d.donorName)} · ⏳ ${timeLeft(d.expiryTime)}</div>
            <div class="row" style="margin-top:8px"><button class="btn sm" data-act="accept" data-id="${d.id}">Accept</button><button class="btn danger sm" data-act="decline" data-id="${d.id}">Decline</button></div></div>`).join('') : '<p class="muted">Nothing waiting. New matches appear here automatically.</p>'}
        </div>
        <div class="card"><h2>Available donations</h2>
          ${avail.length ? avail.map((d) => `<div class="item"><div class="row between"><h3><a href="#/donation/${d.id}">${esc(d.foodType)}</a></h3>${badge('AVAILABLE')}</div>
            <div class="small muted">${d.meals} meals · ${esc(CATS[d.category] || d.category)} · ${d.fit.distanceKm} km · ⏳ ${timeLeft(d.expiryTime)}</div>
            ${d.fit.eligible ? `<div class="row" style="margin-top:8px"><button class="btn ghost sm" data-act="accept" data-id="${d.id}">Claim (score ${Math.round(d.fit.score)})</button></div>` : `<div class="small" style="color:var(--red);margin-top:6px">Can't take: ${esc(d.fit.reason)}</div>`}</div>`).join('') : '<p class="muted">No unmatched donations right now.</p>'}
        </div>
        <div class="card"><h2>Incoming &amp; past deliveries</h2>
          ${del.length ? del.map((x) => `<div class="item row between"><div><b><a href="#/delivery/${x.id}">${esc(x.foodType)}</a></b><div class="small muted">${x.meals} meals · ${esc(x.donorName)}${x.driverName ? ` · 🚚 ${esc(x.driverName)}` : ''}</div></div>${badge(x.status)}</div>`).join('') : '<p class="muted">No deliveries yet.</p>'}
        </div>`;
      if (!profileDrawn) { profileDrawn = true; drawProfile(rec); }
    });
  }

  function drawProfile(r) {
    $('#profile').innerHTML = `
      <form class="card" id="pf">
        <h2>Organization profile</h2>
        <label for="org">Name</label><input id="org" value="${esc(r.organizationName)}" required maxlength="120">
        <div class="form-row">
          <div><label for="cap">Capacity (meals)</label><input id="cap" type="number" min="1" value="${r.capacity}" required></div>
          <div><label for="need">Current need</label><select id="need">${['LOW', 'MEDIUM', 'HIGH'].map((n) => `<option ${n === r.currentNeed ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        </div>
        <p class="small muted">${r.currentLoad} meals currently committed. Location: ${esc(r.address || '-')}</p>
        <label>Food you accept <span class="muted small">(none = everything)</span></label>
        <div class="checks">${Object.entries(CATS).map(([k, v]) => `<label><input type="checkbox" name="cat" value="${k}" ${r.acceptedFoodTypes.includes(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div>
        <div id="pmsg"></div>
        <p><button class="btn">Save profile</button></p>
      </form>`;
    $('#pf').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/recipients/me', { method: 'PUT', body: {
          organizationName: $('#org').value, capacity: Number($('#cap').value), currentNeed: $('#need').value,
          acceptedFoodTypes: [...$('#pf').querySelectorAll('[name=cat]:checked')].map((c) => c.value),
        } });
        toast('Profile saved');
        $('#pmsg').innerHTML = '';
      } catch (err) { $('#pmsg').innerHTML = errBox(err); }
    });
  }

  // ----------------------------------------------------------- driver page
  const routeLine = (x) => `<div class="small"><b>Pickup:</b> ${esc(x.donorName)} - ${esc(x.pickupAddress)}<br><b>Drop:</b> ${esc(x.recipientName)} - ${esc(x.dropAddress)}<br>${x.distanceKm} km · ~${x.etaMinutes} min · ⏳ ${timeLeft(x.expiryTime)}</div>`;
  function deliveryButtons(x) {
    if (x.status === 'PENDING') return `<button class="btn" data-act="dAccept" data-id="${x.id}">Accept task</button>`;
    if (x.status === 'ASSIGNED') return `<button class="btn" data-act="dPickup" data-id="${x.id}">Mark picked up</button>`;
    if (x.status === 'PICKED_UP') return `<button class="btn" data-act="dDeliver" data-id="${x.id}">Mark delivered</button>`;
    return '';
  }

  function pageDriver() {
    loading();
    poll(async () => {
      const [del, s] = await Promise.all([api('/deliveries'), api('/stats/me')]);
      return { del: del.deliveries, s };
    }, ({ del, s }) => {
      const active = del.filter((x) => x.mine && ['ASSIGNED', 'PICKED_UP'].includes(x.status));
      const open = del.filter((x) => x.status === 'PENDING');
      const done = del.filter((x) => x.mine && ['DELIVERED', 'CANCELLED'].includes(x.status));
      app.innerHTML = `
        <h1>Driver dashboard</h1>
        <div class="grid g3" style="margin:16px 0">${stat(s.active, 'Active deliveries')}${stat(s.completed, 'Completed')}${stat(s.distanceKm + ' km', 'Distance driven')}</div>
        <h2>My active delivery</h2>
        ${active.length ? active.map((x) => `<div class="item"><div class="row between"><h3><a href="#/delivery/${x.id}">${esc(x.foodType)} · ${x.meals} meals</a></h3>${badge(x.status)}</div>
          ${routeLine(x)}<div class="row" style="margin-top:10px">${deliveryButtons(x)}<a class="btn ghost" href="#/delivery/${x.id}">Map &amp; route</a></div></div>`).join('') : '<div class="card muted">No active delivery. Accept one below.</div>'}
        <h2 style="margin-top:24px">Open pickup tasks</h2>
        ${open.length ? open.map((x) => `<div class="item"><div class="row between"><h3><a href="#/delivery/${x.id}">${esc(x.foodType)} · ${x.meals} meals</a></h3>${badge(x.status)}</div>
          ${routeLine(x)}${x.distanceFromYouKm != null ? `<div class="small muted">Pickup is ${x.distanceFromYouKm} km from you</div>` : ''}
          <div class="row" style="margin-top:10px">${deliveryButtons(x)}</div></div>`).join('') : '<div class="card muted">No open tasks right now. New ones appear here automatically.</div>'}
        ${done.length ? `<h2 style="margin-top:24px">History</h2>${done.map((x) => `<div class="item row between"><div><b>${esc(x.foodType)}</b><div class="small muted">${x.distanceKm} km · ${fmt(x.deliveryTime || x.createdAt)}</div></div>${badge(x.status)}</div>`).join('')}` : ''}`;
    });
  }

  function pageDelivery(id) {
    loading();
    poll(async () => (await api('/deliveries/' + id)).delivery, (x) => {
      const me = state.me;
      const isMine = me.role === 'DRIVER' && x.driverId === me.id;
      const canAccept = me.role === 'DRIVER' && x.status === 'PENDING';
      const steps = ['PENDING', 'ASSIGNED', 'PICKED_UP', 'DELIVERED'];
      const idx = steps.indexOf(x.status);
      app.innerHTML = `
        <p><a href="${HOME[me.role]}">← Back</a></p>
        <div class="row between"><h1>Delivery #${x.id}</h1>${badge(x.status)}</div>
        <div class="timeline ${x.status === 'CANCELLED' ? 'expired' : ''}">${steps.map((s, i) => `<div class="t ${i <= idx && x.status !== 'CANCELLED' ? 'done' : ''}">${{ PENDING: 'Awaiting driver', ASSIGNED: 'Driver assigned', PICKED_UP: 'Picked up', DELIVERED: 'Delivered' }[s]}</div>`).join('')}</div>
        ${x.status === 'CANCELLED' ? '<div class="err">This delivery was cancelled because the food expired.</div>' : ''}
        <div class="grid g2">
          <div class="card"><h3>${esc(x.foodType)} · ${x.meals} meals (${x.weightKg} kg)</h3>
            <dl class="kv">
              <dt>Pickup</dt><dd>${esc(x.donorName)}<br><span class="muted">${esc(x.pickupAddress)}</span></dd>
              <dt>Drop-off</dt><dd>${esc(x.recipientName)}<br><span class="muted">${esc(x.dropAddress)}</span></dd>
              <dt>Distance</dt><dd><span id="dist">${x.distanceKm} km</span></dd>
              <dt>Est. time</dt><dd><span id="eta">~${x.etaMinutes} min</span></dd>
              <dt>Driver</dt><dd>${x.driverName ? esc(x.driverName) : 'Not assigned yet'}</dd>
              <dt>Expires</dt><dd>${fmt(x.expiryTime)} <span class="muted">(${timeLeft(x.expiryTime)})</span></dd>
              ${x.pickupTime ? `<dt>Picked up</dt><dd>${fmt(x.pickupTime)}</dd>` : ''}${x.deliveryTime ? `<dt>Delivered</dt><dd>${fmt(x.deliveryTime)}</dd>` : ''}
            </dl>
            <div class="row" style="margin-top:14px">${(isMine || canAccept) ? deliveryButtons(x) : ''}<a class="btn ghost" href="#/donation/${x.donationId}">Donation details</a></div>
          </div>
          <div class="card"><h3>Route</h3><div id="map" class="map"></div></div>
        </div>`;
      const pts = [];
      if (x.driverLat != null && x.driverId && ['ASSIGNED'].includes(x.status)) pts.push({ lat: x.driverLat, lng: x.driverLng, label: 'Driver: ' + x.driverName, icon: '🚚', cls: 'amber' });
      pts.push({ lat: x.pickupLat, lng: x.pickupLng, label: 'Pickup: ' + x.donorName, icon: '🍽️' });
      pts.push({ lat: x.dropLat, lng: x.dropLng, label: 'Drop: ' + x.recipientName, icon: '🏠', cls: 'blue' });
      drawMap('map', pts, (r) => {
        if (pts.length === 2) { $('#dist').textContent = r.km + ' km by road'; $('#eta').textContent = '~' + r.min + ' min'; }
        else { $('#dist').textContent = `${r.km} km total (driver → pickup → drop)`; $('#eta').textContent = '~' + r.min + ' min total'; }
      });
    });
  }

  // ---------------------------------------------------------------- impact
  function pageImpact() {
    loading();
    poll(() => api('/stats/impact'), (s) => {
      const days = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        days.push({ day: d, meals: (s.daily.find((x) => x.day === d) || {}).meals || 0 });
      }
      const max = Math.max(1, ...days.map((d) => d.meals));
      const cmax = Math.max(1, ...s.byCategory.map((c) => c.meals));
      app.innerHTML = `
        <h1>Impact dashboard</h1>
        <p class="muted">Live numbers from real deliveries on the platform.</p>
        <div class="grid g3" style="margin:16px 0">
          ${stat(s.mealsRescued.toLocaleString(), 'Meals rescued')}
          ${stat(s.weightKg.toLocaleString() + ' kg', 'Food weight diverted')}
          ${stat(s.successfulDeliveries, 'Successful deliveries')}
          ${stat(s.activeDonations, 'Active donations')}
          ${stat(s.organizationsHelped, 'Organizations helped')}
          ${stat(s.expiredDonations, 'Expired (missed)')}
        </div>
        <div class="grid g2">
          <div class="card"><h3>Meals delivered - last 14 days</h3>
            <div class="bars" role="img" aria-label="Meals delivered per day">${days.map((d) => `<div class="col"><span class="v">${d.meals || ''}</span><div class="bar" style="height:${Math.round((d.meals / max) * 100)}%"></div><span class="d">${d.day.slice(8)}</span></div>`).join('')}</div>
          </div>
          <div class="card"><h3>By food category</h3>
            ${s.byCategory.length ? s.byCategory.map((c) => `<div style="margin:10px 0"><div class="row between small"><span>${esc(CATS[c.category] || c.category)}</span><b>${c.meals} meals</b></div><div class="hbar"><i style="width:${Math.round((c.meals / cmax) * 100)}%"></i></div></div>`).join('') : '<p class="muted">No deliveries yet.</p>'}
          </div>
        </div>`;
    }, 10000);
  }

  // ---------------------------------------------------------------- router
  const routes = [
    [/^#?\/?$/, pageLanding, null],
    [/^#\/login$/, pageLogin, null],
    [/^#\/register$/, pageRegister, null],
    [/^#\/impact$/, pageImpact, null],
    [/^#\/donor$/, pageDonor, 'DONOR'],
    [/^#\/donor\/new$/, pageNewDonation, 'DONOR'],
    [/^#\/donation\/(\d+)$/, pageDonation, '*'],
    [/^#\/recipient$/, pageRecipient, 'RECIPIENT'],
    [/^#\/driver$/, pageDriver, 'DRIVER'],
    [/^#\/delivery\/(\d+)$/, pageDelivery, '*'],
  ];

  async function route() {
    state.gen++;
    clearTimers();
    if (state.map) { state.map.remove(); state.map = null; }
    state.notifOpen = false;
    const hash = location.hash || '#/';
    for (const [re, fn, role] of routes) {
      const m = hash.match(re);
      if (!m) continue;
      if (role && !state.me) { return go('#/login'); }
      if (role && role !== '*' && state.me.role !== role) { return go(HOME[state.me.role]); }
      renderNav();
      window.scrollTo(0, 0);
      try { await fn(m[1]); } catch (e) { app.innerHTML = errBox(e); }
      return;
    }
    renderNav();
    app.innerHTML = '<div class="card"><h2>Page not found</h2><a href="#/">Go home</a></div>';
  }

  window.addEventListener('hashchange', route);
  (async () => {
    try { state.me = (await api('/auth/me')).user; await refreshNotifs(); } catch { state.me = null; }
    route();
  })();
})();
