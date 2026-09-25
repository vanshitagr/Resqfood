(() => {
  'use strict';

  // ------------------------------------------------------------- helpers
  const $ = (s, r = document) => r.querySelector(s);
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CATS = { cooked: 'Cooked meals', produce: 'Fresh produce', bakery: 'Bakery', packaged: 'Packaged', dairy: 'Dairy', beverages: 'Beverages' };
  const HOME = { DONOR: '#/donor', RECIPIENT: '#/recipient', DRIVER: '#/driver' };
  const state = { me: null, gen: 0, timers: [], map: null, notifOpen: false, notifs: { items: [], unread: 0 }, google: false, lastCands: [], sys: 'checking', countGen: -1 };

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
  // Display form of the real numeric id: 12 -> #RSQ-0012. Cosmetic only; the API still uses 12.
  const rid = (id) => `#RSQ-${String(id).padStart(4, '0')}`;

  // "1h 45m", "12m" or "expired" for a span in milliseconds.
  function spanText(ms) {
    const m = Math.round(ms / 60000);
    if (m <= 0) return 'expired';
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  }
  function timeLeft(iso) {
    const t = spanText(Date.parse(iso) - Date.now());
    return t === 'expired' ? t : `${t} left`;
  }

  // Live countdown. Computed in the browser from the real expiry time, and ticked by a single
  // shared interval (see tickCountdowns), so nothing is re-rendered or re-fetched to move it.
  // Hours are not capped at 24, so a 26 hour window reads 26:00:00.
  function clock(iso) {
    const s = Math.max(0, Math.floor((Date.parse(iso) - Date.now()) / 1000));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  }
  const countdown = (iso, cls = '') =>
    `<span class="cd ${cls}" role="timer" data-expiry="${esc(iso)}">${clock(iso)}</span>`;
  function tickCountdowns() {
    document.querySelectorAll('.cd[data-expiry]').forEach((el) => {
      const t = clock(el.dataset.expiry);
      if (el.textContent !== t) el.textContent = t;
    });
  }
  // The backend classifies the risk; the browser only colours the number to match.
  const urgCls = (d) => (d.expiryRisk === 'HIGH' ? 'crit-t' : d.expiryRisk === 'MEDIUM' ? 'warn-t' : '');

  // Status colour is backed up by a symbol and a word, so nothing depends on colour alone.
  const SYM = {
    AVAILABLE: '◷', MATCHED: '◆', DRIVER_ASSIGNED: '⇢', PICKED_UP: '↑', DELIVERED: '✓',
    EXPIRED: '✕', CANCELLED: '⊘', PENDING: '◷', ASSIGNED: '⇢',
  };
  const LABEL = {
    AVAILABLE: 'Posted', MATCHED: 'Matched', DRIVER_ASSIGNED: 'Driver assigned', PICKED_UP: 'Picked up',
    DELIVERED: 'Delivered', EXPIRED: 'Expired', CANCELLED: 'Cancelled', PENDING: 'Awaiting driver', ASSIGNED: 'Driver assigned',
  };
  // `live` shows PICKED_UP as "En route" on live-rescue surfaces. The lifecycle history keeps the
  // backend's own wording, because that is the audit trail.
  const badge = (s, live = false) => {
    const text = live && s === 'PICKED_UP' ? 'En route' : (LABEL[s] || s.replace('_', ' '));
    return `<span class="badge b-${esc(s)}" data-sym="${SYM[s] || '•'}">${esc(text)}</span>`;
  };

  // word is what sighted users read; sr is the plain-language risk level for screen readers.
  const RISK = {
    LOW: { sym: '●', word: 'On track', sr: 'Low risk' },
    MEDIUM: { sym: '◐', word: 'Expiring soon', sr: 'Medium risk' },
    HIGH: { sym: '▲', word: 'Critical', sr: 'High risk' },
    EXPIRED: { sym: '✕', word: 'Expired', sr: 'Expired' },
    NONE: { sym: '✓', word: 'Delivered', sr: 'Delivered' },
  };
  const LIVE_STATUSES = ['AVAILABLE', 'MATCHED', 'DRIVER_ASSIGNED', 'PICKED_UP', 'PENDING', 'ASSIGNED'];
  function riskChip(d) {
    // Once a donation is finished the status badge already tells the story.
    if (d.status && !LIVE_STATUSES.includes(d.status)) return '';
    const r = RISK[d.expiryRisk] || RISK.LOW;
    return `<span class="risk risk-${esc(d.expiryRisk)}"><span aria-hidden="true">${r.sym}</span><span class="risk-word">${r.word}</span><span class="visually-hidden"> (${r.sr})</span></span>`;
  }

  const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  // ---- loading / empty / error states, shared by every page ----------------------------------
  const loading = () => {
    app.innerHTML = `<div aria-busy="true"><span class="visually-hidden" role="status">Loading…</span>
      <div class="skel skel-title"></div>
      <div class="grid g4"><div class="skel skel-card"></div><div class="skel skel-card"></div><div class="skel skel-card"></div><div class="skel skel-card"></div></div>
      <div class="skel skel-block"></div></div>`;
  };
  const emptyState = (title, text, action = '') =>
    `<div class="empty" role="status"><div class="empty-title">${esc(title)}</div><p>${esc(text)}</p>${action}</div>`;
  // Inline message inside a form.
  const errBox = (e) => `<div class="err" role="alert"><div class="err-title">Error</div>${esc(e.message || e)}</div>`;
  // Whole-page failure, with a way out.
  const errState = (e) => `<div class="err-state" role="alert"><div class="err-title">Could not load this page</div>
    <p>${esc(e.message || e)}</p><button class="btn" data-act="reload">Try again</button></div>`;

  // Metric card. Plain numbers count up once when a page first appears (see countUp).
  const stat = (num, lbl, hint = '', key = false) => {
    const raw = String(num);
    const m = raw.match(/^(-?[\d,]*\.?\d+)([^\d/:]*)$/);
    let attrs = '';
    if (m) {
      const to = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(to)) {
        const dp = (m[1].split('.')[1] || '').length;
        attrs = ` data-to="${to}" data-dp="${dp}" data-suffix="${esc(m[2])}" data-grp="${m[1].includes(',') ? 1 : 0}"`;
      }
    }
    return `<div class="card stat"><div class="num${key ? ' key' : ''}"${attrs}>${esc(raw)}</div><div class="lbl">${esc(lbl)}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
  };
  function countUp(root) {
    if (state.countGen === state.gen) return;
    const els = [...root.querySelectorAll('[data-to]')];
    if (!els.length) return;
    state.countGen = state.gen; // animate once per page view; later polls just show the final value
    els.forEach((el) => { el.dataset.final = el.textContent; });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t0 = performance.now();
    const D = 700;
    const show = (el, v) => {
      const dp = Number(el.dataset.dp);
      el.textContent = v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp, useGrouping: el.dataset.grp === '1' }) + el.dataset.suffix;
    };
    const step = (now) => {
      const p = Math.min(1, (now - t0) / D);
      const e = 1 - Math.pow(1 - p, 3);
      els.forEach((el) => { if (el.isConnected) { if (p < 1) show(el, Number(el.dataset.to) * e); else el.textContent = el.dataset.final; } });
      if (p < 1) requestAnimationFrame(step);
    };
    els.forEach((el) => show(el, 0));
    requestAnimationFrame(step);
    // rAF is paused in background tabs; make sure the real value always lands.
    setTimeout(() => els.forEach((el) => { if (el.isConnected) el.textContent = el.dataset.final; }), D + 150);
  }

  const svg = (d) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;
  const ICON = {
    overview: svg('<path d="M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z"/>'),
    plus: svg('<path d="M12 4v16M4 12h16"/>'),
    impact: svg('<path d="M4 20V11M10 20V4M16 20v-6M2 20h20"/>'),
    bell: svg('<path d="M6 17V11a6 6 0 0112 0v6l2 2H4zM10 21h4"/>'),
  };

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
        if (force) app.innerHTML = errState(e);
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
  const TITLES = [
    [/^#\/donor\/new/, 'Post surplus'], [/^#\/donor/, 'Donor operations'], [/^#\/recipient/, 'Recipient operations'],
    [/^#\/driver/, 'Driver operations'], [/^#\/donation\//, 'Rescue detail'], [/^#\/delivery\//, 'Delivery tracking'],
    [/^#\/impact/, 'Impact'], [/^#\/notifications/, 'Notifications'], [/^#\/(login|register|complete-profile)/, 'Access'],
  ];
  const pageTitle = () => {
    const m = TITLES.find(([re]) => re.test(location.hash || '#/'));
    return m ? m[1] : 'Operations';
  };
  const SYS_TEXT = { checking: 'Checking', online: 'System online', degraded: 'Degraded', offline: 'Offline' };
  const NTITLE = {
    MATCH: 'New match', NO_MATCH: 'No match found', ACCEPTED: 'Shelter confirmed', TASK: 'New pickup task',
    DRIVER: 'Driver update', PICKUP_SOON: 'Pickup due', EXPIRING: 'Expiry warning', PICKED_UP: 'Picked up',
    DELIVERED: 'Delivery completed', EXPIRED: 'Donation expired', CANCELLED: 'Cancelled',
  };

  function renderNav() {
    const me = state.me;
    document.body.classList.toggle('authed', !!me);
    const here = (location.hash || '#/').split('?')[0];
    const items = me
      ? [
        { href: HOME[me.role], label: 'Overview', short: 'Home', icon: 'overview' },
        ...(me.role === 'DONOR' ? [{ href: '#/donor/new', label: 'Post surplus', short: 'Post', icon: 'plus' }] : []),
        { href: '#/impact', label: 'Impact', icon: 'impact' },
        { href: '#/notifications', label: 'Notifications', short: 'Alerts', icon: 'bell', badge: state.notifs.unread },
      ]
      : [];
    const link = (i) => `<a class="link ${here === i.href ? 'active' : ''}" href="${i.href}" ${here === i.href ? 'aria-current="page"' : ''}>${ICON[i.icon]}<span class="nl"><span class="lbl-long">${i.label}</span><span class="lbl-short">${i.short || i.label}</span></span>${i.badge ? `<span class="nb"><span class="visually-hidden">${i.badge} unread </span><span aria-hidden="true">${i.badge}</span></span>` : ''}</a>`;

    $('#nav').innerHTML = me
      ? `<a class="brand" href="#/"><span class="brand-mark" aria-hidden="true"></span>RESQFOOD</a>
         <nav class="side-links" aria-label="Main">${items.map(link).join('')}</nav>
         <div class="side-user">
           <div class="su-role">${esc(me.role)}</div>
           <div class="su-name">${esc(me.name)}</div>
           <div style="display:flex;gap:4px;margin-top:4px;">
             <a href="#/profile" class="btn ghost sm">Profile</a>
             <button class="btn ghost sm" data-act="logout">Log out</button>
           </div>
         </div>`
      : '';

    $('#topbar').innerHTML = `
      <div class="tb-left">
        <a class="tb-brand" href="#/"><span class="brand-mark" aria-hidden="true"></span>RESQFOOD</a>
        <span class="tb-title">${esc(pageTitle())}</span>
        <span class="sys sys-${state.sys}"><i aria-hidden="true"></i>${SYS_TEXT[state.sys]}</span>
      </div>
      <div class="tb-right">
        ${me
          ? `<button class="bell" data-act="bell" aria-expanded="${state.notifOpen}" aria-label="Notifications${state.notifs.unread ? `, ${state.notifs.unread} unread` : ''}">${ICON.bell}${state.notifs.unread ? `<span class="dot" aria-hidden="true">${state.notifs.unread}</span>` : ''}</button>
             <span class="tb-user"><b>${esc(me.name)}</b><small>${esc(me.role)}</small></span>
             <button class="btn ghost sm tb-logout" data-act="logout">Log out</button>`
          : `<a class="tb-link" href="#/impact">Impact</a><a class="tb-link" href="#/login">Log in</a><a class="btn sm" href="#/register">Sign up</a>`}
      </div>
      ${state.notifOpen ? notifPanel() : ''}`;
  }

  function notifPanel() {
    const items = state.notifs.items.slice(0, 8);
    return `<div class="notif-panel" role="region" aria-label="Notifications">${items.length
      ? items.map((n) => `<div class="n ${n.read ? '' : 'unread'} ${n.severity === 'URGENT' ? 'urgent' : ''}">
          <div class="n-type">${esc(NTITLE[n.type] || n.type)}${n.severity === 'URGENT' ? '<span class="tag-urgent">Urgent</span>' : ''}</div>
          ${n.donationId ? `<a href="#/donation/${n.donationId}" data-act="closeNotif">${esc(n.message)}</a>` : esc(n.message)}
          <div class="small muted mono">${fmt(n.createdAt)}</div></div>`).join('')
      + '<div class="n-foot"><a href="#/notifications" data-act="closeNotif">View all notifications</a></div>'
      : '<div class="n"><p class="muted small" style="margin:0">No notifications yet.</p></div>'}</div>`;
  }

  // Reflects the real state of the server: it calls the existing /api/health endpoint.
  async function checkHealth() {
    let next = 'online';
    try { await api('/health'); } catch (e) { next = e.status ? 'degraded' : 'offline'; }
    if (next !== state.sys) { state.sys = next; renderNav(); }
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
    reload: () => route(),
    async readAll() {
      await api('/notifications/read', { method: 'POST', body: {} });
      state.notifs.unread = 0;
      route();
    },
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
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '© OpenStreetMap, © CARTO', maxZoom: 19 }).addTo(map);
    const latlngs = pts.map((p) => [p.lat, p.lng]);
    pts.forEach((p) => {
      const icon = L.divIcon({ className: '', html: `<div class="pin ${p.cls || ''}">${p.icon}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });
      L.marker([p.lat, p.lng], { icon, title: p.label, alt: p.label }).addTo(map).bindTooltip(p.label);
    });
    map.fitBounds(latlngs, { padding: [40, 40], maxZoom: 15 });
    const line = L.polyline(latlngs, { color: '#B8FF3D', weight: 4, dashArray: '8 8' }).addTo(map);
    try {
      const coords = pts.map((p) => `${p.lng},${p.lat}`).join(';');
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      const route = data.routes && data.routes[0];
      if (route && state.map === map) {
        line.remove();
        const geo = L.geoJSON(route.geometry, { style: { color: '#B8FF3D', weight: 5 } }).addTo(map);
        map.fitBounds(geo.getBounds(), { padding: [40, 40] });
        onRoute && onRoute({ km: Math.round(route.distance / 100) / 10, min: Math.max(1, Math.round(route.duration / 60)) });
      }
    } catch { /* routing unavailable: the dashed straight line and stored distance remain */ }
  }

  // --------------------------------------------------------------- landing
  // CO2e reads better in tonnes once it passes a tonne. Presentation only.
  const co2Text = (kg) => (kg >= 1000 ? `${(kg / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} t` : `${kg.toLocaleString()} kg`);

  async function pageLanding() {
    const gen = state.gen;
    let s = null;
    try { s = await api('/stats/impact'); } catch { /* landing still renders without stats */ }
    if (gen !== state.gen) return;
    const me = state.me;
    const postHref = !me ? '#/register' : me.role === 'DONOR' ? '#/donor/new' : HOME[me.role];
    app.innerHTML = `
      <section class="hero">
        <div>
          <p class="eyebrow">Real-time food rescue logistics</p>
          <h1>Rescue food <em>before it expires.</em></h1>
          <p class="lede">Real-time surplus food coordination between donors, drivers and community organizations.</p>
          <div class="row">
            <a class="btn lg" href="${postHref}">Post surplus</a>
            ${me ? `<a class="btn ghost lg" href="${HOME[me.role]}">View live rescues</a>` : `<a class="btn ghost lg" href="#/impact">View live impact</a>`}
          </div>
          ${me ? '' : '<p class="small muted">Already registered? <a href="#/login">Log in</a></p>'}
        </div>
        <aside class="card key demo-panel" aria-label="Example of a rescue">
          <span class="demo-tag">Demonstration · sample data, not a live rescue</span>
          <div class="rescue-body">
            <div class="rescue-qty"><span class="q">25</span><span class="u">kg</span></div>
            <div><h3>Cooked rice</h3></div>
          </div>
          <dl class="rescue-grid">
            <div><dt>Donor</dt><dd>Local restaurant</dd></div>
            <div><dt>Matched to</dt><dd>Hope Shelter</dd></div>
            <div><dt>Driver</dt><dd>Aman</dd></div>
            <div><dt>ETA</dt><dd class="mono">11 min</dd></div>
            <div><dt>Expires</dt><dd><span class="cd">01:42:18</span></dd></div>
            <div><dt>Status</dt><dd><span class="badge b-PICKED_UP" data-sym="↑">En route</span></dd></div>
          </dl>
        </aside>
      </section>

      ${s ? `<section aria-label="Impact so far"><p class="eyebrow">Recorded impact · real data</p>
        <div class="grid g4">
          ${stat(s.mealsRescued.toLocaleString(), 'Meals rescued', '', true)}
          ${stat(s.weightKg.toLocaleString() + ' kg', 'Food diverted')}
          ${stat(co2Text(s.co2eKg), 'CO₂e avoided', 'estimate')}
          ${stat(s.activeDonations, 'Active rescues')}
        </div></section>` : ''}

      <ol class="flow" aria-label="How a rescue works">
        <li class="step"><b>01</b><strong>Donor</strong><small>posts surplus food</small></li>
        <li class="step"><b>02</b><strong>Match</strong><small>best nearby recipient</small></li>
        <li class="step"><b>03</b><strong>Driver</strong><small>picks it up</small></li>
        <li class="step"><b>04</b><strong>NGO</strong><small>receives and confirms</small></li>
        <li class="step"><b>05</b><strong>Impact</strong><small>recorded from real deliveries</small></li>
      </ol>

      <section class="grid g3">
        <div class="card"><h3>For donors</h3><p class="muted" style="margin-top:8px">Post surplus in under a minute, even by typing a sentence. Track it until it is delivered.</p></div>
        <div class="card"><h3>For shelters &amp; NGOs</h3><p class="muted" style="margin-top:8px">Set your capacity and food preferences. Get matched only with food you can use, in time.</p></div>
        <div class="card"><h3>For drivers</h3><p class="muted" style="margin-top:8px">See nearby pickups, follow the route on the map and update status in two taps.</p></div>
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
      <form class="card key auth-card" id="f" novalidate>
        <p class="eyebrow">Access</p>
        <h1>Log in</h1>
        ${oauthError ? `<div class="err" role="alert"><div class="err-title">Sign-in problem</div>${esc(OAUTH_ERRORS[oauthError] || 'Sign-in failed. Please try again.')}</div>` : ''}
        ${googleButton(null, 'Continue with Google')}
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="username" aria-describedby="msg">
        <label for="pw">Password</label>
        <input id="pw" name="password" type="password" required autocomplete="current-password">
        <div id="msg"></div>
        <button class="btn lg block" style="margin-top:16px">Log in</button>
        <p class="muted small" style="margin:16px 0 0">New here? <a href="#/register">Create an account</a></p>
      </form>`;
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
      <div class="loc-row">
        <input id="${id}" value="${esc(initial)}" placeholder="e.g. Malviya Nagar, Jaipur" required aria-describedby="${id}-h">
        <button type="button" class="btn ghost sm" id="${id}-gps">📍 Use my location</button>
        <button type="button" class="btn ghost sm" id="${id}-map-btn">🗺️ Pick on map</button>
      </div>
      <p class="small muted" id="${id}-h">Any city works - we look up the coordinates to measure real distances.</p>
      <div id="${id}-map-picker" style="height:250px; margin-top:8px; display:none; border-radius: 6px; z-index: 0; border: 1px solid var(--border)"></div>
      <p class="small gps-msg" id="${id}-gps-msg" role="status" hidden></p>`;
  }
  // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT. The generic
  // "could not get your location" hid the only thing that matters: what to do next.
  const GEO_ERRORS = {
    1: 'Location is blocked for this site. Allow it from the padlock icon in your address bar, then try again.',
    2: 'Your device could not work out where it is. Type the address instead.',
    3: 'Locating took too long. Try again, or type the address instead.',
  };

  // Wires the GPS button; .lat/.lng are set only when exact coordinates are known.
  //
  // The coordinates are sent alongside the address text rather than replacing it. The
  // backend prefers explicit coordinates for distance and routing, so matching still uses
  // the exact position, while the shelter and driver keep a readable address to navigate
  // to. Overwriting the field with "Current location (26.9124, 75.7873)" meant whoever
  // collected the food saw raw numbers instead of somewhere they could find.
  function wireLocation(id) {
    const c = { lat: null, lng: null, accuracy: null };
    const input = $('#' + id);
    const btn = $(`#${id}-gps`);
    const msg = $(`#${id}-gps-msg`);

    const say = (text, kind = '') => {
      msg.hidden = !text;
      msg.textContent = text;
      msg.className = 'small gps-msg ' + kind;
    };

    // Typing a different address invalidates any pinned coordinates.
    input.addEventListener('input', () => {
      if (c.lat !== null) { c.lat = c.lng = c.accuracy = null; say(''); }
    });

    btn.addEventListener('click', () => {
      // Geolocation needs a secure context. Opening the app over a LAN address such as
      // http://192.168.1.5:3000 disables it silently in every modern browser, which looks
      // exactly like the button being broken.
      if (!navigator.geolocation) return say('This browser cannot share your location. Type the address instead.', 'bad');
      if (!window.isSecureContext) {
        return say('Browsers only share location over HTTPS or on localhost. Type the address instead.', 'bad');
      }

      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Locating…';
      say('Getting your position…');

      navigator.geolocation.getCurrentPosition(
        (p) => {
          btn.disabled = false; btn.textContent = label;
          c.lat = p.coords.latitude;
          c.lng = p.coords.longitude;
          c.accuracy = Math.round(p.coords.accuracy);
          // Keep whatever is already typed; only fill in when the field is empty.
          const needsLabel = !input.value.trim();
          if (needsLabel) input.value = 'Pinned location';
          say(
            `Pinned to your position, accurate to about ${c.accuracy} m.` +
            (needsLabel ? ' Add a street or landmark so the driver can find you.' : ' The address above is what the driver will see.'),
            'ok'
          );
          announce('Location pinned from your device');
        },
        (err) => {
          btn.disabled = false; btn.textContent = label;
          c.lat = c.lng = c.accuracy = null;
          say(GEO_ERRORS[err.code] || 'Could not get your location. Type the address instead.', 'bad');
        },
        // High accuracy plus a longer window: a cold GPS fix on a phone regularly needs
        // more than the 8s this used to allow, which surfaced as a bare timeout error.
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
      );
    });

    const mapBtn = $(`#${id}-map-btn`);
    const mapDiv = $(`#${id}-map-picker`);
    let pickerMap = null;
    let pickerMarker = null;

    if (mapBtn && mapDiv) {
      mapBtn.addEventListener('click', () => {
        if (mapDiv.style.display === 'block') {
          mapDiv.style.display = 'none';
          return;
        }
        mapDiv.style.display = 'block';
        if (!pickerMap) {
          // Default to Jaipur if no location is pinned yet
          const lat = c.lat || 26.9124;
          const lng = c.lng || 75.7873;
          pickerMap = L.map(mapDiv.id).setView([lat, lng], 13);
          L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap, © CARTO', maxZoom: 19
          }).addTo(pickerMap);

          pickerMarker = L.marker([lat, lng], { draggable: true }).addTo(pickerMap);

          const updatePin = (latlng) => {
            pickerMarker.setLatLng(latlng);
            c.lat = latlng.lat;
            c.lng = latlng.lng;
            c.accuracy = null;
            if (!input.value.trim() || input.value === 'Pinned location') input.value = 'Pinned location';
            say(`Pinned to map (${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}). Add a street or landmark.`, 'ok');
          };

          pickerMarker.on('dragend', () => updatePin(pickerMarker.getLatLng()));
          pickerMap.on('click', (e) => updatePin(e.latlng));
        } else {
          pickerMap.invalidateSize();
          if (c.lat) {
            pickerMap.setView([c.lat, c.lng], 15);
            pickerMarker.setLatLng([c.lat, c.lng]);
          }
        }
      });
    }

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
      <fieldset style="margin-top:12px">
        <legend>Food you accept <span class="muted small">(none selected = everything)</span></legend>
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
      <form class="card key auth-card" id="f" novalidate>
        <p class="eyebrow">Access</p>
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
      <form class="card key auth-card" id="f" novalidate>
        <p class="eyebrow">Access</p>
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

  function pageProfile() {
    const me = state.me;
    app.innerHTML = `
      <div class="page-head"><div><p class="eyebrow">Account</p><h1>Profile</h1>
      <p class="lede">Update your contact details and location.</p></div></div>
      <form class="card" id="f" novalidate style="max-width:600px">
        <div class="form-row">
          <div><label for="name">Name</label><input id="name" required minlength="2" maxlength="100" value="${esc(me.name)}"></div>
          <div><label for="phone">Phone</label><input id="phone" type="tel" maxlength="30" value="${esc(me.phone || '')}"></div>
        </div>
        ${locationField('loc', me.address || '')}
        ${me.role === 'RECIPIENT' ? recipientFields() : ''}
        <div id="msg"></div>
        <button class="btn lg" style="margin-top:16px">Save changes</button>
      </form>`;
    
    const coords = wireLocation('loc');
    coords.lat = me.lat;
    coords.lng = me.lng;
    
    if (me.role === 'RECIPIENT') {
      $('#rec').hidden = false;
      $('#org').value = me.organizationName || '';
      $('#cap').value = me.capacity || 50;
      $('#need').value = me.currentNeed || 'MEDIUM';
      if (me.acceptedFoodTypes) {
        me.acceptedFoodTypes.forEach(c => {
          const cb = app.querySelector(`[name=cat][value=${c}]`);
          if (cb) cb.checked = true;
        });
      }
    }

    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        name: $('#name').value, phone: $('#phone').value || undefined,
        address: $('#loc').value, lat: coords.lat ?? undefined, lng: coords.lng ?? undefined,
      };
      if (me.role === 'RECIPIENT') Object.assign(body, recipientBody());
      try {
        const r = await api('/auth/me', { method: 'PUT', body });
        state.me = r.user;
        toast('Profile updated');
        go(HOME[r.user.role]);
      } catch (err) {
        $('#msg').innerHTML = errBox(err);
      }
    });
  }

  // ----------------------------------------------------------- donor pages
  // One rescue, readable at a glance: what, how much, where, how long is left, who has it.
  const rescueCard = (d) => {
    const live = ['AVAILABLE', 'MATCHED', 'DRIVER_ASSIGNED', 'PICKED_UP'].includes(d.status);
    return `
    <article class="item rescue">
      <div class="rescue-top"><span class="rid">${rid(d.id)}</span>${badge(d.status, true)}</div>
      <div class="rescue-body">
        <div class="rescue-qty"><span class="q">${esc(d.quantity)}</span><span class="u">${esc(d.unit)}</span></div>
        <div><h3><a href="#/donation/${d.id}">${esc(d.foodType)}</a></h3>
          <p class="muted small" style="margin:4px 0 0">${d.meals} meals · ${esc(CATS[d.category] || d.category)}</p></div>
        ${live ? `<div class="rescue-exp"><span class="k">Expires</span>${countdown(d.expiryTime, 'big ' + urgCls(d))}</div>` : ''}
      </div>
      <dl class="rescue-grid">
        <div><dt>Pickup</dt><dd>${esc(d.pickupAddress)}</dd></div>
        <div><dt>Recipient</dt><dd>${d.recipientName ? `${esc(d.recipientName)}${d.matchScore != null ? ` <span class="mono dim">${Math.round(d.matchScore)}/100</span>` : ''}` : 'Not matched yet'}</dd></div>
        <div><dt>Driver</dt><dd>${d.driverName ? esc(d.driverName) : (d.status === 'MATCHED' ? 'Awaiting assignment' : '—')}</dd></div>
        <div><dt>${live ? 'Urgency' : 'Closed'}</dt><dd>${live ? riskChip(d) : fmt(d.deliveredAt || d.cancelledAt || d.updatedAt)}</dd></div>
      </dl>
      ${d.status === 'AVAILABLE' && d.matchFailureReason ? `<div class="warn small" style="margin-bottom:0"><b>No suitable recipient found.</b> ${esc(d.matchFailureReason)}</div>` : ''}
    </article>`;
  };

  function pageDonor() {
    loading();
    poll(async () => {
      const [s, d] = await Promise.all([api('/stats/me'), api('/donations')]);
      return { s, d: d.donations };
    }, ({ s, d }) => {
      const isLive = (x) => ['AVAILABLE', 'MATCHED', 'DRIVER_ASSIGNED', 'PICKED_UP'].includes(x.status);
      const live = d.filter(isLive);
      const past = d.filter((x) => !isLive(x));
      app.innerHTML = `
        <div class="page-head">
          <div><p class="eyebrow">Donor operations</p><h1>Rescue operations</h1>
            <p class="lede">Real-time surplus food coordination.</p></div>
          <div class="head-actions">
            <a class="btn ghost" href="/api/donations/export.csv" download>Download report (CSV)</a>
            <a class="btn lg" href="#/donor/new">+ Post surplus food</a>
          </div>
        </div>
        <div class="grid g4">
          ${stat(s.weightKg + ' kg', 'Food rescued', '', true)}${stat(s.meals, 'Meals rescued')}${stat(s.active, 'Active rescues')}${stat(s.co2eKg + ' kg', 'CO₂e avoided', 'estimate')}
        </div>
        <div class="grid g3" style="margin-top:16px">
          ${stat(s.total, 'Total donations')}${stat(s.delivered, 'Delivered')}${stat(s.expired + s.cancelled, 'Expired or cancelled')}
        </div>
        <h2 class="sec">Live rescues <span class="count">${live.length}</span></h2>
        ${live.length ? live.map(rescueCard).join('') : emptyState('No active rescues', 'There are currently no active food rescues.', '<a class="btn sm" href="#/donor/new">Post surplus food</a>')}
        <h2 class="sec">History <span class="count">${past.length}</span></h2>
        ${past.length ? past.map(rescueCard).join('') : emptyState('No history yet', 'Completed, expired and cancelled donations will appear here.')}
        <p class="small muted" style="margin-top:24px">The CSV report lists every donation with its
          timestamps, quantities and outcome. It is a donation and impact report, not an official
          tax document - ask the receiving organisation for a receipt if you need one.</p>`;
    });
  }

  function pageNewDonation() {
    const me = state.me;
    app.innerHTML = `
      <div class="page-head"><div><p class="eyebrow">Donor operations</p><h1>Post surplus</h1>
        <p class="lede">Food, quantity, time and place. We match it while you wait.</p></div></div>
      <div class="grid split">
        <div class="stack">
          <div class="card">
            <h2 style="font-size:.95rem">Snap a photo <span class="muted small" style="text-transform:none;font-weight:500">(AI auto-fill)</span></h2>
            <input type="file" id="ai-img" accept="image/*" style="margin-top:12px;display:block">
            <p class="row" style="margin:12px 0 0"><button type="button" class="btn ghost sm" id="parse-img">Analyze image</button>
              <span id="parse-img-msg" class="small muted" role="status"></span></p>
          </div>
          <div class="card">
            <h2 style="font-size:.95rem">Describe it in your own words <span class="muted small" style="text-transform:none;font-weight:500">(optional)</span></h2>
            <label for="nl" class="visually-hidden">Describe the surplus food</label>
            <textarea id="nl" placeholder="We have around 25 boxes of cooked rice and dal left from today's event. Good for about 2 hours."></textarea>
            <p class="row" style="margin:12px 0 0"><button type="button" class="btn ghost sm" id="parse">Auto-fill the form</button>
              <span id="parse-msg" class="small muted" role="status"></span></p>
          </div>
          <form class="card" id="f" novalidate>
            <fieldset><legend>Food</legend>
              <label for="ft">Food type</label><input id="ft" required maxlength="100" placeholder="e.g. Cooked rice">
              <div class="form-row">
                <div><label for="cat">Category</label><select id="cat">${Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
                <div></div>
              </div>
              <div class="form-row">
                <div><label for="qty">Quantity</label><input id="qty" type="number" min="0.1" step="any" required></div>
                <div><label for="unit">Unit</label><select id="unit"><option>meals</option><option>boxes</option><option>kg</option><option>trays</option><option>liters</option></select></div>
              </div>
            </fieldset>
            <fieldset><legend>Pickup</legend>${locationField('loc', me.address || '')}</fieldset>
            <fieldset><legend>Timing</legend>
              <label for="exp" style="margin-top:12px">Usable until</label>
              <input id="exp" type="datetime-local" value="${localInput(new Date(Date.now() + 3 * 3600e3))}" required aria-describedby="exp-h">
              <div class="row" style="margin-top:8px">${[1, 2, 4, 8].map((h) => `<button type="button" class="chip" data-h="${h}">+${h}h</button>`).join('')}</div>
              <p class="small muted" id="exp-h" style="margin:8px 0 0">Must be in the future. We only match recipients who can receive it in time.</p>
            </fieldset>
            <fieldset><legend>Notes</legend>
              <label for="desc" style="margin-top:12px">Notes for the driver <span style="text-transform:none;letter-spacing:0;font-weight:500">(optional)</span></label>
              <input id="desc" maxlength="500" placeholder="e.g. Ask for Sunil at the back door">
            </fieldset>
            <div id="msg"></div>
            <button class="btn lg block" id="go">Find match</button>
          </form>
        </div>
        <div class="side-col">
          <section class="card key" aria-label="Donation preview">
            <p class="eyebrow">Donation preview</p><div id="pv"></div>
          </section>
          <div id="result" aria-live="polite"></div>
        </div>
      </div>`;

    // Live preview. Frontend only: it mirrors what is typed and sends nothing.
    const updatePreview = () => {
      const pv = $('#pv');
      if (!pv) return;
      const qty = $('#qty').value;
      const ms = new Date($('#exp').value) - Date.now();
      pv.innerHTML = `
        <div class="pv-qty"><b>${esc(qty || '—')}</b><span>${esc(qty ? $('#unit').value : '')}</span></div>
        <p class="pv-name">${esc($('#ft').value.trim() || 'Food type')}</p>
        <dl class="rescue-grid">
          <div><dt>Category</dt><dd>${esc(CATS[$('#cat').value] || '')}</dd></div>
          <div><dt>Pickup</dt><dd>${esc($('#loc').value.trim() || '—')}</dd></div>
          <div><dt>Available for</dt><dd class="mono">${Number.isFinite(ms) ? (ms > 0 ? esc(spanText(ms)) : 'Already expired') : '—'}</dd></div>
        </dl>
        <p class="small muted" style="margin:12px 0 0">Preview only. Nothing is saved until you press Find match.</p>`;
    };

    const coords = wireLocation('loc');
    if (me.lat != null) { coords.lat = me.lat; coords.lng = me.lng; }
    $('#loc').addEventListener('input', () => {
      if ($('#loc').value === me.address) { coords.lat = me.lat; coords.lng = me.lng; }
      else { coords.lat = coords.lng = null; }
    });
    ['ft', 'cat', 'qty', 'unit', 'loc', 'exp'].forEach((id) => $('#' + id).addEventListener('input', updatePreview));
    // Also refreshes after values are set programmatically (GPS, quick-time chips, auto-fill),
    // and keeps "available for" honest as time passes. Cleared on navigation with the other timers.
    state.timers.push(setInterval(updatePreview, 1000));
    updatePreview();

    app.querySelectorAll('[data-h]').forEach((b) => b.addEventListener('click', () => {
      $('#exp').value = localInput(new Date(Date.now() + Number(b.dataset.h) * 3600e3));
      updatePreview();
    }));

    const imgBtn = $('#parse-img');
    if (imgBtn) imgBtn.addEventListener('click', async () => {
      const file = $('#ai-img').files[0];
      if (!file) return toast('Please select an image first', true);
      $('#parse-img-msg').textContent = 'Analyzing image...';
      try {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = async () => {
          const b64 = reader.result;
          try {
            const r = await api('/ai/parse-image', { method: 'POST', body: { imageBase64: b64, mimeType: file.type } });
            const d = r.data;
            if (d.foodType) $('#ft').value = d.foodType;
            if (CATS[d.category]) $('#cat').value = d.category;
            if (d.quantity) $('#qty').value = d.quantity;
            if (d.unit) $('#unit').value = d.unit;
            if (d.expiryMinutes) $('#exp').value = localInput(new Date(Date.now() + d.expiryMinutes * 60000));
            if (d.description) $('#desc').value = d.description;
            $('#parse-img-msg').textContent = `Filled in (Gemini AI). Urgency ${d.urgency}${d.diet ? ' · ' + d.diet : ''}. Please check the details.`;
            updatePreview();
          } catch (e) { $('#parse-img-msg').textContent = e.message; }
        };
      } catch (e) { $('#parse-img-msg').textContent = e.message; }
    });


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
        updatePreview();
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
    box.innerHTML = `<div class="card"><h2 style="font-size:.95rem"><span class="spinner" aria-hidden="true"></span> Finding nearest suitable recipient…</h2>
      <ul class="checklist">${steps.map((s) => `<li><span class="tick" aria-hidden="true">✓</span>${s}</li>`).join('')}</ul></div>`;
    const req = api('/donations', { method: 'POST', body }); // runs in parallel with the animation
    req.catch(() => {});
    for (const li of box.querySelectorAll('li')) { await sleep(320); li.classList.add('on'); }
    const r = await req;
    renderMatchResult(r.donation, r.matching);
  }

  // Score bars. `details` adds each factor's plain-English explanation under its bar.
  function breakdownHtml(b, details = true) {
    return `<div class="brk">${Object.values(b).map((x) => `
      <span>${esc(x.label)}</span>
      <div class="hbar" role="img" aria-label="${esc(x.label)}: ${x.points} out of ${x.max} points"><i style="width:${Math.round((x.points / x.max) * 100)}%"></i></div>
      <b>${x.points}/${x.max}</b>
      ${details ? `<div class="d">${esc(x.detail)}</div>` : ''}`).join('')}</div>`;
  }

  const rejectedHtml = (rejected) => !rejected || !rejected.length ? '' : `
    <h3 style="margin:24px 0 4px;font-size:.8rem;font-family:var(--mono);letter-spacing:.12em">Why the others were skipped</h3>
    <ul class="reasons">${rejected.map((x) => `<li><span class="x" aria-hidden="true">✕</span><span><b>${esc(x.organizationName)}</b> — ${esc(x.reason)}</span></li>`).join('')}</ul>`;

  function renderMatchResult(donation, matching) {
    const box = $('#result');
    if (!box) return;
    const best = matching.best;
    if (matching.candidates && matching.candidates.length) state.lastCands = matching.candidates;

    if (!matching.matched) {
      box.innerHTML = `<div class="card key">
        <p class="eyebrow">Donation posted</p>
        <div class="warn" role="status"><b>No suitable recipient found yet.</b><br>${esc(matching.failureReason || 'No organisation can take this right now.')}</div>
        <p class="small muted">It stays <b>posted</b> so any shelter can still claim it, and we keep retrying automatically until ${esc(fmt(donation.expiryTime))}.</p>
        ${rejectedHtml(matching.rejected)}
        <div class="row" style="margin-top:16px">
          <button class="btn" data-act="retry" data-id="${donation.id}">Try matching again</button>
          <a class="btn ghost" href="#/donation/${donation.id}">View status</a>
        </div></div>`;
      announce('Donation posted, but no suitable recipient was found yet.');
      return;
    }

    const others = (matching.candidates || []).filter((c) => c.recipientId !== best.recipientId);
    const pref = best.breakdown && best.breakdown.preference;
    const foodMatch = pref ? (pref.points >= pref.max ? 'Exact' : 'Any food') : '—';
    box.innerHTML = `<div class="card key">
      <p class="eyebrow muted small">Best match${matching.elapsedMs != null ? ` · engine took ${matching.elapsedMs} ms` : ''}</p>
      <h2 style="margin:0">${esc(best.organizationName)}</h2>
      <div class="score">${Math.round(best.score)}<small>/100 match score</small></div>
      <dl class="rescue-grid">
        <div><dt>Distance</dt><dd class="mono">${best.distanceKm} km</dd></div>
        <div><dt>Capacity</dt><dd class="mono">${best.available} meals free</dd></div>
        <div><dt>Food match</dt><dd>${esc(foodMatch)}</dd></div>
        <div><dt>ETA</dt><dd class="mono">~${best.etaMinutes} min</dd></div>
      </dl>
      <h3 style="margin:24px 0 4px;font-size:.8rem;font-family:var(--mono);letter-spacing:.12em">Why this match?</h3>
      <ul class="why">${Object.values(best.breakdown).map((x) => `<li><span class="ok" aria-hidden="true">✓</span><span>${esc(x.detail)}</span></li>`).join('')}</ul>
      ${breakdownHtml(best.breakdown, false)}
      <div class="note" style="margin-top:16px">Waiting for <b>${esc(best.organizationName)}</b> to confirm. You will be notified, and a driver is dispatched once they do.</div>
      <div class="row"><a class="btn" href="#/donation/${donation.id}">Track status</a></div>
      ${others.length ? `<h3 style="margin:24px 0 8px;font-size:.8rem;font-family:var(--mono);letter-spacing:.12em">Other options</h3>${others.map((c) => `
        <div class="item row between"><div><b>${esc(c.organizationName)}</b><div class="small muted mono">${c.distanceKm} km · score ${Math.round(c.score)}</div></div>
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
        return `<li class="t ${i <= idx ? 'done' : ''} ${i === idx && !dead ? 'now' : ''}" ${i === idx && !dead ? 'aria-current="step"' : ''}>${LABEL[s]}</li>`;
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
      const live = LIVE_STATUSES.includes(d.status);

      app.innerHTML = `
        <a class="back" href="${HOME[role]}">← Back to overview</a>
        <div class="page-head">
          <div><p class="eyebrow mono">${rid(d.id)}</p><h1>${esc(d.foodType)}</h1></div>
          <div class="row">${riskChip(d)}${badge(d.status, true)}</div>
        </div>
        ${timelineHtml(d)}
        ${d.status === 'CANCELLED' ? `<div class="err" role="status"><div class="err-title">Cancelled</div>${d.cancelReason ? esc(d.cancelReason) : 'This donation was cancelled.'}</div>` : ''}
        ${d.status === 'EXPIRED' ? '<div class="err" role="status"><div class="err-title">Expired</div>This donation passed its usable time before it could be collected.</div>' : ''}
        ${d.status === 'AVAILABLE' && d.matchFailureReason ? `<div class="warn" role="status"><b>No suitable recipient yet.</b> ${esc(d.matchFailureReason)}</div>` : ''}
        <dl class="rescue-grid" style="margin:0 0 16px">
          <div><dt>Quantity</dt><dd class="mono">${esc(d.quantity)} ${esc(d.unit)}</dd></div>
          <div><dt>${live ? 'Expires in' : (d.deliveredAt ? 'Delivered' : 'Closed')}</dt><dd>${live ? countdown(d.expiryTime, urgCls(d)) : fmt(d.deliveredAt || d.cancelledAt || d.updatedAt)}</dd></div>
          <div><dt>Pickup</dt><dd>${esc(d.pickupAddress)}</dd></div>
          <div><dt>Recipient</dt><dd>${d.recipientName ? esc(d.recipientName) : 'Not matched yet'}</dd></div>
          <div><dt>Driver</dt><dd>${d.driverName ? esc(d.driverName) : '—'}</dd></div>
        </dl>
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
            ${canCancel ? `<div class="row" style="margin-top:16px"><button class="btn danger sm" data-act="cancel" data-id="${d.id}">Cancel donation</button></div>` : ''}
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
            ${awaitingMe ? `<div class="row" style="margin-top:16px"><button class="btn" data-act="accept" data-id="${d.id}">Accept donation</button><button class="btn danger" data-act="decline" data-id="${d.id}">Decline</button></div>` : ''}
            ${role === 'RECIPIENT' && d.status === 'AVAILABLE' ? `<div class="row" style="margin-top:16px"><button class="btn" data-act="accept" data-id="${d.id}">Claim this donation</button></div>` : ''}
            ${role === 'DONOR' && d.status === 'AVAILABLE' ? `<div class="row" style="margin-top:16px"><button class="btn" data-act="retry" data-id="${d.id}">Try matching again</button></div>` : ''}
            ${d.deliveryId ? `<div style="margin-top:16px"><a class="btn ghost" href="#/delivery/${d.deliveryId}">Track delivery →</a></div>` : ''}
          </div>
        </div>
        ${d.recipientLat != null ? `<div class="card" style="margin-top:16px"><h2>Route <span id="route-info" class="muted small mono" style="text-transform:none"></span></h2><div id="map" class="map"></div></div>` : ''}
        ${switchable.length ? `<div class="card" style="margin-top:16px"><h2>Other suitable recipients</h2>${switchable.map((c) => `
          <div class="item row between"><div><b>${esc(c.organizationName)}</b><div class="small muted mono">${c.distanceKm} km · score ${Math.round(c.score)} · ${c.available} meals free</div></div>
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
  // A donation offered to this organisation: quantity, time left, source, and the decision.
  const offerCard = (d, awaiting) => `
    <article class="item rescue">
      <div class="rescue-top"><span class="rid">${rid(d.id)}</span>${awaiting ? `<span class="badge b-MATCHED" data-sym="◆">Score ${Math.round(d.matchScore)}</span>` : badge('AVAILABLE')}</div>
      <div class="rescue-body">
        <div class="rescue-qty"><span class="q">${d.meals}</span><span class="u">meals</span></div>
        <div><h3><a href="#/donation/${d.id}">${esc(d.foodType)}</a></h3>
          <p class="muted small" style="margin:4px 0 0">${awaiting ? `from ${esc(d.donorName)}` : `${esc(CATS[d.category] || d.category)} · ${d.fit.distanceKm} km`}</p></div>
        <div class="rescue-exp"><span class="k">Expires</span>${countdown(d.expiryTime, 'big ' + urgCls(d))}</div>
      </div>
      <div class="row" style="margin-top:12px">${riskChip(d)}</div>
      ${awaiting
        ? `<div class="row" style="margin-top:12px"><button class="btn sm" data-act="accept" data-id="${d.id}">Accept</button><button class="btn danger sm" data-act="decline" data-id="${d.id}">Decline</button></div>`
        : (d.fit.eligible
          ? `<div class="row" style="margin-top:12px"><button class="btn ghost sm" data-act="accept" data-id="${d.id}">Claim (score ${Math.round(d.fit.score)})</button></div>`
          : `<p class="small" style="color:var(--err);margin:12px 0 0"><span aria-hidden="true">✕</span> Cannot take this: ${esc(d.fit.reason)}</p>`)}
    </article>`;

  function pageRecipient() {
    loading();
    app.innerHTML = `
      <div class="page-head">
        <div><p class="eyebrow">Recipient operations</p><h1>Available food &amp; capacity</h1>
          <p class="lede">Real-time surplus food coordination.</p></div>
        <div class="head-actions"><a class="btn ghost" href="/api/donations/export.csv" download>Download report (CSV)</a></div>
      </div>
      <div id="stats"></div>
      <div class="grid split" style="margin-top:16px">
        <div class="stack" id="sections"></div>
        <div id="profile"></div>
      </div>`;
    let profileDrawn = false;
    poll(async () => {
      const [rec, don, del, s] = await Promise.all([api('/recipients/me'), api('/donations'), api('/deliveries'), api('/stats/me')]);
      return { rec: rec.recipient, don: don.donations, del: del.deliveries, s };
    }, ({ rec, don, del, s }) => {
      const usedPct = rec.capacity ? Math.min(100, Math.round((rec.currentLoad / rec.capacity) * 100)) : 0;
      $('#stats').innerHTML = `
        ${rec.isAvailable ? '' : `<div class="warn" role="status"><b>You are marked unavailable.</b> New donations will not be matched to you${rec.availabilityNote ? ` (${esc(rec.availabilityNote)})` : ''}.</div>`}
        <div class="grid g4">
          ${stat(rec.available, 'Meals available', `of ${rec.capacity} capacity`, true)}${stat(s.incoming, 'Incoming donations')}${stat(rec.currentLoad, 'Meals committed')}${stat(s.mealsReceived, 'Meals received')}
        </div>
        <div class="capbar" role="img" aria-label="${rec.currentLoad} of ${rec.capacity} meals of capacity committed">
          <div class="capbar-k"><span>Capacity in use</span><span>${usedPct}%</span></div>
          <div class="hbar"><i style="width:${usedPct}%"></i></div>
        </div>`;

      const awaiting = don.filter((d) => d.status === 'MATCHED' && d.mine && !d.recipientAccepted);
      const avail = don.filter((d) => d.status === 'AVAILABLE');
      $('#sections').innerHTML = `
        <section><h2 class="sec" style="margin-top:0">Awaiting your confirmation <span class="count">${awaiting.length}</span></h2>
          ${awaiting.length ? awaiting.map((d) => offerCard(d, true)).join('') : emptyState('Nothing waiting', 'New matches appear here automatically.')}
        </section>
        <section><h2 class="sec">Available donations nearby <span class="count">${avail.length}</span></h2>
          ${avail.length ? avail.map((d) => offerCard(d, false)).join('') : emptyState('No unmatched donations', 'There is nothing unmatched in range right now.')}
        </section>
        <section><h2 class="sec">Incoming &amp; past deliveries <span class="count">${del.length}</span></h2>
          ${del.length ? del.map((x) => `<div class="item row between"><div><b><a href="#/delivery/${x.id}">${esc(x.foodType)}</a></b><div class="small muted">${x.meals} meals · ${esc(x.donorName)}${x.driverName ? ` · driver ${esc(x.driverName)}` : ''}</div></div>${badge(x.status, true)}</div>`).join('') : emptyState('No deliveries yet', 'Accepted donations and their drivers will appear here.')}
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
        <fieldset style="margin-top:12px">
          <legend>Food you accept <span class="muted small">(none = everything)</span></legend>
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
  const jobGrid = (x) => `
    <dl class="rescue-grid">
      <div><dt>Pickup</dt><dd>${esc(x.donorName)}<br><span class="dim small">${esc(x.pickupAddress)}</span></dd></div>
      <div><dt>Deliver to</dt><dd>${esc(x.recipientName)}<br><span class="dim small">${esc(x.dropAddress)}</span></dd></div>
      <div><dt>Distance</dt><dd class="mono">${x.distanceKm} km</dd></div>
      <div><dt>ETA</dt><dd class="mono">~${x.etaMinutes} min</dd></div>
      ${LIVE_STATUSES.includes(x.status) ? `<div><dt>Expires</dt><dd>${countdown(x.expiryTime, urgCls(x))}</dd></div>` : ''}
    </dl>`;

  // Opens turn-by-turn directions in the driver's own maps app. Only offered once the task is
  // theirs, when the exact address has been released to them.
  function routeLink(x) {
    if (x.approximateLocation || !['ASSIGNED', 'PICKED_UP'].includes(x.status)) return '';
    const toPickup = x.status === 'ASSIGNED';
    const lat = toPickup ? x.pickupLat : x.dropLat;
    const lng = toPickup ? x.pickupLng : x.dropLng;
    if (lat == null || lng == null) return '';
    const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lat + ',' + lng)}&travelmode=driving`;
    return `<a class="btn" href="${url}" target="_blank" rel="noopener noreferrer">Start route<span class="visually-hidden"> to the ${toPickup ? 'pickup' : 'drop-off'} (opens in a new tab)</span></a>`;
  }

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
        <div class="page-head"><div><p class="eyebrow">Driver operations</p><h1>Current job</h1>
          <p class="lede">Real-time surplus food coordination.</p></div></div>
        <div class="grid g3">${stat(s.active, 'Active deliveries', '', true)}${stat(s.completed, 'Completed')}${stat(s.distanceKm + ' km', 'Distance driven')}</div>
        <h2 class="sec">My active delivery <span class="count">${active.length}</span></h2>
        ${active.length ? active.map((x) => `<article class="card key job" style="margin-bottom:16px">
          <div class="rescue-top"><span class="rid">${rid(x.donationId)}</span>${badge(x.status, true)}</div>
          <div class="rescue-body">
            <div class="rescue-qty"><span class="q">${x.meals}</span><span class="u">meals</span></div>
            <div><h3><a href="#/delivery/${x.id}">${esc(x.foodType)}</a></h3></div>
            <div class="rescue-exp">${riskChip(x)}</div>
          </div>
          ${jobGrid(x)}
          <div class="job-actions">${routeLink(x)}${deliveryButtons(x)}<a class="btn ghost" href="#/delivery/${x.id}">Map &amp; route</a></div>
        </article>`).join('') : emptyState('No active delivery', 'Accept one of the open pickup tasks below.')}
        <h2 class="sec">Open pickup tasks <span class="count">${open.length}</span></h2>
        ${open.length ? open.map((x) => `<article class="item rescue">
          <div class="rescue-top"><span class="rid">${rid(x.donationId)}</span>${badge(x.status)}</div>
          <div class="rescue-body">
            <div class="rescue-qty"><span class="q">${x.meals}</span><span class="u">meals</span></div>
            <div><h3><a href="#/delivery/${x.id}">${esc(x.foodType)}</a></h3>
              ${x.distanceFromYouKm != null ? `<p class="muted small mono" style="margin:4px 0 0">Pickup is ${x.distanceFromYouKm} km from you</p>` : ''}</div>
            <div class="rescue-exp">${riskChip(x)}</div>
          </div>
          ${jobGrid(x)}
          <div class="job-actions">${deliveryButtons(x)}</div>
        </article>`).join('') : emptyState('No open tasks', 'New pickup tasks appear here automatically.')}
        ${done.length ? `<h2 class="sec">History <span class="count">${done.length}</span></h2>${done.map((x) => `<div class="item row between"><div><b>${esc(x.foodType)}</b><div class="small muted mono">${x.distanceKm} km · ${fmt(x.deliveryTime || x.createdAt)}</div></div>${badge(x.status)}</div>`).join('')}` : ''}`;
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
      const cancelled = x.status === 'CANCELLED';
      app.innerHTML = `
        <a class="back" href="${HOME[me.role]}">← Back to overview</a>
        <div class="page-head">
          <div><p class="eyebrow mono">${rid(x.donationId)} · Delivery #${x.id}</p><h1>${esc(x.foodType)}</h1></div>
          <div class="row">${riskChip(x)}${badge(x.status, true)}</div>
        </div>
        <ol class="timeline ${cancelled ? 'expired' : ''}" aria-label="Delivery progress">
          ${steps.map((s, i) => `<li class="t ${i <= idx && !cancelled ? 'done' : ''} ${i === idx && !cancelled ? 'now' : ''} ${cancelled && i === 1 ? 'cancelled' : ''}" ${i === idx && !cancelled ? 'aria-current="step"' : ''}>${cancelled && i === 1 ? 'Cancelled' : LABEL[s]}</li>`).join('')}
        </ol>
        ${cancelled ? '<div class="err" role="status"><div class="err-title">Cancelled</div>The food expired or the donor withdrew it.</div>' : ''}
        <dl class="rescue-grid" style="margin:0 0 16px">
          <div><dt>Driver</dt><dd>${x.driverName ? esc(x.driverName) : 'Not assigned yet'}</dd></div>
          <div><dt>ETA</dt><dd class="mono" id="eta">~${x.etaMinutes} min</dd></div>
          <div><dt>Distance</dt><dd class="mono" id="dist">${x.distanceKm} km</dd></div>
          <div><dt>Quantity</dt><dd class="mono">${x.meals} meals · ${x.weightKg} kg</dd></div>
          ${LIVE_STATUSES.includes(x.status) ? `<div><dt>Expires in</dt><dd>${countdown(x.expiryTime, urgCls(x))}</dd></div>` : ''}
        </dl>
        <div class="grid split">
          <div class="card">
            <h2>Logistics</h2>
            <ol class="rail">
              <li class="${idx >= 2 ? 'on' : ''}"><span class="k">Donor</span><b>${esc(x.donorName)}</b><span class="a">${esc(x.pickupAddress)}</span></li>
              <li class="${x.driverName ? 'on' : ''}"><span class="k">Driver</span><b>${x.driverName ? esc(x.driverName) : 'Awaiting driver'}</b>${x.pickupTime ? `<span class="a">Picked up ${esc(fmt(x.pickupTime))}</span>` : ''}</li>
              <li class="${x.status === 'DELIVERED' ? 'on' : ''}"><span class="k">Recipient</span><b>${esc(x.recipientName)}</b><span class="a">${esc(x.dropAddress)}${x.deliveryTime ? ` · delivered ${esc(fmt(x.deliveryTime))}` : ''}</span></li>
            </ol>
            <div class="job-actions">${isMine ? routeLink(x) : ''}${(isMine || canAccept) ? deliveryButtons(x) : ''}<a class="btn ghost" href="#/donation/${x.donationId}">Donation details</a></div>
          </div>
          <div class="card"><h2>Route</h2><div id="map" class="map"></div>
            <p class="small muted" style="margin:8px 0 0">${x.approximateLocation
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
        ${!state.me ? `
        <div class="card" style="text-align:center; padding:32px 16px; margin-bottom:32px; background:var(--bg-card)">
          <h2 style="font-size:1.5rem; margin-bottom:8px;">Wanna contribute?</h2>
          <p class="lede" style="margin-bottom:24px;">Join now or register a shelter to start rescuing food today.</p>
          <div class="row" style="justify-content:center">
            <a href="#/register" class="btn lg">Join now</a>
            <a href="#/register?role=RECIPIENT" class="btn ghost lg">Register a shelter</a>
          </div>
        </div>
        ` : ''}
        <div class="page-head"><div><p class="eyebrow">Impact</p><h1>Impact dashboard</h1>
          <p class="lede">Every figure is calculated from delivery records in the database.</p></div></div>
        <div class="filters" role="group" aria-label="Time period">
          ${PERIODS.map(([p, label]) => `<a class="chip" href="#/impact?period=${p}" ${p === period ? 'aria-current="true"' : ''}>${label}</a>`).join('')}
        </div>
        <div class="grid g3">
          ${stat(s.mealsRescued.toLocaleString(), 'Meals rescued', '', true)}
          ${stat(s.weightKg.toLocaleString() + ' kg', 'Food weight diverted', '', true)}
          ${stat(s.co2eKg.toLocaleString() + ' kg', 'CO₂e avoided', 'estimate — see method below', true)}
          ${stat(s.successfulDeliveries, 'Successful deliveries')}
          ${stat(s.organizationsHelped, 'Organizations helped')}
          ${stat(s.activeDonations, 'Active donations')}
        </div>
        <h2 class="sec">Operations</h2>
        <div class="grid g3">
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
            ${s.byCategory.length ? s.byCategory.map((c) => `<div style="margin:12px 0">
              <div class="row between small"><span>${esc(CATS[c.category] || c.category)}</span><b class="mono">${c.meals} meals</b></div>
              <div class="hbar" role="img" aria-label="${esc(CATS[c.category] || c.category)}: ${c.meals} meals"><i style="width:${Math.round((c.meals / cmax) * 100)}%"></i></div>
            </div>`).join('') : emptyState('No deliveries yet', 'Nothing has been delivered in this period.')}
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
          <p class="warn small" style="margin-top:16px">${esc(s.methodology.caveat)}</p>
        </details>`;
    }, 10000);
  }

  // --------------------------------------------------------- notifications
  function pageNotifications() {
    loading();
    poll(() => api('/notifications'), (d) => {
      app.innerHTML = `
        <div class="page-head">
          <div><p class="eyebrow">Alerts</p><h1>Notifications</h1>
            <p class="lede">${d.unread ? `${d.unread} unread` : 'You are up to date.'}</p></div>
          <div class="head-actions"><button class="btn ghost" data-act="readAll" ${d.unread ? '' : 'disabled'}>Mark all read</button></div>
        </div>
        ${d.notifications.length
          ? `<ul class="nlist">${d.notifications.map((n) => `<li class="nrow ${n.read ? '' : 'unread'} ${n.severity === 'URGENT' ? 'urgent' : ''}">
              <div class="n-type">${esc(NTITLE[n.type] || n.type)}${n.severity === 'URGENT' ? '<span class="tag-urgent">Urgent</span>' : ''}</div>
              <div>${n.donationId ? `<a href="#/donation/${n.donationId}">${esc(n.message)}</a>` : esc(n.message)}</div>
              <time class="n-time" datetime="${esc(n.createdAt)}">${esc(fmt(n.createdAt))}</time></li>`).join('')}</ul>`
          : emptyState('No notifications', 'Alerts about matches, drivers and expiry will appear here.')}`;
    });
  }

  // ---------------------------------------------------------------- router
  const routes = [
    [/^#?\/?$/, pageImpact, null],
    [/^#\/login$/, pageLogin, null],
    [/^#\/register$/, pageRegister, null],
    [/^#\/complete-profile$/, pageCompleteProfile, null],
    [/^#\/profile$/, pageProfile, '*'],
    [/^#\/impact$/, pageImpact, null],
    [/^#\/notifications$/, pageNotifications, '*'],
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
      try { await fn(m[1], params); } catch (e) { app.innerHTML = errState(e); }
      return;
    }
    renderNav();
    app.innerHTML = emptyState('Page not found', 'That page does not exist.', '<a class="btn sm" href="#/">Go home</a>');
  }

  // The skip link targets #app, which is not a route. Letting the browser follow it would
  // change the hash and trigger the router, so move focus directly instead.
  $('.skip').addEventListener('click', (e) => { e.preventDefault(); app.focus(); });

  window.addEventListener('hashchange', route);
  // Metrics count up once whenever a page's numbers first appear.
  new MutationObserver(() => countUp(app)).observe(app, { childList: true, subtree: true });
  setInterval(() => !document.hidden && tickCountdowns(), 1000);
  setInterval(() => !document.hidden && checkHealth(), 30000);

  (async () => {
    try {
      const [me, cfg] = await Promise.allSettled([api('/auth/me'), api('/auth/config')]);
      state.me = me.status === 'fulfilled' ? me.value.user : null;
      state.google = cfg.status === 'fulfilled' ? !!cfg.value.google : false;
      if (state.me) refreshNotifs();
    } catch { state.me = null; }
    route();
    checkHealth();
  })();
})();
