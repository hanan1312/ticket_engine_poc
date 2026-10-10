// Barcode label printing: a live-preview dialog around POST /api/warehouse/barcodes/pdf.
// Margins, label size, spacing and copies are adjustable before printing; the last-used
// layout is remembered per browser so a label-sheet setup only has to be dialled in once.

const LABEL_PRESETS = {
  avery_l7160: { name: 'A4 · 21 per sheet (63.5 × 38.1 mm)', page: 'A4', label_width: 63.5, label_height: 38.1, gap_x: 2.5, gap_y: 0, margin_top: 15.1, margin_bottom: 15.1, margin_left: 7.2, margin_right: 7.2 },
  avery_l7651: { name: 'A4 · 65 per sheet (38.1 × 21.2 mm)', page: 'A4', label_width: 38.1, label_height: 21.2, gap_x: 2.5, gap_y: 0, margin_top: 10.7, margin_bottom: 10.7, margin_left: 4.7, margin_right: 4.7 },
  avery_l7163: { name: 'A4 · 14 per sheet (99.1 × 38.1 mm)', page: 'A4', label_width: 99.1, label_height: 38.1, gap_x: 2.5, gap_y: 0, margin_top: 15.1, margin_bottom: 15.1, margin_left: 4.7, margin_right: 4.7 },
  letter_5160: { name: 'Letter · 30 per sheet (66.7 × 25.4 mm)', page: 'Letter', label_width: 66.7, label_height: 25.4, gap_x: 3.2, gap_y: 0, margin_top: 12.7, margin_bottom: 12.7, margin_left: 4.8, margin_right: 4.8 },
  large: { name: 'Large · 100 × 50 mm', page: 'A4', label_width: 100, label_height: 50, gap_x: 5, gap_y: 5, margin_top: 10, margin_bottom: 10, margin_left: 5, margin_right: 5 },
};
const LABEL_DEFAULTS = { preset: 'avery_l7160', ...LABEL_PRESETS.avery_l7160, padding: 2.5, copies: 1, show_title: true, show_code: true, show_border: true };
const LABEL_NUMBER_FIELDS = ['margin_top', 'margin_right', 'margin_bottom', 'margin_left', 'label_width', 'label_height', 'gap_x', 'gap_y', 'padding'];

function loadLabelOptions() {
  try { return { ...LABEL_DEFAULTS, ...JSON.parse(storageGet('label-options') || '{}') }; } catch { return { ...LABEL_DEFAULTS }; }
}

const PAGE_MM = { A4: [210, 297], Letter: [215.9, 279.4] };

// Mirrors warehouse/pdf.py barcode_labels_pdf's grid maths, so the preview matches the PDF.
function labelGrid(o) {
  const [pw, ph] = PAGE_MM[o.page];
  const cols = Math.max(Math.floor((pw - o.margin_left - o.margin_right + o.gap_x) / (o.label_width + o.gap_x)), 1);
  const rows = Math.max(Math.floor((ph - o.margin_top - o.margin_bottom + o.gap_y) / (o.label_height + o.gap_y)), 1);
  const fits = o.margin_left + o.margin_right + o.label_width <= pw && o.margin_top + o.margin_bottom + o.label_height <= ph
    && o.label_width >= 15 && o.label_height >= 8;
  return { pw, ph, cols, rows, fits };
}

// Deterministic pseudo-barcode stripes for the preview (the real Code128 is in the PDF).
function stripes(code, x, y, w, h) {
  let out = '', cx = x, i = 0;
  const seed = [...code].map(c => c.charCodeAt(0));
  while (cx < x + w - 0.3) {
    const bw = 0.25 + (seed[i % seed.length] % 3) * 0.22;
    if (i % 2 === 0) out += `<rect x="${cx.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${h.toFixed(2)}"/>`;
    cx += bw + 0.18 + (seed[(i + 3) % seed.length] % 2) * 0.2;
    i++;
  }
  return out;
}

function renderLabelPreview(labels, o) {
  const g = labelGrid(o);
  const total = labels.length * o.copies;
  const perPage = g.cols * g.rows;
  const expanded = [];
  for (const l of labels) for (let c = 0; c < o.copies && expanded.length < perPage; c++) expanded.push(l);
  const t = (s, n) => esc(s.length > n ? s.slice(0, n - 1) + '…' : s);
  let cells = '';
  expanded.forEach((l, idx) => {
    const col = idx % g.cols, row = Math.floor(idx / g.cols);
    const x = o.margin_left + col * (o.label_width + o.gap_x);
    const y = o.margin_top + row * (o.label_height + o.gap_y);
    const pad = o.padding, iw = o.label_width - 2 * pad;
    let top = y + pad, bottom = y + o.label_height - pad;
    const maxChars = Math.max(Math.floor(iw / 1.9), 4);
    if (o.show_border) cells += `<rect x="${x}" y="${y}" width="${o.label_width}" height="${o.label_height}" rx="1.5" class="lp-label"/>`;
    if (o.show_title && l.title) {
      const fs = Math.min(3.2, Math.max(2.1, o.label_height / 12.7));
      cells += `<text x="${x + o.label_width / 2}" y="${top + fs}" font-size="${fs}" class="lp-title">${t(l.title, maxChars)}</text>`;
      top += fs + 0.8;
      if (l.subtitle) { cells += `<text x="${x + o.label_width / 2}" y="${top + 2.1}" font-size="2.1" class="lp-sub">${t(l.subtitle, maxChars)}</text>`; top += 2.9; }
    }
    if (o.show_code) { cells += `<text x="${x + o.label_width / 2}" y="${bottom}" font-size="2.3" class="lp-code">${t(l.code, maxChars + 4)}</text>`; bottom -= 3.3; }
    const bh = Math.max(bottom - top - 0.5, 1.5);
    cells += `<g class="lp-bars">${stripes(l.code, x + pad + iw * 0.06, top + 0.3, iw * 0.88, bh)}</g>`;
  });
  const usableW = g.pw - o.margin_left - o.margin_right, usableH = g.ph - o.margin_top - o.margin_bottom;
  return {
    svg: `<svg viewBox="-4 -4 ${g.pw + 8} ${g.ph + 8}" class="label-sheet" role="img" aria-label="Page 1 preview">
      <rect x="0" y="0" width="${g.pw}" height="${g.ph}" class="lp-page"/>
      <rect x="${o.margin_left}" y="${o.margin_top}" width="${Math.max(usableW, 0)}" height="${Math.max(usableH, 0)}" class="lp-margin"/>
      ${g.fits ? cells : ''}</svg>`,
    summary: `${total} label${total === 1 ? '' : 's'} · ${g.cols} × ${g.rows} per page · ${Math.ceil(total / perPage)} page(s)`,
    error: g.fits ? null : "A label doesn't fit on the page with these margins and sizes.",
  };
}

let labelPreviewUrl = null;

function openBarcodePrintDialog(labels, { copies, backTo } = {}) {
  const opts = loadLabelOptions();
  if (copies) opts.copies = Math.min(copies, 500);
  const numberInput = (name, label) =>
    `<label class="field compact"><span>${label}</span><div class="input-unit"><input type="number" step="0.1" min="0" name="${name}" value="${opts[name]}"><em>mm</em></div></label>`;

  openFormModal({
    keepHistory: !!backTo,
    size: 'wide',
    title: `${icon('printer', 18)} Print barcode labels`,
    sub: `${labels.length} barcode${labels.length === 1 ? '' : 's'}: ${labels.slice(0, 3).map(l => esc(l.code)).join(', ')}${labels.length > 3 ? '…' : ''}`,
    body: `
      <div class="print-layout">
        <div class="print-controls" id="label-form">
          <label class="field"><span>Label sheet</span>
            <select name="preset">
              ${Object.entries(LABEL_PRESETS).map(([k, p]) => `<option value="${k}" ${opts.preset === k ? 'selected' : ''}>${p.name}</option>`).join('')}
              <option value="custom" ${opts.preset === 'custom' ? 'selected' : ''}>Custom size…</option>
            </select></label>
          <div class="form-grid two">
            <label class="field compact"><span>Page</span><select name="page"><option ${opts.page === 'A4' ? 'selected' : ''}>A4</option><option ${opts.page === 'Letter' ? 'selected' : ''}>Letter</option></select></label>
            <label class="field compact"><span>Copies of each</span><input type="number" min="1" max="500" name="copies" value="${opts.copies}"></label>
          </div>
          <p class="group-label">Page margins</p>
          <div class="margin-box">
            <div class="mb-top">${numberInput('margin_top', 'Top')}</div>
            <div class="mb-left">${numberInput('margin_left', 'Left')}</div>
            <div class="mb-page">page</div>
            <div class="mb-right">${numberInput('margin_right', 'Right')}</div>
            <div class="mb-bottom">${numberInput('margin_bottom', 'Bottom')}</div>
          </div>
          <p class="group-label">Label size &amp; spacing</p>
          <div class="form-grid two">
            ${numberInput('label_width', 'Width')}${numberInput('label_height', 'Height')}
            ${numberInput('gap_x', 'Gap across')}${numberInput('gap_y', 'Gap down')}
            ${numberInput('padding', 'Inner padding')}
          </div>
          <div class="toggle-list">
            <label class="switch-row"><input type="checkbox" name="show_title" ${opts.show_title ? 'checked' : ''}><span class="switch"></span>Item name on label</label>
            <label class="switch-row"><input type="checkbox" name="show_code" ${opts.show_code ? 'checked' : ''}><span class="switch"></span>Code text under barcode</label>
            <label class="switch-row"><input type="checkbox" name="show_border" ${opts.show_border ? 'checked' : ''}><span class="switch"></span>Dashed cut guides</label>
          </div>
          <button class="link-btn" id="label-reset" type="button">Reset to defaults</button>
        </div>
        <div class="print-preview">
          <div class="preview-head"><span id="label-summary" class="muted"></span><span class="muted">Page 1 preview · to scale</span></div>
          <div class="label-preview" id="label-preview"></div>
          <p class="preview-error" id="label-error" hidden></p>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-outline" id="label-open">${icon('file', 14)} Open PDF</button>
        <button class="btn-primary" id="label-print">${icon('printer', 14)} Print</button>
      </div>`,
  });

  const form = document.getElementById('label-form');
  const read = () => {
    const v = formValues(form);
    const out = { preset: v.preset, page: v.page, copies: parseInt(v.copies, 10) || 1,
      show_title: v.show_title, show_code: v.show_code, show_border: v.show_border };
    LABEL_NUMBER_FIELDS.forEach(f => { out[f] = parseFloat(v[f]); });
    return out;
  };
  const refresh = () => {
    const current = read();
    storageSet('label-options', JSON.stringify(current));
    const preview = renderLabelPreview(labels, current);
    document.getElementById('label-preview').innerHTML = preview.svg;
    document.getElementById('label-summary').textContent = preview.summary;
    const errEl = document.getElementById('label-error');
    errEl.hidden = !preview.error;
    errEl.textContent = preview.error || '';
    labelPreviewUrl = null;  // options changed -- the next Print/Open builds a fresh PDF
  };
  // The real PDF is only built when printing/opening; the server re-validates the layout.
  const buildPdf = async () => {
    if (labelPreviewUrl) return labelPreviewUrl;
    const { preset, ...options } = read();
    const result = await apiBlobUrl('/api/warehouse/barcodes/pdf', { labels, options });
    if (result.error) { toast(result.error, 'error'); return null; }
    labelPreviewUrl = result.url;
    return result.url;
  };
  const schedule = refresh;

  form.addEventListener('input', e => {
    if (e.target.name === 'preset') {
      const preset = LABEL_PRESETS[e.target.value];
      if (preset) Object.entries(preset).forEach(([k, val]) => { const el = form.querySelector(`[name="${k}"]`); if (el) el.value = val; });
    } else if (/^(label_|gap_|margin_)/.test(e.target.name) || e.target.name === 'page') {
      form.querySelector('[name="preset"]').value = 'custom';
    }
    schedule();
  });
  document.getElementById('label-reset').addEventListener('click', () => {
    storageSet('label-options', '{}');
    openBarcodePrintDialog(labels, { copies, backTo });
  });
  document.getElementById('label-open').addEventListener('click', async () => {
    const url = await buildPdf();
    if (url) window.open(url, '_blank');
  });
  document.getElementById('label-print').addEventListener('click', async () => {
    const url = await buildPdf();
    if (!url) return;
    // Print straight from a hidden frame where the browser can; otherwise open the PDF to print it there.
    let frame = document.getElementById('label-print-frame');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'label-print-frame';
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
      document.body.appendChild(frame);
    }
    frame.onload = () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { window.open(url, '_blank'); }
    };
    if (MOBILE_QUERY.matches) window.open(url, '_blank'); else frame.src = url;
  });
  refresh();
}
