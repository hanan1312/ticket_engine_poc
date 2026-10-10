// Preferences tab (admin only): branding (company name + logo) and the WhatsApp
// notifications service (sending number, on/off switch, pairing status).

async function loadPreferencesTab() {
  const settings = await api('/api/settings');
  if (!settings) return;
  appSettings = settings;
  document.getElementById('pref-company-name').value = settings.company_name;
  updateLogoPreview();
  document.getElementById('pref-wa-number').value = settings.whatsapp_number || '';
  document.getElementById('pref-wa-enabled').checked = settings.whatsapp_enabled;
  renderWhatsAppPrefState();
  loadEmailSettings();
}
TAB_LOADERS.preferences = loadPreferencesTab;

function updateLogoPreview() {
  document.getElementById('pref-logo-preview').innerHTML = appSettings.has_logo
    ? `<img src="/api/settings/logo?t=${Date.now()}" alt="logo">` : icon('barcode', 28);
  document.getElementById('pref-remove-logo-btn').hidden = !appSettings.has_logo;
}

document.getElementById('pref-save-name-btn').addEventListener('click', async () => {
  const name = document.getElementById('pref-company-name').value.trim();
  if (!name) return toast('Company name cannot be empty.', 'error');
  const settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ company_name: name }) });
  if (settings) {
    appSettings = { ...appSettings, ...settings };
    renderBrand();
    toast('Company name saved.', 'success');
    log(`branding: company name set to "${settings.company_name}"`);
  }
});

document.getElementById('pref-logo-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const formData = new FormData();
  formData.append('logo', file);
  const res = await fetch('/api/settings/logo', { method: 'POST', body: formData, credentials: 'same-origin' });
  const result = await res.json().catch(() => null);
  if (!res.ok) return toast((result && result.error) || 'Upload failed.', 'error');
  appSettings.has_logo = true;
  renderBrand(); updateLogoPreview();
  toast('Logo updated.', 'success');
  log('branding: logo uploaded');
});

document.getElementById('pref-remove-logo-btn').addEventListener('click', async () => {
  const res = await fetch('/api/settings/logo', { method: 'DELETE', credentials: 'same-origin' });
  if (!res.ok) return;
  appSettings.has_logo = false;
  renderBrand(); updateLogoPreview();
  toast('Logo removed.', 'success');
  log('branding: logo removed');
});

// ---- WhatsApp ----
function renderWhatsAppPrefState() {
  const enabled = appSettings.whatsapp_enabled;
  const el = document.getElementById('pref-wa-state');
  el.className = `wa-state ${enabled ? 'on' : 'off'}`;
  el.innerHTML = enabled
    ? `${icon('check', 15)}<span>WhatsApp notifications are <b>on</b>. The status button in the top bar shows whether the phone is paired.</span>`
    : `${icon('info', 15)}<span>WhatsApp notifications are <b>off</b>. Nobody gets WhatsApp messages; in-app notifications still work.</span>`;
  document.getElementById('pref-wa-check').hidden = !enabled;
}

document.getElementById('pref-wa-save').addEventListener('click', async () => {
  const settings = await api('/api/settings/whatsapp', { method: 'PUT', body: JSON.stringify({
    whatsapp_number: document.getElementById('pref-wa-number').value,
    whatsapp_enabled: document.getElementById('pref-wa-enabled').checked,
  }) });
  if (!settings) { document.getElementById('pref-wa-enabled').checked = appSettings.whatsapp_enabled; return; }
  appSettings = { ...appSettings, ...settings };
  document.getElementById('pref-wa-number').value = settings.whatsapp_number || '';
  renderWhatsAppPrefState();
  toast(`WhatsApp notifications ${settings.whatsapp_enabled ? 'enabled' : 'disabled'}.`, 'success');
  log(`whatsapp: ${settings.whatsapp_enabled ? 'enabled' : 'disabled'} (number ${settings.whatsapp_number || 'none'})`);
  waStatus = null;
  await refreshWhatsAppStatus();
  if (settings.whatsapp_enabled && waStatus && waStatus.status !== 'connected') openWhatsAppModal();
});
document.getElementById('pref-wa-check').addEventListener('click', openWhatsAppModal);

// ---- Email (SMTP) ----
const MAIL_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 587, security: 'starttls',
    hint: 'Gmail needs an <b>App password</b>, not your normal password: Google Account → Security → 2-Step Verification (turn on) → App passwords → create one and paste the 16 characters here. Username = your full Gmail address.' },
  outlook: { host: 'smtp.office365.com', port: 587, security: 'starttls',
    hint: 'Microsoft 365 / Outlook.com: username = your full email address. If sign-in is refused, your admin must enable "Authenticated SMTP" for the mailbox, or create an app password if 2-step verification is on.' },
  custom: { hint: "Use the SMTP details from your email provider or IT team (server, port, security, username and password)." },
};
let mailSettings = null;

function renderMailState() {
  const el = document.getElementById('pref-mail-state');
  const configured = mailSettings && mailSettings.source !== 'none';
  el.className = `wa-state ${configured ? 'on' : 'warn'}`;
  el.innerHTML = configured
    ? `${icon('check', 15)}<span>Email is <b>set up</b>${mailSettings.source === 'environment' ? ' (from the server\'s SMTP_* environment variables — saving here overrides them)' : ` via <b>${esc(mailSettings.host)}</b>`}. Send a test to make sure it's delivered.</span>`
    : `${icon('alert', 15)}<span>Email is <b>not set up</b>, so password-reset links and account emails <b>can't be sent</b>. Until it is, people who forget their password are told to contact an admin, and you get a notification to issue them a temporary password.</span>`;
  document.getElementById('pref-mail-source').textContent = configured ? '' : 'not configured';
  document.getElementById('pref-mail-disable').hidden = !(mailSettings && mailSettings.source === 'settings');
}

function applyMailPreset(key, fill = true) {
  const preset = MAIL_PRESETS[key];
  document.querySelectorAll('#pref-mail-presets button').forEach(b => b.classList.toggle('active', b.dataset.preset === key));
  const hint = document.getElementById('pref-mail-hint');
  hint.hidden = false;
  hint.innerHTML = `${icon('info', 15)}<span>${preset.hint}</span>`;
  if (fill && preset.host) {
    document.getElementById('pref-mail-host').value = preset.host;
    document.getElementById('pref-mail-port').value = preset.port;
    document.getElementById('pref-mail-security').value = preset.security;
  }
}
document.getElementById('pref-mail-presets').addEventListener('click', e => {
  const btn = e.target.closest('button[data-preset]');
  if (btn) applyMailPreset(btn.dataset.preset);
});
document.getElementById('pref-mail-security').addEventListener('change', e => {
  const port = document.getElementById('pref-mail-port');
  if (e.target.value === 'ssl' && (!port.value || port.value === '587')) port.value = 465;
  if (e.target.value === 'starttls' && (!port.value || port.value === '465')) port.value = 587;
});

async function loadEmailSettings() {
  mailSettings = await api('/api/settings/email');
  if (!mailSettings) return;
  document.getElementById('pref-mail-host').value = mailSettings.host;
  document.getElementById('pref-mail-port').value = mailSettings.port;
  document.getElementById('pref-mail-security').value = mailSettings.security;
  document.getElementById('pref-mail-user').value = mailSettings.user;
  document.getElementById('pref-mail-password').value = '';
  document.getElementById('pref-mail-password').placeholder = mailSettings.has_password ? '•••••••• saved — leave blank to keep' : '';
  document.getElementById('pref-mail-from').value = mailSettings.from_addr;
  document.getElementById('pref-mail-from-name').value = mailSettings.from_name;
  if (!document.getElementById('pref-mail-test-to').value) document.getElementById('pref-mail-test-to').value = currentUser.email || '';
  const host = mailSettings.host || '';
  applyMailPreset(host.includes('gmail') ? 'gmail' : /office365|outlook/.test(host) ? 'outlook' : host ? 'custom' : 'gmail', false);
  renderMailState();
}

async function saveEmailSettings() {
  const payload = {
    host: document.getElementById('pref-mail-host').value.trim(),
    port: document.getElementById('pref-mail-port').value,
    security: document.getElementById('pref-mail-security').value,
    user: document.getElementById('pref-mail-user').value.trim(),
    password: document.getElementById('pref-mail-password').value,
    from_addr: document.getElementById('pref-mail-from').value.trim(),
    from_name: document.getElementById('pref-mail-from-name').value.trim(),
  };
  if (!payload.host) return toast('Enter the SMTP server (or pick Gmail / Outlook above).', 'error'), null;
  const saved = await api('/api/settings/email', { method: 'PUT', body: JSON.stringify(payload) });
  if (saved) { log(`email: settings saved (${saved.host})`); await loadEmailSettings(); }
  return saved;
}
document.getElementById('pref-mail-save').addEventListener('click', async () => {
  if (await saveEmailSettings()) toast('Email settings saved — send a test to confirm delivery.', 'success');
});
document.getElementById('pref-mail-test').addEventListener('click', async e => {
  const to = document.getElementById('pref-mail-test-to').value.trim();
  if (!to) return toast('Enter an address to send the test to.', 'error');
  e.target.disabled = true;
  e.target.textContent = 'Sending…';
  // Save first if anything was typed, so the test uses what's on screen.
  const ok = document.getElementById('pref-mail-host').value.trim() ? await saveEmailSettings() : true;
  const r = ok && await api('/api/settings/email/test', { method: 'POST', body: JSON.stringify({ to }) });
  e.target.disabled = false;
  e.target.textContent = 'Send test email';
  if (r) { toast(r.message, 'success', 7000); log(`email: test sent to ${to}`); }
});
document.getElementById('pref-mail-disable').addEventListener('click', async () => {
  if (!confirm('Turn off email sending? Password-reset links will stop being emailed.')) return;
  if (await api('/api/settings/email', { method: 'PUT', body: JSON.stringify({ host: '' }) })) { toast('Email turned off.', 'success'); loadEmailSettings(); }
});
