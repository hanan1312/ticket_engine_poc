// HR tab: Employees | Attendance | Users | Roles | Policy sub-tabs (also listed under HR in the
// left panel), the employee edit modal, user accounts (temporary passwords, recovery requests),
// role management with the access matrix, and the security policy the sign-in page enforces.

const hr = { employees: [], users: [], roles: [], permissions: [], requests: [], policy: null, search: '',
  userSearch: '', userRole: '', userFilter: 'all' };

const EMP_STATUS = { active: ['resolved', 'Active'], on_leave: ['in_progress', 'On leave'], terminated: ['rejected', 'Terminated'] };

async function loadHrTab() {
  const [employees, users, roles, requests, permissions] = await Promise.all([
    api('/api/hr/employees'), api('/api/hr/security/users'),
    api('/api/hr/security/roles'), api('/api/hr/security/recovery-requests'),
    api('/api/hr/security/permissions'),
  ]);
  hr.employees = employees || []; hr.users = users || []; hr.roles = roles || []; hr.requests = requests || [];
  hr.permissions = permissions || [];
  setSubtabCount('hr-employees', hr.employees.length);
  setSubtabCount('hr-accounts', hr.requests.filter(r => r.status === 'pending').length, true);
  setSubtabCount('hr-roles', hr.roles.length);
  renderEmployees(); renderAttendanceSelect(); renderAccounts(); renderRecoveryRequests(); renderRoles();
  const policy = await api('/api/hr/security/policy', { quiet: true });
  if (policy) { hr.policy = policy; fillPolicyForm(policy); }
  document.querySelectorAll('.admin-only').forEach(el => { el.hidden = !isAdmin(); });
  switchSubtab('hr', currentSubtab('hr'));
}
TAB_LOADERS.hr = loadHrTab;
SUBTAB_LOADERS['hr-attendance'] = () => loadHrAttendance();

function roleLabel(key) { const r = hr.roles.find(x => x.key === key); return r ? r.label : (key || 'Custom'); }
function roleByKey(key) { return hr.roles.find(x => x.key === key); }
function roleTag(key, label, extra = '') {
  const r = roleByKey(key);
  return `<span class="role-tag c-${esc(r ? r.color : 'slate')}"><span class="rt-dot"></span>${esc(label || (r ? r.label : 'Custom'))}${extra}</span>`;
}
function avatar(name, cls = '') { return `<span class="avatar ${cls}">${esc(initials(name))}</span>`; }

const PRESENCE_LABEL = { online: 'Online', idle: 'Idle', offline: 'Offline' };
function photoUrl(e) { return `/api/hr/employees/${e.id}/photo?v=${e.photo_version}`; }
// Employee avatar: their photo (or initials) with an online/idle/offline dot.
function empAvatar(e, cls = '') {
  const inner = e.photo_version ? `<img src="${photoUrl(e)}" alt="">` : esc(initials(e.name));
  const state = e.presence || 'offline';
  const title = e.account ? `${PRESENCE_LABEL[state]}${state !== 'online' && e.last_seen ? ' · last seen ' + fmtAgo(e.last_seen) : ''}` : 'Offline · no login account';
  return `<span class="avatar emp-avatar ${cls}">${inner}<span class="presence-dot p-${state}" title="${esc(title)}"></span></span>`;
}
function presencePill(e) {
  const state = e.presence || 'offline';
  return `<span class="presence-pill p-${state}"><span class="presence-dot p-${state}"></span>${PRESENCE_LABEL[state]}</span>`;
}

// Re-fetch just to update presence dots while the HR tab is open (called by the core poll).
async function refreshHrPresence() {
  if (document.body.classList.contains('modal-open')) return;
  const employees = await api('/api/hr/employees', { quiet: true });
  if (employees) { hr.employees = employees; renderEmployees(); }
}

// ---------------- Employees ----------------
function renderEmployees() {
  const q = hr.search.toLowerCase();
  const rows = hr.employees.filter(e => !q || `${e.name} ${e.role} ${e.email || ''} ${e.phone || ''}`.toLowerCase().includes(q));
  document.querySelector('#hr-employees-table tbody').innerHTML = rows.map(e => `
    <tr class="clickable" onclick="openEmployeeModal(${e.id})">
      <td><div class="person">${empAvatar(e)}<div><div class="cell-title">${esc(e.name)}</div><small class="muted">${esc(e.role)}</small></div></div></td>
      <td class="hide-sm">${esc(e.phone || '—')}</td>
      <td class="hide-sm">${esc(e.email || '—')}</td>
      <td>${e.account ? `<span class="acct"><span class="mono">${esc(e.account.username)}</span><small>${esc(roleLabel(e.account.access_role))}${e.account.is_active ? '' : ' · deactivated'}</small></span>` : '<span class="muted">No account</span>'}</td>
      <td>${presencePill(e)}</td>
      <td class="hide-sm">${(([cls, label]) => `<span class="badge badge-${cls} no-dot">${esc(label)}</span>`)(EMP_STATUS[e.status] || ['open', e.status])}${e.clocked_in ? ' <span class="tag">Clocked in</span>' : ''}</td>${CHEVRON_CELL}
    </tr>`).join('') || `<tr><td colspan="7"><div class="empty-state small"><p>${q ? 'No employees match your search.' : 'No employees yet.'}</p></div></td></tr>`;
}
document.getElementById('hr-search').addEventListener('input', e => { hr.search = e.target.value; renderEmployees(); });

function employeeFields(e = {}) {
  return `
    <div class="form-grid two">
      <label class="field"><span>Full name</span><input type="text" name="name" value="${esc(e.name || '')}"></label>
      <label class="field"><span>Job title</span><input type="text" name="role" value="${esc(e.role || '')}" placeholder="e.g. Maintenance Technician"></label>
      <label class="field"><span>Phone (WhatsApp)</span><input type="text" name="phone" value="${esc(e.phone || '')}" placeholder="e.g. 201012345678"></label>
      <label class="field"><span>Email</span><input type="email" name="email" value="${esc(e.email || '')}" placeholder="name@company.com"></label>
      ${e.id ? `<label class="field"><span>Status</span><select name="status">${Object.entries(EMP_STATUS).map(([k, [, l]]) => `<option value="${k}" ${e.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
    </div>`;
}

document.getElementById('hr-new-employee').addEventListener('click', () => {
  openFormModal({
    title: 'Add employee', sub: 'You can give them a login afterwards from their record.',
    body: employeeFields() + `<div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Cancel</button><button class="btn-primary" id="md-emp-create">Add employee</button></div>`,
  });
  modalEl('#md-emp-create').addEventListener('click', async () => {
    const v = formValues();
    if (!v.name || !v.role) return toast('Name and job title are required.', 'error');
    const emp = await api('/api/hr/employees', { method: 'POST', body: JSON.stringify(v) });
    if (emp) { toast(`Added ${emp.name}.`, 'success'); log(`hr: added employee ${emp.name}`); await loadHrTab(); openEmployeeModal(emp.id); }
  });
});

async function openEmployeeModal(employeeId) {
  if (!hr.employees.length) await loadHrTab();
  const e = hr.employees.find(x => x.id === employeeId);
  if (!e) return;
  const account = e.account ? hr.users.find(u => u.id === e.account.id) : null;
  setDetailModal('employee', e.id, {
    title: `<span class="person">${empAvatar(e, 'lg')}<span>${esc(e.name)}</span></span>`,
    sub: `${esc(e.role)} · joined ${e.join_date ? fmtDate(e.join_date.slice(0, 10)) : '—'} · ${statusBadge(EMP_STATUS[e.status] || ['open', e.status])} · ${presencePill(e)}${e.account && e.presence !== 'online' && e.last_seen ? ` <span class="muted">last seen ${fmtAgo(e.last_seen)}</span>` : ''}`,
    body: `
      <div class="modal-section"><h3>Photo</h3>
        <div class="photo-row">
          <div class="photo-frame">${e.photo_version ? `<img src="${photoUrl(e)}" alt="${esc(e.name)}">` : `<span>${esc(initials(e.name))}</span>`}</div>
          <div>
            <label class="btn-outline btn-sm" for="md-emp-photo">${icon('user', 14)} ${e.photo_version ? 'Change photo' : 'Upload photo'}</label>
            <input type="file" id="md-emp-photo" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
            ${e.photo_version ? `<button class="btn-danger-outline btn-sm" id="md-emp-photo-remove">Remove</button>` : ''}
            <p class="muted" style="margin:.45rem 0 0">PNG, JPG, WebP or GIF — up to 3MB.</p>
          </div>
        </div>
      </div>
      <div class="modal-section"><h3>Profile</h3>${employeeFields(e)}
        <div class="modal-actions left"><button class="btn-primary" id="md-emp-save">${icon('check', 14)} Save changes</button></div>
      </div>
      <div class="modal-section"><h3>Login account</h3>
        ${account ? `
          <div class="account-card">
            ${avatar(account.username)}
            <div class="grow"><b class="mono">${esc(account.username)}</b>
              <div class="muted">${esc(account.access_role_label)} · ${esc(account.email || 'no recovery email')}</div>
              <div>${accountStatePills(account)}</div></div>
            ${isAdmin() ? `<button class="btn-outline btn-sm" id="md-emp-account">${icon('key', 14)} Manage account</button>` : ''}
          </div>` : `
          <div class="account-card empty">
            <div class="grow"><b>No login yet</b><div class="muted">Assign a role to create an account. They choose their own password on first login.</div></div>
            ${isAdmin() ? `<button class="btn-primary btn-sm" id="md-emp-create-account">${icon('plus', 14)} Create account</button>` : '<span class="muted">Ask an admin.</span>'}
          </div>`}
      </div>
      <div class="modal-section"><h3>Attendance</h3>
        <div class="account-card">
          <span class="${e.clocked_in ? 'live-dot big' : 'idle-dot'}"></span>
          <div class="grow"><b>${e.clocked_in ? 'Clocked in now' : 'Not clocked in'}</b><div class="muted">See the Attendance tab for hours and sessions.</div></div>
          <button class="${e.clocked_in ? 'btn-outline' : 'btn-primary'} btn-sm" id="md-emp-clock">${e.clocked_in ? 'Clock out' : 'Clock in'}</button>
        </div>
      </div>
      <div class="modal-section danger-zone"><h3>Danger zone</h3>
        <div class="account-card"><div class="grow"><b>Delete employee</b><div class="muted">Removes the record and its attendance history. Their login (if any) is kept — deactivate it separately.</div></div>
        <button class="btn-danger-outline btn-sm" id="md-emp-delete">${icon('trash', 14)} Delete</button></div>
      </div>`,
  });
  modalEl('#md-emp-save').addEventListener('click', async () => {
    const updated = await api(`/api/hr/employees/${e.id}`, { method: 'PUT', body: JSON.stringify(formValues(modalEl('.form-grid'))) });
    if (updated) {
      toast('Employee saved.', 'success'); log(`hr: updated employee ${updated.name}`);
      if (e.username === currentUser.username) refreshCurrentUser();
      await loadHrTab(); openEmployeeModal(e.id);
    }
  });
  modalEl('#md-emp-photo').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    const form = new FormData();
    form.append('photo', file);
    const res = await fetch(`/api/hr/employees/${e.id}/photo`, { method: 'POST', body: form, credentials: 'same-origin' });
    const body = await res.json().catch(() => null);
    if (!res.ok) return toast((body && body.error) || 'Upload failed.', 'error');
    toast('Photo updated.', 'success'); log(`hr: photo updated for ${e.name}`);
    if (e.username === currentUser.username) refreshCurrentUser();
    await loadHrTab(); openEmployeeModal(e.id);
  });
  const removePhoto = modalEl('#md-emp-photo-remove');
  if (removePhoto) removePhoto.addEventListener('click', async () => {
    if (await api(`/api/hr/employees/${e.id}/photo`, { method: 'DELETE' })) {
      toast('Photo removed.', 'success');
      if (e.username === currentUser.username) refreshCurrentUser();
      await loadHrTab(); openEmployeeModal(e.id);
    }
  });
  const manage = modalEl('#md-emp-account');
  if (manage) manage.addEventListener('click', () => openAccountModal(account.id));
  const create = modalEl('#md-emp-create-account');
  if (create) create.addEventListener('click', () => openCreateAccountModal(e.id, true));
  modalEl('#md-emp-clock').addEventListener('click', async () => {
    const path = `/api/hr/employees/${e.id}/attendance/${e.clocked_in ? 'clock-out' : 'clock-in'}`;
    if (await api(path, { method: 'POST' })) { toast(`${e.name} clocked ${e.clocked_in ? 'out' : 'in'}.`, 'success'); await loadHrTab(); openEmployeeModal(e.id); }
  });
  modalEl('#md-emp-delete').addEventListener('click', async () => {
    if (!confirm(`Delete ${e.name} and their attendance history?`)) return;
    if (await api(`/api/hr/employees/${e.id}`, { method: 'DELETE' })) { toast('Employee deleted.', 'success'); closeModal(); loadHrTab(); }
  });
}
registerModalOpener('employee', openEmployeeModal);

// ---------------- Attendance ----------------
function renderAttendanceSelect() {
  const sel = document.getElementById('hr-att-employee');
  const current = sel.value;
  sel.innerHTML = hr.employees.map(e => `<option value="${e.id}">${esc(e.name)}${e.clocked_in ? ' • clocked in' : ''}</option>`).join('');
  if (current && hr.employees.some(e => String(e.id) === current)) sel.value = current;
  const from = document.getElementById('hr-att-from'), to = document.getElementById('hr-att-to');
  if (!from.value) from.value = todayISO().slice(0, 8) + '01';
  if (!to.value) to.value = todayISO();
}

async function loadHrAttendance() {
  const employeeId = document.getElementById('hr-att-employee').value;
  if (!employeeId) return;
  const emp = hr.employees.find(e => String(e.id) === employeeId);
  const from = document.getElementById('hr-att-from').value, to = document.getElementById('hr-att-to').value;
  const [summary, sessions] = await Promise.all([
    // tz_offset: the server stores UTC; this lets it read From/To as *our* calendar days.
    api(`/api/hr/employees/${employeeId}/attendance/summary?date_from=${from}&date_to=${to}&tz_offset=${new Date().getTimezoneOffset()}`),
    api(`/api/hr/employees/${employeeId}/attendance/sessions`),
  ]);
  const clockBtn = document.getElementById('hr-att-clock');
  clockBtn.textContent = emp && emp.clocked_in ? 'Clock out' : 'Clock in';
  clockBtn.className = emp && emp.clocked_in ? 'btn-outline' : 'btn-primary';
  if (summary) {
    const pct = summary.percentage;
    document.getElementById('hr-att-summary').innerHTML = `
      <div class="stat-tile"><span>Worked</span><b>${summary.worked_hours}h</b></div>
      <div class="stat-tile"><span>Expected</span><b>${summary.expected_hours}h</b></div>
      <div class="stat-tile wide"><span>Attendance</span><b>${pct}%</b><div class="meter ${pct >= 90 ? 'ok' : pct < 60 ? 'danger' : ''}"><span style="width:${pct}%"></span></div></div>`;
  }
  document.querySelector('#hr-sessions-table tbody').innerHTML = (sessions || []).map(s => {
    const dur = s.clock_out ? parseTs(s.clock_out) - parseTs(s.clock_in) : Date.now() - parseTs(s.clock_in);
    return `<tr><td>${fmtTs(s.clock_in)}</td>
      <td>${s.clock_out ? fmtTs(s.clock_out) : '<span class="badge badge-assigned">In progress</span>'}</td>
      <td class="num">${fmtDuration(dur)}</td><td class="hide-sm">${esc(s.recorded_by)}</td></tr>`;
  }).join('') || '<tr><td colspan="4"><div class="empty-state small"><p>No sessions yet.</p></div></td></tr>';
}
['hr-att-employee', 'hr-att-from', 'hr-att-to'].forEach(id => document.getElementById(id).addEventListener('change', loadHrAttendance));
document.getElementById('hr-att-clock').addEventListener('click', async () => {
  const emp = hr.employees.find(e => String(e.id) === document.getElementById('hr-att-employee').value);
  if (!emp) return;
  if (await api(`/api/hr/employees/${emp.id}/attendance/${emp.clocked_in ? 'clock-out' : 'clock-in'}`, { method: 'POST' })) {
    toast(`${emp.name} clocked ${emp.clocked_in ? 'out' : 'in'}.`, 'success');
    hr.employees = await api('/api/hr/employees') || hr.employees;
    renderEmployees(); renderAttendanceSelect(); loadHrAttendance();
  }
});

// ---------------- Accounts & security ----------------
function accountStatePills(u) {
  if (!u.is_active) return '<span class="pill pill-danger">Deactivated</span>';
  if (u.must_change_password) return '<span class="pill pill-warn">Awaiting first login</span>';
  return '<span class="pill pill-ok">Active</span>';
}
const USER_FILTERS = {
  all: () => true,
  active: u => u.is_active && !u.must_change_password,
  pending: u => u.is_active && u.must_change_password,
  inactive: u => !u.is_active,
};
function userAvatar(u) {
  const emp = hr.employees.find(e => e.id === u.employee_id);
  const inner = emp && emp.photo_version ? `<img src="${photoUrl(emp)}" alt="">` : esc(initials(u.employee_name || u.username));
  return `<span class="avatar emp-avatar">${inner}<span class="presence-dot p-${u.presence || 'offline'}"></span></span>`;
}
function renderAccounts() {
  const users = hr.users;
  const stat = (label, value, cls, iconName) => `
    <div class="stat-card ${cls}"><div class="stat-icon">${icon(iconName, 19)}</div>
      <div><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div></div>`;
  document.getElementById('hr-user-stats').innerHTML =
    stat('Users', users.length, '', 'user') +
    stat('Online now', users.filter(u => u.presence === 'online').length, 'stat-success', 'check') +
    stat('Awaiting first login', users.filter(USER_FILTERS.pending).length, 'stat-warning', 'key') +
    stat('Deactivated', users.filter(USER_FILTERS.inactive).length, 'stat-slate', 'x');
  const roleSel = document.getElementById('hr-user-role');
  roleSel.innerHTML = '<option value="">All roles</option>' + hr.roles.map(r => `<option value="${esc(r.key)}" ${hr.userRole === r.key ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
  const q = hr.userSearch.toLowerCase();
  const rows = users.filter(u => USER_FILTERS[hr.userFilter](u)
    && (!hr.userRole || u.access_role === hr.userRole)
    && (!q || `${u.username} ${u.employee_name || ''} ${u.email || ''}`.toLowerCase().includes(q)));
  document.querySelector('#hr-accounts-table tbody').innerHTML = rows.map(u => `
    <tr class="clickable ${u.is_active ? '' : 'dim'}" onclick="openAccountModal(${u.id})">
      <td><div class="person">${userAvatar(u)}<div><div class="cell-title mono">${esc(u.username)}</div><small class="muted">${esc(u.employee_name || 'No employee record')}</small></div></div></td>
      <td>${roleTag(u.access_role, u.access_role_label, u.permissions_customised ? ' <em title="Permissions fine-tuned for this user">· custom</em>' : '')}${u.role_can_login ? '' : ' <span class="pill pill-danger" title="Sign-in is disabled for this role">No sign-in</span>'}</td>
      <td>${presencePill(u)}${u.presence !== 'online' && u.last_seen ? `<small class="muted block">${fmtAgo(u.last_seen)}</small>` : ''}</td>
      <td class="hide-sm">${esc(u.email || '—')}</td>
      <td>${accountStatePills(u)}</td>${CHEVRON_CELL}
    </tr>`).join('') || `<tr><td colspan="6"><div class="empty-state small"><p>No users match these filters.</p></div></td></tr>`;
}
document.getElementById('hr-user-search').addEventListener('input', e => { hr.userSearch = e.target.value; renderAccounts(); });
document.getElementById('hr-user-role').addEventListener('change', e => { hr.userRole = e.target.value; renderAccounts(); });
document.getElementById('hr-user-filters').addEventListener('click', e => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  hr.userFilter = btn.dataset.filter;
  document.querySelectorAll('#hr-user-filters button').forEach(b => b.classList.toggle('active', b === btn));
  renderAccounts();
});

function roleCards(selected) {
  return `<div class="role-cards">${hr.roles.map(r => `
    <label class="role-card c-${esc(r.color)}"><input type="radio" name="access_role" value="${esc(r.key)}" ${r.key === selected ? 'checked' : ''}>
      <span><b><span class="rt-dot"></span>${esc(r.label)}${r.can_login ? '' : ' <span class="pill pill-danger">No sign-in</span>'}</b><small>${esc(r.description || roleSummary(r))}</small></span></label>`).join('')}</div>`;
}
function roleSummary(r) {
  if (r.is_admin) return 'Full access to everything.';
  const labels = r.permissions.map(k => (hr.permissions.find(p => p.key === k) || { label: k }).label);
  return labels.length ? `${tabLabel('dashboard')}, ${labels.join(', ')}` : `${tabLabel('dashboard')} and tickets only`;
}

function showTempPassword({ username, temp_password, emailed }, email) {
  openFormModal({
    title: `${icon('key', 18)} Account ready`,
    sub: 'Shown once — share it with the employee now.',
    body: `
      <div class="credential-card">
        <div><span>Username</span><b class="mono">${esc(username)}</b></div>
        <div><span>Temporary password</span><b class="mono" id="temp-pw">${esc(temp_password)}</b></div>
        <button class="btn-outline btn-sm" id="copy-cred">Copy both</button>
      </div>
      <div class="hint-banner ${emailed ? 'ok' : ''}">${icon(emailed ? 'check' : 'info', 15)}<span>${emailed
        ? `Also emailed to <b>${esc(email)}</b>.`
        : `Email isn't configured on the server (SMTP), so nothing was emailed — hand these over in person. The server console shows the message it would have sent.`}</span></div>
      <p class="muted">They'll be asked to choose their own password the first time they log in. If they forget it later, the “Forgot password?” link emails a reset link to their recovery email.</p>
      <div class="modal-actions"><button class="btn-primary" onclick="closeModal()">Done</button></div>`,
  });
  modalEl('#copy-cred').addEventListener('click', async e => {
    try { await navigator.clipboard.writeText(`Username: ${username}\nTemporary password: ${temp_password}`); e.target.textContent = 'Copied'; }
    catch { e.target.textContent = 'Copy failed'; }
  });
}

function openCreateAccountModal(presetEmployeeId, fromEmployee = false) {
  const candidates = hr.employees.filter(e => !e.account);
  if (!candidates.length) return toast('Every employee already has an account.', 'info');
  const pre = hr.employees.find(e => e.id === presetEmployeeId) || candidates[0];
  const suggest = name => (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  openFormModal({
    keepHistory: fromEmployee,
    size: 'wide',
    title: `${icon('user', 18)} New user`,
    sub: 'Pick an employee and a role. A temporary password is generated; they set their own on first login.',
    body: `
      <div class="form-grid two">
        <label class="field"><span>Employee</span><select name="employee_id">${candidates.map(e => `<option value="${e.id}" ${e.id === pre.id ? 'selected' : ''}>${esc(e.name)} — ${esc(e.role)}</option>`).join('')}</select></label>
        <label class="field"><span>Username</span><input type="text" name="username" value="${esc(suggest(pre.name))}"></label>
        <label class="field span-2"><span>Recovery email</span><input type="email" name="email" value="${esc(pre.email || '')}" placeholder="Where forgot-password links are sent"><small>Required — it's how they get back in if they forget their password.</small></label>
      </div>
      <p class="group-label">Role</p>
      ${roleCards('technician')}
      <div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Cancel</button><button class="btn-primary" id="md-acct-create">Create user</button></div>`,
  });
  modalEl('[name=employee_id]').addEventListener('change', ev => {
    const emp = hr.employees.find(x => String(x.id) === ev.target.value);
    modalEl('[name=username]').value = suggest(emp.name);
    modalEl('[name=email]').value = emp.email || '';
  });
  modalEl('#md-acct-create').addEventListener('click', async () => {
    const v = formValues();
    const role = modalEl('[name=access_role]:checked');
    const result = await api('/api/hr/security/accounts', { method: 'POST', body: JSON.stringify({
      employee_id: parseInt(v.employee_id, 10), username: v.username, email: v.email, access_role: role && role.value,
    }) });
    if (result) {
      log(`hr: created account ${result.account.username} (${result.account.access_role_label})`);
      await loadHrTab();
      showTempPassword({ username: result.account.username, temp_password: result.temp_password, emailed: result.emailed }, result.account.email);
    }
  });
}
document.getElementById('hr-new-account').addEventListener('click', () => openCreateAccountModal());

// The sidebar tabs as permission switches (from the server's registry, which is read from the
// sidebar, i.e. config/ui.json). Dashboard has no permission -- everyone gets it -- so it's shown locked on.
function permissionSwitches(granted, editable = isAdmin()) {
  const navIcon = key => {
    const svg = document.querySelector(`.nav-item[data-permission="${key}"] svg`);
    return svg ? svg.outerHTML : '';
  };
  const dashIcon = document.querySelector('.nav-item[data-tab="dashboard"] svg');
  return `<div class="perm-grid">
    <label class="perm-row locked" title="Everyone can open the ${esc(tabLabel('dashboard'))} tab">
      <span class="perm-icon">${dashIcon ? dashIcon.outerHTML : ''}</span>
      <span class="perm-text"><b>${esc(tabLabel('dashboard'))}</b><small>Always on for everyone</small></span>
      <span class="switch-row"><input type="checkbox" checked disabled><span class="switch"></span></span></label>
    ${hr.permissions.map(p => `<label class="perm-row">
      <span class="perm-icon">${navIcon(p.key)}</span>
      <span class="perm-text"><b>${esc(p.label)}</b><small>${esc(p.hint || '')}</small></span>
      <span class="switch-row"><input type="checkbox" name="perm:${esc(p.key)}" ${granted.includes(p.key) ? 'checked' : ''} ${editable ? '' : 'disabled'}><span class="switch"></span></span>
    </label>`).join('')}
  </div>`;
}

async function openAccountModal(userId) {
  if (!hr.users.length) await loadHrTab();
  const u = hr.users.find(x => x.id === userId);
  if (!u) return;
  const self = currentUser && u.id === currentUser.id;
  setDetailModal('account', u.id, {
    size: 'wide',
    title: `<span class="person">${avatar(u.username, 'lg')}<span class="mono">${esc(u.username)}</span></span>`,
    sub: `${esc(u.employee_name || 'No employee record')} · ${roleTag(u.access_role, u.access_role_label)} · ${accountStatePills(u)} · ${presencePill(u)}${u.password_changed_at ? ` <span class="muted">password set ${fmtAgo(u.password_changed_at)}</span>` : ''}`,
    body: `
      <div class="modal-section"><h3>Role</h3>${roleCards(u.access_role || (u.role === 'admin' ? 'admin' : ''))}</div>
      ${u.role !== 'admin' ? `
      <div class="modal-section"><h3>Fine-tune permissions</h3>
        <p class="muted" style="margin-top:0">One switch per tab in the left panel — the person sees and can manage the tabs that are on. New tabs appear here automatically.</p>
        ${permissionSwitches(u.permissions)}
        <p class="muted">Changing the role above resets these to the role's defaults${u.permissions_customised ? ' — and so does the next edit of the role itself under HR → Roles' : ''}.</p>
      </div>` : ''}
      <div class="modal-section"><h3>Recovery email</h3>
        <label class="field"><input type="email" name="email" value="${esc(u.email || '')}" placeholder="name@company.com"><small>Forgot-password links are sent here.</small></label>
      </div>
      <div class="modal-actions left">
        <button class="btn-primary" id="md-acct-save" ${isAdmin() ? '' : 'disabled'}>${icon('check', 14)} Save changes</button>
        <button class="btn-outline" id="md-acct-reset" ${isAdmin() ? '' : 'disabled'}>${icon('key', 14)} Issue temporary password</button>
        ${self ? '' : `<button class="${u.is_active ? 'btn-danger-outline' : 'btn-outline'}" id="md-acct-toggle" ${isAdmin() ? '' : 'disabled'}>${u.is_active ? 'Deactivate' : 'Reactivate'}</button>`}
      </div>
      ${isAdmin() ? '' : '<p class="muted">Only an admin can change accounts.</p>'}`,
  });
  const originalRole = u.access_role;
  modalEl('#md-acct-save').addEventListener('click', async () => {
    const v = formValues();
    const role = modalEl('[name=access_role]:checked');
    const payload = { email: v.email };
    if (role && role.value !== originalRole) payload.access_role = role.value;
    else if (u.role !== 'admin') payload.permissions = hr.permissions.map(p => p.key).filter(key => v['perm:' + key]);
    const updated = await api(`/api/hr/security/users/${u.id}`, { method: 'PUT', body: JSON.stringify(payload) });
    if (updated) { toast('Account saved.', 'success'); log(`hr: updated account ${u.username}`); await loadHrTab(); openAccountModal(u.id); }
  });
  modalEl('#md-acct-reset').addEventListener('click', async () => {
    if (!confirm(`Issue a new temporary password for ${u.username}? Their current password stops working.`)) return;
    const r = await api(`/api/hr/security/users/${u.id}/reset-password`, { method: 'POST' });
    if (r) { await loadHrTab(); showTempPassword(r, u.email); }
  });
  const toggle = modalEl('#md-acct-toggle');
  if (toggle) toggle.addEventListener('click', async () => {
    if (u.is_active && !confirm(`Deactivate ${u.username}? They won't be able to log in.`)) return;
    if (await api(`/api/hr/security/users/${u.id}`, { method: 'PUT', body: JSON.stringify({ is_active: !u.is_active }) })) {
      toast(`${u.username} ${u.is_active ? 'deactivated' : 'reactivated'}.`, 'success'); await loadHrTab(); openAccountModal(u.id);
    }
  });
}
registerModalOpener('account', openAccountModal);

function renderRecoveryRequests() {
  const pending = hr.requests.filter(r => r.status === 'pending');
  const decided = hr.requests.filter(r => r.status !== 'pending').slice(0, 10);
  document.getElementById('hr-requests-list').innerHTML = pending.map(r => `
    <div class="request-card">
      <div class="grow">
        <b>${esc(r.full_name)}</b> ${r.matched_user ? `<span class="muted">· old account <span class="mono">${esc(r.matched_user)}</span></span>` : r.old_username ? `<span class="pill pill-warn">no account “${esc(r.old_username)}”</span>` : ''}
        <div class="muted">Contact: ${esc(r.contact)} · ${fmtAgo(r.created_at)}</div>
        ${r.reason ? `<div class="desc-box">${esc(r.reason)}</div>` : ''}
      </div>
      ${isAdmin() ? `<div class="stack-actions"><button class="btn-primary btn-sm" onclick="openApproveRequestModal(${r.id})">Review &amp; approve</button><button class="btn-danger-outline btn-sm" onclick="rejectRecoveryRequest(${r.id})">Reject</button></div>` : ''}
    </div>`).join('') || `<div class="empty-state small">${icon('check', 26)}<p>No pending requests.</p></div>`;
  document.getElementById('hr-requests-history').innerHTML = decided.length ? `<p class="group-label">Recent decisions</p>` + decided.map(r => `
    <div class="history-row"><span>${esc(r.full_name)}</span><span class="muted">${r.status === 'approved' ? `→ new account <span class="mono">${esc(r.new_username || '')}</span>` : 'rejected'} by ${esc(r.decided_by || '')} ${fmtAgo(r.decided_at)}</span></div>`).join('') : '';
}

function openApproveRequestModal(requestId) {
  const r = hr.requests.find(x => x.id === requestId);
  const emp = hr.employees.find(e => e.id === r.matched_employee_id);
  const base = (emp ? emp.name : r.full_name).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  openFormModal({
    size: 'wide',
    title: `Replace account for ${esc(r.full_name)}`,
    sub: r.matched_user ? `The old account <b class="mono">${esc(r.matched_user)}</b> will be deactivated (kept for history) and a new one issued.` : 'No existing account matched — a new one will be issued for the employee you choose.',
    body: `
      <div class="form-grid two">
        <label class="field"><span>Employee</span><select name="employee_id">${hr.employees.map(e => `<option value="${e.id}" ${emp && e.id === emp.id ? 'selected' : ''}>${esc(e.name)} — ${esc(e.role)}</option>`).join('')}</select></label>
        <label class="field"><span>New username</span><input type="text" name="username" value="${esc(base)}.2"></label>
        <label class="field span-2"><span>Recovery email for the new account</span><input type="email" name="email" value="${esc(/@/.test(r.contact) ? r.contact : (emp && emp.email) || '')}"></label>
      </div>
      <p class="group-label">Role</p>${roleCards(r.matched_access_role || 'technician')}
      <div class="modal-actions"><button class="btn-outline" onclick="closeModal()">Cancel</button><button class="btn-primary" id="md-req-approve">Approve &amp; issue account</button></div>`,
  });
  modalEl('#md-req-approve').addEventListener('click', async () => {
    const v = formValues();
    const role = modalEl('[name=access_role]:checked');
    const result = await api(`/api/hr/security/recovery-requests/${r.id}/approve`, { method: 'POST', body: JSON.stringify({
      employee_id: parseInt(v.employee_id, 10), username: v.username, email: v.email, access_role: role && role.value,
    }) });
    if (result) { log(`hr: approved recovery for ${r.full_name} -> ${result.username}`); await loadHrTab(); showTempPassword(result, v.email); }
  });
}
async function rejectRecoveryRequest(requestId) {
  if (!confirm('Reject this account recovery request?')) return;
  if (await api(`/api/hr/security/recovery-requests/${requestId}/reject`, { method: 'POST' })) { toast('Request rejected.', 'success'); loadHrTab(); }
}

// ---------------- Roles ----------------
const ROLE_COLOR_LIST = ['violet', 'gold', 'teal', 'rose', 'blue', 'green', 'orange', 'slate'];
function navIconFor(key) {
  const svg = document.querySelector(key ? `.nav-item[data-permission="${key}"] svg` : '.nav-item[data-tab="dashboard"] svg');
  return svg ? svg.outerHTML : '';
}
function renderRoles() {
  const grid = document.getElementById('hr-role-grid');
  grid.innerHTML = hr.roles.map(r => {
    const members = hr.users.filter(u => u.access_role === r.key && u.is_active);
    const faces = members.slice(0, 4).map(u => `<span class="avatar xs" title="${esc(u.employee_name || u.username)}">${esc(initials(u.employee_name || u.username))}</span>`).join('');
    const perms = r.is_admin ? '<span class="perm-chip all">Full access · approvals · accounts</span>'
      : [{ key: '', label: tabLabel('dashboard') }, ...hr.permissions.filter(p => r.permissions.includes(p.key))]
        .map(p => `<span class="perm-chip" title="${esc(p.label)}">${navIconFor(p.key)}${esc(p.label)}</span>`).join('');
    return `
      <button class="role-tile c-${esc(r.color)} ${r.can_login ? '' : 'no-login'}" onclick="openRoleModal('${esc(r.key)}')">
        <div class="rt-head">
          <span class="rt-badge">${r.is_admin ? icon('key', 17) : icon('user', 17)}</span>
          <div class="grow"><b>${esc(r.label)}</b><small>${r.is_system ? 'Built-in role' : 'Custom role'}</small></div>
          <span class="rt-login ${r.can_login ? 'on' : 'off'}">${r.can_login ? 'Can sign in' : 'Sign-in off'}</span>
        </div>
        <p class="rt-desc">${esc(r.description || roleSummary(r))}</p>
        <div class="rt-perms">${perms}</div>
        <div class="rt-foot"><span class="faces">${faces}${members.length > 4 ? `<span class="avatar xs more">+${members.length - 4}</span>` : ''}</span>
          <span class="muted">${r.user_count} user${r.user_count === 1 ? '' : 's'}${r.inactive_user_count ? ` · ${r.inactive_user_count} deactivated` : ''}</span></div>
      </button>`;
  }).join('') + (isAdmin() ? `
      <button class="role-tile new" id="hr-new-role">${icon('plus', 22)}<b>New role</b><small>Pick which tabs it opens and whether it can sign in.</small></button>` : '');
  const newBtn = document.getElementById('hr-new-role');
  if (newBtn) newBtn.addEventListener('click', () => openRoleModal(null));

  const cols = [{ key: '', label: tabLabel('dashboard') }, ...hr.permissions];
  document.getElementById('hr-role-matrix').innerHTML = `
    <thead><tr><th>Role</th>${cols.map(c => `<th class="mx-col"><span class="mx-ic">${navIconFor(c.key)}</span>${esc(c.label)}</th>`).join('')}<th class="mx-col">Sign-in</th><th class="num">Users</th></tr></thead>
    <tbody>${hr.roles.map(r => `
      <tr class="clickable" onclick="openRoleModal('${esc(r.key)}')">
        <td>${roleTag(r.key)}</td>
        ${cols.map(c => { const on = r.is_admin || !c.key || r.permissions.includes(c.key);
          return `<td class="mx-cell ${on ? 'on' : ''}">${on ? icon('check', 15) : '<span class="mx-off"></span>'}</td>`; }).join('')}
        <td class="mx-cell ${r.can_login ? 'on' : 'off'}">${r.can_login ? icon('check', 15) : icon('x', 15)}</td>
        <td class="num">${r.user_count}</td>
      </tr>`).join('')}</tbody>`;
}

function openRoleModal(key) {
  const r = key ? roleByKey(key) : { key: null, label: '', description: '', permissions: [], color: 'violet', can_login: true, is_admin: false, is_system: false, user_count: 0, inactive_user_count: 0 };
  if (!r) return;
  const editable = isAdmin();
  const members = key ? hr.users.filter(u => u.access_role === key) : [];
  const others = hr.roles.filter(x => x.key !== key);
  const body = `
    <div class="form-grid two">
      <label class="field"><span>Role name</span><input type="text" name="label" value="${esc(r.label)}" maxlength="60" placeholder="e.g. Night auditor" ${editable ? '' : 'disabled'}></label>
      <div class="field"><span>Colour</span><div class="swatches">${ROLE_COLOR_LIST.map(c => `
        <label class="swatch c-${c}" title="${c}"><input type="radio" name="color" value="${c}" ${r.color === c ? 'checked' : ''} ${editable ? '' : 'disabled'}><span></span></label>`).join('')}</div></div>
      <label class="field span-2"><span>Description</span><input type="text" name="description" value="${esc(r.description)}" maxlength="255" placeholder="What this role is for" ${editable ? '' : 'disabled'}></label>
    </div>
    <div class="modal-section"><h3>Sign-in</h3>
      <label class="perm-row ${r.is_admin ? 'locked' : ''}">
        <span class="perm-icon">${icon('logout', 17)}</span>
        <span class="perm-text"><b>Users with this role can sign in</b><small>${r.is_admin ? 'Administrators can always sign in.' : 'Turn off to suspend everyone with this role at once — they are signed out on their next request.'}</small></span>
        <span class="switch-row"><input type="checkbox" name="can_login" ${r.can_login ? 'checked' : ''} ${editable && !r.is_admin ? '' : 'disabled'}><span class="switch"></span></span>
      </label>
    </div>
    <div class="modal-section"><h3>Tabs in the left panel</h3>
      ${r.is_admin ? '<p class="muted" style="margin-top:0">Administrators can open every tab and also approve bills and work orders, assign tickets and manage users.</p>'
        : `<p class="muted" style="margin-top:0">What users with this role can open and manage.</p>${permissionSwitches(r.permissions, editable)}`}
    </div>
    ${key ? `<div class="modal-section"><h3>Users with this role <span class="muted">(${members.length})</span></h3>
      ${members.length ? `<div class="member-list">${members.map(u => `
        <button class="member" onclick="openAccountModal(${u.id})">${userAvatar(u)}<span class="grow"><b class="mono">${esc(u.username)}</b><small>${esc(u.employee_name || '')}</small></span>${accountStatePills(u)}</button>`).join('')}</div>`
        : '<p class="muted" style="margin-top:0">Nobody has this role yet. Assign it from a user\'s record.</p>'}
      ${members.length && editable ? '<p class="muted">Saving applies the new tabs and sign-in setting to all of them; any per-user fine-tuning is replaced.</p>' : ''}
    </div>` : ''}
    ${key && !r.is_system && editable ? `<div class="modal-section danger-zone"><h3>Delete role</h3>
      <div class="account-card"><div class="grow"><b>Delete “${esc(r.label)}”</b><div class="muted">${members.length ? `Its ${members.length} user(s) move to the role you pick.` : 'Nobody has this role.'}</div>
        ${members.length ? `<select name="reassign_to" style="margin-top:.5rem; max-width:260px">${others.map(o => `<option value="${esc(o.key)}" ${o.key === 'technician' ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : ''}</div>
      <button class="btn-danger-outline btn-sm" id="md-role-delete">${icon('trash', 14)} Delete</button></div></div>` : ''}
    <div class="modal-actions">${editable ? `<button class="btn-outline" onclick="closeModal()">Cancel</button><button class="btn-primary" id="md-role-save">${icon('check', 14)} ${key ? 'Save role' : 'Create role'}</button>` : '<p class="muted">Only an admin can change roles.</p>'}</div>`;
  const opts = { size: 'wide', title: key ? `${roleTag(r.key)}` : `${icon('plus', 18)} New role`, sub: key ? `${r.is_system ? 'Built-in role' : 'Custom role'} · ${r.user_count} active user${r.user_count === 1 ? '' : 's'}` : 'Name it, choose its tabs, and assign it to users from their records.', body };
  if (key) setDetailModal('role', key, opts); else openFormModal(opts);

  const save = modalEl('#md-role-save');
  if (save) save.addEventListener('click', async () => {
    const v = formValues();
    const payload = { label: v.label, description: v.description, can_login: v.can_login,
      color: (modalEl('[name=color]:checked') || {}).value || 'violet' };
    if (!r.is_admin) payload.permissions = hr.permissions.map(p => p.key).filter(k => v['perm:' + k]);
    if (!payload.label) return toast('Give the role a name.', 'error');
    if (key && r.can_login && !payload.can_login && members.some(u => u.is_active) &&
        !confirm(`Turn off sign-in for ${r.label}? ${members.filter(u => u.is_active).length} user(s) will be signed out and unable to sign in.`)) return;
    const saved = await api(key ? `/api/hr/security/roles/${encodeURIComponent(key)}` : '/api/hr/security/roles',
      { method: key ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    if (saved) {
      toast(key ? `Role “${saved.label}” saved${saved.user_count ? ` — applied to ${saved.user_count} user(s)` : ''}.` : `Role “${saved.label}” created.`, 'success');
      log(`hr: ${key ? 'updated' : 'created'} role ${saved.label}`);
      await loadHrTab(); closeModal();
    }
  });
  const del = modalEl('#md-role-delete');
  if (del) del.addEventListener('click', async () => {
    if (!confirm(`Delete the role “${r.label}”?`)) return;
    const target = modalEl('[name=reassign_to]');
    const res = await api(`/api/hr/security/roles/${encodeURIComponent(key)}`, { method: 'DELETE', body: JSON.stringify({ reassign_to: target ? target.value : null }) });
    if (res) { toast(`Role deleted${res.moved ? ` — ${res.moved} user(s) moved` : ''}.`, 'success'); log(`hr: deleted role ${r.label}`); closeModal(); loadHrTab(); }
  });
}
registerModalOpener('role', openRoleModal);

// ---------------- Policy ----------------
// The security policy auth_engine enforces at sign-in (and the attendance hours). The side
// card previews what the sign-in page will show with the values currently in the form.
const policyPane = () => document.querySelector('.subpane[data-pane="hr-policy"]');
function fillPolicyForm(p) {
  policyPane().querySelectorAll('[name]').forEach(el => {
    if (!(el.name in p)) return;
    if (el.type === 'checkbox') el.checked = !!p[el.name]; else el.value = p[el.name] ?? '';
    el.disabled = !isAdmin();
  });
  document.getElementById('hr-save-policy-btn').hidden = !isAdmin();
  document.getElementById('hr-reset-policy-btn').hidden = !isAdmin();
  document.getElementById('pol-readonly').hidden = isAdmin();
  renderPolicyPreview();
}
function readPolicyForm() {
  const out = {};
  policyPane().querySelectorAll('[name]').forEach(el => {
    out[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
  });
  return out;
}
function renderPolicyPreview() {
  const p = readPolicyForm();
  const banner = document.getElementById('pol-prev-banner');
  banner.hidden = !p.login_banner.trim();
  banner.textContent = p.login_banner.trim();
  const rules = passwordChecks('', { ...p, password_require_digit: p.password_require_digit }).map(c => c.label);
  document.getElementById('pol-prev-rules').innerHTML = rules.map(r => `<li>${icon('check', 13)}${esc(r)}</li>`).join('');
  const facts = [
    `Locks a username for ${p.lockout_minutes} min after ${p.lockout_threshold} failed attempt${p.lockout_threshold === 1 ? '' : 's'}`,
    p.password_expiry_days ? `Passwords must be changed every ${p.password_expiry_days} days` : 'Passwords never expire',
    p.idle_logout_timeout_minutes ? `Signed out after ${p.idle_logout_timeout_minutes} min without activity` : 'No idle sign-out',
    p.show_demo_accounts ? 'Demo accounts are shown on the sign-in page' : 'Demo accounts are hidden',
  ];
  document.getElementById('pol-prev-facts').innerHTML = facts.map(f => `<li>${esc(f)}</li>`).join('');
}
policyPane().addEventListener('input', renderPolicyPreview);
policyPane().addEventListener('change', renderPolicyPreview);
document.getElementById('hr-reset-policy-btn').addEventListener('click', () => { if (hr.policy) fillPolicyForm(hr.policy); });
document.getElementById('hr-save-policy-btn').addEventListener('click', async () => {
  const policy = await api('/api/hr/security/policy', { method: 'PUT', body: JSON.stringify(readPolicyForm()) });
  if (policy) {
    hr.policy = policy; fillPolicyForm(policy);
    toast('Policy saved — the sign-in page uses it from now on.', 'success'); log('hr: updated security policy');
    loadAuthPolicy();  // idle sign-out etc. apply to this session straight away
  }
});
