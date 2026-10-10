"""Printable documents for the warehouse: purchase orders (bills), work-order delivery notes,
and sheets of barcode labels with adjustable margins. Built with reportlab (pure Python,
no system dependencies) -- Code128 for barcodes since it encodes the full WB-000001-abc123
/ AST-... alphabet compactly and every USB scanner reads it."""
import io
from dataclasses import dataclass, fields
from datetime import datetime

from reportlab.graphics.barcode import code128
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.platypus import (
    Flowable, Image, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

# Set by the host app (see demo/app.py) so documents carry the configured company name
# without this package importing the app's branding settings.
_company_name_provider = lambda: 'AssetFlow'  # noqa: E731

PRIMARY = colors.HexColor('#5b21b6')
INK = colors.HexColor('#1f1a2e')
MUTED = colors.HexColor('#6e6680')
RULE = colors.HexColor('#e4dff0')
TINT = colors.HexColor('#f5f3ff')


def set_company_name_provider(fn):
    global _company_name_provider
    _company_name_provider = fn


# Returns the uploaded logo's raw bytes, or None. Set by the host app, same reasoning as the
# company name. Used for the header logo and the faint page watermark on documents (not on
# barcode label sheets). SVG logos can't be embedded by reportlab and are skipped.
_logo_provider = lambda: None  # noqa: E731
WATERMARK_ALPHA = 0.06


def set_logo_provider(fn):
    global _logo_provider
    _logo_provider = fn


def _logo():
    """(raw_bytes, ImageReader) for the logo, or (None, None)."""
    try:
        data = _logo_provider()
        return (data, ImageReader(io.BytesIO(data))) if data else (None, None)
    except Exception:  # unreadable/unsupported image (e.g. SVG) -- documents just go without
        return None, None


def _styles():
    base = getSampleStyleSheet()
    return {
        'title': ParagraphStyle('t', parent=base['Title'], fontName='Helvetica-Bold', fontSize=18,
                                textColor=INK, alignment=0, spaceAfter=2, leading=22),
        'company': ParagraphStyle('c', parent=base['Normal'], fontName='Helvetica-Bold', fontSize=11,
                                  textColor=PRIMARY, leading=14),
        'small': ParagraphStyle('s', parent=base['Normal'], fontSize=8.5, textColor=MUTED, leading=11),
        'body': ParagraphStyle('b', parent=base['Normal'], fontSize=9.5, textColor=INK, leading=13),
        'h': ParagraphStyle('h', parent=base['Normal'], fontName='Helvetica-Bold', fontSize=10,
                            textColor=INK, spaceBefore=10, spaceAfter=5),
        'cell': ParagraphStyle('cell', parent=base['Normal'], fontSize=9, textColor=INK, leading=11),
    }


class _Barcode(Flowable):
    """A Code128 barcode flowable scaled to a target width, with its human-readable text."""

    def __init__(self, value, width, height=12 * mm, show_text=True):
        super().__init__()
        self.value, self.target_w, self.bar_h, self.show_text = value, width, height, show_text
        self.width, self.height = width, height + (4 * mm if show_text else 0)

    def draw(self):
        _draw_code128(self.canv, self.value, 0, 4 * mm if self.show_text else 0,
                      self.target_w, self.bar_h)
        if self.show_text:
            self.canv.setFont('Courier', 7.5)
            self.canv.setFillColor(INK)
            self.canv.drawCentredString(self.target_w / 2, 0.8 * mm, self.value)


def _draw_code128(c, value, x, y, max_w, bar_h):
    """Draws a Code128 barcode centred in [x, x+max_w], as wide as fits (barWidth scaled)."""
    probe = code128.Code128(value, barWidth=1, barHeight=bar_h, quiet=False)
    bar_w = max(min(max_w / probe.width, 0.6 * mm), 0.12 * mm)
    bc = code128.Code128(value, barWidth=bar_w, barHeight=bar_h, quiet=False)
    bc.drawOn(c, x + (max_w - bc.width) / 2, y)


def _fmt_dt(value):
    if value is None:
        return '—'
    if isinstance(value, datetime):
        return value.strftime('%Y-%m-%d %H:%M')
    return value.isoformat()


def _header(doc_title, doc_number, st, subtitle=None):
    left = [Paragraph(_company_name_provider(), st['company']),
            Paragraph(doc_title, st['title'])]
    if subtitle:
        left.append(Paragraph(subtitle, st['small']))
    data, logo = _logo()
    if logo is not None:
        w, h = logo.getSize()
        box = 20 * mm  # fit within a 20mm square, keeping the aspect ratio
        scale = min(box / w, box / h)
        brand = Table([[Image(io.BytesIO(data), width=w * scale, height=h * scale), left]],
                      colWidths=[w * scale + 4 * mm, None])
        brand.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                                   ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0)]))
        left = brand
    t = Table([[left, _Barcode(doc_number, 62 * mm, 11 * mm)]], colWidths=[None, 66 * mm])
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('ALIGN', (1, 0), (1, 0), 'RIGHT'),
                           ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                           ('LINEBELOW', (0, 0), (-1, 0), 1.2, PRIMARY), ('BOTTOMPADDING', (0, 0), (-1, -1), 8)]))
    return [t, Spacer(1, 6 * mm)]


def _meta_table(pairs, st):
    """Two-column key/value grid (4 cells per row)."""
    rows, row = [], []
    for k, v in pairs:
        row += [Paragraph(k, st['small']), Paragraph(str(v if v not in (None, '') else '—'), st['body'])]
        if len(row) == 4:
            rows.append(row)
            row = []
    if row:
        rows.append(row + [''] * (4 - len(row)))
    t = Table(rows, colWidths=[30 * mm, None, 30 * mm, None])
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('BACKGROUND', (0, 0), (-1, -1), TINT),
                           ('TOPPADDING', (0, 0), (-1, -1), 4), ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
                           ('BOX', (0, 0), (-1, -1), 0.5, RULE)]))
    return t


def _lines_table(header, rows, col_widths, st, total_row=None):
    header_style = ParagraphStyle('hdr', parent=st['cell'], textColor=colors.white, fontName='Helvetica-Bold')
    data = [[Paragraph(h, header_style) for h in header]]
    data += [[Paragraph(str(c), st['cell']) for c in r] for r in rows]
    if total_row:
        data.append([Paragraph(f'<b>{c}</b>', st['cell']) for c in total_row])
    t = Table(data, colWidths=col_widths, repeatRows=1)
    style = [('BACKGROUND', (0, 0), (-1, 0), PRIMARY), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
             ('LINEBELOW', (0, 1), (-1, -1), 0.4, RULE), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
             ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5)]
    for i in range(1, len(data)):
        if i % 2 == 0:
            style.append(('BACKGROUND', (0, i), (-1, i), colors.HexColor('#faf9fd')))
    if total_row:
        style.append(('LINEABOVE', (0, -1), (-1, -1), 1, INK))
    t.setStyle(TableStyle(style))
    return t


def _signatures(labels, st):
    cells = [[Paragraph(f'{l}<br/><br/><br/>________________________<br/>'
                        f'<font size="7.5" color="#6e6680">Name / signature / date</font>', st['body'])
              for l in labels]]
    t = Table(cells, colWidths=[None] * len(labels))
    t.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('TOPPADDING', (0, 0), (-1, -1), 14)]))
    return KeepTogether([Paragraph('Sign-off', st['h']), t])


def _watermark(c, doc):
    """The logo, large and very faint, centred behind the page's content (page callbacks run
    before the page's flowables are drawn, so it sits underneath)."""
    _, logo = _logo()
    if logo is None:
        return
    page_w, page_h = doc.pagesize
    w, h = logo.getSize()
    scale = min(page_w * 0.62 / w, page_h * 0.45 / h)
    c.saveState()
    c.setFillAlpha(WATERMARK_ALPHA)  # PDF non-stroking alpha also applies to images
    c.drawImage(logo, (page_w - w * scale) / 2, (page_h - h * scale) / 2, w * scale, h * scale,
                mask='auto', preserveAspectRatio=True)
    c.restoreState()


def _footer(c, doc):
    _watermark(c, doc)
    c.saveState()
    c.setFont('Helvetica', 7.5)
    c.setFillColor(MUTED)
    c.drawString(doc.leftMargin, 10 * mm, f'Generated {datetime.now().strftime("%Y-%m-%d %H:%M")} · {_company_name_provider()}')
    c.drawRightString(doc.pagesize[0] - doc.rightMargin, 10 * mm, f'Page {doc.page}')
    c.restoreState()


def _build(story, title):
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm,
                            topMargin=14 * mm, bottomMargin=18 * mm, title=title,
                            author=_company_name_provider())
    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buf.getvalue()


BILL_STATUS = {'demanded': 'Awaiting approval', 'ordered': 'Approved — ordered', 'delivered': 'Delivered'}


def purchase_order_pdf(bills, batches_by_bill):
    st = _styles()
    first = bills[0]
    number = first.group_ref or first.order_id
    story = _header('Purchase Order', number, st, subtitle=f'{len(bills)} line(s)')
    statuses = {BILL_STATUS.get(b.status, b.status) for b in bills}
    story.append(_meta_table([
        ('PO number', number), ('Status', ', '.join(sorted(statuses))),
        ('Requested by', first.created_by), ('Requested on', _fmt_dt(first.created_at)),
        ('Approved by', first.approved_by), ('Approved on', _fmt_dt(first.approved_at)),
        ('Note', first.note),
    ], st))
    story.append(Paragraph('Items', st['h']))
    rows, total = [], 0.0
    for i, b in enumerate(bills, start=1):
        total += b.total_price or 0
        rows.append([i, f'{b.item_name}<br/><font size="7.5" color="#6e6680">{b.item.sku if b.item and b.item.sku else ""}</font>',
                     b.category or '', f'{b.ordered_stock} {b.unit or ""}',
                     f'{(b.price_per_unit or 0):.2f}', f'{(b.total_price or 0):.2f}',
                     BILL_STATUS.get(b.status, b.status)])
    story.append(_lines_table(['#', 'Item', 'Category', 'Qty', 'Unit price', 'Line total', 'Status'], rows,
                              [8 * mm, None, 24 * mm, 20 * mm, 20 * mm, 22 * mm, 30 * mm], st,
                              total_row=['', 'Total', '', '', '', f'{total:.2f}', '']))

    received = [(b, batches_by_bill.get(b.id)) for b in bills if batches_by_bill.get(b.id)]
    if received:
        story.append(Paragraph('Deliveries received', st['h']))
        story.append(_lines_table(
            ['Item', 'Delivered on', 'Accepted by', 'Qty received', 'Expiry', 'Batch barcode'],
            [[b.item_name, _fmt_dt(b.delivered_on), b.accepted_by or batch.received_by or '—',
              batch.quantity_received, _fmt_dt(batch.expiry_date), batch.barcode] for b, batch in received],
            [None, 24 * mm, 26 * mm, 22 * mm, 22 * mm, 40 * mm], st))
    story.append(_signatures(['Requested by', 'Approved by', 'Received by (warehouse)'], st))
    return _build(story, f'Purchase order {number}')


WO_STATUS = {'requested': 'Awaiting approval', 'approved': 'Approved', 'completed': 'Issued',
             'rejected': 'Rejected'}


def work_order_pdf(order, scans):
    from .models import WarehouseBatch
    st = _styles()
    number = f'WO-{order.id:05d}'
    via = {'barcode': ' (barcode scan)', 'sku': ' (SKU entered)'}.get(order.delivery_confirmed_via or '', '')
    delivery_state = ('Confirmed ' + _fmt_dt(order.delivery_confirmed_at) + via) if order.delivery_confirmed_at \
        else ('Awaiting recipient confirmation' if order.status == 'completed' else '—')
    story = _header('Work Order · Delivery Note', number, st)
    story.append(_meta_table([
        ('Work order', number), ('Status', WO_STATUS.get(order.status, order.status)),
        ('Requested by', order.requested_by), ('Requested on', _fmt_dt(order.created_at)),
        ('Approved by', order.approved_by), ('Approved on', _fmt_dt(order.approved_at)),
        ('Deliver to', order.deliver_to), ('Delivery date', _fmt_dt(order.delivery_date)),
        ('Receipt', delivery_state), ('Note', order.note),
    ], st))
    story.append(Paragraph('Items', st['h']))
    unit = order.item.unit if order.item else ''
    story.append(_lines_table(['Item', 'SKU', 'Category', 'Requested', 'Issued'],
                              [[order.item.name, order.item.sku or '—', order.item.category,
                                f'{order.quantity} {unit or ""}', f'{order.quantity_fulfilled} {unit or ""}']],
                              [None, 30 * mm, 30 * mm, 24 * mm, 24 * mm], st))
    if scans:
        story.append(Paragraph('Issued from batches', st['h']))
        story.append(_lines_table(['#', 'Batch barcode', 'Expiry', 'Issued by', 'Issued at', 'FEFO'],
                                  [[i, (b := WarehouseBatch.query.get(sc.batch_id)).barcode, _fmt_dt(b.expiry_date),
                                    sc.scanned_by, _fmt_dt(sc.scanned_at), 'override' if sc.fefo_violation else 'ok']
                                   for i, sc in enumerate(scans, start=1)],
                                  [8 * mm, None, 24 * mm, 26 * mm, 32 * mm, 18 * mm], st))
    story.append(_signatures(['Issued by (warehouse)', 'Delivered by', f'Received by ({order.deliver_to or "recipient"})'], st))
    return _build(story, f'Work order {number}')


# ---- Barcode label sheets ----

PAGE_SIZES = {'A4': A4, 'Letter': letter}


@dataclass
class LabelOptions:
    page: str = 'A4'
    margin_top: float = 10.0     # all lengths in mm
    margin_right: float = 10.0
    margin_bottom: float = 10.0
    margin_left: float = 10.0
    label_width: float = 63.5
    label_height: float = 38.1
    gap_x: float = 2.5
    gap_y: float = 0.0
    padding: float = 2.5
    copies: int = 1
    show_title: bool = True
    show_code: bool = True
    show_border: bool = True

    @classmethod
    def from_dict(cls, data):
        opts = cls()
        for f in fields(cls):
            if f.name not in data or data[f.name] in (None, ''):
                continue
            raw = data[f.name]
            try:
                if f.type is bool:
                    value = raw if isinstance(raw, bool) else str(raw).lower() in ('1', 'true', 'yes', 'on')
                else:
                    value = f.type(raw)
            except (TypeError, ValueError):
                raise ValueError(f'{f.name.replace("_", " ")} must be a number')
            setattr(opts, f.name, value)
        if opts.page not in PAGE_SIZES:
            raise ValueError('page must be A4 or Letter')
        page_w, page_h = (d / mm for d in PAGE_SIZES[opts.page])
        for name in ('margin_top', 'margin_right', 'margin_bottom', 'margin_left', 'gap_x', 'gap_y', 'padding'):
            if not 0 <= getattr(opts, name) <= 100:
                raise ValueError(f'{name.replace("_", " ")} must be between 0 and 100 mm')
        if opts.label_width < 15 or opts.label_height < 8:
            raise ValueError('labels must be at least 15 mm wide and 8 mm tall')
        if opts.margin_left + opts.margin_right + opts.label_width > page_w or \
                opts.margin_top + opts.margin_bottom + opts.label_height > page_h:
            raise ValueError("a label doesn't fit on the page with these margins")
        if not 1 <= opts.copies <= 500:
            raise ValueError('copies must be between 1 and 500')
        return opts


def barcode_labels_pdf(labels, opts):
    page_w, page_h = PAGE_SIZES[opts.page]
    lw, lh = opts.label_width * mm, opts.label_height * mm
    gx, gy, pad = opts.gap_x * mm, opts.gap_y * mm, opts.padding * mm
    usable_w = page_w - (opts.margin_left + opts.margin_right) * mm
    usable_h = page_h - (opts.margin_top + opts.margin_bottom) * mm
    cols = max(int((usable_w + gx) // (lw + gx)), 1)
    rows = max(int((usable_h + gy) // (lh + gy)), 1)

    expanded = [l for l in labels for _ in range(opts.copies)]
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(page_w, page_h))
    c.setTitle('Barcode labels')
    per_page = cols * rows
    for idx, label in enumerate(expanded):
        if idx and idx % per_page == 0:
            c.showPage()
        slot = idx % per_page
        col, row = slot % cols, slot // cols
        x = opts.margin_left * mm + col * (lw + gx)
        y = page_h - opts.margin_top * mm - (row + 1) * lh - row * gy
        if opts.show_border:
            c.setStrokeColor(colors.HexColor('#c9c2d9'))
            c.setDash(2, 2)
            c.setLineWidth(0.4)
            c.roundRect(x, y, lw, lh, 1.5 * mm)
            c.setDash()

        inner_w = lw - 2 * pad
        top = y + lh - pad
        bottom = y + pad
        title = (label.get('title') or '').strip() if opts.show_title else ''
        subtitle = (label.get('subtitle') or '').strip() if opts.show_title else ''
        c.setFillColor(INK)
        if title:
            size = min(9, max(6, lh / mm / 4.5))
            c.setFont('Helvetica-Bold', size)
            c.drawCentredString(x + lw / 2, top - size, _fit(c, title, 'Helvetica-Bold', size, inner_w))
            top -= size + 1.5
        if subtitle:
            c.setFont('Helvetica', 6.5)
            c.setFillColor(MUTED)
            c.drawCentredString(x + lw / 2, top - 6.5, _fit(c, subtitle, 'Helvetica', 6.5, inner_w))
            top -= 8
        code = label['code'].strip()
        if opts.show_code:
            c.setFont('Courier', 7)
            c.setFillColor(INK)
            c.drawCentredString(x + lw / 2, bottom, code)
            bottom += 9
        bar_h = max(top - bottom - 1, 4 * mm * 0.5)
        _draw_code128(c, code, x + pad, bottom, inner_w, bar_h)
    c.save()
    return buf.getvalue()


def _fit(c, text, font, size, max_w):
    if c.stringWidth(text, font, size) <= max_w:
        return text
    while text and c.stringWidth(text + '…', font, size) > max_w:
        text = text[:-1]
    return text + '…'
