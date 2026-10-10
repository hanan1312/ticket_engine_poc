"""The hotel architecture as a printable document: the site-plan whiteboard drawn as vectors,
a summary of every building, then each building's floors and rooms. Reuses the warehouse
documents' styles, tables, footer and logo watermark (and the company name / logo the host
app configured on them) so every PDF the app prints looks like one family."""
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import Flowable, KeepTogether, PageBreak, Paragraph, Spacer, Table, TableStyle

from warehouse import pdf as base

ROOM_COLUMNS = 4  # room ID / number pairs per row in the rooms table


class _SitePlan(Flowable):
    """The whiteboard's shapes, scaled to fit width x max_height (board y grows downwards,
    PDF y upwards, hence the flip)."""

    def __init__(self, shapes, width, max_height):
        super().__init__()
        self.shapes = shapes
        pad = 20
        self.x0 = min(s.x for s in shapes) - pad
        self.y0 = min(s.y for s in shapes) - pad
        span_w = max(s.x + s.w for s in shapes) + pad - self.x0
        span_h = max(s.y + s.h for s in shapes) + pad - self.y0
        self.scale = min(width / span_w, max_height / span_h)
        self.width, self.height = width, span_h * self.scale
        self.offset_x = (width - span_w * self.scale) / 2

    def _pt(self, x, y):
        return self.offset_x + (x - self.x0) * self.scale, self.height - (y - self.y0) * self.scale

    def draw(self):
        c = self.canv
        c.saveState()
        c.setStrokeColor(base.RULE)
        c.setLineWidth(0.6)
        c.rect(0, 0, self.width, self.height, stroke=1, fill=0)
        for s in self.shapes:
            self._shape(c, s)
        c.restoreState()

    def _shape(self, c, s):
        x, top = self._pt(s.x, s.y)
        w, h = s.w * self.scale, s.h * self.scale
        y = top - h
        c.setFillColor(colors.HexColor(s.fill))
        c.setStrokeColor(base.INK)
        c.setLineWidth(0.8)
        if s.kind == 'rect':
            c.rect(x, y, w, h, stroke=1, fill=1)
        elif s.kind == 'rounded':
            c.roundRect(x, y, w, h, min(w, h) * 0.15, stroke=1, fill=1)
        elif s.kind == 'ellipse':
            c.ellipse(x, y, x + w, y + h, stroke=1, fill=1)
        else:
            points = {
                'triangle': [(0.5, 1), (1, 0), (0, 0)],
                'diamond': [(0.5, 1), (1, 0.5), (0.5, 0), (0, 0.5)],
                'hexagon': [(0.25, 1), (0.75, 1), (1, 0.5), (0.75, 0), (0.25, 0), (0, 0.5)],
            }[s.kind]
            path = c.beginPath()
            path.moveTo(x + points[0][0] * w, y + points[0][1] * h)
            for px, py in points[1:]:
                path.lineTo(x + px * w, y + py * h)
            path.close()
            c.drawPath(path, stroke=1, fill=1)

        lines = _shape_lines(s)
        size = max(5, min(9, h / (len(lines) * 1.9 + 0.5)))
        c.setFillColor(base.INK)
        text_y = y + h / 2 + (len(lines) - 1) * size * 0.6 - size * 0.35
        for i, line in enumerate(lines):
            font = 'Helvetica-Bold' if i == 0 else 'Helvetica'
            c.setFont(font, size if i == 0 else size * 0.85)
            c.drawCentredString(x + w / 2, text_y, base._fit(c, line, font, size, w * 0.9))
            text_y -= size * 1.2


def _shape_lines(s):
    if s.building is not None:
        return [s.building.name, s.building.code]
    return [line for line in (s.text or '').split('\n') if line.strip()][:3] or ['']


def architecture_pdf(buildings, shapes, include_rooms=True):
    st = base._styles()
    story = [Paragraph(base._company_name_provider(), st['company']),
             Paragraph('Hotel Architecture', st['title']),
             Paragraph(f'{len(buildings)} building(s) · {sum(len(b.floors) for b in buildings)} floor(s) · '
                       f'{sum(len(f.rooms) for b in buildings for f in b.floors)} room(s)', st['small'])]
    rule = Table([['']], colWidths=[178 * mm], rowHeights=[2 * mm])
    rule.setStyle(TableStyle([('LINEBELOW', (0, 0), (-1, -1), 1.2, base.PRIMARY)]))
    story += [rule, Spacer(1, 5 * mm)]

    if shapes:
        story.append(Paragraph('Site plan', st['h']))
        story.append(_SitePlan(shapes, 178 * mm, 130 * mm))

    story.append(Paragraph('Buildings', st['h']))
    if buildings:
        story.append(base._lines_table(
            ['ID', 'Name', 'Floors', 'Rooms', 'Rooms per floor'],
            [[b.code, b.name, len(b.floors), sum(len(f.rooms) for f in b.floors),
              _per_floor_summary(b)] for b in buildings],
            [22 * mm, None, 16 * mm, 16 * mm, 70 * mm], st))
    else:
        story.append(Paragraph('No buildings yet.', st['body']))

    for b in buildings:
        story.append(PageBreak())
        story.append(Paragraph(f'{b.name} <font color="#6e6680">· {b.code}</font>', st['title']))
        story.append(base._meta_table([('Building ID', b.code), ('Name', b.name),
                                       ('Floors', len(b.floors)),
                                       ('Rooms', sum(len(f.rooms) for f in b.floors))], st))
        story.append(Paragraph('Floors', st['h']))
        if not b.floors:
            story.append(Paragraph('No floors.', st['body']))
            continue
        story.append(base._lines_table(
            ['Floor ID', 'Name', 'Rooms'],
            [[f.code, f.name or f'Floor {f.number}', len(f.rooms)] for f in b.floors],
            [34 * mm, None, 20 * mm], st))
        if include_rooms:
            for f in b.floors:
                if f.rooms:
                    story.append(KeepTogether([Paragraph(f'Rooms — {f.name or f"Floor {f.number}"} ({f.code})', st['h']),
                                               _rooms_table(f.rooms, st)]))
    return base._build(story, 'Hotel architecture')


def _per_floor_summary(building):
    counts = [len(f.rooms) for f in building.floors]
    if not counts:
        return '—'
    if len(set(counts)) == 1:
        return f'{counts[0]} on every floor'
    return ', '.join(f'F{f.number}: {len(f.rooms)}' for f in building.floors)


def _rooms_table(rooms, st):
    """Room ID / number pairs, ROOM_COLUMNS pairs to a row to keep long floors compact."""
    header = ['Room ID', 'No.'] * ROOM_COLUMNS
    cells = [[r.code, r.number] for r in rooms]
    rows = []
    for i in range(0, len(cells), ROOM_COLUMNS):
        chunk = cells[i:i + ROOM_COLUMNS]
        chunk += [['', '']] * (ROOM_COLUMNS - len(chunk))
        rows.append([v for pair in chunk for v in pair])
    return base._lines_table(header, rows, [29 * mm, 14 * mm] * ROOM_COLUMNS, st)
