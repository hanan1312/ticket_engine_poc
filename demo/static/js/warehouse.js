// Warehouse tab: Items | Purchase bills | Batches & barcodes | Work orders sub-tabs, plus
// the item / bill / work-order detail modals (edit, approve, receive a delivery, hand over
// to an employee, confirm receipt, PDFs and barcode labels).

const wh = { items: [], bills: [], batches: [], orders: [], users: null, billFilter: 'all', search: '' };

const BILL_STATUS = {
  demanded: ['open', 'Awaiting approval'], ordered: ['assigned', 'Approved'], delivered: ['resolved', 'Delivered'],
};
const WO_STATUS = {
  requested: ['open', 'Awaiting approval'], approved: ['assigned', 'Approved'],
  completed: ['in_progress', 'Issued'], rejected: ['rejected', 'Rejected'],
};
function woStatus(o) {
  if (o.status === 'completed' && o.delivery_confirmed_at) return ['resolved', 'Received'];
  if (o.status === 'completed') return ['in_progress', 'Awaiting receipt'];
  return WO_STATUS[o.status] || ['open', o.status];
}

async function whUsers() {
  if (!wh.users) wh.users = await api('/api/assignees', { quiet: true }) || [];
  return wh.users;
}
function userOptions(users, selectedId) {
  return users.map(u => `<option value="${u.id}" ${u.id === selectedId ? 'selected' : ''}>${esc(u.username)}${u.role === 'admin' ? ' (admin)' : ''}</option>`).join('');
}

async function loadWarehouseTab() {
  const [items, bills, batches, orders] = await Promise.all([
    api('/api/warehouse/items'), api('/api/warehouse/bills'),
    api('/api/warehouse/batches'), api('/api/warehouse/work-orders'),
  ]);
  wh.items = items || []; wh.bills = bills || []; wh.batches = batches || []; wh.orders = orders || [];
  const low = wh.items.filter(i => i.low_stock).length;
  setSubtabCount('wh-items', low, true);
  setSubtabCount('wh-bills', wh.bills.filter(b => b.status === 'demanded').length, isAdmin());
  setSubtabCount('wh-batches', wh.batches.filter(b => b.is_expired).length, true);
  setSubtabCount('wh-orders', wh.orders.filter(o => o.status === 'requested').length, isAdmin());
  renderWarehouseItems(); renderWarehouseBills(); renderWarehouseBatches(); renderWarehouseOrders();
  switchSubtab('wh', currentSubtab('wh'));
}
TAB_LOADERS.warehouse = loadWarehouseTab;

// ---------------- Items ----------------
function renderWarehouseItems() {
  const low = wh.items.filter(i => i.low_stock);
  const banner = document.getElementById('wh-low-banner');
  banner.hidden = !low.length;
  document.getElementById('wh-low-text').textContent =
    `${low.length} item${low.length === 1 ? ' is' : 's are'} below the critical stock level: ${low.slice(0, 4).map(i => i.name).join(', ')}${low.length > 4 ? '…' : ''}`;
  const q = wh.search.toLowerCase();
  const rows = wh.items.filter(i => !q || `${i.name} ${i.category} ${i.sku || ''}`.toLowerCase().includes(q));
  document.querySelector('#wh-items-table tbody').innerHTML = rows.map(i => {
    const pct = Math.min(100, Math.round(i.quantity / Math.max(i.critical_level * 2, 1) * 100));
    return `<tr class="clickable" onclick="openItemModal(${i.id})">
      <td><div class="cell-title">${esc(i.name)}</div><small class="mono muted">${esc(i.sku || '')}</small>${i.low_stock ? ' <span class="pill pill-danger">Low stock</span>' : ''}</td>
      <td><span class="tag">${esc(i.category)}</span></td>
      <td class="num"><div class="stock-cell"><b>${i.quantity}</b><div class="meter ${i.low_stock ? 'danger' : ''}"><span style="width:${pct}%"></span></div></div></td>
      <td class="num hide-sm">${i.critical_level}</td>
      <td class="hide-sm">${esc(i.unit || '')}</td>${CHEVRON_CELL}
    </tr>`;
  }).join('') || `<tr><td colspan="6"><div class="empty-state small"><p>${q ? 'No items match your search.' : 'No items yet — add your first one.'}</p></div></td></tr>`;
}
document.getElementById('wh-search').addEventListener('input', e => { wh.search = e.target.value; renderWarehouseItems(); });

function itemFormFields(i = {}) {
  return `
    <div class="form-grid two">
      <label class="field"><span>Name</span><input type="text" name="name" value="${esc(i.name || '')}" placeholder="e.g. Nitrile Gloves (Box)"></label>
      <label class="field"><span>SKU</span><input type="text" name="sku" class="mono-input" value="${esc(i.sku || '')}" placeholder="${i.id ? '' : 'Leave blank to auto-generate'}" autocapitalize="characters"><small>Printed on labels and delivery notes — typed to confirm receipt if a barcode won't scan.</small></label>
      <label class="field"><span>Category</span><input type="text" name="category" value="${esc(i.category || '')}" placeholder="e.g. PPE"></label>
      <label class="field"><span>Unit</span><input type="text" name="unit" value="${esc(i.unit || '')}" placeholder="e.g. box, piece, kg"></label>
      <label class="field"><span>Critical level</span><input type="number" min="0" name="critical_level" value="${i.critical_level ?? 5}"><small>"Low stock" is flagged below this quantity.</small></label>
    </div>`;
}

document.getElementById('wh-new-item').addEventListener('click', () => {
  openFormModal({
    title: 'New warehouse item', sub: 'Stock starts at 0 and only increases by receiving a bill.',
    body: itemFormFields() + `<div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Cancel</button><button class="btn-primary" id="md-item-create">Create item</button></div>`,
  });
  modalEl('#md-item-create').addEventListener('click', async () => {
    const v = formValues();
    if (!v.name) return toast('Name is required.', 'error');
    const item = await api('/api/warehouse/items', { method: 'POST', body: JSON.stringify({
      name: v.name, sku: v.sku, category: v.category || 'general', unit: v.unit || 'unit', critical_level: parseInt(v.critical_level, 10) || 0,
    }) });
    if (item) { toast(`Created "${item.name}"`, 'success'); log(`warehouse: created item "${item.name}"`); closeModal(); loadWarehouseTab(); }
  });
});

async function openItemModal(itemId) {
  if (!wh.items.length) await loadWarehouseTab();
  const i = wh.items.find(x => x.id === itemId);
  if (!i) return;
  const batches = wh.batches.filter(b => b.item_id === i.id);
  const bills = wh.bills.filter(b => b.item_id === i.id);
  const orders = wh.orders.filter(o => o.item_id === i.id);
  const activeBatches = batches.filter(b => b.status === 'active');
  const hasHistory = batches.length || bills.length || orders.length;
  setDetailModal('item', i.id, {
    title: esc(i.name),
    sub: `<span class="mono">${esc(i.sku || '')}</span> · ${esc(i.category)} · ${i.quantity} ${esc(i.unit || '')} in stock ${i.low_stock ? '<span class="pill pill-danger">Low stock</span>' : ''}`,
    body: `
      <div class="kpi-row top">
        <div class="kpi"><b>${i.quantity}</b>In stock</div>
        <div class="kpi"><b>${i.critical_level}</b>Critical level</div>
        <div class="kpi"><b>${activeBatches.length}</b>Active batches</div>
        <div class="kpi"><b>${bills.filter(b => b.status !== 'delivered').length}</b>Open bills</div>
        <div class="kpi"><b>${orders.filter(o => ['requested', 'approved'].includes(o.status)).length}</b>Open work orders</div>
      </div>
      <div class="modal-section"><h3>Details</h3>${itemFormFields(i)}
        <p class="muted" style="margin-top:.4rem">Quantity isn't editable — it only changes by receiving bills, issuing work orders or disposing expired batches, so it always matches the audit trail.</p>
        <div class="modal-actions left"><button class="btn-primary" id="md-item-save">${icon('check', 14)} Save changes</button>
          <button class="btn-outline" id="md-item-bill">${icon('file', 14)} New bill</button>
          <button class="btn-outline" id="md-item-wo">${icon('truck', 14)} New work order</button>
          ${hasHistory ? '' : `<button class="btn-danger-outline" id="md-item-delete">${icon('trash', 14)} Delete</button>`}</div>
      </div>
      <div class="modal-section"><h3>Batches (${batches.length})</h3>
        ${batches.length ? `<div class="mini-table"><table class="data-table"><thead><tr><th>Barcode</th><th>Expiry</th><th class="num">Remaining</th><th>Status</th></tr></thead><tbody>
          ${batches.map(b => `<tr><td class="mono">${esc(b.barcode)}</td><td>${fmtDate(b.expiry_date)} ${b.is_expired ? '<span class="pill pill-danger">Expired</span>' : ''}</td><td class="num">${b.quantity_remaining} / ${b.quantity_received}</td><td>${esc(b.status)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">No batches received yet.</p>'}
      </div>
      <div class="modal-section"><h3>Purchase bills (${bills.length})</h3>
        ${bills.map(b => `<div class="list-item" data-bill="${b.id}"><div class="li-main"><div class="li-title">${esc(b.order_id)}</div><div class="li-sub">${b.ordered_stock} ${esc(b.unit || '')} · by ${esc(b.created_by)} · ${fmtAgo(b.created_at)}</div></div>${statusBadge(BILL_STATUS[b.status])}${ARROW}</div>`).join('') || '<p class="muted">No bills yet.</p>'}
      </div>`,
  });
  modalEl('#md-item-save').addEventListener('click', async () => {
    const v = formValues();
    const updated = await api(`/api/warehouse/items/${i.id}`, { method: 'PUT', body: JSON.stringify({
      name: v.name, sku: v.sku, category: v.category, unit: v.unit, critical_level: v.critical_level,
    }) });
    if (updated) { toast('Item saved.', 'success'); log(`warehouse: edited item "${updated.name}"`); await loadWarehouseTab(); openItemModal(i.id); }
  });
  modalEl('#md-item-bill').addEventListener('click', () => openNewBillModal(i.id));
  modalEl('#md-item-wo').addEventListener('click', () => openNewWorkOrderModal(i.id));
  const del = modalEl('#md-item-delete');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`Delete "${i.name}"? This can't be undone.`)) return;
    if (await api(`/api/warehouse/items/${i.id}`, { method: 'DELETE' })) { toast('Item deleted.', 'success'); closeModal(); loadWarehouseTab(); }
  });
  document.querySelectorAll('#modal-body [data-bill]').forEach(el => el.addEventListener('click', () => openBillModal(Number(el.dataset.bill))));
}
registerModalOpener('item', openItemModal);

// ---------------- Bills ----------------
function renderWarehouseBills() {
  const rows = wh.bills.filter(b => wh.billFilter === 'all' || b.status === wh.billFilter);
  document.querySelectorAll('#wh-bill-filters button').forEach(b => b.classList.toggle('active', b.dataset.filter === wh.billFilter));
  document.querySelector('#wh-bills-table tbody').innerHTML = rows.map(b => `
    <tr class="clickable" onclick="openBillModal(${b.id})">
      <td><div class="cell-title mono">${esc(b.group_ref || b.order_id)}</div>${b.group_ref ? `<small class="muted">line ${esc(b.order_id.split('-').pop())}</small>` : ''}</td>
      <td>${esc(b.item_name)}</td>
      <td class="num">${b.ordered_stock} <small class="muted">${esc(b.unit || '')}</small></td>
      <td class="num hide-sm">${b.total_price.toFixed(2)}</td>
      <td>${statusBadge(BILL_STATUS[b.status])}${b.status === 'delivered' && !b.received ? ' <span class="pill pill-warn">Not received</span>' : ''}</td>
      <td class="hide-sm muted">${esc(b.created_by)} · ${fmtAgo(b.created_at)}</td>${CHEVRON_CELL}
    </tr>`).join('') || `<tr><td colspan="7"><div class="empty-state small"><p>No bills ${wh.billFilter === 'all' ? 'yet' : 'with this status'}.</p></div></td></tr>`;
}
document.getElementById('wh-bill-filters').addEventListener('click', e => {
  const btn = e.target.closest('button[data-filter]');
  if (btn) { wh.billFilter = btn.dataset.filter; renderWarehouseBills(); }
});

function openNewBillModal(presetItemId) {
  if (!wh.items.length) return toast('Add a warehouse item first.', 'error');
  openFormModal({
    keepHistory: !!presetItemId,
    title: 'New purchase bill', sub: 'The bill waits for an admin to approve it before it can be ordered and received.',
    body: `
      <div class="form-grid two">
        <label class="field span-2"><span>Item</span><select name="item_id">${wh.items.map(i => `<option value="${i.id}" ${i.id === presetItemId ? 'selected' : ''}>${esc(i.name)} (${i.quantity} ${esc(i.unit || '')} in stock)</option>`).join('')}</select></label>
        <label class="field"><span>Quantity</span><input type="number" min="1" name="ordered_stock" value="10"></label>
        <label class="field"><span>Price per unit</span><input type="number" min="0" step="0.01" name="price_per_unit" value="0"></label>
        <label class="field span-2"><span>Note (optional)</span><input type="text" name="note" placeholder="Supplier, urgency…"></label>
      </div>
      <div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Cancel</button><button class="btn-primary" id="md-bill-create">Submit for approval</button></div>`,
  });
  modalEl('#md-bill-create').addEventListener('click', async () => {
    const v = formValues();
    const bill = await api('/api/warehouse/bills', { method: 'POST', body: JSON.stringify({
      item_id: parseInt(v.item_id, 10), ordered_stock: parseInt(v.ordered_stock, 10), price_per_unit: parseFloat(v.price_per_unit) || 0, note: v.note,
    }) });
    if (bill) {
      toast(`Bill ${bill.order_id} sent for admin approval.`, 'success');
      log(`warehouse: created bill ${bill.order_id}`);
      await loadWarehouseTab(); switchSubtab('wh', 'wh-bills'); openBillModal(bill.id);
    }
  });
}
document.getElementById('wh-new-bill').addEventListener('click', () => openNewBillModal());

function openLowStockBillModal() {
  const low = wh.items.filter(i => i.low_stock);
  if (!low.length) return toast('Nothing is below its critical level right now.', 'info');
  openFormModal({
    size: 'wide',
    title: `${icon('alert', 18)} New bill for low-stock items`,
    sub: 'Tick the items to reorder. They go out as one purchase order that waits for admin approval.',
    body: `
      <div class="table-scroll"><table class="data-table select-table" id="ls-table">
        <thead><tr><th class="check"><input type="checkbox" id="ls-all" checked aria-label="Select all"></th><th>Item</th><th class="num">In stock</th><th class="num">Critical</th><th class="num">Order qty</th><th class="num">Unit price</th><th class="num">Line total</th></tr></thead>
        <tbody>${low.map(i => {
          const suggested = Math.max(i.critical_level * 2 - i.quantity, 1);
          return `<tr data-id="${i.id}">
            <td class="check"><input type="checkbox" class="ls-check" checked></td>
            <td><div class="cell-title">${esc(i.name)}</div><small class="muted">${esc(i.category)}</small></td>
            <td class="num danger-text">${i.quantity} ${esc(i.unit || '')}</td><td class="num">${i.critical_level}</td>
            <td class="num"><input type="number" class="ls-qty" min="1" value="${suggested}"></td>
            <td class="num"><input type="number" class="ls-price" min="0" step="0.01" value="0"></td>
            <td class="num ls-total">0.00</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      <label class="field" style="margin-top:.8rem"><span>Note (optional)</span><input type="text" name="note" placeholder="Supplier, urgency…"></label>
      <div class="modal-actions"><span class="muted grow" id="ls-summary"></span><button class="btn-outline" onclick="closeModal()">Cancel</button><button class="btn-primary" id="ls-create">Create bill</button></div>`,
  });
  const table = modalEl('#ls-table');
  const recalc = () => {
    let count = 0, total = 0;
    table.querySelectorAll('tbody tr').forEach(tr => {
      const on = tr.querySelector('.ls-check').checked;
      const line = (parseFloat(tr.querySelector('.ls-qty').value) || 0) * (parseFloat(tr.querySelector('.ls-price').value) || 0);
      tr.querySelector('.ls-total').textContent = line.toFixed(2);
      tr.classList.toggle('dim', !on);
      if (on) { count++; total += line; }
    });
    const all = table.querySelectorAll('.ls-check');
    const checked = [...all].filter(c => c.checked).length;
    const master = modalEl('#ls-all');
    master.checked = checked === all.length;
    master.indeterminate = checked > 0 && checked < all.length;
    modalEl('#ls-summary').textContent = `${count} of ${all.length} selected · total ${total.toFixed(2)}`;
    modalEl('#ls-create').textContent = count ? `Create bill (${count} item${count === 1 ? '' : 's'})` : 'Select items';
    modalEl('#ls-create').disabled = !count;
  };
  modalEl('#ls-all').addEventListener('change', e => { table.querySelectorAll('.ls-check').forEach(c => { c.checked = e.target.checked; }); recalc(); });
  table.addEventListener('input', recalc);
  recalc();
  modalEl('#ls-create').addEventListener('click', async () => {
    const lines = [...table.querySelectorAll('tbody tr')].filter(tr => tr.querySelector('.ls-check').checked).map(tr => ({
      item_id: Number(tr.dataset.id), ordered_stock: parseInt(tr.querySelector('.ls-qty').value, 10),
      price_per_unit: parseFloat(tr.querySelector('.ls-price').value) || 0,
    }));
    const result = await api('/api/warehouse/bills/bulk', { method: 'POST', body: JSON.stringify({ lines, note: formValues().note }) });
    if (result) {
      toast(`Purchase order ${result.group_ref} (${result.bills.length} items) sent for admin approval.`, 'success');
      log(`warehouse: created purchase order ${result.group_ref}`);
      await loadWarehouseTab(); switchSubtab('wh', 'wh-bills'); openBillModal(result.bills[0].id);
    }
  });
}
document.getElementById('wh-low-bill').addEventListener('click', openLowStockBillModal);
document.getElementById('wh-low-bill-2').addEventListener('click', openLowStockBillModal);

function progressSteps(steps) {
  // steps: [{label, done, current, time, who}]
  return `<div class="stepper">${steps.map((s, i) => `
    <div class="step ${s.rejected ? 'rejected' : s.done ? 'done' : s.current ? 'current' : ''}">
      <div class="step-dot">${s.rejected ? '✕' : s.done ? '✓' : i + 1}</div>
      <div class="step-label">${s.label}</div>
      <div class="step-time">${s.time || ''}${s.who ? `<br>${esc(s.who)}` : ''}</div>
    </div>`).join('')}</div>`;
}

async function openBillModal(billId) {
  const b = await api(`/api/warehouse/bills/${billId}`);
  if (!b) return;
  const group = b.group_ref ? (wh.bills.length ? wh.bills : await api('/api/warehouse/bills') || []).filter(x => x.group_ref === b.group_ref) : [b];
  const canReceive = (b.status === 'ordered' || b.status === 'delivered') && !b.received;
  setDetailModal('bill', b.id, {
    title: `${esc(b.item_name)} <span class="muted-title">· ${b.ordered_stock} ${esc(b.unit || '')}</span>`,
    sub: `<span class="mono">${esc(b.order_id)}</span> · ${statusBadge(BILL_STATUS[b.status])}`,
    body: `
      <div class="modal-section">
        ${progressSteps([
          { label: 'Requested', done: true, time: fmtTs(b.created_at), who: b.created_by },
          { label: 'Approved', done: !!b.approved_at, current: b.status === 'demanded', time: fmtTs(b.approved_at), who: b.approved_by },
          { label: 'Delivered', done: !!b.delivered_on, current: b.status === 'ordered', time: b.delivered_on ? fmtDate(b.delivered_on) : '', who: b.accepted_by },
          { label: 'In stock', done: b.received, current: b.status === 'delivered' && !b.received, time: b.batch ? fmtTs(b.batch.received_at) : '' },
        ])}
      </div>
      <div class="modal-section"><h3>Details</h3>
        <div class="meta-grid">
          <div><div class="meta-k">Quantity</div><div class="meta-v">${b.ordered_stock} ${esc(b.unit || '')}</div></div>
          <div><div class="meta-k">Price / unit</div><div class="meta-v">${(b.price_per_unit || 0).toFixed(2)}</div></div>
          <div><div class="meta-k">Total</div><div class="meta-v">${b.total_price.toFixed(2)}</div></div>
          <div><div class="meta-k">Requested by</div><div class="meta-v">${esc(b.created_by)}</div></div>
          <div><div class="meta-k">Approved by</div><div class="meta-v">${esc(b.approved_by || '—')}</div></div>
          <div><div class="meta-k">Accepted by</div><div class="meta-v">${esc(b.accepted_by || '—')}</div></div>
        </div>
        ${b.note ? `<div class="desc-box">${esc(b.note)}</div>` : ''}
        ${group.length > 1 ? `<p class="muted" style="margin-top:.8rem">Part of purchase order <b class="mono">${esc(b.group_ref)}</b> with ${group.length} lines: ${group.map(g => g.id === b.id ? `<b>${esc(g.item_name)}</b>` : `<button class="link-btn" data-bill="${g.id}">${esc(g.item_name)}</button>`).join(', ')}</p>` : ''}
      </div>
      ${b.batch ? `
      <div class="modal-section"><h3>Received batch</h3>
        <div class="batch-card">
          <div><div class="meta-k">Barcode</div><div class="meta-v mono">${esc(b.batch.barcode)}</div></div>
          <div><div class="meta-k">Quantity</div><div class="meta-v">${b.batch.quantity_received}</div></div>
          <div><div class="meta-k">Expiry</div><div class="meta-v">${fmtDate(b.batch.expiry_date)}</div></div>
          <button class="btn-outline btn-sm" id="md-bill-labels">${icon('printer', 14)} Print barcodes</button>
        </div>
      </div>` : ''}
      <div class="modal-section" id="md-bill-receive-slot"></div>
      <div class="modal-actions">
        <button class="btn-outline" id="md-bill-pdf">${icon('file', 14)} ${group.length > 1 ? 'Purchase order PDF' : 'Bill PDF'}</button>
        ${b.status === 'demanded' && isAdmin() ? `<button class="btn-primary" id="md-bill-approve">${icon('check', 14)} Approve bill</button>` : ''}
        ${b.status === 'demanded' && !isAdmin() ? '<span class="muted">Waiting for an admin to approve.</span>' : ''}
        ${canReceive ? `<button class="btn-primary" id="md-bill-receive">${icon('truck', 14)} Receive delivery</button>` : ''}
      </div>`,
  });
  modalEl('#md-bill-pdf').addEventListener('click', () => openPdf(`/api/warehouse/bills/${b.id}/pdf`));
  document.querySelectorAll('#modal-body [data-bill]').forEach(el => el.addEventListener('click', () => openBillModal(Number(el.dataset.bill))));
  const approve = modalEl('#md-bill-approve');
  if (approve) approve.addEventListener('click', async () => {
    if (await api(`/api/warehouse/bills/${b.id}/status`, { method: 'PUT', body: JSON.stringify({ status: 'ordered' }) })) {
      toast(`Bill ${b.order_id} approved.`, 'success'); log(`warehouse: approved bill ${b.order_id}`);
      await loadWarehouseTab(); openBillModal(b.id);
    }
  });
  const labels = modalEl('#md-bill-labels');
  if (labels) labels.addEventListener('click', () => openBarcodePrintDialog(
    [{ code: b.batch.barcode, title: b.item_name, subtitle: labelSubtitle(b.batch) }],
    { copies: b.batch.quantity_received, backTo: ['bill', b.id] }));
  const receive = modalEl('#md-bill-receive');
  if (receive) receive.addEventListener('click', () => showReceiveForm(b));
}
registerModalOpener('bill', openBillModal);

async function showReceiveForm(b) {
  const users = await whUsers();
  const slot = modalEl('#md-bill-receive-slot');
  slot.innerHTML = `
    <h3>Receive delivery</h3>
    <div class="action-box">
      <div class="form-grid two">
        <label class="field"><span>Delivery date</span><input type="date" name="delivered_on" value="${todayISO()}" max="${todayISO()}"></label>
        <label class="field"><span>Accepted by</span><select name="accepted_by_user_id">${userOptions(users, currentUser.id)}</select></label>
        <label class="field"><span>Quantity received</span><input type="number" min="1" name="quantity_received" value="${b.ordered_stock}"></label>
        <label class="field"><span>Expiry date</span><input type="date" name="expiry_date" value="${todayISO(365)}"></label>
      </div>
      <p class="muted">Receiving adds the quantity to stock and mints a new batch barcode you can print straight away.</p>
      <div class="modal-actions left"><button class="btn-primary" id="md-receive-confirm">${icon('check', 14)} Add to stock</button></div>
    </div>`;
  slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  modalEl('#md-bill-receive').hidden = true;
  modalEl('#md-receive-confirm').addEventListener('click', async () => {
    const v = formValues(slot);
    const batch = await api(`/api/warehouse/bills/${b.id}/receive`, { method: 'POST', body: JSON.stringify({
      delivered_on: v.delivered_on, expiry_date: v.expiry_date,
      quantity_received: parseInt(v.quantity_received, 10), accepted_by_user_id: parseInt(v.accepted_by_user_id, 10),
    }) });
    if (batch) {
      toast(`${batch.quantity_received} × ${batch.item_name} added to stock — barcode ${batch.barcode}`, 'success');
      log(`warehouse: received bill ${b.order_id} -> batch ${batch.barcode}`);
      await loadWarehouseTab();
      openBarcodePrintDialog([{ code: batch.barcode, title: batch.item_name, subtitle: labelSubtitle(batch) }],
        { copies: batch.quantity_received, backTo: ['bill', b.id] });
    }
  });
}

// ---------------- Batches ----------------
function renderWarehouseBatches() {
  document.querySelector('#wh-batches-table tbody').innerHTML = wh.batches.map(b => `
    <tr class="clickable" data-batch="${b.id}">
      <td class="check"><input type="checkbox" class="batch-check" value="${b.id}" aria-label="Select ${esc(b.barcode)}"></td>
      <td class="mono">${esc(b.barcode)}</td>
      <td>${esc(b.item_name)}</td>
      <td>${fmtDate(b.expiry_date)} ${b.is_expired ? '<span class="pill pill-danger">Expired</span>' : ''}</td>
      <td class="num">${b.quantity_remaining} / ${b.quantity_received}</td>
      <td class="hide-sm">${statusBadge(b.status === 'active' ? ['resolved', 'Active'] : b.status === 'exhausted' ? ['open', 'Used up'] : ['rejected', 'Disposed'])}</td>
      <td class="hide-sm muted">${esc(b.received_by || '')}${b.received_at ? ' · ' + fmtAgo(b.received_at) : ''}</td>
      <td class="row-actions">
        <button class="icon-btn sm" title="Print label" data-print="${b.id}">${icon('printer', 15)}</button>
        ${b.is_expired && isAdmin() ? `<button class="btn-danger-outline btn-sm" data-dispose="${b.id}">Dispose</button>` : ''}
      </td>
    </tr>`).join('') || `<tr><td colspan="8"><div class="empty-state small"><p>No batches yet — receive a delivered bill to create one.</p></div></td></tr>`;
  updateBatchSelection();
}
function labelSubtitle(batch) { return [batch.item_sku && `SKU ${batch.item_sku}`, `Exp ${batch.expiry_date}`].filter(Boolean).join(' · '); }
function batchLabel(b) { return { code: b.barcode, title: b.item_name, subtitle: labelSubtitle(b) }; }
function updateBatchSelection() {
  const checks = [...document.querySelectorAll('.batch-check')];
  const selected = checks.filter(c => c.checked).length;
  const btn = document.getElementById('wh-print-selected');
  btn.disabled = !selected;
  btn.innerHTML = `${icon('printer', 14)} Print ${selected ? selected + ' ' : ''}barcode${selected === 1 ? '' : 's'}`;
  const all = document.getElementById('wh-batches-all');
  all.checked = checks.length > 0 && selected === checks.length;
  all.indeterminate = selected > 0 && selected < checks.length;
}
document.getElementById('wh-batches-table').addEventListener('click', async e => {
  const printBtn = e.target.closest('[data-print]');
  const disposeBtn = e.target.closest('[data-dispose]');
  if (printBtn) return openBarcodePrintDialog([batchLabel(wh.batches.find(b => b.id === Number(printBtn.dataset.print)))]);
  if (disposeBtn) {
    const reason = prompt('Reason for disposing this expired batch:');
    if (!reason) return;
    const res = await api(`/api/warehouse/batches/${disposeBtn.dataset.dispose}/dispose`, { method: 'POST', body: JSON.stringify({ reason }) });
    if (res) { toast(`Disposed ${res.disposed_quantity} unit(s).`, 'success'); loadWarehouseTab(); }
    return;
  }
  const row = e.target.closest('tr[data-batch]');
  if (row && !e.target.matches('input')) { const c = row.querySelector('.batch-check'); c.checked = !c.checked; }
  updateBatchSelection();
});
document.getElementById('wh-batches-all').addEventListener('change', e => {
  document.querySelectorAll('.batch-check').forEach(c => { c.checked = e.target.checked; });
  updateBatchSelection();
});
document.getElementById('wh-print-selected').addEventListener('click', () => {
  const ids = [...document.querySelectorAll('.batch-check:checked')].map(c => Number(c.value));
  openBarcodePrintDialog(wh.batches.filter(b => ids.includes(b.id)).map(batchLabel));
});

// ---------------- Work orders ----------------
function renderWarehouseOrders() {
  document.querySelector('#wh-orders-table tbody').innerHTML = wh.orders.map(o => {
    const pct = Math.round(o.quantity_fulfilled / o.quantity * 100);
    return `<tr class="clickable" onclick="openWorkOrderModal(${o.id})">
      <td class="mono">#${o.id}</td>
      <td><div class="cell-title">${esc(o.item_name)}</div><small class="muted">by ${esc(o.requested_by)} · ${fmtAgo(o.created_at)}</small></td>
      <td class="num"><div class="stock-cell"><b>${o.quantity_fulfilled}/${o.quantity}</b><div class="meter ${pct === 100 ? 'ok' : ''}"><span style="width:${pct}%"></span></div></div></td>
      <td class="hide-sm">${o.deliver_to ? `${icon('user', 13)} ${esc(o.deliver_to)}` : '<span class="muted">—</span>'}</td>
      <td class="hide-sm">${o.delivery_date ? fmtDate(o.delivery_date) : '<span class="muted">—</span>'}</td>
      <td>${statusBadge(woStatus(o))}</td>${CHEVRON_CELL}
    </tr>`;
  }).join('') || `<tr><td colspan="7"><div class="empty-state small"><p>No work orders yet.</p></div></td></tr>`;
}

function openNewWorkOrderModal(presetItemId) {
  if (!wh.items.length) return toast('Add a warehouse item first.', 'error');
  openFormModal({
    keepHistory: !!presetItemId,
    title: 'New work order', sub: 'Request stock to be issued. An admin approves it and names who receives the items.',
    body: `
      <div class="form-grid two">
        <label class="field span-2"><span>Item</span><select name="item_id">${wh.items.map(i => `<option value="${i.id}" ${i.id === presetItemId ? 'selected' : ''}>${esc(i.name)} (${i.quantity} ${esc(i.unit || '')} in stock)</option>`).join('')}</select></label>
        <label class="field"><span>Quantity</span><input type="number" min="1" name="quantity" value="1"></label>
        <label class="field"><span>Purpose / note</span><input type="text" name="note" placeholder="e.g. Room 204 HVAC service"></label>
      </div>
      <div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Cancel</button><button class="btn-primary" id="md-wo-create">Submit for approval</button></div>`,
  });
  modalEl('#md-wo-create').addEventListener('click', async () => {
    const v = formValues();
    const order = await api('/api/warehouse/work-orders', { method: 'POST', body: JSON.stringify({
      item_id: parseInt(v.item_id, 10), quantity: parseInt(v.quantity, 10) || 1, note: v.note,
    }) });
    if (order) {
      toast(`Work order #${order.id} sent for approval.`, 'success'); log(`warehouse: requested work order #${order.id}`);
      await loadWarehouseTab(); switchSubtab('wh', 'wh-orders'); openWorkOrderModal(order.id);
    }
  });
}
document.getElementById('wh-new-wo').addEventListener('click', () => openNewWorkOrderModal());

async function scanIntoWorkOrder(orderId, barcode) {
  const result = await api(`/api/warehouse/work-orders/${orderId}/scan`, { method: 'POST', body: JSON.stringify({ barcode }) });
  if (result) {
    toast(`${result.item_name}: ${result.line_fulfilled}/${result.line_requested} issued${result.line_complete ? ' — complete' : ''}`, 'success');
    log(`warehouse scan: ${result.item_name} ${result.line_fulfilled}/${result.line_requested}${result.line_complete ? ' (complete)' : ''}`);
  }
  return result;
}

// Tab-level scan box: finds the oldest approved work order for the scanned batch's item.
const whScanInput = document.getElementById('wh-scan-input');
whScanInput.addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  const barcode = whScanInput.value.trim();
  whScanInput.value = '';
  if (!barcode) return;
  const batch = await api(`/api/warehouse/batches/barcode/${encodeURIComponent(barcode)}`);
  if (batch) {
    const order = wh.orders.filter(o => o.status === 'approved' && o.item_id === batch.item_id).sort((a, b) => a.id - b.id)[0];
    if (!order) toast(`No approved work order is waiting for ${batch.item_name}.`, 'error');
    else if (await scanIntoWorkOrder(order.id, barcode)) await loadWarehouseTab();
  }
  whScanInput.focus();
});

async function openWorkOrderModal(orderId) {
  const o = await api(`/api/warehouse/work-orders/${orderId}`);
  if (!o) return;
  const warehouseStaff = hasPermission('warehouse');
  const isRecipient = currentUser && o.deliver_to_user_id === currentUser.id;
  const users = o.status === 'requested' && isAdmin() ? await whUsers() : [];
  const [cls, label] = woStatus(o);
  setDetailModal('work_order', o.id, {
    title: `Work order #${o.id} <span class="muted-title">· ${o.quantity} × ${esc(o.item_name)}</span>`,
    sub: `${statusBadge([cls, label])} · requested by ${esc(o.requested_by)} ${fmtAgo(o.created_at)}`,
    body: `
      <div class="modal-section">
        ${progressSteps([
          { label: 'Requested', done: true, time: fmtTs(o.created_at), who: o.requested_by },
          o.status === 'rejected'
            ? { label: 'Rejected', rejected: true, time: fmtTs(o.approved_at), who: o.approved_by }
            : { label: 'Approved', done: !!o.approved_at, current: o.status === 'requested', time: fmtTs(o.approved_at), who: o.approved_by },
          { label: 'Issued', done: o.status === 'completed', current: o.status === 'approved', time: `${o.quantity_fulfilled}/${o.quantity}` },
          { label: 'Received', done: !!o.delivery_confirmed_at, current: o.status === 'completed' && !o.delivery_confirmed_at, time: o.delivery_confirmed_at ? fmtTs(o.delivery_confirmed_at) : '', who: o.deliver_to },
        ])}
      </div>
      <div class="modal-section"><h3>Details</h3>
        <div class="meta-grid">
          <div><div class="meta-k">Item</div><div class="meta-v">${esc(o.item_name)}</div></div>
          <div><div class="meta-k">Quantity</div><div class="meta-v">${o.quantity} ${esc(o.unit || '')}</div></div>
          <div><div class="meta-k">Issued</div><div class="meta-v">${o.quantity_fulfilled} / ${o.quantity}</div></div>
          <div><div class="meta-k">Deliver to</div><div class="meta-v">${esc(o.deliver_to || '—')}</div></div>
          <div><div class="meta-k">Delivery date</div><div class="meta-v">${fmtDate(o.delivery_date)}</div></div>
          <div><div class="meta-k">Receipt confirmed</div><div class="meta-v">${o.delivery_confirmed_at ? fmtTs(o.delivery_confirmed_at) : '—'}</div></div>
        </div>
        ${o.note ? `<div class="desc-box">${esc(o.note)}</div>` : ''}
      </div>
      ${o.status === 'requested' && isAdmin() ? `
      <div class="modal-section"><h3>Approve &amp; schedule delivery</h3>
        <div class="action-box">
          <div class="form-grid two">
            <label class="field"><span>Deliver to employee</span><select name="deliver_to_user_id"><option value="">Choose…</option>${userOptions(users, null)}</select></label>
            <label class="field"><span>Delivery date</span><input type="date" name="delivery_date" min="${todayISO()}" value="${todayISO(1)}"></label>
          </div>
          <p class="muted">The employee and the admins are notified; the employee confirms receipt once the items are issued.</p>
          <div class="modal-actions left"><button class="btn-primary" id="md-wo-approve">${icon('check', 14)} Approve</button><button class="btn-danger-outline" id="md-wo-reject">Reject</button></div>
        </div>
      </div>` : ''}
      ${o.status === 'approved' && warehouseStaff ? `
      <div class="modal-section"><h3>Issue items</h3>
        <div class="scan-input-wrap">${icon('search', 16)}<input id="md-wo-scan" class="scan-input" type="text" placeholder="Scan a ${esc(o.item_name)} batch barcode, then Enter" autocomplete="off"></div>
      </div>` : ''}
      ${isRecipient && ['approved', 'completed'].includes(o.status) && !o.delivery_confirmed_at ? (() => {
        const handingOver = o.status === 'approved';  // not issued by the warehouse yet -- receiving hands it over
        const left = o.quantity - o.quantity_fulfilled;
        return `
      <div class="modal-section"><h3>Confirm you received the items</h3>
        <div class="confirm-box column">
          <div class="confirm-head">${icon('truck', 22)}<div><b>Did you receive ${o.quantity} × ${esc(o.item_name)}?</b>
            <p>${handingOver
              ? `Scan the barcode on each item as you receive it — <b>${o.quantity_fulfilled} of ${o.quantity}</b> received so far. Receipt is confirmed when all are scanned.`
              : 'Scan the barcode on any of the items to confirm.'} The admins are notified.</p></div></div>
          ${handingOver && o.quantity > 1 ? `<div class="meter ok rc-meter"><span style="width:${Math.round(o.quantity_fulfilled / o.quantity * 100)}%"></span></div>` : ''}
          <div id="rc-scan-mode">
            <div class="scan-input-wrap">${icon('search', 16)}<input id="rc-barcode" type="text" placeholder="${handingOver && o.quantity_fulfilled ? 'Scan the next item, then Enter' : 'Scan the barcode on the items, then Enter'}" autocomplete="off"></div>
            <button class="link-btn rc-switch" id="rc-to-sku" type="button">Scanner not working or barcode won't scan? Enter the SKU instead</button>
          </div>
          <div id="rc-sku-mode" hidden>
            <div class="field-row">
              <input id="rc-sku" type="text" class="mono-input" placeholder="Item SKU, e.g. SKU-00012" autocomplete="off" autocapitalize="characters">
              <button class="btn-primary" id="rc-sku-confirm">${icon('check', 14)} ${handingOver && left > 1 ? `Confirm all ${left} received` : 'Confirm receipt'}</button>
            </div>
            <p class="rc-help">The SKU is printed on the item labels (under the name) and on the delivery note.</p>
            <button class="link-btn rc-switch" id="rc-to-scan" type="button">← Back to scanning</button>
          </div>
        </div>
      </div>`;
      })() : ''}
      ${o.delivery_confirmed_at ? `<div class="hint-banner ok">${icon('check', 15)}<span>Received and confirmed by <b>${esc(o.deliver_to || '')}</b> on ${fmtTs(o.delivery_confirmed_at)}${o.delivery_confirmed_via === 'sku' ? ' — by typing the SKU (barcode not scanned)' : o.delivery_confirmed_via === 'barcode' ? ' — by scanning a batch barcode' : ''}.</span></div>` : ''}
      ${o.status === 'completed' && !o.delivery_confirmed_at && !isRecipient ? `<div class="hint-banner">${icon('info', 15)}<span>Waiting for <b>${esc(o.deliver_to || 'the recipient')}</b> to confirm they received the items.</span></div>` : ''}
      ${(o.scans || []).length ? `
      <div class="modal-section"><h3>Issued from batches</h3>
        <div class="mini-table"><table class="data-table"><thead><tr><th>Batch</th><th>By</th><th>When</th><th>FEFO</th></tr></thead><tbody>
        ${o.scans.map(sc => `<tr><td class="mono">${esc(sc.barcode)}</td><td>${esc(sc.scanned_by)}</td><td>${fmtTs(sc.scanned_at)}</td><td>${sc.fefo_violation ? '<span class="pill pill-warn">override</span>' : 'ok'}</td></tr>`).join('')}
        </tbody></table></div>
      </div>` : ''}
      ${warehouseStaff || o.delivery_confirmed_at ? `<div class="modal-actions"><button class="btn-outline" id="md-wo-pdf">${icon('file', 14)} Delivery note PDF</button></div>` : ''}`,
  });
  const pdfBtn = modalEl('#md-wo-pdf');
  if (pdfBtn) pdfBtn.addEventListener('click', () => openPdf(`/api/warehouse/work-orders/${o.id}/pdf`));
  const refresh = async () => { if (warehouseStaff) await loadWarehouseTab(); if (currentTab === 'dashboard') loadMyDeliveries(); openWorkOrderModal(o.id); };
  const approve = modalEl('#md-wo-approve');
  if (approve) approve.addEventListener('click', async () => {
    const v = formValues(approve.closest('.action-box'));
    if (!v.deliver_to_user_id) return toast('Choose who the items will be delivered to.', 'error');
    if (await api(`/api/warehouse/work-orders/${o.id}/approve`, { method: 'PUT', body: JSON.stringify({
      deliver_to_user_id: parseInt(v.deliver_to_user_id, 10), delivery_date: v.delivery_date,
    }) })) { toast(`Work order #${o.id} approved.`, 'success'); log(`warehouse: approved work order #${o.id}`); refresh(); }
  });
  const reject = modalEl('#md-wo-reject');
  if (reject) reject.addEventListener('click', async () => {
    if (!confirm(`Reject work order #${o.id}?`)) return;
    if (await api(`/api/warehouse/work-orders/${o.id}/reject`, { method: 'PUT' })) { toast('Work order rejected.', 'success'); refresh(); }
  });
  const scan = modalEl('#md-wo-scan');
  if (scan) {
    setTimeout(() => scan.focus(), 60);
    scan.addEventListener('keydown', async e => {
      if (e.key !== 'Enter' || !scan.value.trim()) return;
      const code = scan.value.trim();
      scan.value = '';
      if (await scanIntoWorkOrder(o.id, code)) refresh();
    });
  }
  const barcodeInput = modalEl('#rc-barcode');
  if (barcodeInput) {
    const confirmWith = async payload => {
      const result = await api(`/api/warehouse/work-orders/${o.id}/confirm-delivery`, { method: 'POST', body: JSON.stringify(payload) });
      if (!result) return false;
      if (result.delivery_confirmed_at) {
        toast('Receipt confirmed — thank you!', 'success');
        log(`work order #${o.id}: delivery confirmed via ${payload.barcode ? 'barcode' : 'SKU'}`);
      } else {
        toast(`${result.quantity_fulfilled} of ${result.quantity} received — scan the next item.`, 'success');
      }
      refresh();
      return true;
    };
    const setMode = sku => {
      modalEl('#rc-scan-mode').hidden = sku;
      modalEl('#rc-sku-mode').hidden = !sku;
      setTimeout(() => modalEl(sku ? '#rc-sku' : '#rc-barcode').focus(), 30);
    };
    setTimeout(() => barcodeInput.focus(), 60);
    barcodeInput.addEventListener('keydown', async e => {
      if (e.key !== 'Enter' || !barcodeInput.value.trim()) return;
      const barcode = barcodeInput.value.trim();
      barcodeInput.value = '';
      if (!await confirmWith({ barcode })) barcodeInput.focus();
    });
    modalEl('#rc-to-sku').addEventListener('click', () => setMode(true));
    modalEl('#rc-to-scan').addEventListener('click', () => setMode(false));
    const skuInput = modalEl('#rc-sku');
    const submitSku = async () => {
      const sku = skuInput.value.trim();
      if (!sku) return toast('Enter the SKU printed on the label or delivery note.', 'error');
      if (!await confirmWith({ sku })) skuInput.select();
    };
    modalEl('#rc-sku-confirm').addEventListener('click', submitSku);
    skuInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitSku(); });
  }
}
registerModalOpener('work_order', openWorkOrderModal);
