// Dashboard tab: asset registration, barcode scan -> ticket, ticket list, drill-down stat
// cards, and the ticket/asset detail modals (lifecycle stepper + audit timeline).
let currentAsset = null;

document.getElementById('create-asset-btn').addEventListener('click', async () => {
  const name = document.getElementById('new-asset-name').value.trim();
  const location = document.getElementById('new-asset-location').value;
  if (!name) return;
  const asset = await api('/api/assets', { method: 'POST', body: JSON.stringify({ name, location }) });
  if (asset) {
    log(`created asset "${asset.name}" -> barcode ${asset.barcode}`);
    document.getElementById('new-asset-name').value = '';
    document.getElementById('new-asset-location').value = '';
    refreshAll();
  }
});

const scanInput = document.getElementById('scan-input');
scanInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const code = scanInput.value.trim();
  scanInput.value = '';
  if (!code) return;
  const asset = await api(`/api/assets/barcode/${encodeURIComponent(code)}`);
  const resultEl = document.getElementById('scan-result');
  if (asset) {
    currentAsset = asset;
    resultEl.classList.add('visible');
    resultEl.querySelector('.asset-name').textContent = asset.name;
    resultEl.querySelector('.asset-meta').textContent =
      `${asset.location || 'no location'} · barcode ${asset.barcode}`;
    document.getElementById('ticket-form-section').style.display = 'block';
    log(`scanned ${asset.barcode} -> ${asset.name}`);
  } else {
    resultEl.classList.remove('visible');
    document.getElementById('ticket-form-section').style.display = 'none';
    log(`scan failed: unknown barcode "${code}"`);
  }
  // Refocus the scan box itself for the next consecutive scan -- scoped to this one input,
  // unlike the previous document-wide click listener this replaced, which stole focus from
  // *any* field the moment you clicked into it (that was the "typing doesn't work" bug).
  scanInput.focus();
});

document.getElementById('create-ticket-btn').addEventListener('click', async () => {
  const title = document.getElementById('ticket-title').value.trim();
  if (!title || !currentAsset) return;
  const description = document.getElementById('ticket-description').value.trim();
  const priority = document.getElementById('ticket-priority').value;
  const ticket = await api(`/api/assets/${currentAsset.id}/tickets`, {
    method: 'POST', body: JSON.stringify({ title, description, priority }),
  });
  if (ticket) {
    log(`created ticket #${ticket.id} "${ticket.title}" for ${ticket.asset_name}`);
    document.getElementById('ticket-title').value = '';
    document.getElementById('ticket-description').value = '';
    document.getElementById('ticket-priority').value = 'normal';
    await refreshAll();
    openTicketModal(ticket.id);
  }
});

// ---- Ticket workflow ----
// Mirrors ticket_engine/models.py ALLOWED_TRANSITIONS (role=null means anyone logged in),
// so the UI only offers buttons the server will actually accept for this user.
const ACTIONS = {
  open: [['assigned', 'Assign', 'btn-primary', 'admin'], ['rejected', 'Reject', 'btn-danger-outline', 'admin']],
  assigned: [['in_progress', 'Start work', 'btn-primary', null], ['rejected', 'Reject', 'btn-danger-outline', 'admin']],
  in_progress: [['resolved', 'Resolve', 'btn-primary', null], ['assigned', 'Reassign', 'btn-outline', 'admin']],
  resolved: [],
  rejected: [],
};
function actionsFor(status) {
  return (ACTIONS[status] || []).filter(([, , , role]) => !role || (currentUser && currentUser.role === role));
}

const STATUS_LABEL = {
  open: 'Open', assigned: 'Assigned', in_progress: 'In progress',
  resolved: 'Resolved', rejected: 'Rejected',
};

async function transition(ticketId, status, extra = {}) {
  const ticket = await api(`/api/tickets/${ticketId}/status`, { method: 'PUT', body: JSON.stringify({ status, ...extra }) });
  if (ticket) {
    log(`ticket #${ticket.id} -> ${ticket.status}${ticket.assigned_to && status === 'assigned' ? ' (' + ticket.assigned_to + ')' : ''}`);
    if (status === 'assigned' || status === 'resolved') {
      const events = await api(`/api/tickets/${ticketId}/events`);
      const notif = events && events.filter(e => e.event_type === 'notification').pop();
      if (notif) log(`  ↳ ${notif.note}`);
    }
    await refreshAll();
  }
  return ticket;
}

// Quick buttons on the Tickets list: assigning needs a person picked, so it opens the detail view.
function quickAction(ticketId, status) {
  if (status === 'assigned') openTicketModal(ticketId);
  else transition(ticketId, status);
}

const EMPTY_TICKETS = `
  <div class="empty-state">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4Z"/></svg>
    <p>No tickets yet — scan an asset to raise one.</p>
  </div>`;

let lastTickets = [];
let lastAssets = [];

async function loadTickets() {
  const tickets = await api('/api/tickets');
  const el = document.getElementById('tickets-list');
  if (!tickets) {
    el.innerHTML = `<div class="empty-state"><p>Please log in to view tickets.</p></div>`;
    return [];
  }
  el.innerHTML = tickets.map(t => `
    <div class="ticket-row status-${t.status}" onclick="openTicketModal(${t.id})" title="Click for full details & history">
      <div class="ticket-main">
        <div class="ticket-title">#${t.id} ${esc(t.title)} ${t.priority !== 'normal' ? prioChip(t.priority) : ''}</div>
        <div class="ticket-sub">${esc(t.asset_name)}${t.assigned_to ? ' · assigned to ' + esc(t.assigned_to) : ''}</div>
      </div>
      <span class="badge badge-${t.status}">${STATUS_LABEL[t.status] || t.status}</span>
      <div class="ticket-actions" onclick="event.stopPropagation()">
        ${actionsFor(t.status).map(([s, label, cls]) =>
          `<button class="${cls} btn-sm" onclick="quickAction(${t.id}, '${s}')">${label}</button>`).join('')}
      </div>
    </div>
  `).join('') || EMPTY_TICKETS;
  return tickets;
}

async function loadStats(tickets) {
  const assets = await api('/api/assets');
  lastAssets = assets || [];
  document.getElementById('stat-assets').textContent = assets ? assets.length : '–';
  const count = (s) => tickets.filter(t => t.status === s).length;
  document.getElementById('stat-open').textContent = count('open');
  document.getElementById('stat-progress').textContent = count('assigned') + count('in_progress');
  document.getElementById('stat-resolved').textContent = count('resolved');
}

async function refreshAll() {
  const tickets = await loadTickets();
  lastTickets = tickets || [];
  await loadStats(lastTickets);
  renderStatPanel();
}

// ---- Expandable stat cards ----
const STAT_PANELS = {
  assets: {
    title: 'Assets tracked', empty: 'No assets registered yet.',
    items: () => lastAssets,
    row: a => {
      const active = lastTickets.filter(t => t.asset_id === a.id && ['open', 'assigned', 'in_progress'].includes(t.status)).length;
      return `<div class="list-item" onclick="openAssetModal(${a.id})">
        <div class="li-main">
          <div class="li-title">${esc(a.name)}</div>
          <div class="li-sub">${esc(a.location || 'no location')} · <span class="mono">${esc(a.barcode)}</span></div>
        </div>
        ${active ? `<span class="badge badge-in_progress">${active} active</span>` : '<span class="badge badge-resolved">No issues</span>'}
        ${ARROW}</div>`;
    },
  },
  open: {
    title: 'Open tickets', empty: 'No open tickets — nothing waiting to be dispatched.',
    items: () => lastTickets.filter(t => t.status === 'open'),
  },
  progress: {
    title: 'In progress (assigned or being worked on)', empty: 'Nothing in progress right now.',
    items: () => lastTickets.filter(t => t.status === 'assigned' || t.status === 'in_progress'),
  },
  resolved: {
    title: 'Resolved tickets', empty: 'No tickets resolved yet.',
    items: () => lastTickets.filter(t => t.status === 'resolved'),
  },
};

function ticketListRow(t) {
  const when = t.status === 'resolved'
    ? `resolved ${fmtAgo(t.resolved_at)} · took ${fmtDuration(parseTs(t.resolved_at) - parseTs(t.created_at))}`
    : `opened ${fmtAgo(t.created_at)}`;
  return `<div class="list-item" style="border-left-color:var(--${{ open: 'slate', assigned: 'info', in_progress: 'warning', resolved: 'success', rejected: 'danger' }[t.status]})" onclick="openTicketModal(${t.id})">
    <div class="li-main">
      <div class="li-title">#${t.id} ${esc(t.title)} ${prioChip(t.priority)}</div>
      <div class="li-sub">${esc(t.asset_name)}${t.asset_location ? ' (' + esc(t.asset_location) + ')' : ''} · ${when}${t.assigned_to ? ' · ' + esc(t.assigned_to) : ''}</div>
    </div>
    <span class="badge badge-${t.status}">${STATUS_LABEL[t.status]}</span>
    ${ARROW}</div>`;
}

let openPanel = null;

function renderStatPanel() {
  const panelEl = document.getElementById('stat-panel');
  document.querySelectorAll('.stat-card[data-panel]').forEach(c => {
    const active = c.dataset.panel === openPanel;
    c.classList.toggle('active', active);
    c.setAttribute('aria-expanded', active);
  });
  if (!openPanel) { panelEl.classList.remove('open'); return; }
  const cfg = STAT_PANELS[openPanel];
  const card = document.querySelector(`.stat-card[data-panel="${openPanel}"]`);
  const items = cfg.items();
  document.getElementById('stat-panel-icon').innerHTML = card.querySelector('.stat-icon').innerHTML;
  document.getElementById('stat-panel-title').textContent = cfg.title;
  document.getElementById('stat-panel-count').textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
  document.getElementById('stat-panel-list').innerHTML =
    items.map(cfg.row || ticketListRow).join('') || `<div class="empty-state"><p>${cfg.empty}</p></div>`;
  panelEl.classList.add('open');
}

document.querySelectorAll('.stat-card[data-panel]').forEach(card => {
  const toggle = () => { openPanel = openPanel === card.dataset.panel ? null : card.dataset.panel; renderStatPanel(); };
  card.addEventListener('click', toggle);
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
});
document.getElementById('stat-panel-close').addEventListener('click', () => { openPanel = null; renderStatPanel(); });

// ---- Ticket / asset detail modals ----
let assigneesCache = null;

const STEP_PATH = ['open', 'assigned', 'in_progress', 'resolved'];

function renderStepper(ticket, events) {
  // First time each status was entered, from the audit trail.
  const reachedAt = {};
  events.forEach(e => { if (e.to_status && !(e.to_status in reachedAt)) reachedAt[e.to_status] = e.created_at; });
  const rejection = events.find(e => e.to_status === 'rejected');
  const rejectedFromIdx = rejection ? STEP_PATH.indexOf(rejection.from_status) : -1;
  const currentIdx = STEP_PATH.indexOf(ticket.status);

  const steps = STEP_PATH.map((st, i) => {
    let cls;
    if (ticket.status === 'rejected') cls = i <= rejectedFromIdx ? 'done' : 'skipped';
    else if (ticket.status === 'resolved' || i < currentIdx) cls = 'done';
    else if (i === currentIdx) cls = 'current';
    else cls = '';
    const time = cls === 'done' || cls === 'current' ? fmtTs(reachedAt[st]) : '';
    return `<div class="step ${cls}"><div class="step-dot">${cls === 'done' ? '✓' : i + 1}</div>
      <div class="step-label">${STATUS_LABEL[st]}</div><div class="step-time">${time}</div></div>`;
  });
  if (ticket.status === 'rejected') {
    steps.splice(rejectedFromIdx + 1, 0, `<div class="step rejected"><div class="step-dot">✕</div>
      <div class="step-label" style="color:var(--danger)">Rejected</div><div class="step-time">${fmtTs(rejection.created_at)}</div></div>`);
  }
  return `<div class="stepper">${steps.join('')}</div>`;
}

function renderKpis(ticket, events) {
  const created = parseTs(ticket.created_at);
  const firstAt = st => { const e = events.find(ev => ev.to_status === st); return e ? parseTs(e.created_at) : null; };
  const assigned = firstAt('assigned'), started = firstAt('in_progress');
  const closed = parseTs(ticket.resolved_at) || firstAt('rejected');
  const kpis = [
    ['Age', ticket.status === 'resolved' || ticket.status === 'rejected' ? `closed` : fmtDuration(Date.now() - created)],
    ['Time to assign', assigned ? fmtDuration(assigned - created) : '–'],
    ['Time to start', started ? fmtDuration(started - created) : '–'],
    [ticket.status === 'rejected' ? 'Time to reject' : 'Time to resolve', closed ? fmtDuration(closed - created) : '–'],
    ['Comments', events.filter(e => e.event_type === 'comment').length],
  ];
  return `<div class="kpi-row">${kpis.map(([k, v]) => `<div class="kpi"><b>${v}</b>${k}</div>`).join('')}</div>`;
}

const TL_ICONS = {
  created: '<path d="M12 5v14M5 12h14"/>',
  assigned: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
  in_progress: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  resolved: '<path d="M20 6 9 17l-5-5"/>',
  rejected: '<path d="M18 6 6 18M6 6l12 12"/>',
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  notification: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
};

function renderTimeline(events) {
  return `<ul class="timeline">${events.map((e, i) => {
    const kind = e.event_type === 'status_changed' ? e.to_status : e.event_type;
    const who = e.actor ? `<b>${esc(e.actor)}</b>` : 'System';
    let text;
    if (e.event_type === 'created') text = `${who} opened the ticket`;
    else if (e.event_type === 'status_changed') text = `${who} moved it <span class="badge badge-${e.from_status}">${STATUS_LABEL[e.from_status]}</span> → <span class="badge badge-${e.to_status}">${STATUS_LABEL[e.to_status]}</span>${e.overrode_warning ? '<span class="override-chip">warning overridden</span>' : ''}`;
    else if (e.event_type === 'comment') text = `${who} commented`;
    else if (e.event_type === 'notification') {
      const sent = /^WhatsApp sent/.test(e.note || '');
      const skipped = /skipped|no phone/.test(e.note || '');
      text = `WhatsApp notification <span class="badge badge-${sent ? 'resolved' : skipped ? 'open' : 'in_progress'}">${sent ? 'Sent' : skipped ? 'Skipped' : 'Not sent'}</span>`;
    }
    else text = `${who} · ${esc(e.event_type)}`;
    // "+Xm after previous step" only between workflow steps -- a notification is a side effect
    // written the same instant as the transition that caused it, not a step of its own.
    const prevStep = e.event_type === 'notification' ? null
      : events.slice(0, i).reverse().find(p => p.event_type !== 'notification');
    const gap = prevStep ? ` · +${fmtDuration(parseTs(e.created_at) - parseTs(prevStep.created_at))} after previous step` : '';
    return `<li class="tl-item">
      <div class="tl-icon t-${kind}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${TL_ICONS[kind] || TL_ICONS.comment}</svg></div>
      <div class="tl-text">${text}</div>
      <div class="tl-meta">${fmtTs(e.created_at)} (${fmtAgo(e.created_at)})${gap}</div>
      ${e.note ? `<div class="tl-note">${esc(e.note)}</div>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

async function openTicketModal(ticketId) {
  const [ticket, events] = await Promise.all([api(`/api/tickets/${ticketId}`), api(`/api/tickets/${ticketId}/events`)]);
  if (!ticket || !events) return;
  const actions = actionsFor(ticket.status);
  const needsAssignee = actions.some(([s]) => s === 'assigned');
  if (needsAssignee && !assigneesCache) assigneesCache = await api('/api/assignees') || [];
  pushHistory('ticket', ticket.id);

  document.getElementById('modal-title').innerHTML = `#${ticket.id} ${esc(ticket.title)}`;
  document.getElementById('modal-sub').innerHTML =
    `<span class="badge badge-${ticket.status}">${STATUS_LABEL[ticket.status]}</span> ${prioChip(ticket.priority)} · opened by ${esc(ticket.created_by || '—')} ${fmtAgo(ticket.created_at)}`;

  const assigneeSelect = needsAssignee ? `
    <select id="md-assignee" style="flex:1; min-width:160px;">
      ${assigneesCache.map(u => `<option value="${u.id}" ${u.id === ticket.assigned_to_id ? 'selected' : ''}>${esc(u.username)} (${esc(u.role)})</option>`).join('')}
    </select>` : '';

  const actionBox = actions.length ? `
    <div class="modal-section">
      <h3>Next step</h3>
      <div class="action-box">
        ${needsAssignee ? `<div class="field-row" style="margin-bottom:0.6rem;"><span class="field-label" style="flex:0 0 auto; margin:0;">Assign to</span>${assigneeSelect}</div>` : ''}
        <input id="md-note" type="text" placeholder="Note for this step (optional) — e.g. 'replaced compressor fuse'" style="width:100%;">
        <div class="action-buttons">
          ${actions.map(([s, label, cls]) => `<button class="${cls} btn-sm" data-to="${s}">${label}</button>`).join('')}
        </div>
      </div>
    </div>` : `
    <div class="modal-section"><div class="hint-banner" style="margin:0;">
      <span>${ticket.status === 'resolved' || ticket.status === 'rejected'
        ? `This ticket is <b>${STATUS_LABEL[ticket.status].toLowerCase()}</b> — its lifecycle is complete.`
        : 'No actions available for your role at this stage.'}</span></div></div>`;

  document.getElementById('modal-body').innerHTML = `
    <div class="modal-section">
      <h3>Lifecycle</h3>
      ${renderStepper(ticket, events)}
      ${renderKpis(ticket, events)}
    </div>
    <div class="modal-section">
      <h3>Details</h3>
      <div class="meta-grid">
        <div><div class="meta-k">Asset</div><div class="meta-v"><button class="link-btn" id="md-asset-link">${esc(ticket.asset_name)}</button></div></div>
        <div><div class="meta-k">Location</div><div class="meta-v">${esc(ticket.asset_location || '—')}</div></div>
        <div><div class="meta-k">Barcode</div><div class="meta-v mono">${esc(ticket.asset_barcode)}</div></div>
        <div><div class="meta-k">Assigned to</div><div class="meta-v">${esc(ticket.assigned_to || 'Unassigned')}</div></div>
        <div><div class="meta-k">Created</div><div class="meta-v">${fmtTs(ticket.created_at)}</div></div>
        <div><div class="meta-k">Resolved</div><div class="meta-v">${ticket.resolved_at ? fmtTs(ticket.resolved_at) : '—'}</div></div>
      </div>
      ${ticket.description ? `<div class="desc-box">${esc(ticket.description)}</div>` : ''}
    </div>
    ${actionBox}
    <div class="modal-section">
      <h3>History (${events.length} event${events.length === 1 ? '' : 's'})</h3>
      ${renderTimeline(events)}
      <div class="field-row" style="margin-top:1rem;">
        <input id="md-comment" type="text" placeholder="Add a comment to the history…">
        <button class="btn-outline" id="md-comment-btn" style="flex:0 0 auto;">Comment</button>
      </div>
    </div>`;

  document.getElementById('md-asset-link').addEventListener('click', () => openAssetModal(ticket.asset_id));
  document.querySelectorAll('#modal-body .action-buttons button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const to = btn.dataset.to;
      const extra = {};
      const note = document.getElementById('md-note').value.trim();
      if (note) extra.note = note;
      if (to === 'assigned') extra.assigned_to_id = parseInt(document.getElementById('md-assignee').value, 10);
      if (to === 'rejected' && !confirm(`Reject ticket #${ticket.id}? This ends its lifecycle.`)) return;
      btn.disabled = true;
      const updated = await transition(ticket.id, to, extra);
      if (updated) openTicketModal(ticket.id); else btn.disabled = false;
    });
  });
  const commentInput = document.getElementById('md-comment');
  const postComment = async () => {
    const note = commentInput.value.trim();
    if (!note) return;
    const ok = await api(`/api/tickets/${ticket.id}/comments`, { method: 'POST', body: JSON.stringify({ note }) });
    if (ok) { log(`ticket #${ticket.id}: comment added`); openTicketModal(ticket.id); }
  };
  document.getElementById('md-comment-btn').addEventListener('click', postComment);
  commentInput.addEventListener('keydown', e => { if (e.key === 'Enter') postComment(); });
  showModal();
}

async function openAssetModal(assetId) {
  const asset = (await api('/api/assets') || lastAssets).find(a => a.id === assetId);  // fresh: the Assets tab may have edited it
  if (!asset) return;
  lastTickets = await api('/api/tickets', { quiet: true }) || lastTickets;  // may not be loaded if the Dashboard wasn't opened yet
  pushHistory('asset', asset.id);
  const tickets = lastTickets.filter(t => t.asset_id === asset.id);
  const active = tickets.filter(t => ['open', 'assigned', 'in_progress'].includes(t.status));
  const resolved = tickets.filter(t => t.status === 'resolved');
  const avgMs = resolved.length
    ? resolved.reduce((sum, t) => sum + (parseTs(t.resolved_at) - parseTs(t.created_at)), 0) / resolved.length : null;

  document.getElementById('modal-title').textContent = asset.name;
  document.getElementById('modal-sub').innerHTML = `${esc(asset.location || 'no location')} · <span class="mono">${esc(asset.barcode)}</span>`;
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-section">
      <h3>Asset</h3>
      <div class="meta-grid">
        <div><div class="meta-k">Barcode</div><div class="meta-v mono">${esc(asset.barcode)} <button class="link-btn" id="md-copy-barcode" style="font-size:0.72rem;">copy</button> · <button class="link-btn" id="md-print-barcode" style="font-size:0.72rem;">print label</button></div></div>
        <div><div class="meta-k">Category</div><div class="meta-v">${esc(asset.category || '—')}</div></div>
        <div><div class="meta-k">Condition</div><div class="meta-v">${conditionPill(asset.condition || 'good')}</div></div>
        <div><div class="meta-k">Location</div><div class="meta-v">${esc(asset.location || '—')}</div></div>
        <div><div class="meta-k">Comment</div><div class="meta-v">${esc(asset.comment || '—')}</div></div>
      </div>
      ${hasPermission('assets') ? `<div class="modal-actions left"><button class="btn-outline btn-sm" id="md-edit-asset">${icon('edit', 13)} Edit asset (condition, location, comment)</button></div>` : ''}
      <div class="kpi-row">
        <div class="kpi"><b>${tickets.length}</b>Total tickets</div>
        <div class="kpi"><b>${active.length}</b>Active</div>
        <div class="kpi"><b>${resolved.length}</b>Resolved</div>
        <div class="kpi"><b>${fmtDuration(avgMs)}</b>Avg. time to resolve</div>
      </div>
    </div>
    <div class="modal-section">
      <h3>Raise a ticket for this asset</h3>
      <div class="field-row" style="margin-bottom:0.6rem;">
        <input id="md-new-title" type="text" placeholder="What's wrong?">
        <select id="md-new-priority" style="flex:0 0 auto;">
          <option value="low">Low</option><option value="normal" selected>Normal</option><option value="high">High</option>
        </select>
      </div>
      <textarea id="md-new-desc" rows="2" placeholder="Details (optional)" style="margin-bottom:0.6rem;"></textarea>
      <button class="btn-primary btn-sm" id="md-new-btn">Create ticket</button>
    </div>
    <div class="modal-section">
      <h3>Ticket history</h3>
      <div style="border:1px solid var(--border); border-radius:10px; overflow:hidden;">
        ${tickets.map(ticketListRow).join('') || '<div class="empty-state"><p>No tickets raised against this asset yet.</p></div>'}
      </div>
    </div>`;

  document.getElementById('md-edit-asset')?.addEventListener('click', async () => {
    if (!as.assets.some(a => a.id === asset.id)) await loadAssetsTab();
    openAssetEditModal(asset.id);
  });
  document.getElementById('md-copy-barcode').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(asset.barcode); e.target.textContent = 'copied'; } catch { e.target.textContent = 'copy failed'; }
  });
  document.getElementById('md-print-barcode').addEventListener('click', () =>
    openBarcodePrintDialog([{ code: asset.barcode, title: asset.name, subtitle: asset.location || '' }], { backTo: ['asset', asset.id] }));
  document.getElementById('md-new-btn').addEventListener('click', async () => {
    const title = document.getElementById('md-new-title').value.trim();
    if (!title) return;
    const ticket = await api(`/api/assets/${asset.id}/tickets`, { method: 'POST', body: JSON.stringify({
      title, description: document.getElementById('md-new-desc').value.trim(),
      priority: document.getElementById('md-new-priority').value,
    }) });
    if (ticket) {
      log(`created ticket #${ticket.id} "${ticket.title}" for ${ticket.asset_name}`);
      await refreshAll();
      openTicketModal(ticket.id);
    }
  });
  showModal();
}


// ---- My deliveries (work orders addressed to me, from warehouse approvals) ----
const WO_DELIVERY_STATE = o => o.delivery_confirmed_at ? ['resolved', 'Received']
  : o.status === 'completed' ? ['in_progress', 'Confirm receipt'] : o.status === 'approved' ? ['assigned', 'On its way'] : ['open', o.status];

async function loadMyDeliveries() {
  const orders = await api('/api/warehouse/my-deliveries', { quiet: true }) || [];
  const card = document.getElementById('my-deliveries-card');
  const recent = orders.filter(o => !o.delivery_confirmed_at || Date.now() - parseTs(o.delivery_confirmed_at) < 7 * 864e5);
  card.hidden = !recent.length;
  const pending = recent.filter(o => o.status === 'completed' && !o.delivery_confirmed_at).length;
  document.getElementById('my-deliveries-count').textContent = pending ? `${pending} awaiting your confirmation` : '';
  document.getElementById('my-deliveries-list').innerHTML = recent.map(o => {
    const [cls, label] = WO_DELIVERY_STATE(o);
    return `<div class="list-item" onclick="openWorkOrderModal(${o.id})">
      <div class="li-icon">${icon('truck', 16)}</div>
      <div class="li-main"><div class="li-title">${o.quantity} × ${esc(o.item_name)}</div>
        <div class="li-sub">Work order #${o.id} · delivery ${fmtDate(o.delivery_date)} · approved by ${esc(o.approved_by || '—')}</div></div>
      <span class="badge badge-${cls}">${label}</span>${ARROW}</div>`;
  }).join('');
}

function resetDashboardState() {
  openPanel = null;
  assigneesCache = null;
  lastTickets = [];
  lastAssets = [];
}

TAB_LOADERS.dashboard = () => {
  document.getElementById('register-asset-card').hidden = !hasPermission('assets');
  refreshAll(); loadMyDeliveries(); fillLocationSelect(document.getElementById('new-asset-location')); };
registerModalOpener('ticket', openTicketModal);
registerModalOpener('asset', openAssetModal);
