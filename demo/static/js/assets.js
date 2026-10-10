// Assets tab: every asset with its condition (good / fair / broken), location (picked from the
// hotel architecture), current ticket and comment. Condition cards filter the table; broken
// assets get a "Maintain" button that raises (and, for admins, assigns) a ticket -- the same
// ticket the Dashboard shows and moves through its lifecycle. Edits are admin-only, matching
// who can register assets: the Assets tab's permission. Assigning a ticket stays admin-only,
// as everywhere in the ticket workflow.

const as = { assets: [], filter: '', search: '', selected: new Set() };
function canManageAssets() { return hasPermission('assets'); }
const CONDITIONS = { good: 'Good', fair: 'Fair', broken: 'Broken' };

function conditionPill(c) { return `<span class="cond-pill cond-${esc(c)}">${esc(CONDITIONS[c] || c)}</span>`; }
function ticketCell(a) {
  const t = a.ticket;
  if (!t) return '<span class="muted">—</span>';
  return `<button class="link-btn ticket-link" data-ticket="${t.id}" title="${esc(t.title)}">#${t.id}</button>
    <span class="badge badge-${t.status}">${STATUS_LABEL[t.status] || t.status}</span>${t.assigned_to && t.active ? `<small class="muted"> · ${esc(t.assigned_to)}</small>` : ''}`;
}
function needsMaintenance(a) { return a.condition === 'broken' && !(a.ticket && a.ticket.active); }

async function loadAssetsTab() {
  const assets = await api('/api/assets');
  if (!assets) return;
  as.assets = assets;
  const ids = new Set(assets.map(a => a.id));
  [...as.selected].forEach(id => { if (!ids.has(id)) as.selected.delete(id); });
  document.querySelectorAll('#tab-assets .admin-only').forEach(el => { el.hidden = !canManageAssets(); });
  Object.keys(CONDITIONS).forEach(c => {
    const n = assets.filter(a => a.condition === c).length;
    document.getElementById(`as-count-${c}`).textContent = n;
    setNavSubCount('assets', 'data-filter', c, n);
  });
  setNavSubCount('assets', 'data-filter', 'all', assets.length);
  renderAssetsTable();
}
TAB_LOADERS.assets = loadAssetsTab;
// Sidebar: Assets -> All / Good / Fair / Broken.
NAV_FILTERS.assets = value => { as.filter = value === 'all' ? '' : value; if (as.assets.length) renderAssetsTable(); };

function visibleAssets() {
  const q = as.search.toLowerCase();
  return as.assets.filter(a => (!as.filter || a.condition === as.filter)
    && (!q || `${a.id} ${a.name} ${a.category || ''} ${a.location || ''} ${a.comment || ''} ${a.barcode}`.toLowerCase().includes(q)));
}

function renderAssetsTable() {
  const admin = canManageAssets();
  const rows = visibleAssets();
  document.querySelectorAll('#tab-assets .cond-card').forEach(card => {
    const on = card.dataset.cond === as.filter;
    card.classList.toggle('active', on);
    card.setAttribute('aria-pressed', on);
  });
  setNavSubActive('assets', 'data-filter', as.filter || 'all');
  const chip = document.getElementById('as-filter-chip');
  chip.hidden = !as.filter;
  chip.innerHTML = as.filter ? `Showing ${conditionPill(as.filter)} <button class="link-btn" id="as-clear-filter" aria-label="Show all">✕</button>` : '';

  document.querySelector('#as-table tbody').innerHTML = rows.map(a => `
    <tr class="clickable ${as.selected.has(a.id) ? 'selected' : ''}" data-asset="${a.id}">
      ${admin ? `<td class="check"><input type="checkbox" data-select="${a.id}" ${as.selected.has(a.id) ? 'checked' : ''} aria-label="Select ${esc(a.name)}"></td>` : ''}
      <td class="mono">#${a.id}</td>
      <td><div class="cell-title">${esc(a.name)}</div><small class="mono muted">${esc(a.barcode || '')}</small></td>
      <td class="hide-sm">${a.category ? `<span class="tag">${esc(a.category)}</span>` : '<span class="muted">—</span>'}</td>
      <td>${conditionPill(a.condition)}</td>
      <td class="as-loc">${a.location ? esc(a.location) : '<span class="muted">No location</span>'}</td>
      <td class="as-ticket">${ticketCell(a)}</td>
      <td class="hide-sm as-comment">${a.comment ? esc(a.comment) : '<span class="muted">—</span>'}</td>
      <td class="row-actions">${needsMaintenance(a) ? `<button class="btn-primary btn-sm" data-maintain="${a.id}">Maintain</button>` : `<span class="chev">${icon('chevronRight', 16)}</span>`}</td>
    </tr>`).join('') || `<tr><td colspan="9"><div class="empty-state small"><p>${as.search || as.filter ? 'No assets match.' : `No assets yet${admin ? ' — add one with <b>+ Asset</b>.' : '.'}`}</p></div></td></tr>`;

  const visibleIds = rows.map(a => a.id);
  const all = document.getElementById('as-all');
  all.checked = visibleIds.length > 0 && visibleIds.every(id => as.selected.has(id));
  all.indeterminate = !all.checked && visibleIds.some(id => as.selected.has(id));
  const del = document.getElementById('as-delete-selected');
  del.hidden = !admin || !as.selected.size;
  del.textContent = `Delete selected (${as.selected.size})`;
  const maintainable = as.assets.filter(a => as.selected.has(a.id) && needsMaintenance(a));
  const maint = document.getElementById('as-maintain-selected');
  maint.hidden = as.filter !== 'broken' || !maintainable.length;
  maint.textContent = `Maintain selected (${maintainable.length})`;
}

// ---- Events ----
document.querySelectorAll('#tab-assets .cond-card').forEach(card => {
  const toggle = () => { as.filter = as.filter === card.dataset.cond ? '' : card.dataset.cond; renderAssetsTable(); };
  card.addEventListener('click', toggle);
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
});
document.getElementById('as-filter-chip').addEventListener('click', e => {
  if (e.target.closest('#as-clear-filter')) { as.filter = ''; renderAssetsTable(); }
});
document.getElementById('as-search').addEventListener('input', e => { as.search = e.target.value; renderAssetsTable(); });
document.getElementById('as-all').addEventListener('change', e => {
  visibleAssets().forEach(a => { if (e.target.checked) as.selected.add(a.id); else as.selected.delete(a.id); });
  renderAssetsTable();
});
document.querySelector('#as-table tbody').addEventListener('click', e => {
  const sel = e.target.closest('[data-select]');
  if (sel) {
    const id = +sel.dataset.select;
    if (sel.checked) as.selected.add(id); else as.selected.delete(id);
    return renderAssetsTable();
  }
  if (e.target.closest('td.check')) return;  // clicking around the checkbox shouldn't open the row
  const ticket = e.target.closest('[data-ticket]');
  if (ticket) return openTicketModal(+ticket.dataset.ticket);
  const maintain = e.target.closest('[data-maintain]');
  if (maintain) return openMaintainModal([+maintain.dataset.maintain]);
  const row = e.target.closest('[data-asset]');
  if (row) openAssetEditModal(+row.dataset.asset);
});
document.getElementById('as-new').addEventListener('click', () => openAssetEditModal(null));
document.getElementById('as-maintain-selected').addEventListener('click', () =>
  openMaintainModal(as.assets.filter(a => as.selected.has(a.id) && needsMaintenance(a)).map(a => a.id)));
document.getElementById('as-delete-selected').addEventListener('click', async () => {
  const chosen = as.assets.filter(a => as.selected.has(a.id));
  if (!chosen.length) return;
  const busy = chosen.filter(a => a.ticket && a.ticket.active);
  if (busy.length) return toast(`${busy.map(a => a.name).slice(0, 3).join(', ')} still ${busy.length === 1 ? 'has' : 'have'} an active ticket — resolve or reject it first.`, 'error', 6000);
  const history = chosen.reduce((n, a) => n + (a.ticket_count || 0), 0);
  if (!confirm(`Delete ${chosen.length} asset${chosen.length === 1 ? '' : 's'}${history ? ` and their ${history} finished ticket${history === 1 ? '' : 's'}` : ''}? Their barcodes stop working. This can't be undone.`)) return;
  const r = await api('/api/assets/delete', { method: 'POST', body: JSON.stringify({ ids: chosen.map(a => a.id) }) });
  if (!r) return;
  toast(`Deleted ${r.deleted.length} asset${r.deleted.length === 1 ? '' : 's'}.`, 'success');
  log(`assets: deleted ${chosen.map(a => `#${a.id}`).join(', ')}`);
  as.selected.clear();
  lastAssets = [];
  loadAssetsTab();
});

// A ticket opened from here (or anything else in the modal) may have moved on -- refresh
// the table when the modal closes, so ticket status and condition stay current.
onModalClose(() => { if (currentTab === 'assets') loadAssetsTab(); });

// ---- Add / edit ----
async function openAssetEditModal(assetId) {
  if (!as.assets.length && assetId) await loadAssetsTab();
  const a = assetId ? as.assets.find(x => x.id === assetId) : { condition: 'good' };
  if (!a) return toast('That asset no longer exists.', 'error');
  if (assetId && !canManageAssets()) return openAssetModal(assetId);  // read-only view with its ticket history
  const categories = [...new Set(as.assets.map(x => x.category).filter(Boolean))].sort();
  const body = `
    <div class="form-grid two">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(a.name || '')}" placeholder="e.g. Room 204 AC unit"></label>
      <label class="field"><span>Category</span><input type="text" name="category" list="as-categories" value="${esc(a.category || '')}" placeholder="e.g. HVAC"><datalist id="as-categories">${categories.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
    </div>
    <p class="group-label">Condition</p>
    <div class="cond-choice" role="radiogroup">${Object.entries(CONDITIONS).map(([k, label]) => `
      <label class="cond-opt cond-${k}"><input type="radio" name="condition" value="${k}" ${a.condition === k ? 'checked' : ''}><span>${label}</span></label>`).join('')}</div>
    <label class="field" style="margin-top:1rem"><span>Location</span><select name="location" id="ae-location"><option value="">Loading locations…</option></select><small>From Hotel architecture — the same location the Dashboard shows for this asset.</small></label>
    <label class="field" style="margin-top:1rem"><span>Comment</span><textarea name="comment" rows="3" placeholder="e.g. Compressor noisy since Monday">${esc(a.comment || '')}</textarea></label>
    ${assetId ? `<div class="modal-section"><h3>Ticket</h3>
      <div class="ae-ticket">${a.ticket ? `${ticketCell(a)} <span class="muted">${esc(a.ticket.title)}</span>` : '<span class="muted">No tickets raised for this asset yet.</span>'}</div>
      <div class="modal-actions left">
        <button class="btn-primary" id="ae-maintain" ${a.ticket && a.ticket.active ? 'hidden' : ''}>Maintain — raise a ticket</button>
        <button class="btn-outline" id="ae-history">Ticket history &amp; barcode</button>
      </div></div>` : ''}
    <div class="modal-actions">
      ${assetId ? `<button class="btn-danger-outline" id="ae-delete" style="margin-right:auto">${icon('trash', 14)} Delete</button>` : ''}
      <button class="btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="ae-save">${assetId ? `${icon('check', 14)} Save changes` : 'Create asset &amp; mint barcode'}</button>
    </div>`;
  if (assetId) {
    setDetailModal('asset-edit', a.id, { title: `${esc(a.name)} <span class="code-chip">#${a.id}</span>`,
      sub: `${conditionPill(a.condition)} <span class="mono">${esc(a.barcode || '')}</span>`, body });
  } else {
    openFormModal({ title: 'New asset', sub: 'A barcode is minted for it straight away.', body });
  }
  fillLocationSelect(modalEl('#ae-location'), a.location || '');

  const values = () => {
    const v = formValues();
    const cond = modalEl('input[name=condition]:checked');
    return { name: v.name, category: v.category, location: modalEl('#ae-location').value, comment: v.comment, condition: cond ? cond.value : 'good' };
  };
  modalEl('#ae-save').addEventListener('click', async () => {
    const payload = values();
    if (!payload.name) return toast('Name is required.', 'error');
    const saved = await api(assetId ? `/api/assets/${assetId}` : '/api/assets', { method: assetId ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    if (!saved) return;
    toast(assetId ? `Saved ${saved.name}.` : `Created ${saved.name} — barcode ${saved.barcode}.`, 'success');
    log(`assets: ${assetId ? 'updated' : 'created'} #${saved.id} "${saved.name}" (${saved.condition})`);
    lastAssets = [];
    await loadAssetsTab();
    if (needsMaintenance(saved) && confirm(`${saved.name} is broken. Raise a maintenance ticket for it now?`)) return openMaintainModal([saved.id]);
    if (assetId) { modalHistory.pop(); openAssetEditModal(saved.id); } else closeModal();
  });
  if (!assetId) return;
  modalEl('#ae-maintain').addEventListener('click', () => openMaintainModal([a.id], true));
  modalEl('#ae-history').addEventListener('click', () => openAssetModal(a.id));
  modalEl('.ae-ticket [data-ticket]')?.addEventListener('click', () => openTicketModal(a.ticket.id));
  modalEl('#ae-delete').addEventListener('click', async () => {
    if (a.ticket && a.ticket.active) return toast('This asset has an active ticket — resolve or reject it before deleting.', 'error', 6000);
    if (!confirm(`Delete ${a.name}${a.ticket_count ? ` and its ${a.ticket_count} finished ticket(s)` : ''}? This can't be undone.`)) return;
    if (await api('/api/assets/delete', { method: 'POST', body: JSON.stringify({ ids: [a.id] }) })) {
      toast(`Deleted ${a.name}.`, 'success');
      as.selected.delete(a.id);
      lastAssets = [];
      closeModal();
      loadAssetsTab();
    }
  });
}
registerModalOpener('asset-edit', openAssetEditModal);

// ---- Maintain: raise a ticket (and, for admins, assign it) for one or more broken assets ----
// It's an ordinary ticket: it appears on the Dashboard, moves through assigned → in progress →
// resolved there, and resolving it sets the asset back to "good" (server-side hook).
async function openMaintainModal(assetIds, fromDetail = false) {
  const targets = as.assets.filter(a => assetIds.includes(a.id));
  if (!targets.length) return;
  const one = targets.length === 1 ? targets[0] : null;
  const users = isAdmin() ? await api('/api/assignees', { quiet: true }) || [] : [];
  openFormModal({
    title: one ? `Maintain ${esc(one.name)}` : `Maintain ${targets.length} assets`,
    sub: one ? `${esc(one.location || 'No location')} · ${conditionPill(one.condition)}` : esc(targets.map(a => a.name).join(', ')),
    keepHistory: fromDetail,
    body: `
      <label class="field"><span>What needs doing?</span><input type="text" name="title" value="${esc(one ? `Repair: ${one.name}` : 'Repair')}"><small>${one ? '' : 'Each asset gets its own ticket, titled with its name.'}</small></label>
      <div class="form-grid two" style="margin-top:1rem">
        <label class="field"><span>Priority</span><select name="priority"><option value="low">Low</option><option value="normal">Normal</option><option value="high" selected>High</option></select></label>
        ${isAdmin() ? `<label class="field"><span>Assign to</span><select name="assignee"><option value="">— Decide later (stays open) —</option>${users.map(u => `<option value="${u.id}">${esc(u.username)}${u.role === 'admin' ? ' (admin)' : ''}</option>`).join('')}</select><small>They're notified, same as assigning from the Dashboard.</small></label>` : ''}
      </div>
      <label class="field" style="margin-top:1rem"><span>Details</span><textarea name="description" rows="3">${esc(one ? one.comment || '' : '')}</textarea></label>
      <div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Cancel</button><button class="btn-primary" id="mt-create">${one ? 'Create ticket' : `Create ${targets.length} tickets`}</button></div>`,
  });
  modalEl('#mt-create').addEventListener('click', async e => {
    const v = formValues();
    if (!v.title) return toast('Say what needs doing.', 'error');
    e.target.disabled = true;
    const created = [];
    for (const a of targets) {
      const title = one ? v.title : `${v.title}: ${a.name}`;
      const ticket = await api(`/api/assets/${a.id}/tickets`, { method: 'POST', body: JSON.stringify({ title, priority: v.priority, description: v.description || a.comment || '' }) });
      if (!ticket) continue;
      if (v.assignee) {
        await api(`/api/tickets/${ticket.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'assigned', assigned_to_id: +v.assignee, note: 'Assigned from Assets → Maintain' }) });
      }
      created.push(ticket);
      log(`assets: maintenance ticket #${ticket.id} raised for "${a.name}"`);
    }
    e.target.disabled = false;
    if (!created.length) return;
    toast(created.length === 1 ? `Ticket #${created[0].id} raised${v.assignee ? ' and assigned' : ''} — it's on the Dashboard too.` : `${created.length} tickets raised${v.assignee ? ' and assigned' : ''}.`, 'success', 6000);
    as.selected.clear();
    await loadAssetsTab();
    if (created.length === 1) openTicketModal(created[0].id); else closeModal();
  });
}
