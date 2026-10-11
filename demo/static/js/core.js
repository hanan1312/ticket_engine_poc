// Shared app shell: API helper, formatting helpers, toasts, the detail modal, sidebar layout
// and tab/sub-tab routing, the auth screens (login / forgot / reset / recovery request /
// forced password change), the notifications bell and the WhatsApp status pill.
// Loaded first; the per-tab files (dashboard.js, warehouse.js, hr.js, preferences.js) build
// on the globals defined here.

let currentUser = null;
let appSettings = { company_name: 'AssetFlow', has_logo: false, whatsapp_enabled: false };

// ---- Icons ----
const ICONS = {
  barcode: '<path d="M5 6v12M8.5 6v12M11 6v12M13 6v12M16.5 6v12M19 6v12"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  truck: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  key: '<path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  search: '<path d="m21 21-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"/>',
  trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  whatsapp: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  // Tab icons -- the names config/ui.json's "icon" can use (or give raw SVG markup instead).
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  package: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  building: '<path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M15 9h2a2 2 0 0 1 2 2v10M9 7h2M9 11h2M9 15h2"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  chart: '<path d="M12 20V10M18 20V4M6 20v-4"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  map: '<path d="m1 6 7-4 8 4 7-4v16l-7 4-8-4-7 4z"/><path d="M8 2v16M16 6v16"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  caretDown: '<path d="m6 9 6 6 6-6"/>',
};
function icon(name, size = 16, extra = '') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICONS[name] || ''}</svg>`;
}

const ARROW = `<svg class="li-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`;
const CHEVRON_CELL = `<td class="chev">${icon('chevronRight', 16)}</td>`;
function statusBadge([cls, label]) { return `<span class="badge badge-${cls}">${esc(label)}</span>`; }

// ---- Formatting helpers ----
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Server timestamps are naive UTC (datetime.utcnow().isoformat()) -- pin them to UTC before parsing.
function parseTs(iso) { return iso ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + 'Z') : null; }
function fmtTs(iso) {
  const d = parseTs(iso);
  return d ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}
function fmtDate(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDuration(ms) {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return '–';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}
function fmtAgo(iso) { const d = parseTs(iso); return d ? fmtDuration(Date.now() - d) + ' ago' : ''; }
function prioChip(p) { return `<span class="prio prio-${esc(p)}">${esc(p)}</span>`; }
function todayISO(offsetDays = 0) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function initials(name) {
  return (name || '?').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('') || '?';
}
function isAdmin() { return !!currentUser && currentUser.role === 'admin'; }
function hasPermission(perm) {
  if (!currentUser) return false;
  if (currentUser.role === 'admin') return true;  // permissions === null sentinel, see auth_engine
  return (currentUser.permissions || []).includes(perm);
}

// ---- Activity log + toasts ----
function log(msg) {
  const el = document.getElementById('log');
  if (!el) return;
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function toast(message, kind = 'info', timeout = 4200) {
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = `<span class="toast-icon">${icon(kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'info', 16)}</span><span>${esc(message)}</span>`;
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, timeout);
}

// ---- API ----
async function api(path, opts = {}) {
  const { quiet, ...fetchOpts } = opts;
  const res = await fetch(path, {
    method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...fetchOpts,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body && body.error) || `Request failed (${res.status})`;
    log(`ERROR ${path}: ${message}`);
    // Soft workflow warnings (duplicate active ticket, FEFO order): confirm, then resend with the override flag.
    const overrideKey = body && (body.confirm_override_required ? 'confirm_override'
      : body.confirm_fefo_override_required ? 'confirm_fefo_override' : null);
    if (overrideKey && fetchOpts.body) {
      if (confirm(message + '\n\nProceed anyway?')) {
        return api(path, { ...opts, body: JSON.stringify({ ...JSON.parse(fetchOpts.body), [overrideKey]: true }) });
      }
      return null;
    }
    if (body && body.must_change_password) { showAuthCard('change'); return null; }
    if (res.status === 401 && currentUser) {
      if (body && body.reason === 'idle') { exitApp(message); return null; }
      toast('Your session has ended — please log in again.', 'error'); exitApp(message); return null;
    }
    if (!quiet) toast(message, 'error');
    return null;
  }
  return body;
}

// POST JSON, get a binary (PDF) back as an object URL.
async function apiBlobUrl(path, payload) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { error: (body && body.error) || `Request failed (${res.status})` };
  }
  return { url: URL.createObjectURL(await res.blob()) };
}

function openPdf(path) { window.open(path, '_blank', 'noopener'); }

// ---- Detail modal ----
// One modal, with a back-stack so e.g. asset -> ticket -> Back returns to the asset.
// Each detail type registers its opener, so Back (and notifications) can reopen anything.
const modalHistory = [];
const MODAL_OPENERS = {};
function registerModalOpener(type, fn) { MODAL_OPENERS[type] = fn; }

function showModal(size = 'normal') {
  const overlay = document.getElementById('modal-overlay');
  overlay.querySelector('.modal').dataset.size = size;
  overlay.classList.add('open');
  document.body.classList.add('modal-open');
  document.getElementById('modal-back').style.display = modalHistory.length > 1 ? '' : 'none';
}
const MODAL_CLOSE_LISTENERS = [];
function onModalClose(fn) { MODAL_CLOSE_LISTENERS.push(fn); }
function closeModal() {
  const wasOpen = document.getElementById('modal-overlay').classList.contains('open');
  modalHistory.length = 0;
  document.getElementById('modal-overlay').classList.remove('open');
  document.body.classList.remove('modal-open');
  document.getElementById('modal-body').innerHTML = '';
  if (wasOpen) MODAL_CLOSE_LISTENERS.forEach(fn => fn());
}
function pushHistory(type, id) {
  const top = modalHistory[modalHistory.length - 1];
  if (!top || top.type !== type || top.id !== id) modalHistory.push({ type, id });
}
// For one-off forms (new item, new bill...) -- not part of the back-stack unless opened from a detail view.
function openFormModal({ title, sub = '', body, size = 'normal', keepHistory = false }) {
  // A form opened from a detail view joins the back-stack as a placeholder entry, so Back
  // pops it and reopens the detail view underneath.
  if (keepHistory && modalHistory.length) modalHistory.push({ type: 'form', id: Date.now() });
  else modalHistory.length = 0;
  document.getElementById('modal-title').innerHTML = title;
  document.getElementById('modal-sub').innerHTML = sub;
  document.getElementById('modal-body').innerHTML = body;
  showModal(size);
  const first = document.querySelector('#modal-body input:not([type=hidden]):not([type=checkbox]), #modal-body select, #modal-body textarea');
  if (first && window.matchMedia('(min-width: 700px)').matches) setTimeout(() => first.focus(), 50);
}
function setDetailModal(type, id, { title, sub = '', body, size = 'normal' }) {
  pushHistory(type, id);
  document.getElementById('modal-title').innerHTML = title;
  document.getElementById('modal-sub').innerHTML = sub;
  document.getElementById('modal-body').innerHTML = body;
  showModal(size);
}
function modalEl(selector) { return document.querySelector('#modal-body ' + selector); }
function formValues(root = document.getElementById('modal-body')) {
  const out = {};
  root.querySelectorAll('[name]').forEach(el => {
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  });
  return out;
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('mousedown', e => { if (e.target.id === 'modal-overlay') closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('modal-overlay').classList.contains('open')) closeModal();
    closeDropdowns();
  }
});
document.getElementById('modal-back').addEventListener('click', () => {
  modalHistory.pop();
  const prev = modalHistory.pop();
  if (prev && MODAL_OPENERS[prev.type]) MODAL_OPENERS[prev.type](prev.id);
});

// ---- Layout: sidebar, tabs, sub-tabs ----
// Which tabs and sub-tabs exist, their names, icons, order and page titles all come from
// config/ui.json (served as /ui-config.json, see demo/ui_config.py); buildNavigation() turns
// it into the sidebar and the sub-tab bars. The tabs' own content stays in scan.html.
let uiConfig = null;
const TAB_META = {};   // tab id -> { title, sub }, from the config
const PANE_META = {};  // sub-tab id -> { title, sub }, for sub-tabs with their own page
const TAB_LOADERS = {};  // filled by each tab's file
let currentTab = 'dashboard';
const MOBILE_QUERY = window.matchMedia('(max-width: 900px)');

function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

async function loadUiConfig() {
  try {
    const res = await fetch('/ui-config.json', { credentials: 'same-origin' });
    if (res.ok) return await res.json();
  } catch { /* offline */ }
  return null;
}

// A config icon is either a name from ICONS or raw SVG markup (paths, circles...).
function tabIcon(value, size = 19) {
  const inner = String(value || '').trim().startsWith('<') ? value : (ICONS[value] || ICONS.file);
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
function tabLabel(id) {
  const tab = uiConfig && uiConfig.tabs.find(t => t.id === id);
  return tab ? tab.label : id;
}

// Content of a custom (config-defined) tab or sub-tab: a page of HTML or an embedded URL.
// type "link" has no content -- clicking it opens the URL instead.
function customContent(entry) {
  if (entry.type === 'iframe') {
    return `<div class="card custom-embed"><iframe src="${esc(entry.url)}" title="${esc(entry.label)}" loading="lazy" referrerpolicy="no-referrer"></iframe></div>`;
  }
  return `<div class="card custom-page"><div class="card-body">${entry.html || ''}</div></div>`;
}

// Where a built-in sub-tab link points: data-pane (real sub-tab), data-filter (Assets
// condition filter) or data-scroll (Preferences card).
function navSubTarget(tab, child) {
  if (child.type === 'link') return `data-link="${esc(child.url)}"`;
  if (tab.kind === 'filter') return `data-filter="${esc(child.id)}"`;
  if (tab.kind === 'scroll') return `data-scroll="pref-card-${esc(child.id)}"`;
  return `data-pane="${esc(child.id)}"`;
}

function buildNavigation(config) {
  uiConfig = config;
  const { app, login, tabs } = config;
  document.getElementById('sb-subtitle').textContent = app.sidebar_subtitle;
  document.getElementById('sb-section').textContent = app.sidebar_section;
  document.getElementById('sb-footer').textContent = app.footer;
  document.getElementById('login-tagline').textContent = login.tagline;
  document.getElementById('login-heading').textContent = login.heading;
  document.getElementById('login-lead').textContent = login.lead;
  document.getElementById('login-art-kicker').textContent = login.art_kicker;
  document.getElementById('login-art-heading').textContent = login.art_heading;
  document.getElementById('login-art-points').innerHTML = login.art_points.map(p => `<li>${icon('check', 18, 'stroke-width="2.2"')}${esc(p)}</li>`).join('');

  // Every built-in section starts hidden; a tab left out of the config simply never shows.
  document.querySelectorAll('main.content > section[id^="tab-"]').forEach(sec => { sec.hidden = true; });
  const content = document.querySelector('main.content');
  const nav = [];
  tabs.forEach(tab => {
    const hasChildren = tab.children.length > 0;
    const attrs = [`data-label="${esc(tab.label)}"`, `id="nav-${esc(tab.id)}"`];
    if (tab.type === 'link') attrs.push(`data-link="${esc(tab.url)}"`); else attrs.push(`data-tab="${esc(tab.id)}"`);
    if (tab.permission) attrs.push(`data-permission="${esc(tab.permission)}"`, `data-permission-hint="${esc(tab.description)}"`);
    if (hasChildren) attrs.push('aria-expanded="false"');
    nav.push(`<button class="nav-item${hasChildren ? ' has-children' : ''}" ${attrs.join(' ')}>
      ${tabIcon(tab.icon)}<span class="nav-label">${esc(tab.label)}</span>
      ${hasChildren ? icon('caretDown', 15, 'class="nav-caret" stroke-width="2.2"') : ''}</button>`);
    if (hasChildren) {
      nav.push(`<div class="nav-children" id="nav-${esc(tab.id)}-children" role="group" aria-label="${esc(tab.label)} sections">
        ${tab.children.map(c => `<button class="nav-sub" data-sub-tab="${esc(tab.id)}" ${navSubTarget(tab, c)}><span class="nav-sub-label">${esc(c.label)}</span><span class="count"></span></button>`).join('')}
      </div>`);
    }
    if (tab.type === 'link') return;
    TAB_META[tab.id] = { title: tab.title, sub: tab.subtitle };

    // Custom tab: its section is created here. Built-in ones already exist in scan.html.
    let section = document.getElementById('tab-' + tab.id);
    if (!section) {
      section = document.createElement('section');
      section.id = 'tab-' + tab.id;
      section.hidden = true;
      section.innerHTML = tab.kind === 'pane' ? `<div class="subtabs" data-group="${esc(tab.group)}" role="tablist"></div>` : customContent(tab);
      content.appendChild(section);
      if (tab.kind === 'pane') TAB_LOADERS[tab.id] = () => switchSubtab(tab.group, currentSubtab(tab.group));
    }

    if (tab.kind === 'pane') {
      section.querySelector('.subtabs').innerHTML = tab.children.map(c => c.type === 'link'
        ? `<button data-link="${esc(c.url)}">${esc(c.label)} ${icon('link', 12)}</button>`
        : `<button data-pane="${esc(c.id)}" role="tab">${esc(c.label)}</button>`).join('');
      tab.children.forEach(c => {
        if (c.type === 'link') return;
        PANE_META[c.id] = { title: c.title, sub: c.subtitle || tab.subtitle };
        if (c.builtin) return;
        const pane = document.createElement('div');
        pane.className = 'subpane';
        pane.dataset.group = tab.group;
        pane.dataset.pane = c.id;
        pane.hidden = true;
        pane.innerHTML = customContent(c);
        section.appendChild(pane);
      });
    } else if (tab.kind === 'filter') {
      // Assets: a hidden condition filter takes its stat card with it.
      section.querySelectorAll('.cond-card[data-cond]').forEach(card => { card.hidden = !tab.children.some(c => c.id === card.dataset.cond); });
    } else if (tab.kind === 'scroll') {
      // Preferences: a hidden section hides its card too.
      section.querySelectorAll('[id^="pref-card-"]').forEach(card => { card.hidden = !tab.children.some(c => `pref-card-${c.id}` === card.id); });
    }
  });
  document.getElementById('sb-nav').innerHTML = nav.join('');
}

// Problems in config/ui.json (only sent to admins): shown once per sign-in.
async function reportUiConfigWarnings() {
  if (!isAdmin()) return;
  const fresh = await loadUiConfig();
  const warnings = (fresh && fresh.warnings) || [];
  if (!warnings.length) return;
  warnings.forEach(w => console.warn('config/ui.json:', w));
  toast(`config/ui.json has ${warnings.length} problem${warnings.length === 1 ? '' : 's'}: ${warnings[0]}${warnings.length > 1 ? ' (see the browser console for the rest)' : ''}`, 'error', 12000);
}

function openNavLink(url) { window.open(url, '_blank', 'noopener'); }

// The first tab this user may open: the config's default_tab if allowed, else the first visible one.
function firstAllowedTab() {
  const visible = id => { const btn = document.getElementById('nav-' + id); return btn && !btn.hidden && btn.dataset.tab; };
  if (uiConfig && visible(uiConfig.app.default_tab)) return uiConfig.app.default_tab;
  const first = document.querySelector('.nav-item[data-tab]:not([hidden])');
  return first ? first.dataset.tab : null;
}

function applySidebarState() {
  const shell = document.getElementById('app-shell');
  shell.classList.toggle('sb-collapsed', !MOBILE_QUERY.matches && storageGet('sidebar-collapsed') === '1');
}
document.getElementById('menu-toggle').addEventListener('click', () => {
  const shell = document.getElementById('app-shell');
  if (MOBILE_QUERY.matches) {
    shell.classList.toggle('sb-open');
  } else {
    storageSet('sidebar-collapsed', shell.classList.contains('sb-collapsed') ? '0' : '1');
    applySidebarState();
  }
});
document.getElementById('sb-backdrop').addEventListener('click', () => document.getElementById('app-shell').classList.remove('sb-open'));
MOBILE_QUERY.addEventListener('change', () => { document.getElementById('app-shell').classList.remove('sb-open'); applySidebarState(); });

// Sidebar groups: a tab button with .has-children is followed by .nav-children holding its
// .nav-sub links. A link does one of four things, by attribute:
//   data-pane="wh-items"            open that sub-tab (Warehouse, HR, Hotel architecture, custom tabs)
//   data-filter="broken"            run the tab's NAV_FILTERS handler (Assets condition filter)
//   data-scroll="pref-card-email"   scroll to that card (Preferences sections)
//   data-link="https://..."         open that address in a new browser tab (config "type": "link")
// The group opens when its tab is shown; clicking the tab button again folds it.
const NAV_FILTERS = {};  // tab -> fn(value), filled by the tab's file
function setNavGroupOpen(tab, open) {
  const btn = document.getElementById('nav-' + tab);
  if (!btn || !btn.classList.contains('has-children')) return;
  btn.setAttribute('aria-expanded', open);
  btn.classList.toggle('open', open);
}

// ---- Back navigation ----
// Every tab / sub-tab change is remembered so the top bar's Back button (and the phone's back
// gesture / browser Back, via history.pushState) returns to the previous page. A location is
// {tab, pane}: pane is the tab's sub-tab, or null for tabs without sub-tabs.
const navStack = [];
let navCurrent = null, navRestoring = false;
function tabGroup(tab) { const bar = document.querySelector(`#tab-${tab} .subtabs`); return bar ? bar.dataset.group : null; }
function groupTab(group) { const bar = document.querySelector(`.subtabs[data-group="${group}"]`); const sec = bar && bar.closest('section'); return sec ? sec.id.slice(4) : null; }
function navLabel(loc) { return loc.pane && PANE_META[loc.pane] ? PANE_META[loc.pane].title : (TAB_META[loc.tab] || {}).title || loc.tab; }
function navVisit(tab, pane) {
  if (!tab) return;
  const loc = { tab, pane: pane || null };
  if (navCurrent && navCurrent.tab === loc.tab && navCurrent.pane === loc.pane) return;
  if (navCurrent && !navRestoring) {
    navStack.push(navCurrent);
    if (navStack.length > 50) navStack.shift();
    try { history.pushState({ nav: navStack.length }, ''); } catch { /* sandboxed */ }
  }
  navCurrent = loc;
  renderBackButton();
}
function renderBackButton() {
  const btn = document.getElementById('nav-back');
  const prev = navStack[navStack.length - 1];
  btn.hidden = !prev;
  if (prev) { btn.title = `Back to ${navLabel(prev)}`; btn.setAttribute('aria-label', btn.title); }
}
function navBack() {
  const loc = navStack.pop();
  if (!loc) return;
  navRestoring = true;
  try {
    const group = tabGroup(loc.tab);
    if (group && loc.pane) switchSubtab(group, loc.pane);  // remembered, so the tab's loader keeps it
    if (currentTab !== loc.tab || document.getElementById('tab-' + loc.tab).hidden) switchTab(loc.tab);
    navCurrent = loc;
  } finally {
    navRestoring = false;
  }
  renderBackButton();
}
function resetNavHistory() { navStack.length = 0; navCurrent = null; renderBackButton(); }
// The Back button goes through browser history so it and the phone's back gesture stay in
// step; popstate does the navigating. With a pop-up open, Back closes the pop-up first.
document.getElementById('nav-back').addEventListener('click', () => {
  if (!navStack.length) return;
  try { history.back(); } catch { navBack(); }
});
window.addEventListener('popstate', () => {
  if (!currentUser) return;
  if (document.getElementById('modal-overlay').classList.contains('open')) {
    closeModal();
    try { history.pushState({ nav: navStack.length }, ''); } catch { /* sandboxed */ }  // keep this page's entry
    return;
  }
  navBack();
});

function switchTab(tab) {
  // A tab that isn't in the config (or was hidden there) can't be opened, e.g. from a notification.
  if (!TAB_META[tab]) { tab = firstAllowedTab(); if (!tab) return; }
  const group = tabGroup(tab);
  navVisit(tab, group ? currentSubtab(group) : null);
  currentTab = tab;
  document.querySelectorAll('.nav-item[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.nav-item.has-children').forEach(b => setNavGroupOpen(b.dataset.tab, b.dataset.tab === tab));
  document.querySelectorAll('main.content > section[id^="tab-"]').forEach(sec => { sec.hidden = sec.id !== 'tab-' + tab; });
  document.getElementById('page-title').textContent = TAB_META[tab].title;
  document.getElementById('page-sub').textContent = TAB_META[tab].sub;
  document.getElementById('app-shell').classList.remove('sb-open');
  storageSet('last-tab', tab);
  if (TAB_LOADERS[tab]) TAB_LOADERS[tab]();
}
// Highlight one link in a tab's group (for filter/scroll links; sub-tab links follow switchSubtab).
function setNavSubActive(tab, attr, value) {
  document.querySelectorAll(`.nav-sub[data-sub-tab="${tab}"]`).forEach(b => b.classList.toggle('active', b.getAttribute(attr) === value));
}
function setNavSubCount(tab, attr, value, count) {
  const badge = document.querySelector(`.nav-sub[data-sub-tab="${tab}"][${attr}="${value}"] .count`);
  if (badge) { badge.textContent = count; badge.hidden = !count; }
}
// One listener for the whole (generated) sidebar.
document.getElementById('sb-nav').addEventListener('click', e => {
  const btn = e.target.closest('.nav-item, .nav-sub');
  if (!btn) return;
  if (btn.dataset.link) { openNavLink(btn.dataset.link); return; }
  if (btn.classList.contains('nav-item')) {
    // Re-clicking an open group's tab just folds/unfolds it, without reloading the tab.
    if (btn.classList.contains('has-children') && currentTab === btn.dataset.tab && !document.getElementById('tab-' + currentTab).hidden) {
      setNavGroupOpen(btn.dataset.tab, !btn.classList.contains('open'));
      return;
    }
    switchTab(btn.dataset.tab);
    return;
  }
  const tab = btn.dataset.subTab, d = btn.dataset;
  const opening = currentTab !== tab || document.getElementById('tab-' + tab).hidden;
  if (d.pane) {
    switchSubtab(document.querySelector(`#tab-${tab} .subtabs`).dataset.group, d.pane);  // remembered, so the loader re-opens it
    if (opening) switchTab(tab);
  } else if (d.filter) {
    if (NAV_FILTERS[tab]) NAV_FILTERS[tab](d.filter);  // set before the loader renders
    if (opening) switchTab(tab);
    setNavSubActive(tab, 'data-filter', d.filter);
  } else if (d.scroll) {
    if (opening) switchTab(tab);
    setNavSubActive(tab, 'data-scroll', d.scroll);
    const target = document.getElementById(d.scroll);
    if (target) {
      setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target.classList.remove('nav-flash'); void target.offsetWidth; target.classList.add('nav-flash');
      }, opening ? 120 : 0);
    }
  }
  document.getElementById('app-shell').classList.remove('sb-open');
});

// Sub-tabs: <div class="subtabs" data-group="wh"><button data-pane="wh-items">...</button></div>
// and panes <div class="subpane" data-pane="wh-items">. The chosen pane is remembered per group.
// The bars' buttons come from the config, so a sub-tab hidden there has no button -- and
// asking for it (e.g. after creating a bill) falls back to the remembered/first one.
const SUBTAB_LOADERS = {};
function switchSubtab(group, pane) {
  if (!document.querySelector(`.subtabs[data-group="${group}"] button[data-pane="${pane}"]`)) {
    pane = currentSubtab(group);
    if (!pane) return;
  }
  // Only a change on the tab being shown is a page visit; a sidebar link into another tab is
  // recorded by the switchTab that follows (it reads this remembered pane).
  const paneTab = groupTab(group);
  if (paneTab === currentTab && !document.getElementById('tab-' + paneTab).hidden) navVisit(paneTab, pane);
  document.querySelectorAll(`.subtabs[data-group="${group}"] button[data-pane]`).forEach(b => {
    const active = b.dataset.pane === pane;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active);
  });
  document.querySelectorAll(`.subpane[data-group="${group}"]`).forEach(p => { p.hidden = p.dataset.pane !== pane; });
  document.querySelectorAll('.nav-sub[data-pane]').forEach(b => {
    if (b.closest('.nav-children') && document.querySelector(`.subtabs[data-group="${group}"] button[data-pane="${b.dataset.pane}"]`)) {
      b.classList.toggle('active', b.dataset.pane === pane);
    }
  });
  if (PANE_META[pane] && !document.getElementById('app-shell').hidden) {
    document.getElementById('page-title').textContent = PANE_META[pane].title;
    document.getElementById('page-sub').textContent = PANE_META[pane].sub;
  }
  storageSet('subtab-' + group, pane);
  if (SUBTAB_LOADERS[pane]) SUBTAB_LOADERS[pane]();
}
function currentSubtab(group) {
  const saved = storageGet('subtab-' + group);
  const first = document.querySelector(`.subtabs[data-group="${group}"] button[data-pane]`);
  if (saved && document.querySelector(`.subtabs[data-group="${group}"] button[data-pane="${saved}"]`)) return saved;
  return first ? first.dataset.pane : null;
}
document.addEventListener('click', e => {
  const btn = e.target.closest('.subtabs button');
  if (!btn) return;
  if (btn.dataset.link) openNavLink(btn.dataset.link);
  else if (btn.dataset.pane) switchSubtab(btn.closest('.subtabs').dataset.group, btn.dataset.pane);
});

function setSubtabCount(pane, count, alert = false) {
  document.querySelectorAll(`.subtabs button[data-pane="${pane}"], .nav-sub[data-pane="${pane}"]`).forEach(btn => {
    let badge = btn.querySelector('.count');
    if (!badge) { badge = document.createElement('span'); badge.className = 'count'; btn.appendChild(badge); }
    badge.textContent = count;
    badge.hidden = !count;
    badge.classList.toggle('alert', alert);
  });
}

// ---- Dropdowns (notifications, user menu) ----
function closeDropdowns(except) {
  document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== except) m.hidden = true; });
}
function bindDropdown(buttonId, menuId, onOpen) {
  const btn = document.getElementById(buttonId), menu = document.getElementById(menuId);
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    closeDropdowns(menu);
    menu.hidden = !willOpen;
    if (willOpen && onOpen) onOpen();
  });
  menu.addEventListener('click', e => e.stopPropagation());
}
document.addEventListener('click', () => closeDropdowns());

// ---- Branding ----
const DEFAULT_BRAND_ICON = icon('barcode', 20, 'stroke="white" stroke-width="1.7"');
function renderBrand() {
  const logoUrl = `/api/settings/logo?t=${Date.now()}`;
  const logo = appSettings.has_logo ? `<img src="${logoUrl}" alt="logo">` : DEFAULT_BRAND_ICON;
  document.querySelectorAll('.brand-mark').forEach(el => { el.innerHTML = logo; });
  // Faint watermark of the uploaded logo behind the app (see .main-col::before / .auth-panel::before).
  document.documentElement.style.setProperty('--app-logo', appSettings.has_logo ? `url("${logoUrl}")` : 'none');
  document.body.classList.toggle('has-watermark', !!appSettings.has_logo);
  document.querySelectorAll('.brand-name').forEach(el => { el.textContent = appSettings.company_name; });
  document.title = appSettings.company_name;
}
async function loadBranding() {
  const settings = await api('/api/settings', { quiet: true });
  if (settings) appSettings = settings;
  renderBrand();
  renderWhatsAppPill();
}

// ---- Auth screens ----
const AUTH_CARDS = ['login', 'forgot', 'reset', 'recover', 'change'];
let resetToken = null;
// The security policy (HR -> Policy) as the sign-in screens need it: password rules for the
// live checklist, lockout limits, the notice banner, demo accounts. Public endpoint.
let authPolicy = null;

async function loadAuthPolicy() {
  try {
    const res = await fetch('/api/auth/policy', { credentials: 'same-origin' });
    if (res.ok) authPolicy = await res.json();
  } catch { /* offline -- keep the last one */ }
  renderAuthPolicy();
  return authPolicy;
}

function renderAuthPolicy() {
  const p = authPolicy;
  const banner = document.getElementById('auth-banner');
  banner.hidden = !(p && p.login_banner);
  document.getElementById('auth-banner-text').textContent = (p && p.login_banner) || '';
  document.getElementById('auth-demo').hidden = !(p && p.show_demo_accounts);
  const chips = [];
  if (p) {
    chips.push(`${icon('key', 12)} ${p.password_min_length}+ character passwords`);
    chips.push(`${icon('alert', 12)} Locks after ${p.lockout_threshold} failed ${p.lockout_threshold === 1 ? 'try' : 'tries'}`);
    if (p.idle_logout_minutes) chips.push(`${icon('logout', 12)} Idle sign-out ${p.idle_logout_minutes} min`);
  }
  document.getElementById('auth-policy-chips').innerHTML = chips.map(c => `<span>${c}</span>`).join('');
  document.querySelectorAll('[data-policy-check]').forEach(input => renderPasswordChecklist(input));
}

// Live checklist + strength meter under a new-password field, mirroring the server's rules
// (auth_engine/passwords.py validate_new_password) so people see what's missing before submitting.
function passwordChecks(pw, p = authPolicy || {}) {
  const checks = [{ ok: pw.length >= (p.password_min_length || 8), label: `At least ${p.password_min_length || 8} characters` }];
  if (p.password_require_digit !== false) checks.push({ ok: /\d/.test(pw) && /[a-z]/i.test(pw), label: 'Letters and numbers' });
  if (p.password_require_upper) checks.push({ ok: /[A-Z]/.test(pw) && /[a-z]/.test(pw), label: 'Upper- and lower-case letters' });
  if (p.password_require_symbol) checks.push({ ok: /[^A-Za-z0-9]/.test(pw), label: 'At least one symbol' });
  return checks;
}
function passwordStrength(pw) {
  if (!pw) return 0;
  let score = Math.min(2, Math.floor(pw.length / 6));
  score += /[a-z]/.test(pw) && /[A-Z]/.test(pw) ? 1 : 0;
  score += /\d/.test(pw) ? 1 : 0;
  score += /[^A-Za-z0-9]/.test(pw) ? 1 : 0;
  return Math.min(4, Math.max(1, score));
}
const STRENGTH_LABEL = ['', 'Weak', 'Fair', 'Good', 'Strong'];
function renderPasswordChecklist(input) {
  const box = document.querySelector(`.pw-policy[data-policy-for="${input.dataset.policyCheck}"]`);
  if (!box) return;
  const pw = input.value, checks = passwordChecks(pw);
  // Never call it more than "Fair" while a required rule is still missing.
  const strength = checks.every(c => c.ok) ? passwordStrength(pw) : Math.min(2, passwordStrength(pw));
  box.innerHTML = `
    <div class="pw-meter s${pw ? strength : 0}"><span></span><span></span><span></span><span></span></div>
    <div class="pw-meter-label">${pw ? `Strength: <b>${STRENGTH_LABEL[strength]}</b>` : 'Your password must have:'}</div>
    <ul>${checks.map(c => `<li class="${c.ok ? 'ok' : ''}">${icon(c.ok ? 'check' : 'x', 12)}${esc(c.label)}</li>`).join('')}</ul>`;
}
document.querySelectorAll('[data-policy-check]').forEach(input => input.addEventListener('input', () => renderPasswordChecklist(input)));

function showAuthCard(name) {
  document.getElementById('auth-screen').hidden = false;
  document.getElementById('app-shell').hidden = true;
  AUTH_CARDS.forEach(c => { document.getElementById('auth-' + c).hidden = c !== name; });
  document.querySelectorAll('.auth-msg').forEach(m => { m.hidden = true; });
  document.getElementById('auth-banner').hidden = !(authPolicy && authPolicy.login_banner) || name !== 'login';
  if (name === 'change') renderChangeReason();
  const first = document.querySelector(`#auth-${name} input:not([type=checkbox])`);
  if (first) setTimeout(() => (first.value && name === 'login' ? document.getElementById('login-password') : first).focus(), 30);
}
function authMsg(card, text, kind = 'error') {
  const el = document.querySelector(`#auth-${card} .auth-msg`);
  el.textContent = text;
  el.className = `auth-msg ${kind}`;
  el.hidden = false;
}
document.querySelectorAll('[data-auth]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); showAuthCard(a.dataset.auth); }));

function setBusy(btn, busy) { btn.disabled = busy; btn.classList.toggle('busy', busy); }

// Show / hide password eye buttons, and the Caps Lock hint.
const EYE = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>';
document.querySelectorAll('.pw-toggle').forEach(btn => {
  const input = btn.parentElement.querySelector('input');
  const paint = () => {
    const shown = input.type === 'text';
    btn.innerHTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shown ? EYE_OFF : EYE}</svg>`;
    btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
  };
  btn.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; paint(); input.focus(); });
  paint();
});
document.querySelectorAll('#auth-screen input[type=password]').forEach(input => {
  const warn = input.closest('.field') && input.closest('.field').querySelector('.caps-warn');
  if (!warn) return;
  const check = e => { if (e.getModifierState) warn.hidden = !e.getModifierState('CapsLock'); };
  input.addEventListener('keyup', check);
  input.addEventListener('keydown', check);
  input.addEventListener('blur', () => { warn.hidden = true; });
});

function renderGreeting() {
  const h = new Date().getHours();
  document.getElementById('auth-greeting').textContent = h < 5 ? 'Working late?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  document.getElementById('auth-year').textContent = new Date().getFullYear();
}

// Demo account chips fill the form (shown only when the policy allows).
document.querySelectorAll('[data-demo]').forEach(btn => btn.addEventListener('click', () => {
  const [u, p] = btn.dataset.demo.split(':');
  document.getElementById('login-username').value = u;
  document.getElementById('login-username').dispatchEvent(new Event('input'));  // clears another username's lockout
  document.getElementById('login-password').value = p;
  document.getElementById('login-btn').focus();
}));

async function postAuth(path, payload) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

// Lockout: count down on the button until the username can try again.
let lockoutTimer = null;
function startLockoutCountdown(seconds) {
  clearInterval(lockoutTimer);
  const btn = document.getElementById('login-btn'), label = btn.querySelector('.btn-label');
  const until = Date.now() + seconds * 1000;
  btn.disabled = true;
  btn.classList.add('locked');
  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    label.textContent = left ? `Locked — try again in ${left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : `${left}s`}` : 'Sign in';
    if (!left) { clearInterval(lockoutTimer); btn.disabled = false; btn.classList.remove('locked'); document.querySelector('#auth-login .auth-msg').hidden = true; }
  };
  tick();
  lockoutTimer = setInterval(tick, 1000);
}
document.getElementById('login-username').addEventListener('input', () => {
  // A different username isn't locked -- let them try.
  if (lockoutTimer) { clearInterval(lockoutTimer); lockoutTimer = null; const btn = document.getElementById('login-btn'); btn.disabled = false; btn.classList.remove('locked'); btn.querySelector('.btn-label').textContent = 'Sign in'; }
});

async function attemptLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) return authMsg('login', 'Enter your username and password.');
  const btn = document.getElementById('login-btn');
  setBusy(btn, true);
  const { ok, status, body } = await postAuth('/api/auth/login', { username, password });
  setBusy(btn, false);
  if (!ok) {
    document.getElementById('auth-login').classList.remove('shake');
    void document.getElementById('auth-login').offsetWidth;
    document.getElementById('auth-login').classList.add('shake');
    if (status === 429 && body.locked_seconds) {
      startLockoutCountdown(body.locked_seconds);
      return authMsg('login', `Too many failed attempts — this username is locked for ${Math.ceil(body.locked_seconds / 60)} minute(s). Use "Forgot password?" if you can't remember it.`);
    }
    const left = body.attempts_left;
    return authMsg('login', (body.error || 'Sign-in failed.') + (left != null && left <= 3 ? ` — ${left} attempt${left === 1 ? '' : 's'} left before the username is locked.` : ''));
  }
  storageSet('remember-username', document.getElementById('login-remember').checked ? body.username : '');
  document.getElementById('login-password').value = '';
  log(`logged in as ${body.username} (${body.role_label || body.role})`);
  if (body.must_change_password) {
    currentUser = body;
    document.getElementById('change-current').value = password;
    showAuthCard('change');  // its lead text explains why (temporary vs expired password)
    return;
  }
  enterApp(body, { welcome: true });
}
document.getElementById('login-btn').addEventListener('click', attemptLogin);
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });
document.getElementById('login-username').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('login-password').focus(); });

document.getElementById('forgot-btn').addEventListener('click', async () => {
  const identifier = document.getElementById('forgot-identifier').value.trim();
  if (!identifier) return authMsg('forgot', 'Enter your username or recovery email.');
  const btn = document.getElementById('forgot-btn');
  setBusy(btn, true);
  const { ok, body } = await postAuth('/api/auth/forgot-password', { identifier });
  setBusy(btn, false);
  // delivered === false: email isn't set up on the server -- say so instead of "sent".
  authMsg('forgot', ok ? body.message : (body.error || 'Something went wrong.'), !ok ? 'error' : body.delivered === false ? 'warn' : 'success');
});

function unmetRule(pw) {
  const missing = passwordChecks(pw).find(c => !c.ok);
  return missing ? `Your new password needs: ${missing.label.toLowerCase()}.` : null;
}

document.getElementById('reset-btn').addEventListener('click', async () => {
  const pw = document.getElementById('reset-password').value, confirmPw = document.getElementById('reset-confirm').value;
  const rule = unmetRule(pw);
  if (rule) return authMsg('reset', rule);
  if (pw !== confirmPw) return authMsg('reset', "The two passwords don't match.");
  const btn = document.getElementById('reset-btn');
  setBusy(btn, true);
  const { ok, body } = await postAuth('/api/auth/reset-password', { token: resetToken, new_password: pw });
  setBusy(btn, false);
  if (!ok) return authMsg('reset', body.error || 'Could not reset the password.');
  history.replaceState(null, '', location.pathname);
  resetToken = null;
  showAuthCard('login');
  document.getElementById('login-username').value = body.username || '';
  authMsg('login', body.message, 'success');
  document.getElementById('login-password').focus();
});

document.getElementById('recover-btn').addEventListener('click', async () => {
  const payload = {
    full_name: document.getElementById('recover-name').value.trim(),
    old_username: document.getElementById('recover-username').value.trim(),
    contact: document.getElementById('recover-contact').value.trim(),
    reason: document.getElementById('recover-reason').value.trim(),
  };
  if (!payload.full_name || !payload.contact) return authMsg('recover', 'Your full name and a way to reach you are required.');
  const btn = document.getElementById('recover-btn');
  setBusy(btn, true);
  const { ok, body } = await postAuth('/api/auth/recovery-requests', payload);
  setBusy(btn, false);
  authMsg('recover', ok ? body.message : (body.error || 'Could not send the request.'), ok ? 'success' : 'error');
  if (ok) document.querySelectorAll('#auth-recover input, #auth-recover textarea').forEach(i => { i.value = ''; });
});

async function submitPasswordChange(currentPw, newPw, confirmPw) {
  const rule = unmetRule(newPw);
  if (rule) return { error: rule };
  if (newPw !== confirmPw) return { error: "The two new passwords don't match." };
  const { ok, body } = await postAuth('/api/auth/change-password', { current_password: currentPw, new_password: newPw });
  return ok ? { user: body } : { error: body.error || 'Could not change the password.' };
}
function renderChangeReason() {
  const expired = currentUser && currentUser.password_change_reason === 'expired';
  document.getElementById('change-lead').textContent = expired
    ? `Your password is older than ${authPolicy ? authPolicy.password_expiry_days : 'the allowed number of'} days. Choose a new one to continue.`
    : "You're using a temporary password. Choose a new one to continue.";
  document.getElementById('change-current-label').textContent = expired ? 'Current password' : 'Temporary password';
}
document.getElementById('change-btn').addEventListener('click', async () => {
  const btn = document.getElementById('change-btn');
  setBusy(btn, true);
  const result = await submitPasswordChange(
    document.getElementById('change-current').value, document.getElementById('change-new').value,
    document.getElementById('change-confirm').value);
  setBusy(btn, false);
  if (result.error) return authMsg('change', result.error);
  ['change-current', 'change-new', 'change-confirm'].forEach(id => { document.getElementById(id).value = ''; });
  toast('Password updated — welcome aboard!', 'success');
  enterApp(result.user);
});
document.getElementById('change-logout').addEventListener('click', e => { e.preventDefault(); logout(); });

function openChangePasswordModal() {
  closeDropdowns();
  openFormModal({
    title: 'Change password', sub: 'Your new password must meet the password policy.',
    body: `
      <div class="form-grid one">
        <label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password"></label>
        <label class="field"><span>New password</span><input type="password" name="new" autocomplete="new-password" data-policy-check="modal"></label>
        <div class="pw-policy" data-policy-for="modal"></div>
        <label class="field"><span>Confirm new password</span><input type="password" name="confirm" autocomplete="new-password"></label>
      </div>
      <div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Cancel</button><button class="btn-primary" id="md-pw-save">Update password</button></div>`,
  });
  const pwInput = modalEl('[data-policy-check=modal]');
  renderPasswordChecklist(pwInput);
  pwInput.addEventListener('input', () => renderPasswordChecklist(pwInput));
  modalEl('#md-pw-save').addEventListener('click', async () => {
    const v = formValues();
    const result = await submitPasswordChange(v.current, v.new, v.confirm);
    if (result.error) return toast(result.error, 'error');
    closeModal();
    toast('Password updated.', 'success');
  });
}

function enterApp(user, { welcome = false } = {}) {
  currentUser = user;
  if (welcome) toast(`Signed in as ${user.display_name || user.username} · ${user.role_label || 'Staff'}`, 'success', 3200);
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app-shell').hidden = false;
  renderUserChip(user);
  document.getElementById('menu-user-email').textContent = user.email || 'No recovery email on file';
  // Every sidebar tab carries its permission (data-permission, from config/ui.json); tabs
  // without one (Dashboard) are for everyone. Grants are managed in HR -> Users / Roles, which
  // list these same tabs.
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.hidden = !!btn.dataset.permission && !hasPermission(btn.dataset.permission);  // CSS hides its group too
  });
  applySidebarState();
  const saved = storageGet('last-tab');
  const savedBtn = saved && document.getElementById('nav-' + saved);
  const allowed = savedBtn && !savedBtn.hidden && TAB_META[saved] ? saved : firstAllowedTab();
  loadBranding();
  if (allowed) switchTab(allowed);
  startPolling();
  reportUiConfigWarnings();
}

// Header chip + menu: the linked employee's name and photo when there is one, else the username.
function renderUserChip(user) {
  const name = user.display_name || user.username;
  const avatarEl = document.getElementById('user-avatar');
  avatarEl.textContent = initials(name);
  avatarEl.classList.toggle('has-photo', !!user.photo_url);
  if (user.photo_url) {
    const img = new Image();
    img.alt = '';
    img.onload = () => { avatarEl.textContent = ''; avatarEl.appendChild(img); };
    img.src = user.photo_url;  // falls back to initials if it fails to load
  }
  document.getElementById('user-name').textContent = name;
  document.getElementById('user-role').textContent = user.role_label || (user.role === 'admin' ? 'Administrator' : 'Staff');
  document.getElementById('menu-user-name').textContent = name;
  document.getElementById('menu-user-login').textContent = user.display_name ? `@${user.username}` : '';
}

// Re-read the logged-in user (e.g. after their own photo/name changed in HR) and redraw the chip.
async function refreshCurrentUser() {
  const user = await api('/api/auth/current_user', { quiet: true });
  if (user) { currentUser = user; renderUserChip(user); }
}

// reason: optional message shown on the sign-in card (e.g. signed out for inactivity).
function exitApp(reason) {
  currentUser = null;
  resetNavHistory();
  stopPolling();
  closeModal();
  if (typeof resetDashboardState === 'function') resetDashboardState();
  document.getElementById('toast-stack').innerHTML = '';
  loadAuthPolicy();
  showAuthCard('login');
  document.getElementById('login-username').value = storageGet('remember-username') || '';
  document.getElementById('login-password').value = '';
  if (reason) authMsg('login', reason, 'warn');
}
async function logout(reason) {
  closeDropdowns();
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  log('logged out');
  exitApp(typeof reason === 'string' ? reason : undefined);
}
document.getElementById('menu-logout').addEventListener('click', logout);
document.getElementById('menu-password').addEventListener('click', openChangePasswordModal);
bindDropdown('user-btn', 'user-menu');

// ---- Notifications bell ----
const NOTIFICATION_OPENERS = {
  ticket: id => openTicketModal(id),
  work_order: id => openWorkOrderModal(id),
  bill: id => { if (hasPermission('warehouse')) openBillModal(id); },
  account: id => { if (hasPermission('hr-management')) { switchTab('hr'); switchSubtab('hr', 'hr-accounts'); openAccountModal(id); } },
  recovery_request: () => { if (hasPermission('hr-management')) { switchTab('hr'); switchSubtab('hr', 'hr-accounts'); } },
};
let notifications = [];

async function loadNotifications() {
  if (!currentUser) return;
  const data = await api('/api/notifications', { quiet: true });
  if (!data) return;
  const known = new Set(notifications.map(n => n.id));
  notifications = data.items;
  const badge = document.getElementById('bell-badge');
  badge.textContent = data.unread > 9 ? '9+' : data.unread;
  badge.hidden = !data.unread;
  // Toast only genuine new arrivals since the last poll -- never the backlog on first load.
  const fresh = loadNotifications.primed ? notifications.filter(n => !n.read && !known.has(n.id)) : [];
  fresh.slice(0, 2).forEach(n => toast(n.title, n.kind === 'success' ? 'success' : 'info'));
  loadNotifications.primed = true;
  renderNotifications();
  // Something changed server-side (approval, delivery...) -- refresh what's on screen.
  if (fresh.length && TAB_LOADERS[currentTab] && !document.body.classList.contains('modal-open')) TAB_LOADERS[currentTab]();
}
function renderNotifications() {
  const list = document.getElementById('notif-list');
  list.innerHTML = notifications.map(n => `
    <button class="notif-item ${n.read ? '' : 'unread'} kind-${esc(n.kind)}" data-id="${n.id}">
      <span class="notif-dot"></span>
      <span class="notif-text"><b>${esc(n.title)}</b>${n.body ? `<span>${esc(n.body)}</span>` : ''}<small>${fmtAgo(n.created_at)}</small></span>
    </button>`).join('') || `<div class="empty-state small">${icon('bell', 28)}<p>You're all caught up.</p></div>`;
}
document.getElementById('notif-list').addEventListener('click', async e => {
  const item = e.target.closest('.notif-item');
  if (!item) return;
  const n = notifications.find(x => x.id === Number(item.dataset.id));
  closeDropdowns();
  if (!n.read) { await api(`/api/notifications/${n.id}/read`, { method: 'POST', quiet: true }); loadNotifications(); }
  if (n.link_type && NOTIFICATION_OPENERS[n.link_type]) NOTIFICATION_OPENERS[n.link_type](n.link_id);
});
document.getElementById('notif-read-all').addEventListener('click', async () => {
  await api('/api/notifications/read-all', { method: 'POST', quiet: true });
  loadNotifications();
});
bindDropdown('bell-btn', 'notif-menu');

// ---- WhatsApp status pill (admin, when the service is switched on) ----
let waStatus = null;
const WA_LABEL = { connected: 'Connected', qr: 'Scan QR to pair', initializing: 'Starting…', offline: 'Not paired', error: 'Error', unreachable: 'Service offline' };

function renderWhatsAppPill() {
  const pill = document.getElementById('wa-pill');
  const show = isAdmin() && appSettings.whatsapp_enabled;
  pill.hidden = !show;
  if (!show) return;
  const state = waStatus ? waStatus.status : 'initializing';
  pill.dataset.state = state === 'connected' ? 'ok' : (state === 'qr' || state === 'initializing') ? 'wait' : 'bad';
  document.getElementById('wa-pill-text').textContent = WA_LABEL[state] || state;
}
async function refreshWhatsAppStatus() {
  if (!isAdmin() || !appSettings.whatsapp_enabled) { renderWhatsAppPill(); return null; }
  waStatus = await api('/api/settings/whatsapp/status', { quiet: true });
  renderWhatsAppPill();
  return waStatus;
}
async function openWhatsAppModal() {
  openFormModal({ title: `${icon('whatsapp', 18)} WhatsApp pairing`, sub: 'Checking status…', body: '<div class="loading-block"><span class="spinner"></span></div>' });
  const render = async () => {
    const s = await refreshWhatsAppStatus();
    if (!document.getElementById('modal-overlay').classList.contains('open')) return false;
    if (!s) return false;
    document.getElementById('modal-sub').textContent = s.configured_number ? `Sending number: +${s.configured_number}` : 'No sending number configured';
    const stateClass = s.status === 'connected' ? 'ok' : (s.status === 'qr' || s.status === 'initializing') ? 'wait' : 'bad';
    document.getElementById('modal-body').innerHTML = `
      <div class="wa-status-card state-${stateClass}">
        <span class="wa-big-dot"></span>
        <div><b>${esc(WA_LABEL[s.status] || s.status)}</b><p>${esc(s.message || '')}</p></div>
      </div>
      ${s.qr_svg ? `
        <div class="qr-wrap">
          <div class="qr-box">${s.qr_svg}</div>
          <ol class="qr-steps">
            <li>Open WhatsApp on the phone for <b>+${esc(s.configured_number || '')}</b></li>
            <li>Go to <b>Settings → Linked devices → Link a device</b></li>
            <li>Point the phone at this QR code. It refreshes automatically.</li>
          </ol>
        </div>` : ''}
      ${s.status === 'connected' ? `
        <div class="field-row" style="margin-top:1rem;">
          <input type="text" id="wa-test-phone" placeholder="Send a test message to… (e.g. 2010…)" value="${esc(currentUser.phone || '')}">
          <button class="btn-primary" id="wa-test-btn">Send test</button>
        </div>` : ''}
      <div class="modal-actions"><button class="btn-outline" id="wa-refresh">${icon('refresh', 14)} Refresh</button><button class="btn-primary" onclick="closeModal()">Done</button></div>`;
    document.getElementById('wa-refresh').addEventListener('click', render);
    const testBtn = document.getElementById('wa-test-btn');
    if (testBtn) testBtn.addEventListener('click', async () => {
      const r = await api('/api/settings/whatsapp/test', { method: 'POST', body: JSON.stringify({ phone: document.getElementById('wa-test-phone').value }) });
      if (r) toast(r.message, 'success');
    });
    return s.status !== 'connected';
  };
  // Keep refreshing while the modal stays open on this view and pairing isn't done yet
  // (WhatsApp rotates the pairing QR every ~20s).
  const loop = async () => {
    const keepGoing = await render();
    if (keepGoing) setTimeout(() => { if (document.querySelector('#modal-body .wa-status-card')) loop(); }, 8000);
  };
  loop();
}
document.getElementById('wa-pill').addEventListener('click', openWhatsAppModal);

// ---- Presence heartbeat ----
// Reports online / idle / offline for this user (shown as a coloured dot in HR). It also
// keeps non-admin sessions alive: auth_engine expires a session whose heartbeat goes stale.
const IDLE_AFTER_MS = 5 * 60 * 1000;
let lastActivity = Date.now(), presenceTimer = null, reportedState = null;

function idleAfterMs() {
  const policyMin = authPolicy && authPolicy.idle_logout_minutes;
  return policyMin ? Math.min(IDLE_AFTER_MS, policyMin * 60000) : IDLE_AFTER_MS;
}
function presenceState() {
  return document.hidden || Date.now() - lastActivity > idleAfterMs() ? 'idle' : 'online';
}
// Sign out on this side as soon as the idle limit passes, rather than waiting for the next
// request to be refused. The server enforces the same rule regardless.
function checkIdleLogout() {
  const minutes = authPolicy && authPolicy.idle_logout_minutes;
  if (currentUser && minutes && Date.now() - lastActivity > minutes * 60000) {
    sendPresence(true);  // reports idle_for, so the server ends the session too
    logout(`You were signed out after ${minutes} minutes of inactivity.`);
  }
}
function sendPresence(force = false) {
  if (!currentUser) return;
  const state = presenceState();
  if (!force && state === reportedState) return;
  reportedState = state;
  // idle_for: real inactivity, so the server's idle sign-out (HR -> Policy) counts from the last
  // mouse/keyboard input rather than from when this tab started reporting 'idle'.
  const idleFor = state === 'idle' ? Math.round((Date.now() - lastActivity) / 1000) : 0;
  fetch('/api/auth/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin', body: JSON.stringify({ status: state, idle_for: idleFor }) })
    .then(res => res.status === 401 && currentUser ? res.json().then(b => exitApp(b && b.error)) : null)
    .catch(() => {});
}
['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll', 'wheel'].forEach(evt =>
  window.addEventListener(evt, () => {
    const wasIdle = Date.now() - lastActivity > idleAfterMs();
    lastActivity = Date.now();
    if (wasIdle) sendPresence();  // back from idle -> report online straight away
  }, { passive: true }));
document.addEventListener('visibilitychange', () => sendPresence());
window.addEventListener('pagehide', () => {
  if (currentUser) navigator.sendBeacon('/api/auth/presence', JSON.stringify({ status: 'offline' }));
});
function startPresence() {
  stopPresence();
  lastActivity = Date.now();
  sendPresence(true);
  let tick = 0;
  presenceTimer = setInterval(() => {
    if (++tick % 3 === 0) sendPresence(true);  // heartbeat every 45s, even when unchanged
    checkIdleLogout();
  }, 15000);
}
function stopPresence() { if (presenceTimer) clearInterval(presenceTimer); presenceTimer = null; reportedState = null; }

// ---- Polling ----
let pollTimer = null;
function startPolling() {
  stopPolling();
  startPresence();
  loadNotifications.primed = false;
  loadNotifications();
  refreshWhatsAppStatus();
  pollTimer = setInterval(() => {
    loadNotifications(); refreshWhatsAppStatus();
    if (currentTab === 'hr' && typeof refreshHrPresence === 'function') refreshHrPresence();
  }, 20000);
}
function stopPolling() { stopPresence(); if (pollTimer) clearInterval(pollTimer); pollTimer = null; notifications = []; waStatus = null; }

// ---- Boot ----
async function boot() {
  const params = new URLSearchParams(location.search);
  // The navigation has to exist before anything can switch tabs. If the config can't be
  // fetched at all, the server-side defaults are unreachable too -- show a plain message.
  const config = await loadUiConfig();
  if (!config) { document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">Could not load the app configuration. Check that the server is running and reload the page.</p>'; return; }
  buildNavigation(config);
  renderGreeting();
  const remembered = storageGet('remember-username');
  document.getElementById('login-username').value = remembered || '';
  document.getElementById('login-remember').checked = !!remembered;
  await Promise.all([loadBranding(), loadAuthPolicy()]);
  if (params.get('reset_token')) {
    resetToken = params.get('reset_token');
    showAuthCard('reset');
    return;
  }
  const user = await api('/api/auth/current_user', { quiet: true });
  if (user && user.must_change_password) { currentUser = user; showAuthCard('change'); return; }
  if (user) enterApp(user);
  else showAuthCard('login');
}
