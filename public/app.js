(() => {
  'use strict';

  // ------------------------------------------------------------- helpers
  const $ = (s, r = document) => r.querySelector(s);
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CATS = { cooked: 'Cooked meals', produce: 'Fresh produce', bakery: 'Bakery', packaged: 'Packaged', dairy: 'Dairy', beverages: 'Beverages' };
  const HOME = { DONOR: '#/donor', RECIPIENT: '#/recipient', DRIVER: '#/driver' };
  const state = { me: null, gen: 0, timers: [], map: null, notifOpen: false, notifs: { items: [], unread: 0 }, google: false, lastCands: [] };

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
    toastTimer = setTimeout(() => (t.hidden = true), 4000);
  }
  // Announces changes to screen readers without stealing focus.
  const announce = (msg) => { $('#live').textContent = msg; };

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  function timeLeft(iso) {
    const m = Math.round((Date.parse(iso) - Date.now()) / 60000);
    if (m <= 0) return 'expired';
    return (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`) + ' left';
  }

  // Status colour is backed up by a symbol and a word, so nothing depends on colour alone.
  const SYM = {
    AVAILABLE: '◷', MATCHED: '◆', DRIVER_ASSIGNED: '⇢', PICKED_UP: '↑', DELIVERED: '✓',
    EXPIRED: '✕', CANCELLED: '⊘', PENDING: '◷', ASSIGNED: '⇢',
  };
  const LABEL = {
    AVAILABLE: 'Posted', MATCHED: 'Matched', DRIVER_ASSIGNED: 'Driver assigned', PICKED_UP: 'Picked up',
    DELIVERED: 'Delivered', EXPIRED: 'Expired', CANCELLED: 'Cancelled', PENDING: 'Awaiting driver', ASSIGNED: 'Driver assigned',
  };
  const badge = (s) =>
    `<span class="badge b-${esc(s)}" data-sym="${SYM[s] || '•'}">${esc(LABEL[s] || s.replace('_', ' '))}</span>`;

  const RISK = {
    LOW: { sym: '●', text: 'Low risk' }, MEDIUM: { sym: '◐', text: 'Medium risk' },
    HIGH: { sym: '▲', text: 'High risk' }, EXPIRED: { sym: '✕', text: 'Expired' }, NONE: { sym: '✓', text: 'Delivered' },
  };
  const LIVE_STATUSES = ['AVAILABLE', 'MATCHED', 'DRIVER_ASSIGNED', 'PICKED_UP', 'PENDING', 'ASSIGNED'];
  function riskChip(d) {
    // Once a donation is finished the status badge already tells the story.
    if (d.status && !LIVE_STATUSES.includes(d.status)) return '';
    const r = RISK[d.expiryRisk] || RISK.LOW;
    const extra = d.expiryRisk === 'EXPIRED' || d.expiryRisk === 'NONE' ? '' : ` · ${timeLeft(d.expiryTime)}`;
    return `<span class="risk risk-${esc(d.expiryRisk)}"><span aria-hidden="true">${r.sym}</span>${esc(r.text)}${extra}</span>`;
  }

  const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const loading = () => (app.innerHTML = '<p class="muted"><span class="spinner" aria-hidden="true"></span> Loading…</p>');
  const errBox = (e) => `<div class="err" role="alert">${esc(e.message || e)}</div>`;

  function clearTimers() {
    state.timers.forEach(clearInterval);
    state.timers = [];
  }

  // Re-fetch every few seconds; only re-render when the data actually changed.
  function poll(fetcher, render, ms = 8000) {
    let last = null;
    const gen = state.gen; // results arriving after navigating away are dropped
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
    const here = location.hash.split('?')[0];
    const link = (href, text) =>
      `<a class="link ${here === href ? 'active' : ''}" href="${href}" ${here === href ? 'aria-current="page"' : ''}>${text}</a>`;
    $('#nav').innerHTML = `
      <a class="brand" href="#/">🍲 Surplus-to-Shelter</a>
      <nav aria-label="Main">
        ${me ? link(HOME[me.role], 'Dashboard') : ''}
        ${me && me.role === 'DONOR' ? link('#/donor/new', 'Donate food') : ''}
        ${link('#/impact', 'Impact')}
      </nav>
      <span class="right row">
        ${me
          ? `<button class="bell" data-act="bell" aria-expanded="${state.notifOpen}" aria-label="Notifications${state.notifs.unread ? `, ${state.notifs.unread} unread` : ''}">🔔${state.notifs.unread ? `<span class="dot" aria-hidden="true">${state.notifs.unread}</span>` : ''}</button>
             <span class="small muted">${esc(me.name)} · ${esc(me.role.toLowerCase())}</span>
             <button class="btn ghost sm" data-act="logout">Log out</button>`
          : `${link('#/login', 'Log in')}<a class="btn sm" href="#/register">Sign up</a>`}
      </span>
      ${state.notifOpen ? notifPanel() : ''}`;
  }

  function notifPanel() {
    const items = state.notifs.items;
    return `<div class="notif-panel" role="region" aria-label="Notifications">${items.length
      ? items.map((n) => `<div class="n ${n.read ? '' : 'unread'} ${n.severity === 'URGENT' ? 'urgent' : ''}">
          ${n.severity === 'URGENT' ? '<span class="tag-urgent">Urgent</span> ' : ''}
          ${n.donationId ? `<a href="#/donation/${n.donationId}" data-act="closeNotif">${esc(n.message)}</a>` : esc(n.message)}
          <div class="small muted">${fmt(n.createdAt)}</div></div>`).join('')
      : '<p class="muted small" style="padding:8px">No notifications yet.</p>'}</div>`;
  }

  async function refreshNotifs() {
    if (!state.me) return;
    try {
      const d = await api('/notifications');
      const changed = d.unread !== state.notifs.unread || d.notifications.length !== state.notifs.items.length;
      const grew = d.unread > state.notifs.unread;
      state.notifs = { items: d.notifications, unread: d.unread };
      if (changed) renderNav();
      if (grew && d.notifications[0]) announce('New notification: ' + d.notifications[0].message);
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
    accept: (d) => doAction(`/donations/${d.id}/accept`, 'Donation confirmed - drivers have been notified'),
    async decline(d) {
      const ok = await ask({
        title: 'Decline this donation?',
        message: 'We will immediately look for the next best recipient. This cannot be undone for your organisation.',
        confirmLabel: 'Decline', danger: true,
      });
      if (!ok) return;
      await doAction(`/donations/${d.id}/decline`, 'Declined - looking for another recipient');
    },
    async cancel(d) {
      const ok = await ask({
        title: 'Cancel this donation?',
        message: 'Any capacity reserved at the shelter will be released and the pickup task withdrawn.',
        confirmLabel: 'Cancel donation', danger: true,
        field: { label: 'Reason (optional)', placeholder: 'e.g. guests ate it after all' },
      });
      if (!ok) return;
      await doAction(`/donations/${d.id}/cancel`, 'Donation cancelled', ok.value ? { reason: ok.value } : {});
    },
    dAccept: (d) => doAction(`/deliveries/${d.id}/accept`, 'Delivery accepted'),
    dPickup: (d) => doAction(`/deliveries/${d.id}/pickup`, 'Marked as picked up'),
    dDeliver: (d) => doAction(`/deliveries/${d.id}/deliver`, 'Delivered - thank you!'),
    async dRelease(d) {
      const ok = await ask({
        title: 'Release this task?',
        message: 'It goes back to the open pool so another driver can take it.',
        confirmLabel: 'Release', danger: true,
      });
      if (!ok) return;
      await doAction(`/deliveries/${d.id}/release`, 'Task released');
    },
    async dFail(d) {
      const ok = await ask({
        title: 'Report a problem with this delivery',
        message: 'Use this if the food could not be handed over - it expired in transit, the shelter was closed, or something went wrong. The donation will be closed as cancelled, not counted as rescued.',
        confirmLabel: 'Report problem', danger: true,
        field: { label: 'What happened?', placeholder: 'e.g. shelter closed on arrival', required: true },
      });
      if (!ok) return;
      await doAction(`/deliveries/${d.id}/fail`, 'Problem reported - the donation was closed', { reason: ok.value });
    },
    async retry(d) {
      const r = await api(`/donations/${d.id}/match`, { method: 'POST', body: {} });
      toast(r.matching.matched ? `Matched to ${r.matching.best.organizationName}` : 'Still no suitable recipient', !r.matching.matched);
      if ($('#result')) renderMatchResult(r.donation, r.matching);
      else route();
    },
    async choose(d) {
      const r = await api(`/donations/${d.id}/match`, { method: 'POST', body: { recipientId: Number(d.rid) } });
      toast(r.matching.matched ? 'Recipient changed' : 'Could not match');
      if ($('#result')) renderMatchResult(r.donation, { ...r.matching, candidates: state.lastCands });
      else route();
    },
  };

  async function doAction(path, okMsg, body = {}) {
    try {
      await api(path, { method: 'POST', body });
      toast(okMsg);
      announce(okMsg);
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


  // ------------------------------------------------------- confirm dialog
  // Replaces window.confirm/prompt, which are not reliably announced by screen readers and are
  // suppressed in some embedded browsers. Focus is trapped while open and restored on close.
  function ask({ title, message, confirmLabel = 'Confirm', danger = false, field = null }) {
    return new Promise((resolve) => {
      const previous = document.activeElement;
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-m">
          <h2 id="dlg-t">${esc(title)}</h2>
          <p id="dlg-m">${esc(message)}</p>
          ${field ? `<label for="dlg-i">${esc(field.label)}</label>
            <input id="dlg-i" maxlength="200" placeholder="${esc(field.placeholder || '')}" ${field.required ? 'required' : ''}>
            <p class="err" id="dlg-e" hidden role="alert">Please fill this in.</p>` : ''}
          <div class="row" style="justify-content:flex-end;margin-top:16px">
            <button class="btn ghost" data-dlg="cancel">Cancel</button>
            <button class="btn ${danger ? 'danger' : ''}" data-dlg="ok">${esc(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);

      const focusable = () => [...wrap.querySelectorAll('button, input')].filter((el) => !el.disabled);
      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        wrap.remove();
        if (previous && previous.isConnected) previous.focus();
        resolve(result);
      };
      const submit = () => {
        const input = wrap.querySelector('#dlg-i');
        if (field && field.required && !input.value.trim()) {
          wrap.querySelector('#dlg-e').hidden = false;
          input.focus();
          return;
        }
        close({ value: input ? input.value.trim() : '' });
      };
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
        if (e.key === 'Tab') { // simple focus trap
          const items = focusable();
          const i = items.indexOf(document.activeElement);
          const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
          e.preventDefault();
          items[next].focus();
        }
      }
      document.addEventListener('keydown', onKey, true);
      wrap.addEventListener('click', (e) => {
        if (e.target === wrap) return close(null);
        const act = e.target.closest('[data-dlg]');
        if (!act) return;
        if (act.dataset.dlg === 'cancel') close(null);
        else submit();
      });
      (wrap.querySelector('#dlg-i') || wrap.querySelector('[data-dlg=ok]')).focus();
    });
  }

  const verifiedBadge = (isVerified) => isVerified
    ? '<span class="verified" title="Registration documents checked by the platform team"><span aria-hidden="true">✓</span> Verified</span>'
    : '<span class="unverified" title="This organisation has not completed verification yet"><span aria-hidden="true">○</span> Unverified</span>';

  // ------------------------------------------------------------------- map
  // Always renders pins and the straight-line distance first; the road route from OSRM is a
  // progressive enhancement, so the map still works if that service is unreachable.
  async function drawMap(elId, pts, onRoute) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (typeof L === 'undefined') {
      el.innerHTML = '<p class="muted small" style="padding:12px">Map library unavailable. Addresses and distance are shown above.</p>';
      return;
    }
    if (state.map) { state.map.remove(); state.map = null; }
    const map = (state.map = L.map(el, { scrollWheelZoom: false }));
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
    const latlngs = pts.map((p) => [p.lat, p.lng]);
    pts.forEach((p) => {
      const icon = L.divIcon({ className: '', html: `<div class="pin ${p.cls || ''}">${p.icon}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
      L.marker([p.lat, p.lng], { icon, title: p.label, alt: p.label }).addTo(map).bindTooltip(p.label);
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
    } catch { /* routing unavailable: the dashed straight line and stored distance remain */ }
  }

  // --------------------------------------------------------------- landing
  const stat = (num, lbl, hint = '') =>
    `<div class="card stat"><div class="num">${esc(num)}</div><div class="lbl">${esc(lbl)}</div>${hint ? `<div class="small muted">${esc(hint)}</div>` : ''}</div>`;

  async function pageLanding() {
    const gen = state.gen;
    let s = null;
    try { s = await api('/stats/impact'); } catch { /* landing still renders without stats */ }
    if (gen !== state.gen) return;
    const me = state.me;
    app.innerHTML = `
      <section class="hero">
        <h1>Rescue surplus food. <em>Deliver it before it expires.</em></h1>
        <p>Restaurants, caterers and stores post leftovers in seconds. We instantly match them with the best nearby shelter and dispatch a volunteer driver.</p>
        <div class="row">
          ${me ? `<a class="btn lg" href="${HOME[me.role]}">Go to my dashboard</a>` : `<a class="btn lg" href="#/register">Get started</a><a class="btn ghost lg" href="#/login">Log in</a>`}
          <a class="btn ghost lg" href="#/impact">See our impact</a>
        </div>
        <ol class="flow">
          <li class="step">🍽️ Donor posts food</li><li class="arrow" aria-hidden="true">→</li>
          <li class="step">🧠 Smart matching</li><li class="arrow" aria-hidden="true">→</li>
          <li class="step">🏠 NGO confirms</li><li class="arrow" aria-hidden="true">→</li>
          <li class="step">🚚 Driver picks up</li><li class="arrow" aria-hidden="true">→</li>
          <li class="step">📈 Impact tracked</li>
        </ol>
      </section>
      ${s ? `<section class="grid g3" aria-label="Impact so far">
        ${stat(s.mealsRescued.toLocaleString(), 'Meals rescued')}
        ${stat(s.weightKg.toLocaleString() + ' kg', 'Food diverted from waste')}
        ${stat(s.co2eKg.toLocaleString() + ' kg', 'CO₂e avoided (estimate)')}
      </section>` : ''}
      <section class="grid g3" style="margin-top:24px">
        <div class="card"><h3>For donors</h3><p class="muted">Post surplus in under a minute - even by typing a sentence. Track it until it's delivered.</p></div>
        <div class="card"><h3>For shelters &amp; NGOs</h3><p class="muted">Set your capacity and food preferences. Get matched only with food you can use, in time.</p></div>
        <div class="card"><h3>For drivers</h3><p class="muted">See nearby pickups, follow the route on the map and update status in two taps.</p></div>
      </section>`;
  }

  // ------------------------------------------------------------ auth pages
  const GOOGLE_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.2-3.2-.5-4.7H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.3z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C1 16.3 0 20 0 24s1 7.7 2.6 10.8l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.4 0-11.7-3.7-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/></svg>`;
  const googleButton = (role, label) => state.google
    ? `<a class="btn google" style="width:100%" href="/api/auth/google${role ? '?role=' + role : ''}">${GOOGLE_SVG} ${label}</a><div class="divider">or</div>`
    : '';

  const OAUTH_ERRORS = {
    bad_state: 'That sign-in link expired or was tampered with. Please try again.',
    google_cancelled: 'Google sign-in was cancelled.',
    google_failed: 'Could not complete Google sign-in. Please try again or use your password.',
    email_unverified: 'Your Google account email is not verified, so we cannot use it to sign in.',
    account_conflict: 'This email is already linked to a different Google account.',
    missing_code: 'Google did not return a sign-in code. Please try again.',
  };

  function pageLogin(_, params) {
    const oauthError = params.get('error');
    app.innerHTML = `
      <div class="grid g2">
        <form class="card" id="f" novalidate>
          <h1>Welcome back</h1>
          ${oauthError ? `<div class="err" role="alert">${esc(OAUTH_ERRORS[oauthError] || 'Sign-in failed. Please try again.')}</div>` : ''}
          ${googleButton(null, 'Continue with Google')}
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required autocomplete="username" aria-describedby="msg">
          <label for="pw">Password</label>
          <input id="pw" name="password" type="password" required autocomplete="current-password">
          <div id="msg"></div>
          <p><button class="btn" style="width:100%">Log in</button></p>
          <p class="muted small">New here? <a href="#/register">Create an account</a></p>
        </form>
        <div class="card flat demo-box">
          <h2>Demo accounts</h2>
          <p class="muted">After running <code>npm run seed</code>, the password for all of them is <code>demo1234</code>.</p>
          <div class="stack">
            ${[['Donor', 'donor@demo.com'], ['NGO / Shelter', 'ngo@demo.com'], ['Driver', 'driver@demo.com']]
              .map(([r, e]) => `<div><b>${r}</b><br><button type="button" class="chip" data-fill="${e}">Use ${e}</button></div>`).join('')}
          </div>
        </div>
      </div>`;
    app.querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => {
      $('#email').value = b.dataset.fill;
      $('#pw').value = 'demo1234';
      $('#pw').focus();
    }));
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/auth/login', { method: 'POST', body: { email: $('#email').value, password: $('#pw').value } });
        state.me = r.user;
        refreshNotifs();
        go(HOME[r.user.role]);
      } catch (err) {
        $('#msg').innerHTML = errBox(err);
        $('#email').focus();
      }
    });
  }

  function locationField(id, initial = '') {
    return `<label for="${id}">Location (address or area)</label>
      <div class="row" style="flex-wrap:nowrap">
        <input id="${id}" value="${esc(initial)}" placeholder="e.g. Malviya Nagar, Jaipur" required aria-describedby="${id}-h">
        <button type="button" class="btn ghost sm" id="${id}-gps" style="white-space:nowrap">📍 Use my location</button>
      </div>
      <p class="small muted" id="${id}-h">Any city works - we look up the coordinates to measure real distances.</p>`;
  }
  // Wires the GPS button; .lat/.lng are set only when exact coordinates are known.
  function wireLocation(id) {
    const c = { lat: null, lng: null };
    const input = $('#' + id);
    input.addEventListener('input', () => { c.lat = c.lng = null; });
    $(`#${id}-gps`).addEventListener('click', () => {
      if (!navigator.geolocation) return toast('Geolocation is not supported by this browser', true);
      navigator.geolocation.getCurrentPosition(
        (p) => {
          c.lat = p.coords.latitude; c.lng = p.coords.longitude;
          input.value = `Current location (${c.lat.toFixed(4)}, ${c.lng.toFixed(4)})`;
          announce('Location set from your device');
        },
        () => toast('Could not get your location - type an address instead', true),
        { timeout: 8000 }
      );
    });
    return c;
  }

  // Role-dependent NGO fields, shared by password signup and Google profile completion.
  const recipientFields = () => `
    <div id="rec" hidden>
      <label for="org">Organization name</label><input id="org" maxlength="120">
      <div class="form-row">
        <div><label for="cap">Capacity (meals)</label><input id="cap" type="number" min="1" value="50"></div>
        <div><label for="need">Current need</label><select id="need"><option>LOW</option><option selected>MEDIUM</option><option>HIGH</option></select></div>
      </div>
      <fieldset style="border:0;padding:0;margin:12px 0 0">
        <legend style="font-weight:600;font-size:.9rem;padding:0">Food you accept <span class="muted small">(none selected = everything)</span></legend>
        <div class="checks">${Object.entries(CATS).map(([k, v]) => `<label><input type="checkbox" name="cat" value="${k}"> ${v}</label>`).join('')}</div>
      </fieldset>
    </div>`;

  function wireRoleToggle(roleEl) {
    const sync = () => {
      const isNgo = roleEl.value === 'RECIPIENT';
      $('#rec').hidden = !isNgo;
      $('#org').required = isNgo;
      const nameLabel = $('#name-l');
      if (nameLabel) nameLabel.textContent = roleEl.value === 'DONOR' ? 'Business name' : roleEl.value === 'DRIVER' ? 'Your name' : 'Contact person';
    };
    roleEl.addEventListener('change', sync);
    sync();
  }

  const recipientBody = () => ({
    organizationName: $('#org').value,
    capacity: Number($('#cap').value),
    currentNeed: $('#need').value,
    acceptedFoodTypes: [...app.querySelectorAll('[name=cat]:checked')].map((c) => c.value),
  });

  function pageRegister() {
    app.innerHTML = `
      <form class="card" id="f" style="max-width:640px;margin:0 auto" novalidate>
        <h1>Create your account</h1>
        ${googleButton('DONOR', 'Sign up with Google')}
        <label for="role">I am a…</label>
        <select id="role">
          <option value="DONOR">Donor (restaurant, store, caterer, cafeteria)</option>
          <option value="RECIPIENT">Shelter / NGO / Food bank</option>
          <option value="DRIVER">Volunteer driver</option>
        </select>
        <div class="form-row">
          <div><label for="name" id="name-l">Business name</label><input id="name" required minlength="2" maxlength="100" autocomplete="organization"></div>
          <div><label for="phone">Phone</label><input id="phone" type="tel" maxlength="30" autocomplete="tel"></div>
        </div>
        <div class="form-row">
          <div><label for="email">Email</label><input id="email" type="email" required autocomplete="username"></div>
          <div><label for="pw">Password</label><input id="pw" type="password" required minlength="8" autocomplete="new-password" aria-describedby="pw-h">
            <p class="small muted" id="pw-h">At least 8 characters.</p></div>
        </div>
        ${locationField('loc')}
        ${recipientFields()}
        <div id="msg"></div>
        <p><button class="btn lg" style="width:100%">Create account</button></p>
        <p class="muted small">Already registered? <a href="#/login">Log in</a></p>
      </form>`;
    const coords = wireLocation('loc');
    const role = $('#role');
    wireRoleToggle(role);
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        role: role.value, name: $('#name').value, phone: $('#phone').value || undefined, email: $('#email').value,
        password: $('#pw').value, address: $('#loc').value, lat: coords.lat ?? undefined, lng: coords.lng ?? undefined,
      };
      if (role.value === 'RECIPIENT') Object.assign(body, recipientBody());
      try {
        const r = await api('/auth/register', { method: 'POST', body });
        state.me = r.user;
        toast('Welcome aboard!');
        go(HOME[r.user.role]);
      } catch (err) {
        $('#msg').innerHTML = errBox(err);
        $('#msg').scrollIntoView({ block: 'center' });
      }
    });
  }

  // Finishes a Google sign-up: Google gives us a verified identity, we still need role + location.
  async function pageCompleteProfile() {
    const gen = state.gen;
    let pending;
    try {
      pending = (await api('/auth/google/pending')).pending;
    } catch (err) {
      return go('#/login?error=bad_state');
    }
    if (gen !== state.gen) return;
    app.innerHTML = `
      <form class="card" id="f" style="max-width:640px;margin:0 auto" novalidate>
        <h1>Almost there</h1>
        <p class="muted">Signed in with Google as <b>${esc(pending.email)}</b>. Tell us how you will use the platform.</p>
        <label for="role">I am a…</label>
        <select id="role">
          <option value="DONOR">Donor (restaurant, store, caterer, cafeteria)</option>
          <option value="RECIPIENT">Shelter / NGO / Food bank</option>
          <option value="DRIVER">Volunteer driver</option>
        </select>
        <div class="form-row">
          <div><label for="name" id="name-l">Business name</label><input id="name" required minlength="2" maxlength="100" value="${esc(pending.name || '')}"></div>
          <div><label for="phone">Phone</label><input id="phone" type="tel" maxlength="30"></div>
        </div>
        ${locationField('loc')}
        ${recipientFields()}
        <div id="msg"></div>
        <p><button class="btn lg" style="width:100%">Finish setup</button></p>
      </form>`;
    const coords = wireLocation('loc');
    const role = $('#role');
    if (pending.role) role.value = pending.role;
    wireRoleToggle(role);
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        role: role.value, name: $('#name').value, phone: $('#phone').value || undefined,
        address: $('#loc').value, lat: coords.lat ?? undefined, lng: coords.lng ?? undefined,
      };
      if (role.value === 'RECIPIENT') Object.assign(body, recipientBody());
      try {
        const r = await api('/auth/google/complete', { method: 'POST', body });
        state.me = r.user;
        toast('Welcome aboard!');
        go(HOME[r.user.role]);
      } catch (err) { $('#msg').innerHTML = errBox(err); }
    });
  }

  // ----------------------------------------------------------- donor pages
  const donationRow = (d) => `
    <article class="item">
      <div class="row between">
        <div><h3><a href="#/donation/${d.id}">${esc(d.foodType)}</a></h3>
          <div class="muted small">${esc(d.quantity)} ${esc(d.unit)} · ${d.meals} meals · ${esc(CATS[d.category] || d.category)}</div></div>
        ${badge(d.status)}
      </div>
      <div class="row small muted" style="margin-top:8px">
        ${['AVAILABLE', 'MATCHED', 'DRIVER_ASSIGNED', 'PICKED_UP'].includes(d.status) ? riskChip(d) : ''}
        <span>${d.recipientName ? `→ ${esc(d.recipientName)}${d.matchScore != null ? ` (score ${Math.round(d.matchScore)})` : ''}` : 'Not matched yet'}</span>
        ${d.driverName ? `<span>· 🚚 ${esc(d.driverName)}</span>` : ''}
      </div>
      ${d.status === 'AVAILABLE' && d.matchFailureReason ? `<div class="warn small" style="margin-top:8px">${esc(d.matchFailureReason)}</div>` : ''}
    </article>`;

  function pageDonor() {
    loading();
    poll(async () => {
      const [s, d] = await Promise.all([api('/stats/me'), api('/donations')]);
      return { s, d: d.donations };
    }, ({ s, d }) => {
      app.innerHTML = `
        <div class="row between"><h1>Donor dashboard</h1>
          <span class="row">
            <a class="btn ghost" href="/api/donations/export.csv" download>⭳ Download report (CSV)</a>
            <a class="btn lg" href="#/donor/new">＋ Donate food</a>
          </span>
        </div>
        <div class="grid g3" style="margin:16px 0">
          ${stat(s.total, 'Total donations')}${stat(s.active, 'In progress')}${stat(s.delivered, 'Delivered')}
          ${stat(s.meals, 'Meals rescued')}${stat(s.weightKg + ' kg', 'Food rescued')}${stat(s.co2eKg + ' kg', 'CO₂e avoided', 'estimate')}
        </div>
        <h2>Donation history</h2>
        ${d.length ? d.map(donationRow).join('') : '<div class="card muted">No donations yet. <a href="#/donor/new">Post your first surplus food</a>.</div>'}
        <p class="small muted" style="margin-top:16px">The CSV report lists every donation with its
          timestamps, quantities and outcome. It is a donation and impact report, not an official
          tax document - ask the receiving organisation for a receipt if you need one.</p>`;
    });
  }

  function pageNewDonation() {
    const me = state.me;
    app.innerHTML = `
      <h1>Donate surplus food</h1>
      <div class="grid g2">
        <div>
          <div class="card" style="margin-bottom:16px">
            <h2 style="font-size:1.05rem">✨ Describe it in your own words <span class="muted small">(optional)</span></h2>
            <label for="nl" class="visually-hidden">Describe the surplus food</label>
            <textarea id="nl" placeholder="We have around 25 boxes of cooked rice and dal left from today's event. Good for about 2 hours."></textarea>
            <p class="row"><button type="button" class="btn ghost sm" id="parse">Auto-fill the form</button>
              <span id="parse-msg" class="small muted" role="status"></span></p>
          </div>
          <form class="card" id="f" novalidate>
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
            <input id="exp" type="datetime-local" value="${localInput(new Date(Date.now() + 3 * 3600e3))}" required aria-describedby="exp-h">
            <div class="row" style="margin-top:6px">${[1, 2, 4, 8].map((h) => `<button type="button" class="chip" data-h="${h}">+${h}h</button>`).join('')}</div>
            <p class="small muted" id="exp-h">Must be in the future. We only match recipients who can receive it in time.</p>
            <label for="desc">Notes for the driver <span class="muted small">(optional)</span></label>
            <input id="desc" maxlength="500" placeholder="e.g. Ask for Sunil at the back door">
            <div id="msg"></div>
            <p><button class="btn lg" style="width:100%" id="go">Find best recipient</button></p>
          </form>
        </div>
        <div id="result" aria-live="polite"></div>
      </div>`;
    const coords = wireLocation('loc');
    if (me.lat != null) { coords.lat = me.lat; coords.lng = me.lng; }
    $('#loc').addEventListener('input', () => {
      if ($('#loc').value === me.address) { coords.lat = me.lat; coords.lng = me.lng; }
      else { coords.lat = coords.lng = null; }
    });
    app.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => {
      $('#exp').value = localInput(new Date(Date.now() + Number(b.dataset.h) * 3600e3));
    }));

    $('#parse').addEventListener('click', async () => {
      const text = $('#nl').value.trim();
      if (text.length < 3) return toast('Write a sentence describing the food first', true);
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
        $('#parse-msg').textContent = `Filled in (${r.source === 'ai' ? 'AI' : 'quick parser'}). Urgency ${d.urgency}${d.diet ? ' · ' + d.diet : ''}. Please check the details.`;
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
      } catch (err) {
        $('#msg').innerHTML = errBox(err);
        $('#result').innerHTML = '';
        $('#msg').scrollIntoView({ block: 'center' });
      }
      btn.disabled = false;
    });
  }

  async function showMatching(body) {
    const box = $('#result');
    const steps = ['Checking distance', 'Checking capacity', 'Checking food preference', 'Checking expiry'];
    box.innerHTML = `<div class="card"><h2><span class="spinner" aria-hidden="true"></span> Finding best recipient…</h2>
      <ul class="checklist">${steps.map((s) => `<li><span class="tick" aria-hidden="true">✓</span>${s}</li>`).join('')}</ul></div>`;
    const req = api('/donations', { method: 'POST', body }); // runs in parallel with the animation
    req.catch(() => {});
    for (const li of box.querySelectorAll('li')) { await sleep(320); li.classList.add('on'); }
    const r = await req;
    renderMatchResult(r.donation, r.matching);
  }

  function breakdownHtml(b) {
    return `<div class="brk">${Object.values(b).map((x) => `
      <span>${esc(x.label)}</span>
      <div class="hbar" role="img" aria-label="${esc(x.label)}: ${x.points} out of ${x.max} points"><i style="width:${Math.round((x.points / x.max) * 100)}%"></i></div>
      <b>${x.points}/${x.max}</b>
      <div class="d">${esc(x.detail)}</div>`).join('')}</div>`;
  }

  const rejectedHtml = (rejected) => !rejected || !rejected.length ? '' : `
    <h3 style="margin-top:16px;font-size:.95rem">Why the others were skipped</h3>
    <ul class="reasons">${rejected.map((x) => `<li><span class="x" aria-hidden="true">✕</span><span><b>${esc(x.organizationName)}</b> — ${esc(x.reason)}</span></li>`).join('')}</ul>`;

  function renderMatchResult(donation, matching) {
    const box = $('#result');
    if (!box) return;
    const best = matching.best;
    if (matching.candidates && matching.candidates.length) state.lastCands = matching.candidates;

    if (!matching.matched) {
      box.innerHTML = `<div class="card">
        <h2>Donation posted ✓</h2>
        <div class="warn" role="status"><b>No suitable recipient found yet.</b><br>${esc(matching.failureReason || 'No organisation can take this right now.')}</div>
        <p class="small muted">It stays <b>posted</b> so any shelter can still claim it, and we keep retrying automatically until ${esc(fmt(donation.expiryTime))}.</p>
        ${rejectedHtml(matching.rejected)}
        <div class="row" style="margin-top:14px">
          <button class="btn" data-act="retry" data-id="${donation.id}">Try matching again</button>
          <a class="btn ghost" href="#/donation/${donation.id}">View status</a>
        </div></div>`;
      announce('Donation posted, but no suitable recipient was found yet.');
      return;
    }

    const others = (matching.candidates || []).filter((c) => c.recipientId !== best.recipientId);
    box.innerHTML = `<div class="card">
      <ul class="checklist">${['Distance', 'Capacity', 'Food preference', 'Expiry'].map((s) => `<li class="on"><span class="tick" aria-hidden="true">✓</span>${s} checked</li>`).join('')}</ul>
      <p class="muted small" style="margin:0">Best match${matching.elapsedMs != null ? ` · engine took ${matching.elapsedMs} ms` : ''}</p>
      <h2 style="margin:0">${esc(best.organizationName)}</h2>
      <p class="muted" style="margin:4px 0">${best.distanceKm} km away · ~${best.etaMinutes} min · ${best.available} meals of free capacity</p>
      <div class="score">${Math.round(best.score)}<small>/100 match score</small></div>
      ${breakdownHtml(best.breakdown)}
      <div class="note" style="margin-top:14px">Waiting for <b>${esc(best.organizationName)}</b> to confirm. You will be notified, and a driver is dispatched once they do.</div>
      <div class="row"><a class="btn" href="#/donation/${donation.id}">Track status</a></div>
      ${others.length ? `<h3 style="margin-top:18px">Other options</h3>${others.map((c) => `
        <div class="item row between"><div><b>${esc(c.organizationName)}</b><div class="small muted">${c.distanceKm} km · score ${Math.round(c.score)}</div></div>
        <button class="btn ghost sm" data-act="choose" data-id="${donation.id}" data-rid="${c.recipientId}">Choose this one</button></div>`).join('')}` : ''}
      ${rejectedHtml(matching.rejected)}
    </div>`;
    announce(`Matched to ${best.organizationName}, score ${Math.round(best.score)} out of 100.`);
  }

  // -------------------------------------------------------- donation detail
  const STEPS = ['AVAILABLE', 'MATCHED', 'DRIVER_ASSIGNED', 'PICKED_UP', 'DELIVERED'];
  function timelineHtml(d) {
    const dead = d.status === 'EXPIRED' || d.status === 'CANCELLED';
    const idx = dead ? 0 : STEPS.indexOf(d.status);
    return `<ol class="timeline ${dead ? 'expired' : ''}" aria-label="Donation progress">
      ${STEPS.map((s, i) => {
        if (dead && i === 1) return `<li class="t ${d.status === 'CANCELLED' ? 'cancelled' : 'bad'}">${LABEL[d.status]}</li>`;
        return `<li class="t ${i <= idx ? 'done' : ''}">${LABEL[s]}</li>`;
      }).join('')}
    </ol>`;
  }

  const historyHtml = (h) => !h || !h.length ? '' : `
    <div class="card" style="margin-top:16px"><h2>Lifecycle history</h2>
      <ul class="hist">${h.map((e) => `<li>
        <span><span class="badge b-${esc(e.to)}" data-sym="${SYM[e.to] || '•'}">${esc(LABEL[e.to] || e.to)}</span></span>
        <span>${esc(e.note || '')}<span class="when"> — ${esc(fmt(e.at))}${e.actorRole && e.actorRole !== 'SYSTEM' ? ` · by ${esc(e.actorRole.toLowerCase())}` : ''}</span></span>
      </li>`).join('')}</ul></div>`;

  function pageDonation(id) {
    loading();
    poll(async () => {
      const { donation, history } = await api('/donations/' + id);
      let candidates = null;
      let rejected = null;
      if (state.me.role === 'DONOR' && ['AVAILABLE', 'MATCHED'].includes(donation.status) && !donation.recipientAccepted) {
        const c = await api(`/donations/${id}/candidates`);
        candidates = c.candidates;
        rejected = c.rejected;
      }
      return { donation, history, candidates, rejected };
    }, ({ donation: d, history, candidates, rejected }) => {
      const role = state.me.role;
      const awaitingMe = role === 'RECIPIENT' && d.status === 'MATCHED' && !d.recipientAccepted;
      const canCancel = role === 'DONOR' && ['AVAILABLE', 'MATCHED', 'DRIVER_ASSIGNED'].includes(d.status);
      const switchable = (candidates || []).filter((c) => c.recipientId !== d.matchedRecipientId);

      app.innerHTML = `
        <p><a href="${HOME[role]}">← Back to dashboard</a></p>
        <div class="row between"><h1>${esc(d.foodType)}</h1><div class="row">${riskChip(d)}${badge(d.status)}</div></div>
        ${timelineHtml(d)}
        ${d.status === 'CANCELLED' ? `<div class="err" role="status">Cancelled${d.cancelReason ? `: ${esc(d.cancelReason)}` : ''}.</div>` : ''}
        ${d.status === 'EXPIRED' ? '<div class="err" role="status">This donation passed its usable time before it could be collected.</div>' : ''}
        ${d.status === 'AVAILABLE' && d.matchFailureReason ? `<div class="warn" role="status"><b>No suitable recipient yet.</b> ${esc(d.matchFailureReason)}</div>` : ''}
        <div class="grid g2">
          <div class="card">
            <h2>Donation</h2>
            <dl class="kv">
              <dt>Quantity</dt><dd>${esc(d.quantity)} ${esc(d.unit)} (~${d.meals} meals, ${d.weightKg} kg)</dd>
              <dt>Category</dt><dd>${esc(CATS[d.category] || d.category)}</dd>
              <dt>Donor</dt><dd>${esc(d.donorName)}${d.donorPhone ? ` · ${esc(d.donorPhone)}` : ''}</dd>
              <dt>Pickup</dt><dd>${esc(d.pickupAddress)}${d.approximateLocation ? ' <span class="muted small">(approximate until you are involved)</span>' : ''}</dd>
              <dt>Usable until</dt><dd>${fmt(d.expiryTime)}</dd>
              ${d.description ? `<dt>Notes</dt><dd>${esc(d.description)}</dd>` : ''}
              <dt>Posted</dt><dd>${fmt(d.createdAt)}</dd>
              ${d.deliveredAt ? `<dt>Delivered</dt><dd>${fmt(d.deliveredAt)}</dd>` : ''}
            </dl>
            ${canCancel ? `<div class="row" style="margin-top:14px"><button class="btn danger sm" data-act="cancel" data-id="${d.id}">Cancel donation</button></div>` : ''}
          </div>
          <div class="card">
            <h2>Recipient &amp; driver</h2>
            ${d.recipientName ? `<dl class="kv">
                <dt>Matched to</dt><dd><b>${esc(d.recipientName)}</b> ${verifiedBadge(d.recipientVerified)}${d.recipientPhone ? `<br>${esc(d.recipientPhone)}` : ''}</dd>
                <dt>Drop-off</dt><dd>${esc(d.recipientAddress || '-')}</dd>
                <dt>Confirmed</dt><dd>${d.recipientAccepted ? 'Yes ✓' : 'Waiting for confirmation'}</dd>
                <dt>Driver</dt><dd>${d.driverName ? `${esc(d.driverName)}${d.driverPhone ? ` · ${esc(d.driverPhone)}` : ''}` : 'Not assigned yet'}</dd>
              </dl>
              ${d.matchScore != null ? `<div class="score">${Math.round(d.matchScore)}<small>/100 match score</small></div>${d.matchBreakdown ? breakdownHtml(d.matchBreakdown) : ''}` : ''}`
              : '<p class="muted">No recipient matched yet. We keep looking automatically until the food expires.</p>'}
            ${awaitingMe ? `<div class="row" style="margin-top:14px"><button class="btn" data-act="accept" data-id="${d.id}">Accept donation</button><button class="btn danger" data-act="decline" data-id="${d.id}">Decline</button></div>` : ''}
            ${role === 'RECIPIENT' && d.status === 'AVAILABLE' ? `<div class="row" style="margin-top:14px"><button class="btn" data-act="accept" data-id="${d.id}">Claim this donation</button></div>` : ''}
            ${role === 'DONOR' && d.status === 'AVAILABLE' ? `<div class="row" style="margin-top:14px"><button class="btn" data-act="retry" data-id="${d.id}">Try matching again</button></div>` : ''}
            ${d.deliveryId ? `<div style="margin-top:14px"><a class="btn ghost" href="#/delivery/${d.deliveryId}">Track delivery →</a></div>` : ''}
          </div>
        </div>
        ${d.recipientLat != null ? `<div class="card" style="margin-top:16px"><h2>Route <span id="route-info" class="muted small"></span></h2><div id="map" class="map"></div></div>` : ''}
        ${switchable.length ? `<div class="card" style="margin-top:16px"><h2>Other suitable recipients</h2>${switchable.map((c) => `
          <div class="item row between"><div><b>${esc(c.organizationName)}</b><div class="small muted">${c.distanceKm} km · score ${Math.round(c.score)} · ${c.available} meals free</div></div>
          <button class="btn ghost sm" data-act="choose" data-id="${d.id}" data-rid="${c.recipientId}">Choose</button></div>`).join('')}</div>` : ''}
        ${role === 'DONOR' && rejected && rejected.length ? `<div class="card" style="margin-top:16px"><h2>Organisations that cannot take this</h2><ul class="reasons">${rejected.map((x) => `<li><span class="x" aria-hidden="true">✕</span><span><b>${esc(x.organizationName)}</b> — ${esc(x.reason)}</span></li>`).join('')}</ul></div>` : ''}
        ${historyHtml(history)}`;

      if (d.recipientLat != null) {
        drawMap('map', [
          { lat: d.pickupLat, lng: d.pickupLng, label: 'Pickup: ' + d.donorName, icon: '🍽️' },
          { lat: d.recipientLat, lng: d.recipientLng, label: 'Drop-off: ' + d.recipientName, icon: '🏠', cls: 'blue' },
        ], (r) => { const el = $('#route-info'); if (el) el.textContent = `· ${r.km} km · ~${r.min} min by road`; });
      }
    });
  }

  // ------------------------------------------------------- recipient page
  function pageRecipient() {
    loading();
    app.innerHTML = `
      <div class="row between"><h1>Recipient dashboard</h1>
        <a class="btn ghost" href="/api/donations/export.csv" download>⭳ Download report (CSV)</a></div>
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
      $('#stats').innerHTML = `
        ${rec.isAvailable ? '' : `<div class="warn" role="status"><b>You are marked unavailable.</b> New donations will not be matched to you${rec.availabilityNote ? ` (${esc(rec.availabilityNote)})` : ''}.</div>`}
        <div class="grid g3">
          ${stat(`${rec.available} / ${rec.capacity}`, 'Meals capacity free')}${stat(s.incoming, 'Incoming donations')}${stat(s.mealsReceived, 'Meals received')}
        </div>`;

      const awaiting = don.filter((d) => d.status === 'MATCHED' && d.mine && !d.recipientAccepted);
      const avail = don.filter((d) => d.status === 'AVAILABLE');
      $('#sections').innerHTML = `
        <section class="card"><h2>Awaiting your confirmation</h2>
          ${awaiting.length ? awaiting.map((d) => `<article class="item">
            <div class="row between"><h3><a href="#/donation/${d.id}">${esc(d.foodType)}</a></h3><span class="badge b-MATCHED" data-sym="◆">Score ${Math.round(d.matchScore)}</span></div>
            <div class="row small muted">${riskChip(d)}<span>${d.meals} meals · from ${esc(d.donorName)}</span></div>
            <div class="row" style="margin-top:8px"><button class="btn sm" data-act="accept" data-id="${d.id}">Accept</button><button class="btn danger sm" data-act="decline" data-id="${d.id}">Decline</button></div>
          </article>`).join('') : '<p class="muted">Nothing waiting. New matches appear here automatically.</p>'}
        </section>
        <section class="card"><h2>Available donations nearby</h2>
          ${avail.length ? avail.map((d) => `<article class="item">
            <div class="row between"><h3><a href="#/donation/${d.id}">${esc(d.foodType)}</a></h3>${badge('AVAILABLE')}</div>
            <div class="row small muted">${riskChip(d)}<span>${d.meals} meals · ${esc(CATS[d.category] || d.category)} · ${d.fit.distanceKm} km</span></div>
            ${d.fit.eligible
              ? `<div class="row" style="margin-top:8px"><button class="btn ghost sm" data-act="accept" data-id="${d.id}">Claim (score ${Math.round(d.fit.score)})</button></div>`
              : `<p class="small" style="color:var(--red);margin:6px 0 0"><span aria-hidden="true">✕</span> Cannot take this: ${esc(d.fit.reason)}</p>`}
          </article>`).join('') : '<p class="muted">No unmatched donations in range right now.</p>'}
        </section>
        <section class="card"><h2>Incoming &amp; past deliveries</h2>
          ${del.length ? del.map((x) => `<div class="item row between"><div><b><a href="#/delivery/${x.id}">${esc(x.foodType)}</a></b><div class="small muted">${x.meals} meals · ${esc(x.donorName)}${x.driverName ? ` · 🚚 ${esc(x.driverName)}` : ''}</div></div>${badge(x.status)}</div>`).join('') : '<p class="muted">No deliveries yet.</p>'}
        </section>`;
      if (!profileDrawn) { profileDrawn = true; drawProfile(rec); }
    });
  }

  function drawProfile(r) {
    $('#profile').innerHTML = `
      <form class="card" id="pf" novalidate>
        <h2>Organization profile ${verifiedBadge(r.isVerified)}</h2>
        ${r.isVerified
          ? ''
          : '<p class="small muted">Verification is granted by the platform team once your registration documents are checked. Donors can see this status.</p>'}
        <div class="switch ${r.isAvailable ? '' : 'off'}">
          <input type="checkbox" id="avail" ${r.isAvailable ? 'checked' : ''}>
          <label for="avail" style="margin:0">Currently accepting donations</label>
        </div>
        <label for="anote">Availability note <span class="muted small">(optional)</span></label>
        <input id="anote" maxlength="200" value="${esc(r.availabilityNote || '')}" placeholder="e.g. Closed after 9 PM">
        <label for="org">Organization name</label><input id="org" value="${esc(r.organizationName)}" required maxlength="120">
        <div class="form-row">
          <div><label for="cap">Capacity (meals)</label><input id="cap" type="number" min="1" value="${r.capacity}" required></div>
          <div><label for="need">Current need</label><select id="need">${['LOW', 'MEDIUM', 'HIGH'].map((n) => `<option ${n === r.currentNeed ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        </div>
        <p class="small muted">${r.currentLoad} meals currently committed. Location: ${esc(r.address || '-')}</p>
        <fieldset style="border:0;padding:0;margin:12px 0 0">
          <legend style="font-weight:600;font-size:.9rem;padding:0">Food you accept <span class="muted small">(none = everything)</span></legend>
          <div class="checks">${Object.entries(CATS).map(([k, v]) => `<label><input type="checkbox" name="cat" value="${k}" ${r.acceptedFoodTypes.includes(k) ? 'checked' : ''}> ${v}</label>`).join('')}</div>
        </fieldset>
        <div id="pmsg"></div>
        <p><button class="btn">Save profile</button></p>
      </form>`;
    $('#pf').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/recipients/me', { method: 'PUT', body: {
          organizationName: $('#org').value,
          capacity: Number($('#cap').value),
          currentNeed: $('#need').value,
          isAvailable: $('#avail').checked,
          availabilityNote: $('#anote').value || undefined,
          acceptedFoodTypes: [...$('#pf').querySelectorAll('[name=cat]:checked')].map((c) => c.value),
        } });
        toast('Profile saved');
        announce('Profile saved');
        $('#pmsg').innerHTML = '';
      } catch (err) { $('#pmsg').innerHTML = errBox(err); }
    });
  }

  // ----------------------------------------------------------- driver page
  const routeLine = (x) => `
    <p class="small" style="margin:6px 0">
      <b>Pickup:</b> ${esc(x.donorName)} — ${esc(x.pickupAddress)}<br>
      <b>Drop-off:</b> ${esc(x.recipientName)} — ${esc(x.dropAddress)}<br>
      ${x.distanceKm} km · ~${x.etaMinutes} min
    </p>
    <div class="row small">${riskChip(x)}</div>`;

  function deliveryButtons(x) {
    if (x.status === 'PENDING') return `<button class="btn" data-act="dAccept" data-id="${x.id}">Accept task</button>`;
    if (x.status === 'ASSIGNED') return `<button class="btn" data-act="dPickup" data-id="${x.id}">Mark picked up</button>
      <button class="btn ghost sm" data-act="dRelease" data-id="${x.id}">Release task</button>`;
    if (x.status === 'PICKED_UP') return `<button class="btn" data-act="dDeliver" data-id="${x.id}">Mark delivered</button>
      <button class="btn danger sm" data-act="dFail" data-id="${x.id}">Report a problem</button>`;
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
        ${active.length ? active.map((x) => `<article class="item">
          <div class="row between"><h3><a href="#/delivery/${x.id}">${esc(x.foodType)} · ${x.meals} meals</a></h3>${badge(x.status)}</div>
          ${routeLine(x)}
          <div class="row" style="margin-top:10px">${deliveryButtons(x)}<a class="btn ghost" href="#/delivery/${x.id}">Map &amp; route</a></div>
        </article>`).join('') : '<div class="card muted">No active delivery. Accept one below.</div>'}
        <h2 style="margin-top:24px">Open pickup tasks</h2>
        ${open.length ? open.map((x) => `<article class="item">
          <div class="row between"><h3><a href="#/delivery/${x.id}">${esc(x.foodType)} · ${x.meals} meals</a></h3>${badge(x.status)}</div>
          ${routeLine(x)}
          ${x.distanceFromYouKm != null ? `<p class="small muted" style="margin:4px 0">Pickup is ${x.distanceFromYouKm} km from your registered location</p>` : ''}
          <div class="row" style="margin-top:10px">${deliveryButtons(x)}</div>
        </article>`).join('') : '<div class="card muted">No open tasks right now. New ones appear here automatically.</div>'}
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
        <p><a href="${HOME[me.role]}">← Back to dashboard</a></p>
        <div class="row between"><h1>Delivery #${x.id}</h1><div class="row">${riskChip(x)}${badge(x.status)}</div></div>
        <ol class="timeline ${x.status === 'CANCELLED' ? 'expired' : ''}" aria-label="Delivery progress">
          ${steps.map((s, i) => `<li class="t ${i <= idx && x.status !== 'CANCELLED' ? 'done' : ''} ${x.status === 'CANCELLED' && i === 1 ? 'cancelled' : ''}">${x.status === 'CANCELLED' && i === 1 ? 'Cancelled' : LABEL[s]}</li>`).join('')}
        </ol>
        ${x.status === 'CANCELLED' ? '<div class="err" role="status">This delivery was cancelled - the food expired or the donor withdrew it.</div>' : ''}
        <div class="grid g2">
          <div class="card"><h2>${esc(x.foodType)} · ${x.meals} meals (${x.weightKg} kg)</h2>
            <dl class="kv">
              <dt>Pickup</dt><dd>${esc(x.donorName)}<br><span class="muted">${esc(x.pickupAddress)}</span></dd>
              <dt>Drop-off</dt><dd>${esc(x.recipientName)}<br><span class="muted">${esc(x.dropAddress)}</span></dd>
              <dt>Distance</dt><dd><span id="dist">${x.distanceKm} km</span></dd>
              <dt>Est. time</dt><dd><span id="eta">~${x.etaMinutes} min</span></dd>
              <dt>Driver</dt><dd>${x.driverName ? esc(x.driverName) : 'Not assigned yet'}</dd>
              <dt>Usable until</dt><dd>${fmt(x.expiryTime)}</dd>
              ${x.pickupTime ? `<dt>Picked up</dt><dd>${fmt(x.pickupTime)}</dd>` : ''}
              ${x.deliveryTime ? `<dt>Delivered</dt><dd>${fmt(x.deliveryTime)}</dd>` : ''}
            </dl>
            <div class="row" style="margin-top:14px">${(isMine || canAccept) ? deliveryButtons(x) : ''}<a class="btn ghost" href="#/donation/${x.donationId}">Donation details</a></div>
          </div>
          <div class="card"><h2>Route</h2><div id="map" class="map"></div>
            <p class="small muted" style="margin-top:8px">${x.approximateLocation
              ? 'Locations are approximate (about 1 km) until you accept this task - exact addresses appear once it is yours.'
              : 'Road route from OpenStreetMap. If routing is unavailable the straight-line distance above is used.'}</p>
          </div>
        </div>`;
      const pts = [];
      if (x.driverLat != null && x.status === 'ASSIGNED') {
        pts.push({ lat: x.driverLat, lng: x.driverLng, label: 'Driver: ' + x.driverName, icon: '🚚', cls: 'amber' });
      }
      pts.push({ lat: x.pickupLat, lng: x.pickupLng, label: 'Pickup: ' + x.donorName, icon: '🍽️' });
      pts.push({ lat: x.dropLat, lng: x.dropLng, label: 'Drop-off: ' + x.recipientName, icon: '🏠', cls: 'blue' });
      drawMap('map', pts, (r) => {
        const d = $('#dist'); const e = $('#eta');
        if (!d || !e) return;
        d.textContent = pts.length === 2 ? `${r.km} km by road` : `${r.km} km total (driver → pickup → drop-off)`;
        e.textContent = `~${r.min} min`;
      });
    });
  }

  // ---------------------------------------------------------------- impact
  const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All time']];

  function pageImpact(_, params) {
    const period = PERIODS.some(([p]) => p === params.get('period')) ? params.get('period') : 'all';
    loading();
    poll(() => api('/stats/impact?period=' + period), (s) => {
      const days = [];
      for (let i = 13; i >= 0; i--) {
        const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        days.push({ day: key, meals: (s.daily.find((x) => x.day === key) || {}).meals || 0 });
      }
      const max = Math.max(1, ...days.map((d) => d.meals));
      const cmax = Math.max(1, ...s.byCategory.map((c) => c.meals));
      const mins = (sec) => (sec == null ? '—' : sec < 1 ? 'under 1s' : sec < 90 ? `${sec}s` : `${Math.round(sec / 60)} min`);

      app.innerHTML = `
        <h1>Impact dashboard</h1>
        <p class="muted">Every figure is calculated from delivery records in the database.</p>
        <div class="filters" role="group" aria-label="Time period">
          ${PERIODS.map(([p, label]) => `<a class="chip" href="#/impact?period=${p}" ${p === period ? 'aria-current="true"' : ''}>${label}</a>`).join('')}
        </div>
        <div class="grid g3">
          ${stat(s.mealsRescued.toLocaleString(), 'Meals rescued')}
          ${stat(s.weightKg.toLocaleString() + ' kg', 'Food weight diverted')}
          ${stat(s.co2eKg.toLocaleString() + ' kg', 'CO₂e avoided', 'estimate — see method below')}
          ${stat(s.successfulDeliveries, 'Successful deliveries')}
          ${stat(s.organizationsHelped, 'Organizations helped')}
          ${stat(s.activeDonations, 'Active donations')}
        </div>
        <div class="grid g3" style="margin-top:16px">
          ${stat(s.totalDonations, 'Total donations posted')}
          ${stat(s.successfulMatches, 'Successful matches')}
          ${stat(s.pickupSuccessRate == null ? '—' : s.pickupSuccessRate + '%', 'Delivery success rate', 'delivered ÷ concluded')}
          ${stat(mins(s.avgMatchingSeconds), 'Average time to match')}
          ${stat(s.avgDeliveryMinutes == null ? '—' : s.avgDeliveryMinutes + ' min', 'Average match → delivery')}
          ${stat(s.expiredDonations, 'Expired before pickup')}
        </div>
        <div class="grid g2" style="margin-top:16px">
          <div class="card"><h2>Meals delivered — last 14 days</h2>
            <div class="bars">${days.map((d) => `<div class="col"><span class="v">${d.meals || ''}</span><div class="bar" style="height:${Math.round((d.meals / max) * 100)}%"></div><span class="d">${d.day.slice(8)}</span></div>`).join('')}</div>
            <table class="visually-hidden"><caption>Meals delivered per day</caption><tbody>${days.map((d) => `<tr><th scope="row">${d.day}</th><td>${d.meals}</td></tr>`).join('')}</tbody></table>
          </div>
          <div class="card"><h2>By food category</h2>
            ${s.byCategory.length ? s.byCategory.map((c) => `<div style="margin:10px 0">
              <div class="row between small"><span>${esc(CATS[c.category] || c.category)}</span><b>${c.meals} meals</b></div>
              <div class="hbar" role="img" aria-label="${esc(CATS[c.category] || c.category)}: ${c.meals} meals"><i style="width:${Math.round((c.meals / cmax) * 100)}%"></i></div>
            </div>`).join('') : '<p class="muted">No deliveries in this period yet.</p>'}
          </div>
        </div>
        <details class="method-box">
          <summary>How these numbers are calculated</summary>
          <dl class="method">
            <dt>Meals rescued</dt><dd>${esc(s.methodology.meals)}</dd>
            <dt>Food weight diverted</dt><dd>${esc(s.methodology.weight)}</dd>
            <dt>CO₂e avoided</dt><dd>${esc(s.methodology.co2e)}</dd>
            <dt>Water saved (${s.waterLitres.toLocaleString()} L)</dt><dd>${esc(s.methodology.water)}</dd>
          </dl>
          <p class="warn small" style="margin-top:12px">${esc(s.methodology.caveat)}</p>
        </details>`;
    }, 10000);
  }

  // ---------------------------------------------------------------- router
  const routes = [
    [/^#?\/?$/, pageLanding, null],
    [/^#\/login$/, pageLogin, null],
    [/^#\/register$/, pageRegister, null],
    [/^#\/complete-profile$/, pageCompleteProfile, null],
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

    const raw = location.hash || '#/';
    const [path, query] = raw.split('?');
    const params = new URLSearchParams(query || '');

    for (const [re, fn, role] of routes) {
      const m = path.match(re);
      if (!m) continue;
      if (role && !state.me) return go('#/login');
      if (role && role !== '*' && state.me.role !== role) return go(HOME[state.me.role]);
      renderNav();
      window.scrollTo(0, 0);
      app.focus({ preventScroll: true }); // move keyboard focus to the new page content
      try { await fn(m[1], params); } catch (e) { app.innerHTML = errBox(e); }
      return;
    }
    renderNav();
    app.innerHTML = '<div class="card"><h1>Page not found</h1><p><a href="#/">Go home</a></p></div>';
  }

  window.addEventListener('hashchange', route);
  (async () => {
    try {
      const [me, cfg] = await Promise.allSettled([api('/auth/me'), api('/auth/config')]);
      state.me = me.status === 'fulfilled' ? me.value.user : null;
      state.google = cfg.status === 'fulfilled' ? !!cfg.value.google : false;
      if (state.me) refreshNotifs();
    } catch { state.me = null; }
    route();
  })();
})();
