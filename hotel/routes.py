import re

from flask import Blueprint, Response, jsonify, request

from auth_engine import get_current_user, login_required
from auth_engine.models import UserPermission
from shared_db import db

from . import pdf
from .models import BoardShape, Building, Floor, Room

bp = Blueprint('hotel', __name__, url_prefix='/api/hotel')

# Everyone signed in can read the layout (asset locations are picked from it); changing it needs
# the Hotel architecture tab's permission, "hotel" (admins always have it).
CODE_RE = re.compile(r'^[A-Z0-9][A-Z0-9-]{0,19}$')
ROOM_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]{0,19}$')
COLOR_RE = re.compile(r'^#[0-9a-fA-F]{6}$')
SHAPE_KINDS = {'rect', 'rounded', 'ellipse', 'triangle', 'diamond', 'hexagon'}
BOARD_W, BOARD_H = 1600, 1000
MAX_FLOORS, MAX_ROOMS_PER_FLOOR = 200, 500


def _admin_error():
    user = get_current_user()
    if user is None or (user.role != 'admin' and UserPermission.query.filter_by(
            user_id=user.id, permission='hotel').first() is None):
        return jsonify({'error': "Changing the hotel architecture needs the 'hotel' permission"}), 403
    return None


def _int(raw, field, lo, hi):
    """Returns (int, None) or (None, error message)."""
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None, f'{field} must be a whole number'
    if not lo <= value <= hi:
        return None, f'{field} must be between {lo} and {hi}'
    return value, None


# ---- JSON ----

def _room_json(r):
    return {'id': r.id, 'code': r.code, 'number': r.number, 'floor_id': r.floor_id}


def _floor_json(f):
    return {'id': f.id, 'code': f.code, 'number': f.number, 'name': f.name or f'Floor {f.number}',
            'building_id': f.building_id, 'room_count': len(f.rooms),
            'rooms': [_room_json(r) for r in f.rooms]}


def _building_json(b):
    shape = BoardShape.query.filter_by(building_id=b.id).first()
    return {'id': b.id, 'code': b.code, 'name': b.name, 'floor_count': len(b.floors),
            'room_count': sum(len(f.rooms) for f in b.floors),
            'floors': [_floor_json(f) for f in b.floors],
            'shape_id': shape.id if shape else None}


def _shape_json(s):
    return {'id': s.id, 'building_id': s.building_id, 'kind': s.kind, 'x': s.x, 'y': s.y,
            'w': s.w, 'h': s.h, 'fill': s.fill, 'text': s.text or '', 'z': s.z}


# ---- Keeping floors and rooms in sync with a building's spec ----

def _next_room_number(floor, taken):
    """Next free default door number on this floor: 101, 102... for floor 1."""
    index = 1
    while True:
        candidate = f'{floor.number}{index:02d}'
        if candidate not in taken:
            return candidate
        index += 1


def _resize_rooms(floor, count):
    """Adds rooms at the end or removes them from the end, so existing door numbers (which
    people may have edited) are kept."""
    rooms = list(floor.rooms)
    if count < len(rooms):
        for room in rooms[count:]:
            floor.rooms.remove(room)
    taken = {r.number for r in floor.rooms}
    position = max((r.position for r in floor.rooms), default=-1)
    while len(floor.rooms) < count:
        number = _next_room_number(floor, taken)
        taken.add(number)
        position += 1
        floor.rooms.append(Room(number=number, position=position))


def _sync_floors(building, floors_spec):
    """floors_spec: [{name, room_count}, ...] -- index 0 is floor 1. Floors beyond the list are
    removed (with their rooms); new ones are created; each floor's rooms are resized."""
    by_number = {f.number: f for f in building.floors}
    for number in list(by_number):
        if number > len(floors_spec):
            building.floors.remove(by_number.pop(number))
    for i, spec in enumerate(floors_spec, start=1):
        floor = by_number.get(i)
        if floor is None:
            floor = Floor(number=i)
            building.floors.append(floor)
        floor.name = spec['name']
        _resize_rooms(floor, spec['room_count'])


def _parse_building(data, building=None):
    """Validates a create/update payload. Returns (fields, None) or (None, error message).
    `floors` may be given as a per-floor list, or as floor_count + rooms_per_floor."""
    code = (data.get('code') or '').strip().upper()
    name = (data.get('name') or '').strip()
    if not name:
        return None, 'Building name is required'
    if not code:
        return None, 'Building ID is required'
    if not CODE_RE.match(code):
        return None, 'Building ID must be 1-20 characters: letters, digits or dash (no spaces or "_")'
    clash = Building.query.filter(Building.code == code).first()
    if clash is not None and (building is None or clash.id != building.id):
        return None, f'Building ID {code} is already used by {clash.name}'

    raw_floors = data.get('floors')
    if raw_floors is None:
        count, err = _int(data.get('floor_count', 1), 'Number of floors', 0, MAX_FLOORS)
        if err:
            return None, err
        per_floor, err = _int(data.get('rooms_per_floor', 0), 'Rooms per floor', 0, MAX_ROOMS_PER_FLOOR)
        if err:
            return None, err
        raw_floors = [{'room_count': per_floor} for _ in range(count)]
    if not isinstance(raw_floors, list) or len(raw_floors) > MAX_FLOORS:
        return None, f'A building can have at most {MAX_FLOORS} floors'
    floors = []
    for i, f in enumerate(raw_floors, start=1):
        rooms, err = _int((f or {}).get('room_count', 0), f'Rooms on floor {i}', 0, MAX_ROOMS_PER_FLOOR)
        if err:
            return None, err
        floors.append({'name': ((f or {}).get('name') or '').strip()[:120] or f'Floor {i}',
                       'room_count': rooms})
    return {'code': code, 'name': name[:120], 'floors': floors}, None


# ---- Buildings ----

@bp.route('/buildings', methods=['GET'])
@login_required
def list_buildings():
    return jsonify([_building_json(b) for b in Building.query.order_by(Building.code).all()])


@bp.route('/buildings/<int:building_id>', methods=['GET'])
@login_required
def get_building(building_id):
    return jsonify(_building_json(Building.query.get_or_404(building_id)))


@bp.route('/buildings', methods=['POST'])
@login_required
def create_building():
    if (err := _admin_error()):
        return err
    data = request.get_json(force=True) or {}
    fields, error = _parse_building(data)
    if error:
        return jsonify({'error': error}), 400
    building = Building(code=fields['code'], name=fields['name'])
    db.session.add(building)
    _sync_floors(building, fields['floors'])
    # Created from the whiteboard: link the shape that was clicked "create building" on.
    shape_id = data.get('shape_id')
    if shape_id:
        shape = BoardShape.query.get(shape_id)
        if shape is not None:
            db.session.flush()
            BoardShape.query.filter_by(building_id=building.id).update({'building_id': None})
            shape.building_id = building.id
    db.session.commit()
    return jsonify(_building_json(building)), 201


@bp.route('/buildings/<int:building_id>', methods=['PUT'])
@login_required
def update_building(building_id):
    if (err := _admin_error()):
        return err
    building = Building.query.get_or_404(building_id)
    data = request.get_json(force=True) or {}
    merged = {'code': building.code, 'name': building.name,
              'floors': [{'name': f.name, 'room_count': len(f.rooms)} for f in building.floors], **data}
    fields, error = _parse_building(merged, building)
    if error:
        return jsonify({'error': error}), 400
    building.code, building.name = fields['code'], fields['name']
    _sync_floors(building, fields['floors'])
    db.session.commit()
    return jsonify(_building_json(building))


@bp.route('/buildings/<int:building_id>', methods=['DELETE'])
@login_required
def delete_building(building_id):
    if (err := _admin_error()):
        return err
    building = Building.query.get_or_404(building_id)
    # Its shape on the board goes too -- a shape labelled with a building that no longer
    # exists would only mislead.
    BoardShape.query.filter_by(building_id=building.id).delete()
    db.session.delete(building)
    db.session.commit()
    return jsonify({'deleted': building_id})


@bp.route('/next-code', methods=['GET'])
@login_required
def next_code():
    """Suggested ID for a new building: B1, B2, ... (first unused)."""
    taken = {c for (c,) in db.session.query(Building.code).all()}
    n = 1
    while f'B{n}' in taken:
        n += 1
    return jsonify({'code': f'B{n}'})


# ---- Floors and rooms ----

@bp.route('/floors/<int:floor_id>', methods=['PUT'])
@login_required
def update_floor(floor_id):
    if (err := _admin_error()):
        return err
    floor = Floor.query.get_or_404(floor_id)
    data = request.get_json(force=True) or {}
    if 'name' in data:
        floor.name = (data.get('name') or '').strip()[:120] or f'Floor {floor.number}'
    if 'room_count' in data:
        count, error = _int(data['room_count'], 'Number of rooms', 0, MAX_ROOMS_PER_FLOOR)
        if error:
            return jsonify({'error': error}), 400
        _resize_rooms(floor, count)
    db.session.commit()
    return jsonify(_floor_json(floor))


@bp.route('/rooms/<int:room_id>', methods=['PUT'])
@login_required
def update_room(room_id):
    if (err := _admin_error()):
        return err
    room = Room.query.get_or_404(room_id)
    number = ((request.get_json(force=True) or {}).get('number') or '').strip()
    if not ROOM_RE.match(number):
        return jsonify({'error': 'Room number must be 1-20 characters: letters, digits or dash'}), 400
    clash = Room.query.filter(Room.floor_id == room.floor_id, Room.number == number, Room.id != room.id).first()
    if clash is not None:
        return jsonify({'error': f'Room {number} already exists on this floor'}), 400
    room.number = number
    db.session.commit()
    return jsonify(_room_json(room))


# ---- Whiteboard ----

def _apply_shape(shape, data):
    """Copies validated fields from data onto shape; returns an error message or None."""
    if 'kind' in data:
        if data['kind'] not in SHAPE_KINDS:
            return 'Unknown shape'
        shape.kind = data['kind']
    for key, lo, hi in (('x', -BOARD_W, BOARD_W * 2), ('y', -BOARD_H, BOARD_H * 2),
                        ('w', 20, BOARD_W * 2), ('h', 20, BOARD_H * 2)):
        if key in data:
            try:
                setattr(shape, key, min(max(float(data[key]), lo), hi))
            except (TypeError, ValueError):
                return f'{key} must be a number'
    if 'fill' in data:
        if not COLOR_RE.match(data['fill'] or ''):
            return 'Colour must look like #aabbcc'
        shape.fill = data['fill']
    if 'text' in data:
        shape.text = (data.get('text') or '')[:200]
    if 'z' in data:
        try:
            shape.z = int(data['z'])
        except (TypeError, ValueError):
            return 'z must be a whole number'
    if 'building_id' in data:
        building_id = data['building_id']
        if building_id and Building.query.get(building_id) is None:
            return 'That building no longer exists'
        if building_id:
            # One shape per building: linking here unlinks it anywhere else.
            BoardShape.query.filter(BoardShape.building_id == building_id,
                                    BoardShape.id != shape.id).update({'building_id': None})
        shape.building_id = building_id or None
    return None


@bp.route('/board', methods=['GET'])
@login_required
def get_board():
    shapes = BoardShape.query.order_by(BoardShape.z, BoardShape.id).all()
    return jsonify({'width': BOARD_W, 'height': BOARD_H, 'shapes': [_shape_json(s) for s in shapes]})


@bp.route('/board/shapes', methods=['POST'])
@login_required
def create_shape():
    if (err := _admin_error()):
        return err
    shape = BoardShape(z=(db.session.query(db.func.max(BoardShape.z)).scalar() or 0) + 1)
    error = _apply_shape(shape, request.get_json(force=True) or {})
    if error:
        return jsonify({'error': error}), 400
    db.session.add(shape)
    db.session.commit()
    return jsonify(_shape_json(shape)), 201


@bp.route('/board/shapes/<int:shape_id>', methods=['PUT'])
@login_required
def update_shape(shape_id):
    if (err := _admin_error()):
        return err
    shape = BoardShape.query.get_or_404(shape_id)
    error = _apply_shape(shape, request.get_json(force=True) or {})
    if error:
        return jsonify({'error': error}), 400
    db.session.commit()
    return jsonify(_shape_json(shape))


@bp.route('/board/shapes/<int:shape_id>', methods=['DELETE'])
@login_required
def delete_shape(shape_id):
    if (err := _admin_error()):
        return err
    db.session.delete(BoardShape.query.get_or_404(shape_id))
    db.session.commit()
    return jsonify({'deleted': shape_id})


# ---- PDF ----

@bp.route('/pdf', methods=['GET'])
@login_required
def architecture_pdf():
    buildings = Building.query.order_by(Building.code).all()
    shapes = BoardShape.query.order_by(BoardShape.z, BoardShape.id).all()
    data = pdf.architecture_pdf(buildings, shapes, include_rooms=request.args.get('rooms', '1') != '0')
    return Response(data, mimetype='application/pdf',
                    headers={'Content-Disposition': 'inline; filename="hotel-architecture.pdf"'})
