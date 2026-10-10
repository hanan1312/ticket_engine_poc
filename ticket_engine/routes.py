from datetime import datetime

from flask import Blueprint, jsonify, request

from auth_engine import require_permission

from .auth import get_current_actor, require_role
from .barcode import mint_barcode
from .db import db
from .models import ACTIVE_TICKET_STATUSES, ASSET_CONDITIONS, Asset, Ticket, TicketEvent
from .workflow import (
    TransitionError, TransitionWarning, run_post_transition_hooks, validate_transition,
)

bp = Blueprint('ticket_engine', __name__, url_prefix='/api')


@bp.route('/assets', methods=['POST'])
@require_permission('assets')  # the Assets tab's permission (admins always pass)
def create_asset():
    data = request.get_json(force=True) or {}
    if not data.get('name'):
        return jsonify({'error': 'name is required'}), 400

    asset = Asset(name=data['name'].strip(), category=(data.get('category') or '').strip() or None,
                  location=data.get('location') or None, comment=(data.get('comment') or '').strip() or None)
    condition = data.get('condition') or 'good'
    if condition not in ASSET_CONDITIONS:
        return jsonify({'error': f"condition must be one of {', '.join(ASSET_CONDITIONS)}"}), 400
    asset.condition = condition
    db.session.add(asset)
    db.session.flush()  # need asset.id before minting its barcode
    asset.barcode = mint_barcode('AST', asset.id)
    db.session.commit()
    return jsonify(_asset_json(asset)), 201


@bp.route('/assets', methods=['GET'])
@require_role()
def list_assets():
    assets = Asset.query.order_by(Asset.id.desc()).all()
    return jsonify([_asset_json(a) for a in assets])


@bp.route('/assets/<int:asset_id>', methods=['PUT'])
@require_permission('assets')  # the Assets tab's permission (admins always pass)
def update_asset(asset_id):
    asset = Asset.query.get_or_404(asset_id)
    data = request.get_json(force=True) or {}
    if 'name' in data:
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'name is required'}), 400
        asset.name = name[:200]
    if 'condition' in data:
        if data['condition'] not in ASSET_CONDITIONS:
            return jsonify({'error': f"condition must be one of {', '.join(ASSET_CONDITIONS)}"}), 400
        asset.condition = data['condition']
    for field, limit in (('category', 100), ('location', 200)):
        if field in data:
            setattr(asset, field, (data.get(field) or '').strip()[:limit] or None)
    if 'comment' in data:
        asset.comment = (data.get('comment') or '').strip() or None
    db.session.commit()
    return jsonify(_asset_json(asset))


@bp.route('/assets/delete', methods=['POST'])
@require_permission('assets')  # the Assets tab's permission (admins always pass)
def delete_assets():
    """Bulk delete (the Assets tab's checkboxes). Refused as a whole if any asset still has an
    active ticket -- finish or reject that work first; finished tickets and their history are
    deleted along with the asset."""
    ids = (request.get_json(force=True) or {}).get('ids') or []
    assets = Asset.query.filter(Asset.id.in_([int(i) for i in ids if str(i).isdigit()])).all()
    if not assets:
        return jsonify({'error': 'no assets selected'}), 400
    busy = [a for a in assets if a.tickets.filter(Ticket.status.in_(ACTIVE_TICKET_STATUSES)).count()]
    if busy:
        names = ', '.join(a.name for a in busy[:3]) + ('…' if len(busy) > 3 else '')
        return jsonify({'error': f'{names} still has an active ticket -- resolve or reject it before deleting'}), 409
    for asset in assets:
        for ticket in asset.tickets.all():
            TicketEvent.query.filter_by(ticket_id=ticket.id).delete()
            db.session.delete(ticket)
        db.session.delete(asset)
    db.session.commit()
    return jsonify({'deleted': [a.id for a in assets]})


@bp.route('/assets/barcode/<code>', methods=['GET'])
@require_role()
def resolve_barcode(code):
    """What a barcode scanner's Enter keystroke ultimately hits -- same 'scan -> DB lookup,
    the code itself carries no meaning' shape as module_app's warehouse batch scanning."""
    asset = Asset.query.filter_by(barcode=code).first()
    if asset is None:
        return jsonify({'error': 'no asset with that barcode'}), 404
    return jsonify(_asset_json(asset))


@bp.route('/assets/<int:asset_id>/tickets', methods=['POST'])
@require_role()
def create_ticket(asset_id):
    asset = Asset.query.get_or_404(asset_id)
    data = request.get_json(force=True) or {}
    if not data.get('title'):
        return jsonify({'error': 'title is required'}), 400

    actor = get_current_actor()
    ticket = Ticket(
        asset_id=asset.id,
        title=data['title'],
        description=data.get('description'),
        priority=data.get('priority', 'normal'),
        created_by_id=actor.id,
    )
    db.session.add(ticket)
    db.session.flush()
    db.session.add(TicketEvent(ticket_id=ticket.id, actor_id=actor.id, event_type='created',
                                to_status=ticket.status))
    db.session.commit()
    return jsonify(_ticket_json(ticket)), 201


@bp.route('/tickets', methods=['GET'])
@require_role()
def list_tickets():
    tickets = Ticket.query.order_by(Ticket.id.desc()).all()
    return jsonify([_ticket_json(t) for t in tickets])


@bp.route('/tickets/<int:ticket_id>', methods=['GET'])
@require_role()
def get_ticket(ticket_id):
    ticket = Ticket.query.get_or_404(ticket_id)
    return jsonify(_ticket_json(ticket))


@bp.route('/tickets/<int:ticket_id>/status', methods=['PUT'])
@require_role()
def update_ticket_status(ticket_id):
    ticket = Ticket.query.get_or_404(ticket_id)
    data = request.get_json(force=True) or {}
    to_status = data.get('status')
    confirm_override = bool(data.get('confirm_override'))
    actor = get_current_actor()

    if not to_status:
        return jsonify({'error': 'status is required'}), 400

    try:
        validate_transition(ticket, to_status, actor.role, confirm_override=confirm_override)
    except TransitionError as e:
        return jsonify({'error': e.message}), e.status_code
    except TransitionWarning as e:
        # 409, same as module_app's FEFO check -- caller resends with confirm_override to proceed
        return jsonify({'error': e.message, 'confirm_override_required': True}), 409

    assignee_id = data.get('assigned_to_id')
    if to_status == 'assigned' and assignee_id and _user_model().query.get(assignee_id) is None:
        return jsonify({'error': 'assignee not found'}), 400

    from_status = ticket.status
    ticket.status = to_status
    if to_status == 'resolved':
        ticket.resolved_at = datetime.utcnow()
    if to_status == 'assigned' and assignee_id:
        ticket.assigned_to_id = assignee_id

    db.session.add(TicketEvent(
        ticket_id=ticket.id, actor_id=actor.id, event_type='status_changed',
        from_status=from_status, to_status=to_status, note=data.get('note'),
        overrode_warning=confirm_override,
    ))
    db.session.commit()
    run_post_transition_hooks(ticket, from_status, to_status)
    return jsonify(_ticket_json(ticket))


@bp.route('/tickets/<int:ticket_id>/comments', methods=['POST'])
@require_role()
def add_ticket_comment(ticket_id):
    """A free-text note on the ticket's audit trail that doesn't change its status -- the
    'comment' event_type TicketEvent already allowed for but nothing wrote yet."""
    ticket = Ticket.query.get_or_404(ticket_id)
    data = request.get_json(force=True) or {}
    note = (data.get('note') or '').strip()
    if not note:
        return jsonify({'error': 'note is required'}), 400
    db.session.add(TicketEvent(ticket_id=ticket.id, actor_id=get_current_actor().id,
                                event_type='comment', note=note))
    db.session.commit()
    return jsonify({'ok': True}), 201


@bp.route('/assignees', methods=['GET'])
@require_role()
def list_assignees():
    """Who a ticket can be assigned to -- deliberately not gated on hr-management the way
    the HR security user list is, since dispatching a ticket needs a name, not permissions."""
    users = _user_model().query.order_by(_user_model().username).all()
    return jsonify([{'id': u.id, 'username': u.username, 'role': u.role} for u in users])


@bp.route('/tickets/<int:ticket_id>/events', methods=['GET'])
@require_role()
def get_ticket_events(ticket_id):
    Ticket.query.get_or_404(ticket_id)
    events = TicketEvent.query.filter_by(ticket_id=ticket_id).order_by(TicketEvent.created_at).all()
    return jsonify([{
        'id': e.id,
        'actor': e.actor_id and e.actor.username,
        'event_type': e.event_type,
        'from_status': e.from_status,
        'to_status': e.to_status,
        'note': e.note,
        'overrode_warning': e.overrode_warning,
        'created_at': e.created_at.isoformat(),
    } for e in events])


def _user_model():
    # Imported lazily for the same circular-import reason models.py only names 'User' by string.
    from auth_engine import User
    return User


def _asset_json(asset):
    return {
        'id': asset.id,
        'name': asset.name,
        'category': asset.category,
        'location': asset.location,
        'barcode': asset.barcode,
        'status': asset.status,
        'condition': asset.condition or 'good',
        'comment': asset.comment,
        # The ticket people care about: the active one if there is one, else the latest.
        'ticket': _asset_ticket_json(asset),
        'ticket_count': asset.tickets.count(),
    }


def _asset_ticket_json(asset):
    ticket = (asset.tickets.filter(Ticket.status.in_(ACTIVE_TICKET_STATUSES)).order_by(Ticket.id.desc()).first()
              or asset.tickets.order_by(Ticket.id.desc()).first())
    if ticket is None:
        return None
    return {'id': ticket.id, 'status': ticket.status, 'title': ticket.title,
            'assigned_to': ticket.assigned_to.username if ticket.assigned_to else None,
            'active': ticket.status in ACTIVE_TICKET_STATUSES}


def _ticket_json(ticket):
    return {
        'id': ticket.id,
        'asset_id': ticket.asset_id,
        'asset_name': ticket.asset.name,
        'asset_location': ticket.asset.location,
        'asset_barcode': ticket.asset.barcode,
        'title': ticket.title,
        'description': ticket.description,
        'priority': ticket.priority,
        'status': ticket.status,
        'created_by': ticket.created_by.username if ticket.created_by else None,
        'assigned_to': ticket.assigned_to.username if ticket.assigned_to else None,
        'assigned_to_id': ticket.assigned_to_id,
        'created_at': ticket.created_at.isoformat(),
        'resolved_at': ticket.resolved_at.isoformat() if ticket.resolved_at else None,
    }
