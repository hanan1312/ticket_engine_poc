// Hotel architecture tab: Buildings | Floors | Rooms sub-tabs, the building and floor detail
// modals (editing a building re-syncs its floors and rooms on the server), the site-plan
// whiteboard (shapes you add, drag, resize, label and link to buildings) and the PDF print.
// IDs are derived server-side: building "A", floor "A_2", room "A_2_204".

const ha = { buildings: [], board: null, zoom: 1, selected: null, floorsBuilding: '', roomsBuilding: '', roomsSearch: '' };
const ROOMS_RENDER_LIMIT = 500;
// Editing needs the Hotel architecture tab's permission (granted per account in HR; admins have it).
function canEditHotel() { return hasPermission('hotel'); }

function haFloors() { return ha.buildings.flatMap(b => b.floors.map(f => ({ ...f, building: b }))); }
function haRooms() { return haFloors().flatMap(f => f.rooms.map(r => ({ ...r, floor: f, building: f.building }))); }
function haBuilding(id) { return ha.buildings.find(b => b.id === id); }
function perFloorSummary(b) {
  const counts = b.floors.map(f => f.room_count);
  if (!counts.length) return '—';
  if (counts.every(c => c === counts[0])) return `${counts[0]} on every floor`;
  return b.floors.map(f => `F${f.number}: ${f.room_count}`).join(' · ');
}

async function loadHotelTab() {
  const buildings = await api('/api/hotel/buildings');
  if (!buildings) return;
  ha.buildings = buildings;
  document.querySelectorAll('#tab-hotel .admin-only').forEach(el => { el.hidden = !canEditHotel(); });
  setSubtabCount('ha-buildings', ha.buildings.length);
  setSubtabCount('ha-floors', ha.buildings.reduce((n, b) => n + b.floor_count, 0));
  setSubtabCount('ha-rooms', ha.buildings.reduce((n, b) => n + b.room_count, 0));
  renderBuildingFilters(); renderBuildingsTable(); renderFloorsTable(); renderRoomsTable();
  switchSubtab('ha', currentSubtab('ha'));
}
TAB_LOADERS.hotel = loadHotelTab;

// Reload after any change, keeping whatever is open (tab tables, whiteboard) in sync.
async function refreshHotel() {
  await loadHotelTab();
  if (!document.getElementById('wb-overlay').hidden) await loadBoard();
}

// ---------------- Locations (used by the asset form on the Dashboard) ----------------
// A location is stored on the asset as readable text that also carries the ID, e.g.
// "Main tower › Floor 2 › Room 204 (A_2_204)" -- ticket_engine keeps a plain string, so it
// stays independent of the hotel package.
function locationLabel(b, f = null, r = null) {
  const parts = [b.name, f && f.name, r && `Room ${r.number}`].filter(Boolean);
  return `${parts.join(' › ')} (${(r || f || b).code})`;
}

// Fills a <select> with every building, floor and room, one group per building, selecting
// `current`. A location saved before it matched the architecture (old free text, or a since
// renamed room) is kept as an extra option so editing an asset never silently drops it.
async function fillLocationSelect(select, current = select.value) {
  const buildings = await api('/api/hotel/buildings', { quiet: true });
  if (!buildings) return;
  ha.buildings = buildings;
  const pad = '\u00a0\u00a0\u00a0\u00a0';
  const opt = (value, text) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(text)}</option>`;
  select.innerHTML = `<option value="">${buildings.length ? '— Choose a location —' : '— No locations yet (add buildings in Hotel architecture) —'}</option>`
    + buildings.map(b => `<optgroup label="${esc(b.name)} (${esc(b.code)})">
      ${opt(locationLabel(b), `${b.name} — whole building · ${b.code}`)}
      ${b.floors.map(f => opt(locationLabel(b, f), `${f.name} · ${f.code}`)
        + f.rooms.map(r => opt(locationLabel(b, f, r), `${pad}Room ${r.number} · ${r.code}`)).join('')).join('')}
    </optgroup>`).join('');
  if (current && select.value !== current) {
    select.insertAdjacentHTML('beforeend', `<optgroup label="Saved earlier"><option value="${esc(current)}" selected>${esc(current)} (not in the architecture)</option></optgroup>`);
  }
}

// ---------------- Tables ----------------
function renderBuildingFilters() {
  const opts = sel => `<option value="">All buildings</option>` + ha.buildings.map(b =>
    `<option value="${b.id}" ${String(b.id) === sel ? 'selected' : ''}>${esc(b.code)} — ${esc(b.name)}</option>`).join('');
  document.getElementById('ha-floors-building').innerHTML = opts(ha.floorsBuilding);
  document.getElementById('ha-rooms-building').innerHTML = opts(ha.roomsBuilding);
}

function renderBuildingsTable() {
  document.querySelector('#ha-buildings-table tbody').innerHTML = ha.buildings.map(b => `
    <tr class="clickable" onclick="openBuildingModal(${b.id})">
      <td><span class="code-chip">${esc(b.code)}</span></td>
      <td><div class="cell-title">${esc(b.name)}</div>${b.shape_id ? '' : '<small class="muted">not on the site plan</small>'}</td>
      <td class="num">${b.floor_count}</td>
      <td class="num">${b.room_count}</td>
      <td class="hide-sm muted">${esc(perFloorSummary(b))}</td>${CHEVRON_CELL}
    </tr>`).join('') || `<tr><td colspan="6"><div class="empty-state small"><p>No buildings yet — ${canEditHotel() ? 'add one with <b>+ New building</b>, or draw it on the whiteboard.' : 'an administrator can add them.'}</p></div></td></tr>`;
}

function renderFloorsTable() {
  const floors = haFloors().filter(f => !ha.floorsBuilding || String(f.building.id) === ha.floorsBuilding);
  document.querySelector('#ha-floors-table tbody').innerHTML = floors.map(f => `
    <tr class="clickable" onclick="openFloorModal(${f.id})">
      <td><span class="code-chip">${esc(f.code)}</span></td>
      <td class="cell-title">${esc(f.name)}</td>
      <td class="hide-sm">${esc(f.building.name)}</td>
      <td class="num">${f.room_count}</td>${CHEVRON_CELL}
    </tr>`).join('') || `<tr><td colspan="5"><div class="empty-state small"><p>No floors yet.</p></div></td></tr>`;
}

function renderRoomsTable() {
  const q = ha.roomsSearch.toLowerCase();
  const rooms = haRooms().filter(r => (!ha.roomsBuilding || String(r.building.id) === ha.roomsBuilding)
    && (!q || `${r.code} ${r.number} ${r.floor.name} ${r.building.name}`.toLowerCase().includes(q)));
  document.querySelector('#ha-rooms-table tbody').innerHTML = rooms.slice(0, ROOMS_RENDER_LIMIT).map(r => `
    <tr class="clickable" onclick="openFloorModal(${r.floor.id})">
      <td><span class="code-chip">${esc(r.code)}</span></td>
      <td class="cell-title">${esc(r.number)}</td>
      <td>${esc(r.floor.name)} <small class="mono muted">${esc(r.floor.code)}</small></td>
      <td class="hide-sm">${esc(r.building.name)}</td>${CHEVRON_CELL}
    </tr>`).join('') || `<tr><td colspan="5"><div class="empty-state small"><p>${q ? 'No rooms match your search.' : 'No rooms yet.'}</p></div></td></tr>`;
  const more = document.getElementById('ha-rooms-more');
  more.hidden = rooms.length <= ROOMS_RENDER_LIMIT;
  more.textContent = `Showing the first ${ROOMS_RENDER_LIMIT} of ${rooms.length} rooms — search or pick a building to narrow it down.`;
}

document.getElementById('ha-floors-building').addEventListener('change', e => { ha.floorsBuilding = e.target.value; renderFloorsTable(); });
document.getElementById('ha-rooms-building').addEventListener('change', e => { ha.roomsBuilding = e.target.value; renderRoomsTable(); });
document.getElementById('ha-rooms-search').addEventListener('input', e => { ha.roomsSearch = e.target.value; renderRoomsTable(); });
document.getElementById('ha-print').addEventListener('click', () => openPdf('/api/hotel/pdf'));
document.getElementById('ha-open-board').addEventListener('click', openWhiteboard);
document.getElementById('ha-new-building').addEventListener('click', () => openNewBuildingModal());

// ---------------- Building form (new + edit share the floors editor) ----------------
// `draft` holds the floors being edited: [{name, room_count}], index 0 = floor 1. Saving sends
// the whole list; the server adds/removes floors and rooms to match.
let draft = null;

function buildingFormHtml(b, editable) {
  const dis = editable ? '' : 'disabled';
  return `
    <div class="form-grid two">
      <label class="field"><span>Building ID</span><input type="text" name="code" class="mono-input" value="${esc(b.code || '')}" ${dis} autocapitalize="characters" placeholder="e.g. A"><small>Floors and rooms take their IDs from it (A_2, A_2_204).</small></label>
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(b.name || '')}" ${dis} placeholder="e.g. Main tower"></label>
    </div>
    <div class="modal-section">
      <h3>Floors &amp; rooms</h3>
      ${editable ? `<div class="ha-quick">
        <label class="field"><span>Number of floors</span><input type="number" min="0" max="200" id="bf-floor-count" value="${draft.length}"></label>
        <label class="field"><span>Rooms per floor</span><input type="number" min="0" max="500" id="bf-per-floor" value="${draft.length ? draft[draft.length - 1].room_count : 10}"></label>
        <button type="button" class="btn-outline" id="bf-apply-all">Apply to every floor</button>
      </div>` : ''}
      <div class="mini-table"><table class="data-table"><thead><tr><th>Floor ID</th><th>Name</th><th class="num">Rooms</th><th class="num hide-sm">Room numbers</th>${b.id ? '<th></th>' : ''}</tr></thead>
        <tbody id="bf-floors"></tbody></table></div>
      <p class="muted" id="bf-total" style="margin-top:.5rem"></p>
    </div>`;
}

function renderFloorsEditor(b, editable) {
  const code = (modalEl('input[name=code]').value.trim().toUpperCase() || '?');
  const existing = b.floors || [];
  modalEl('#bf-floors').innerHTML = draft.map((f, i) => {
    const n = i + 1, saved = existing.find(x => x.number === n);
    const range = f.room_count ? `${n}01 – ${n}${String(f.room_count).padStart(2, '0')}` : '—';
    return `<tr>
      <td><span class="code-chip">${esc(code)}_${n}</span></td>
      <td>${editable ? `<input type="text" data-floor-name="${i}" value="${esc(f.name)}">` : esc(f.name)}</td>
      <td class="num">${editable ? `<input type="number" min="0" max="500" data-floor-rooms="${i}" value="${f.room_count}">` : f.room_count}</td>
      <td class="num hide-sm muted">${saved && saved.room_count === f.room_count && saved.rooms.length ? `${esc(saved.rooms[0].number)} – ${esc(saved.rooms[saved.rooms.length - 1].number)}` : range}</td>
      ${b.id ? `<td class="num">${saved ? `<button type="button" class="link-btn" data-open-floor="${saved.id}">Rooms →</button>` : '<small class="muted">new</small>'}</td>` : ''}
    </tr>`;
  }).join('') || `<tr><td colspan="5"><p class="muted" style="margin:.4rem 0">No floors.</p></td></tr>`;
  renderDraftTotal();
}
function renderDraftTotal() {
  const total = draft.reduce((s, f) => s + (f.room_count || 0), 0);
  modalEl('#bf-total').textContent = `${draft.length} floor${draft.length === 1 ? '' : 's'} · ${total} room${total === 1 ? '' : 's'} in total`;
}

function bindFloorsEditor(b) {
  const rerender = () => renderFloorsEditor(b, true);
  modalEl('input[name=code]').addEventListener('input', rerender);
  modalEl('#bf-floor-count').addEventListener('change', e => {
    const count = Math.max(0, Math.min(200, parseInt(e.target.value, 10) || 0));
    const perFloor = Math.max(0, parseInt(modalEl('#bf-per-floor').value, 10) || 0);
    while (draft.length < count) draft.push({ name: `Floor ${draft.length + 1}`, room_count: perFloor });
    draft.length = count;
    e.target.value = count;
    rerender();
  });
  modalEl('#bf-apply-all').addEventListener('click', () => {
    const perFloor = Math.max(0, Math.min(500, parseInt(modalEl('#bf-per-floor').value, 10) || 0));
    draft.forEach(f => { f.room_count = perFloor; });
    rerender();
  });
  modalEl('#bf-floors').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.floorName !== undefined) draft[+t.dataset.floorName].name = t.value.trim() || `Floor ${+t.dataset.floorName + 1}`;
    if (t.dataset.floorRooms !== undefined) {
      // Update in place rather than re-rendering, so Tab moves on to the next field normally.
      const i = +t.dataset.floorRooms, count = Math.max(0, Math.min(500, parseInt(t.value, 10) || 0));
      draft[i].room_count = count;
      t.value = count;
      t.closest('tr').children[3].textContent = count ? `${i + 1}01 – ${i + 1}${String(count).padStart(2, '0')}` : '—';
      renderDraftTotal();
    }
  });
  modalEl('#bf-floors').addEventListener('click', e => {
    const btn = e.target.closest('[data-open-floor]');
    if (btn) openFloorModal(+btn.dataset.openFloor);
  });
}

// What saving would delete -- floors and rooms beyond the new counts go, with their room numbers.
function removalSummary(b) {
  let floors = 0, rooms = 0;
  (b.floors || []).forEach(f => {
    const next = draft[f.number - 1];
    if (!next) { floors++; rooms += f.room_count; } else if (next.room_count < f.room_count) rooms += f.room_count - next.room_count;
  });
  return { floors, rooms };
}

async function openNewBuildingModal({ shapeId = null, name = '' } = {}) {
  const suggestion = await api('/api/hotel/next-code', { quiet: true });
  draft = [1, 2, 3].map(n => ({ name: `Floor ${n}`, room_count: 10 }));
  const b = { code: suggestion ? suggestion.code : '', name };
  openFormModal({
    title: 'New building', size: 'wide',
    sub: shapeId ? 'It will be linked to the shape you selected on the whiteboard.' : 'Floors and rooms are created for you — adjust any floor afterwards.',
    body: buildingFormHtml(b, true) + `<div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Cancel</button><button class="btn-primary" id="bf-create">Create building</button></div>`,
  });
  renderFloorsEditor(b, true);
  bindFloorsEditor(b);
  modalEl('#bf-create').addEventListener('click', async () => {
    const v = formValues();
    if (!v.name) return toast('Name is required.', 'error');
    const created = await api('/api/hotel/buildings', { method: 'POST', body: JSON.stringify({ code: v.code, name: v.name, floors: draft, shape_id: shapeId }) });
    if (!created) return;
    toast(`Created ${created.name} (${created.code}) — ${created.floor_count} floors, ${created.room_count} rooms.`, 'success');
    log(`hotel: created building ${created.code} "${created.name}"`);
    closeModal();
    await refreshHotel();
  });
}

async function openBuildingModal(buildingId) {
  if (!ha.buildings.length) await loadHotelTab();
  const b = haBuilding(buildingId);
  if (!b) return toast('That building no longer exists.', 'error');
  const editable = canEditHotel();
  draft = b.floors.map(f => ({ name: f.name, room_count: f.room_count }));
  setDetailModal('building', b.id, {
    title: `${esc(b.name)} <span class="code-chip">${esc(b.code)}</span>`, size: 'wide',
    sub: `${b.floor_count} floor${b.floor_count === 1 ? '' : 's'} · ${b.room_count} rooms · ${esc(perFloorSummary(b))}`,
    body: `
      <div class="kpi-row top">
        <div class="kpi"><b class="mono">${esc(b.code)}</b>Building ID</div>
        <div class="kpi"><b>${b.floor_count}</b>Floors</div>
        <div class="kpi"><b>${b.room_count}</b>Rooms</div>
        <div class="kpi"><b>${b.shape_id ? 'Yes' : 'No'}</b>On the site plan</div>
      </div>
      ${buildingFormHtml(b, editable)}
      <div class="modal-actions left">
        ${editable ? `<button class="btn-primary" id="bf-save">${icon('check', 14)} Save changes</button>` : ''}
        <button class="btn-outline" id="bf-board">${b.shape_id ? 'Show on whiteboard' : (editable ? 'Place on whiteboard' : 'Open whiteboard')}</button>
        ${editable ? `<button class="btn-danger-outline" id="bf-delete">${icon('trash', 14)} Delete building</button>` : ''}
      </div>`,
  });
  renderFloorsEditor(b, editable);
  if (editable) bindFloorsEditor(b);
  else modalEl('#bf-floors').addEventListener('click', e => { const btn = e.target.closest('[data-open-floor]'); if (btn) openFloorModal(+btn.dataset.openFloor); });

  modalEl('#bf-board').addEventListener('click', async () => {
    closeModal();
    await openWhiteboard();
    if (!b.shape_id && editable) await placeBuilding(b.id);
    else if (b.shape_id) selectShape(b.shape_id, true);
  });
  if (!editable) return;
  modalEl('#bf-save').addEventListener('click', async () => {
    const v = formValues();
    if (!v.name) return toast('Name is required.', 'error');
    const { floors, rooms } = removalSummary(b);
    if ((floors || rooms) && !confirm(`Saving removes ${floors ? `${floors} floor${floors === 1 ? '' : 's'} and ` : ''}${rooms} room${rooms === 1 ? '' : 's'} (from the end of each floor). Continue?`)) return;
    const updated = await api(`/api/hotel/buildings/${b.id}`, { method: 'PUT', body: JSON.stringify({ code: v.code, name: v.name, floors: draft }) });
    if (!updated) return;
    toast(`Saved ${updated.name} — floors and rooms updated.`, 'success');
    log(`hotel: updated building ${updated.code} (${updated.floor_count} floors, ${updated.room_count} rooms)`);
    await refreshHotel();
    modalHistory.pop();
    openBuildingModal(b.id);
  });
  modalEl('#bf-delete').addEventListener('click', async () => {
    if (!confirm(`Delete ${b.name} (${b.code}) with its ${b.floor_count} floors and ${b.room_count} rooms? Its shape is removed from the site plan too. This can't be undone.`)) return;
    if (await api(`/api/hotel/buildings/${b.id}`, { method: 'DELETE' })) {
      toast(`Deleted ${b.name}.`, 'success');
      log(`hotel: deleted building ${b.code}`);
      closeModal();
      if (ha.selected && ha.board && !ha.board.shapes.some(s => s.id === ha.selected)) ha.selected = null;
      await refreshHotel();
    }
  });
}
registerModalOpener('building', openBuildingModal);

// ---------------- Floor modal: name, room count, door numbers ----------------
async function openFloorModal(floorId) {
  if (!ha.buildings.length) await loadHotelTab();
  const f = haFloors().find(x => x.id === floorId);
  if (!f) return toast('That floor no longer exists.', 'error');
  const editable = canEditHotel();
  setDetailModal('floor', f.id, {
    title: `${esc(f.name)} <span class="code-chip">${esc(f.code)}</span>`,
    sub: `${esc(f.building.name)} (${esc(f.building.code)}) · ${f.room_count} room${f.room_count === 1 ? '' : 's'}`,
    body: `
      ${editable ? `<div class="form-grid two">
        <label class="field"><span>Floor name</span><input type="text" name="name" value="${esc(f.name)}"></label>
        <label class="field"><span>Number of rooms</span><input type="number" min="0" max="500" name="room_count" value="${f.room_count}"><small>Rooms are added or removed at the end.</small></label>
      </div>
      <div class="modal-actions left"><button class="btn-primary" id="fl-save">${icon('check', 14)} Save floor</button><button class="btn-outline" id="fl-building">Open ${esc(f.building.name)}</button></div>` : `<div class="modal-actions left" style="margin-top:0"><button class="btn-outline" id="fl-building">Open ${esc(f.building.name)}</button></div>`}
      <div class="modal-section"><h3>Rooms (${f.room_count})${editable ? ' — edit a door number and press Enter' : ''}</h3>
        ${f.rooms.length ? `<div class="room-grid">${f.rooms.map(r => `
          <div class="room-card"><small class="mono" data-room-code="${r.id}">${esc(r.code)}</small>
            ${editable ? `<input type="text" value="${esc(r.number)}" data-room="${r.id}" data-prev="${esc(r.number)}" aria-label="Room number">` : `<b>${esc(r.number)}</b>`}</div>`).join('')}</div>`
          : '<p class="muted">No rooms on this floor.</p>'}
      </div>`,
  });
  modalEl('#fl-building').addEventListener('click', () => openBuildingModal(f.building.id));
  if (!editable) return;
  modalEl('#fl-save').addEventListener('click', async () => {
    const v = formValues();
    const count = parseInt(v.room_count, 10) || 0;
    if (count < f.room_count && !confirm(`This removes ${f.room_count - count} room(s) from the end of ${f.name}. Continue?`)) return;
    const updated = await api(`/api/hotel/floors/${f.id}`, { method: 'PUT', body: JSON.stringify({ name: v.name, room_count: count }) });
    if (!updated) return;
    toast(`Saved ${updated.name}.`, 'success');
    log(`hotel: updated floor ${updated.code} (${updated.room_count} rooms)`);
    await refreshHotel();
    modalHistory.pop();
    openFloorModal(f.id);
  });
  const saveRoom = async input => {
    const number = input.value.trim();
    if (number === input.dataset.prev) return;
    const room = await api(`/api/hotel/rooms/${input.dataset.room}`, { method: 'PUT', body: JSON.stringify({ number }) });
    if (!room) { input.value = input.dataset.prev; return; }
    input.dataset.prev = room.number;
    modalEl(`[data-room-code="${room.id}"]`).textContent = room.code;
    input.classList.add('saved'); setTimeout(() => input.classList.remove('saved'), 900);
    log(`hotel: room renumbered to ${room.code}`);
    const fresh = await api('/api/hotel/buildings', { quiet: true });
    if (fresh) { ha.buildings = fresh; renderRoomsTable(); renderBuildingsTable(); }
  };
  modalEl('.room-grid')?.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.room) { e.preventDefault(); e.target.blur(); } });
  modalEl('.room-grid')?.addEventListener('focusout', e => { if (e.target.dataset.room) saveRoom(e.target); });
}
registerModalOpener('floor', openFloorModal);

// =====================================================================================
// Whiteboard (site plan). Board units are 1600 x 1000; shapes are stored in those units and
// the SVG is scaled for zoom. Admins add / drag / resize / label / link shapes; everyone can
// click a building's shape to open it.
// =====================================================================================
const BOARD_W = 1600, BOARD_H = 1000, SNAP = 10;
const SHAPE_KINDS = [
  ['rect', 'Rectangle'], ['rounded', 'Rounded'], ['ellipse', 'Ellipse'],
  ['triangle', 'Triangle'], ['diamond', 'Diamond'], ['hexagon', 'Hexagon'],
];
const SHAPE_FILLS = ['#ede9fe', '#dbeafe', '#dcfce7', '#fef3c7', '#fee2e2', '#e0f2fe', '#fce7f3', '#f1f5f9'];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const wbSvg = document.getElementById('wb-svg');
const wbCanvas = document.getElementById('wb-canvas');
let wbDrag = null;

function svgNS(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

// Shape outline as SVG markup, in board units.
function shapeOutline(kind, x, y, w, h, extra = '') {
  const pts = p => `<polygon points="${p.map(([px, py]) => `${x + px * w},${y + py * h}`).join(' ')}" ${extra}/>`;
  switch (kind) {
    case 'rounded': return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w, h) * 0.15}" ${extra}/>`;
    case 'ellipse': return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${extra}/>`;
    case 'triangle': return pts([[0.5, 0], [1, 1], [0, 1]]);
    case 'diamond': return pts([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]);
    case 'hexagon': return pts([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]);
    default: return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${extra}/>`;
  }
}

function shapeLines(s) {
  const b = s.building_id && haBuilding(s.building_id);
  if (b) return [{ text: b.name, cls: 'wb-t-name' }, { text: b.code, cls: 'wb-t-code' }];
  return (s.text || '').split('\n').map(t => t.trim()).filter(Boolean).slice(0, 4).map((text, i) => ({ text, cls: i ? 'wb-t-sub' : 'wb-t-name' }));
}

function shapeTextSvg(s) {
  const lines = shapeLines(s);
  if (!lines.length) return '';
  // Usable box: triangles/diamonds/hexagons have less room than their bounding box.
  const inset = { triangle: [0.5, 0.45], diamond: [0.55, 0.55], hexagon: [0.8, 0.8], ellipse: [0.75, 0.75] }[s.kind] || [0.9, 0.85];
  const boxW = s.w * inset[0], boxH = s.h * inset[1];
  const longest = Math.max(...lines.map(l => l.text.length), 1);
  const size = Math.max(9, Math.min(30, boxH / (lines.length * 1.35), boxW / (longest * 0.58)));
  const maxChars = Math.max(3, Math.floor(boxW / (size * 0.56)));
  const cy = s.y + s.h * (s.kind === 'triangle' ? 0.66 : 0.5);
  const top = cy - ((lines.length - 1) * size * 1.25) / 2;
  return `<text class="wb-text" x="${s.x + s.w / 2}" text-anchor="middle" dominant-baseline="middle" style="font-size:${size}px">${lines.map((l, i) => {
    const t = l.text.length > maxChars ? l.text.slice(0, maxChars - 1) + '…' : l.text;
    return `<tspan class="${l.cls}" x="${s.x + s.w / 2}" y="${top + i * size * 1.25}">${esc(t)}</tspan>`;
  }).join('')}<title>${esc(lines.map(l => l.text).join(' / '))}</title></text>`;
}

function renderBoard() {
  if (!ha.board) return;
  wbSvg.setAttribute('viewBox', `0 0 ${BOARD_W} ${BOARD_H}`);
  wbSvg.setAttribute('width', Math.round(BOARD_W * ha.zoom));
  wbSvg.setAttribute('height', Math.round(BOARD_H * ha.zoom));
  document.getElementById('wb-zoom-label').textContent = `${Math.round(ha.zoom * 100)}%`;
  const shapes = [...ha.board.shapes].sort((a, b) => a.z - b.z || a.id - b.id);
  const sel = shapes.find(s => s.id === ha.selected);
  const hs = 9 / ha.zoom;  // handles stay the same size on screen
  wbSvg.innerHTML = `
    <defs><pattern id="wb-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#eceaf2" stroke-width="1"/></pattern>
      <pattern id="wb-grid-lg" width="100" height="100" patternUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#wb-grid)"/><path d="M100 0H0V100" fill="none" stroke="#dedbe8" stroke-width="1.2"/></pattern></defs>
    <rect class="wb-bg" x="0" y="0" width="${BOARD_W}" height="${BOARD_H}" fill="#fff"/>
    <rect class="wb-bg" x="0" y="0" width="${BOARD_W}" height="${BOARD_H}" fill="url(#wb-grid-lg)"/>
    ${shapes.map(s => `<g class="wb-shape ${s.building_id ? 'linked' : ''} ${s.id === ha.selected ? 'selected' : ''}" data-shape="${s.id}">
      ${shapeOutline(s.kind, s.x, s.y, s.w, s.h, `fill="${esc(s.fill)}" class="wb-outline" vector-effect="non-scaling-stroke"`)}
      ${shapeTextSvg(s)}</g>`).join('')}
    ${!shapes.length ? `<text x="${BOARD_W / 2}" y="${BOARD_H / 2}" text-anchor="middle" class="wb-empty">${canEditHotel() ? 'Empty site plan — use “+ Add shape” to draw your first building' : 'Nothing has been drawn on the site plan yet'}</text>` : ''}
    ${sel ? `<rect class="wb-sel-box" x="${sel.x}" y="${sel.y}" width="${sel.w}" height="${sel.h}" vector-effect="non-scaling-stroke"/>
      ${canEditHotel() ? HANDLES.map(hd => {
        const hx = sel.x + (hd.includes('e') ? sel.w : hd.includes('w') ? 0 : sel.w / 2);
        const hy = sel.y + (hd.includes('s') ? sel.h : hd.includes('n') ? 0 : sel.h / 2);
        return `<rect class="wb-handle h-${hd}" data-handle="${hd}" x="${hx - hs / 2}" y="${hy - hs / 2}" width="${hs}" height="${hs}" vector-effect="non-scaling-stroke"/>`;
      }).join('') : ''}` : ''}`;
}

function renderPanel() {
  const panel = document.getElementById('wb-panel');
  const s = ha.board && ha.board.shapes.find(x => x.id === ha.selected);
  const admin = canEditHotel();
  if (!s) {
    const placed = new Set(ha.board ? ha.board.shapes.map(x => x.building_id).filter(Boolean) : []);
    panel.innerHTML = `
      <h3>Buildings</h3>
      ${ha.buildings.map(b => `<div class="wb-bld ${placed.has(b.id) ? '' : 'unplaced'}">
        <span class="code-chip">${esc(b.code)}</span><div class="grow"><b>${esc(b.name)}</b><small>${b.floor_count} floors · ${b.room_count} rooms</small></div>
        ${placed.has(b.id) ? `<button class="link-btn" data-select-building="${b.id}">Show</button>`
          : admin ? `<button class="btn-outline btn-sm" data-place="${b.id}">Place</button>` : '<small class="muted">not drawn</small>'}
      </div>`).join('') || '<p class="muted">No buildings yet.</p>'}
      ${admin ? `<button class="btn-outline wb-full" id="wb-new-building">+ New building</button>` : ''}
      <div class="wb-tips"><b>Tips</b><ul>
        ${admin ? '<li><b>+ Add shape</b> draws a shape; link it to a building on the right, or keep it as a label (pool, parking, gate…).</li><li>Drag to move, pull the square handles to resize. Everything snaps to a 10-unit grid.</li><li>Delete key removes the selected shape (the building itself stays).</li>' : ''}
        <li>Click a building's shape to open its details.</li></ul></div>`;
    return;
  }
  const b = s.building_id && haBuilding(s.building_id);
  if (!admin) {
    panel.innerHTML = b ? `<h3>${esc(b.name)}</h3><p><span class="code-chip">${esc(b.code)}</span> ${b.floor_count} floors · ${b.room_count} rooms</p>
      <button class="btn-primary wb-full" data-open-building="${b.id}">Open building details</button>`
      : `<h3>Label</h3><p>${esc(s.text || '(no text)')}</p>`;
    panel.innerHTML += `<button class="link-btn" id="wb-deselect" style="margin-top:1rem">← All buildings</button>`;
    return;
  }
  panel.innerHTML = `
    <h3>${b ? esc(b.name) : 'Shape'}</h3>
    <label class="field"><span>Building</span><select id="wb-link">
      <option value="">— None (just a label) —</option>
      ${ha.buildings.map(x => `<option value="${x.id}" ${x.id === s.building_id ? 'selected' : ''}>${esc(x.code)} — ${esc(x.name)}${x.shape_id && x.shape_id !== s.id ? ' (moves here)' : ''}</option>`).join('')}
      <option value="new">+ Create a new building…</option>
    </select></label>
    ${b ? `<div class="wb-linked"><span>Shows <b>${esc(b.name)}</b> / <span class="mono">${esc(b.code)}</span></span>
        <button class="btn-primary wb-full" data-open-building="${b.id}">Open building details</button></div>`
      : `<label class="field"><span>Text inside</span><textarea id="wb-text" rows="3" placeholder="e.g. Pool">${esc(s.text)}</textarea><small>One line per row; the first is bold.</small></label>`}
    <p class="group-label">Shape</p>
    <div class="wb-kinds">${SHAPE_KINDS.map(([k, label]) => `<button type="button" class="${k === s.kind ? 'active' : ''}" data-kind="${k}" title="${label}">${kindIcon(k)}</button>`).join('')}</div>
    <p class="group-label">Colour</p>
    <div class="wb-fills">${SHAPE_FILLS.map(c => `<button type="button" class="${c === s.fill ? 'active' : ''}" data-fill="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('')}</div>
    <p class="group-label">Size &amp; position</p>
    <div class="wb-geom">${['x', 'y', 'w', 'h'].map(k => `<label><span>${k.toUpperCase()}</span><input type="number" step="10" data-geom="${k}" value="${Math.round(s[k])}"></label>`).join('')}</div>
    <div class="wb-row"><button class="btn-outline btn-sm" id="wb-front">Bring to front</button><button class="btn-danger-outline btn-sm" id="wb-delete">${icon('trash', 13)} Delete shape</button></div>
    <button class="link-btn" id="wb-deselect" style="margin-top:1rem">← All buildings</button>`;

  const text = document.getElementById('wb-text');
  if (text) {
    text.addEventListener('input', () => { s.text = text.value; renderBoard(); });
    text.addEventListener('change', () => saveShape(s, { text: s.text }));
  }
  document.getElementById('wb-link').addEventListener('change', async e => {
    if (e.target.value === 'new') {
      e.target.value = s.building_id || '';
      return openNewBuildingModal({ shapeId: s.id, name: (s.text || '').split('\n')[0].trim() });
    }
    const building_id = e.target.value ? +e.target.value : null;
    if (await saveShape(s, { building_id })) await refreshHotel();
  });
  document.getElementById('wb-front').addEventListener('click', () => {
    const z = Math.max(...ha.board.shapes.map(x => x.z)) + 1;
    s.z = z; renderBoard(); saveShape(s, { z });
  });
  document.getElementById('wb-delete').addEventListener('click', deleteSelectedShape);
  panel.querySelectorAll('[data-geom]').forEach(input => input.addEventListener('change', () => {
    const k = input.dataset.geom;
    let v = Math.round((parseFloat(input.value) || 0) / SNAP) * SNAP;
    if ((k === 'w' || k === 'h') && v < 20) v = 20;
    s[k] = v; input.value = v;
    renderBoard(); saveShape(s, { [k]: v });
  }));
}

function kindIcon(kind) {
  return `<svg width="22" height="18" viewBox="0 0 24 20">${shapeOutline(kind, 2, 2, 20, 16, 'fill="currentColor" fill-opacity=".15" stroke="currentColor" stroke-width="1.6"')}</svg>`;
}

document.getElementById('wb-panel').addEventListener('click', async e => {
  const t = e.target.closest('button');
  if (!t) return;
  const s = ha.board && ha.board.shapes.find(x => x.id === ha.selected);
  if (t.dataset.kind && s) { s.kind = t.dataset.kind; renderBoard(); renderPanel(); saveShape(s, { kind: s.kind }); }
  if (t.dataset.fill && s) { s.fill = t.dataset.fill; renderBoard(); renderPanel(); saveShape(s, { fill: s.fill }); }
  if (t.dataset.openBuilding) openBuildingModal(+t.dataset.openBuilding);
  if (t.dataset.place) placeBuilding(+t.dataset.place);
  if (t.dataset.selectBuilding) { const b = haBuilding(+t.dataset.selectBuilding); if (b && b.shape_id) selectShape(b.shape_id, true); }
  if (t.id === 'wb-deselect') selectShape(null);
  if (t.id === 'wb-new-building') openNewBuildingModal();
});

async function saveShape(s, fields) {
  const saved = await api(`/api/hotel/board/shapes/${s.id}`, { method: 'PUT', body: JSON.stringify(fields) });
  if (saved) Object.assign(s, saved);
  else await loadBoard();  // server refused -- snap back to what's stored
  return saved;
}

function selectShape(id, scrollIntoView = false) {
  ha.selected = id;
  renderBoard(); renderPanel();
  const s = id && ha.board.shapes.find(x => x.id === id);
  if (s && scrollIntoView) {
    wbCanvas.scrollTo({ left: (s.x + s.w / 2) * ha.zoom - wbCanvas.clientWidth / 2, top: (s.y + s.h / 2) * ha.zoom - wbCanvas.clientHeight / 2, behavior: 'smooth' });
  }
}

// Where a new shape goes: the free spot (not overlapping any shape, with a 20-unit gap)
// nearest the middle of what's currently visible; the middle itself if the board is full.
function freeSpot(w, h) {
  const cx = (wbCanvas.scrollLeft + wbCanvas.clientWidth / 2) / ha.zoom - w / 2;
  const cy = (wbCanvas.scrollTop + wbCanvas.clientHeight / 2) / ha.zoom - h / 2;
  const gap = 20, clampX = v => Math.min(Math.max(v, 0), BOARD_W - w), clampY = v => Math.min(Math.max(v, 0), BOARD_H - h);
  const free = (x, y) => ha.board.shapes.every(o => x + w + gap <= o.x || o.x + o.w + gap <= x || y + h + gap <= o.y || o.y + o.h + gap <= y);
  let best = null, bestDist = Infinity;
  for (let y = 20; y <= BOARD_H - h; y += 20) {
    for (let x = 20; x <= BOARD_W - w; x += 20) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestDist && free(x, y)) { best = { x, y }; bestDist = d; }
    }
  }
  const snap = v => Math.round(v / SNAP) * SNAP;
  return best || { x: snap(clampX(cx)), y: snap(clampY(cy)) };
}

async function addShape(kind, extra = {}) {
  const w = 220, h = kind === 'ellipse' || kind === 'hexagon' ? 160 : 140;
  const shape = await api('/api/hotel/board/shapes', { method: 'POST', body: JSON.stringify({
    kind, w, h, ...freeSpot(w, h), fill: SHAPE_FILLS[ha.board.shapes.length % SHAPE_FILLS.length], ...extra,
  }) });
  if (!shape) return null;
  ha.board.shapes.push(shape);
  log(`hotel: added a ${kind} to the site plan`);
  return shape;
}

async function placeBuilding(buildingId) {
  const shape = await addShape('rect', { building_id: buildingId });
  if (!shape) return;
  await refreshHotel();
  selectShape(shape.id, true);
}

async function deleteSelectedShape() {
  const s = ha.board.shapes.find(x => x.id === ha.selected);
  if (!s) return;
  const b = s.building_id && haBuilding(s.building_id);
  if (b && !confirm(`Remove ${b.name}'s shape from the site plan? The building, its floors and rooms stay.`)) return;
  if (!await api(`/api/hotel/board/shapes/${s.id}`, { method: 'DELETE' })) return;
  ha.board.shapes = ha.board.shapes.filter(x => x.id !== s.id);
  ha.selected = null;
  log('hotel: removed a shape from the site plan');
  if (b) await refreshHotel(); else { renderBoard(); renderPanel(); }
}

// ---- Pointer interaction: select, drag to move, handles to resize, click to open ----
function boardPoint(e) {
  const r = wbSvg.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * BOARD_W, y: (e.clientY - r.top) / r.height * BOARD_H };
}

wbSvg.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const handle = e.target.closest('[data-handle]');
  const g = e.target.closest('[data-shape]');
  const s = handle ? ha.board.shapes.find(x => x.id === ha.selected) : g && ha.board.shapes.find(x => x.id === +g.dataset.shape);
  if (!s) { if (ha.selected) selectShape(null); return; }
  e.preventDefault();
  const wasSelected = ha.selected === s.id;
  if (!wasSelected) selectShape(s.id);
  wbSvg.setPointerCapture(e.pointerId);
  wbDrag = { s, mode: handle ? handle.dataset.handle : 'move', start: boardPoint(e), orig: { x: s.x, y: s.y, w: s.w, h: s.h },
    screen: { x: e.clientX, y: e.clientY }, moved: false, pointerId: e.pointerId };
});

wbSvg.addEventListener('pointermove', e => {
  if (!wbDrag || e.pointerId !== wbDrag.pointerId) return;
  if (!wbDrag.moved && Math.hypot(e.clientX - wbDrag.screen.x, e.clientY - wbDrag.screen.y) < 4) return;
  if (!canEditHotel()) return;
  wbDrag.moved = true;
  const p = boardPoint(e), o = wbDrag.orig, s = wbDrag.s, mode = wbDrag.mode;
  const dx = p.x - wbDrag.start.x, dy = p.y - wbDrag.start.y;
  const snap = v => Math.round(v / SNAP) * SNAP;
  if (mode === 'move') {
    s.x = snap(Math.min(Math.max(o.x + dx, -o.w / 2), BOARD_W - o.w / 2));
    s.y = snap(Math.min(Math.max(o.y + dy, -o.h / 2), BOARD_H - o.h / 2));
  } else {
    let { x, y, w, h } = o;
    if (mode.includes('e')) w = Math.max(20, snap(o.w + dx));
    if (mode.includes('s')) h = Math.max(20, snap(o.h + dy));
    if (mode.includes('w')) { const nx = Math.min(snap(o.x + dx), o.x + o.w - 20); w = o.x + o.w - nx; x = nx; }
    if (mode.includes('n')) { const ny = Math.min(snap(o.y + dy), o.y + o.h - 20); h = o.y + o.h - ny; y = ny; }
    Object.assign(s, { x, y, w, h });
  }
  renderBoard();
});

function endDrag(e) {
  if (!wbDrag || e.pointerId !== wbDrag.pointerId) return;
  const { s, moved, orig } = wbDrag;
  wbDrag = null;
  if (moved) {
    renderPanel();
    if (s.x !== orig.x || s.y !== orig.y || s.w !== orig.w || s.h !== orig.h) saveShape(s, { x: s.x, y: s.y, w: s.w, h: s.h });
  } else if (e.type === 'pointerup' && s.building_id) {
    openBuildingModal(s.building_id);
  } else if (e.type === 'pointerup' && canEditHotel()) {
    document.getElementById('wb-text')?.focus();
  }
}
wbSvg.addEventListener('pointerup', endDrag);
wbSvg.addEventListener('pointercancel', endDrag);

// ---- Toolbar, zoom, open/close ----
document.getElementById('wb-add-menu').innerHTML = SHAPE_KINDS.map(([k, label]) =>
  `<button class="menu-item" data-add="${k}">${kindIcon(k)}${label}</button>`).join('');
bindDropdown('wb-add-btn', 'wb-add-menu');
document.getElementById('wb-add-menu').addEventListener('click', async e => {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  closeDropdowns();
  const shape = await addShape(btn.dataset.add, { text: 'New area' });
  if (!shape) return;
  selectShape(shape.id);
  const text = document.getElementById('wb-text');
  if (text) { text.focus(); text.select(); }
});

function setZoom(z, keepCenter = true) {
  const cx = (wbCanvas.scrollLeft + wbCanvas.clientWidth / 2) / ha.zoom;
  const cy = (wbCanvas.scrollTop + wbCanvas.clientHeight / 2) / ha.zoom;
  ha.zoom = Math.min(3, Math.max(0.2, z));
  renderBoard();
  if (keepCenter) wbCanvas.scrollTo(cx * ha.zoom - wbCanvas.clientWidth / 2, cy * ha.zoom - wbCanvas.clientHeight / 2);
}
function fitZoom() {
  const pad = 24;
  setZoom(Math.min((wbCanvas.clientWidth - pad) / BOARD_W, (wbCanvas.clientHeight - pad) / BOARD_H), false);
  wbCanvas.scrollTo(0, 0);
}
document.getElementById('wb-zoom-in').addEventListener('click', () => setZoom(ha.zoom * 1.25));
document.getElementById('wb-zoom-out').addEventListener('click', () => setZoom(ha.zoom / 1.25));
document.getElementById('wb-zoom-fit').addEventListener('click', fitZoom);
wbCanvas.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;  // plain wheel scrolls; ctrl/pinch zooms
  e.preventDefault();
  setZoom(ha.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

async function loadBoard() {
  const [board, buildings] = await Promise.all([api('/api/hotel/board'), api('/api/hotel/buildings', { quiet: true })]);
  if (!board) return;
  ha.board = board;
  if (buildings) ha.buildings = buildings;
  if (ha.selected && !board.shapes.some(s => s.id === ha.selected)) ha.selected = null;
  renderBoard(); renderPanel();
}

async function openWhiteboard() {
  const overlay = document.getElementById('wb-overlay');
  overlay.hidden = false;
  document.body.classList.add('wb-open');
  overlay.classList.toggle('readonly', !canEditHotel());
  document.getElementById('wb-hint').textContent = canEditHotel()
    ? 'Drag to move · handles resize · click a building to open it'
    : 'Click a building to open its details';
  await loadBoard();
  fitZoom();
}
function closeWhiteboard() {
  document.getElementById('wb-overlay').hidden = true;
  document.body.classList.remove('wb-open');
  ha.selected = null;
  loadHotelTab();
}
document.getElementById('wb-close').addEventListener('click', closeWhiteboard);
document.getElementById('wb-print').addEventListener('click', () => openPdf('/api/hotel/pdf'));

// Capture phase, so it runs before core.js's Escape handler closes the modal: Escape closes
// the modal first if one is open over the board, and the board only on the next press.
window.addEventListener('keydown', e => {
  if (document.getElementById('wb-overlay').hidden || document.getElementById('modal-overlay').classList.contains('open')) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === 'Escape' && !typing) { ha.selected ? selectShape(null) : closeWhiteboard(); e.stopPropagation(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && ha.selected && canEditHotel()) { e.preventDefault(); deleteSelectedShape(); }
}, true);
