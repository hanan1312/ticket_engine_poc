from datetime import datetime

from flask import Blueprint, jsonify, request

from auth_engine import display_name, require_permission

from .auth import get_current_actor, require_role
from .barcode import mint_barcode
from .db import db
from .models import ACTIVE_TICKET_STATUSES, ASSET_CONDITIONS, Asset, Ticket, TicketEvent, TicketReferral
from .workflow import (
    TransitionError, TransitionWarning, run_post_transition_hooks, run_ticket_event_hooks,
    validate_transition,
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
    if to_status == 'assigned':
        if assignee_id:
            error = _assignee_error(assignee_id)
            if error:
                return jsonify({'error': error}), 400
        elif ticket.assigned_to_id is None:
            # An 'assigned' ticket with nobody on it can't be acted on -- pick a person.
            return jsonify({'error': 'choose who to assign this ticket to'}), 400
    if to_status == 'in_progress' and ticket.assigned_to_id is None:
        return jsonify({'error': 'nobody is assigned to this ticket yet -- an admin has to assign it first'}), 400

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
    closed_referral = None
    if to_status not in ACTIVE_TICKET_STATUSES:
        closed_referral = _close_pending_referral(ticket, actor, 'closed', f'ticket {to_status}')
    db.session.commit()
    run_post_transition_hooks(ticket, from_status, to_status)
    if closed_referral:
        run_ticket_event_hooks(ticket, 'referral_cancelled', actor, referral=closed_referral, reason='closed')
    return jsonify(_ticket_json(ticket))


@bp.route('/tickets/<int:ticket_id>/assignee', methods=['PUT'])
@require_role('admin')
def set_ticket_assignee(ticket_id):
    """Assign or reassign an active ticket to someone, at any stage -- including a ticket that
    is 'assigned' but names nobody. An open ticket becomes 'assigned'; an in-progress one goes
    back to 'assigned' when it changes hands (the new person hasn't started yet). A pending
    referral request is closed, since the admin has decided who does the work."""
    ticket = Ticket.query.get_or_404(ticket_id)
    if ticket.status not in ACTIVE_TICKET_STATUSES:
        return jsonify({'error': f'this ticket is {ticket.status} -- it can no longer be assigned'}), 400
    data = request.get_json(force=True) or {}
    error = _assignee_error(data.get('assigned_to_id'))
    if error:
        return jsonify({'error': error}), 400
    actor = get_current_actor()
    assignee = _user_model().query.get(int(data['assigned_to_id']))
    note = (data.get('note') or '').strip() or None
    previous = ticket.assigned_to
    if previous is not None and previous.id == assignee.id and ticket.status != 'open':
        return jsonify({'error': f'the ticket is already assigned to {display_name(assignee)}'}), 400
    from_status = _apply_assignment(ticket, assignee, actor, note)
    closed = _close_pending_referral(ticket, actor, 'reassigned', f'assigned directly to {display_name(assignee)}')
    db.session.commit()
    run_post_transition_hooks(ticket, from_status, ticket.status)
    run_ticket_event_hooks(ticket, 'assigned', actor, previous=previous, assignee=assignee, note=note)
    if closed:
        run_ticket_event_hooks(ticket, 'referral_cancelled', actor, referral=closed, reason='reassigned')
    return jsonify(_ticket_json(ticket))


@bp.route('/tickets/<int:ticket_id>/referrals', methods=['GET'])
@require_role()
def list_ticket_referrals(ticket_id):
    Ticket.query.get_or_404(ticket_id)
    rows = TicketReferral.query.filter_by(ticket_id=ticket_id).order_by(TicketReferral.created_at.desc()).all()
    return jsonify([_referral_json(r) for r in rows])


@bp.route('/tickets/<int:ticket_id>/referrals', methods=['POST'])
@require_role()
def request_referral(ticket_id):
    """The assignee asks for the ticket to go to someone else (optionally naming who). Admins
    are notified and decide; until then the ticket stays with the requester."""
    ticket = Ticket.query.get_or_404(ticket_id)
    actor = get_current_actor()
    if ticket.assigned_to_id != actor.id:
        return jsonify({'error': 'only the person this ticket is assigned to can ask to refer it'}), 403
    if ticket.status not in ('assigned', 'in_progress'):
        return jsonify({'error': f'a {ticket.status} ticket cannot be referred'}), 400
    if ticket.referrals.filter_by(status='pending').first():
        return jsonify({'error': 'there is already a referral request waiting for an admin'}), 400
    data = request.get_json(force=True) or {}
    reason = (data.get('reason') or '').strip()
    if not reason:
        return jsonify({'error': 'say why the ticket should go to someone else'}), 400
    to_user_id = data.get('to_user_id') or None
    if to_user_id:
        error = _assignee_error(to_user_id)
        if error:
            return jsonify({'error': error}), 400
        if int(to_user_id) == actor.id:
            return jsonify({'error': 'suggest someone other than yourself'}), 400
    referral = TicketReferral(ticket_id=ticket.id, requested_by_id=actor.id,
                              to_user_id=int(to_user_id) if to_user_id else None, reason=reason[:2000])
    db.session.add(referral)
    db.session.flush()
    target = display_name(referral.to_user) if referral.to_user else 'another employee (admin to choose)'
    db.session.add(TicketEvent(ticket_id=ticket.id, actor_id=actor.id, event_type='referral_requested',
                               note=f'Asked to refer to {target}: {reason}'))
    db.session.commit()
    run_ticket_event_hooks(ticket, 'referral_requested', actor, referral=referral)
    return jsonify(_referral_json(referral)), 201


@bp.route('/referrals', methods=['GET'])
@require_role('admin')
def list_referrals():
    """Referral requests across all tickets (?status=pending for the admin's to-do list)."""
    query = TicketReferral.query
    if request.args.get('status'):
        query = query.filter_by(status=request.args['status'])
    return jsonify([_referral_json(r, with_ticket=True)
                    for r in query.order_by(TicketReferral.created_at.desc()).limit(100).all()])


@bp.route('/referrals/<int:referral_id>/decide', methods=['POST'])
@require_role('admin')
def decide_referral(referral_id):
    """decision='approve' assigns the ticket to assign_to_id (default: the suggested person);
    decision='reject' leaves it with the requester. Either way an optional note is recorded and
    sent to the requester."""
    referral = TicketReferral.query.get_or_404(referral_id)
    if referral.status != 'pending':
        return jsonify({'error': f'this request was already {referral.status}'}), 400
    ticket = referral.ticket
    data = request.get_json(force=True) or {}
    decision = data.get('decision')
    note = (data.get('note') or '').strip() or None
    actor = get_current_actor()
    if decision not in ('approve', 'reject'):
        return jsonify({'error': "decision must be 'approve' or 'reject'"}), 400

    referral.decided_by_id = actor.id
    referral.decided_at = datetime.utcnow()
    referral.decision_note = note
    if decision == 'reject':
        referral.status = 'rejected'
        db.session.add(TicketEvent(ticket_id=ticket.id, actor_id=actor.id, event_type='referral_rejected',
                                   note=f'Referral declined -- stays with {display_name(referral.requested_by)}'
                                        + (f': {note}' if note else '')))
        db.session.commit()
        run_ticket_event_hooks(ticket, 'referral_rejected', actor, referral=referral)
        return jsonify({'referral': _referral_json(referral), 'ticket': _ticket_json(ticket)})

    assignee_id = data.get('assign_to_id') or referral.to_user_id
    if not assignee_id:
        return jsonify({'error': 'choose who gets the ticket'}), 400
    error = _assignee_error(assignee_id)
    if error:
        return jsonify({'error': error}), 400
    assignee = _user_model().query.get(int(assignee_id))
    if assignee.id == referral.requested_by_id:
        return jsonify({'error': 'that is the person who asked to hand it over -- reject the request instead'}), 400
    previous = ticket.assigned_to
    referral.status = 'approved'
    referral.assigned_to_id = assignee.id
    db.session.add(TicketEvent(ticket_id=ticket.id, actor_id=actor.id, event_type='referral_approved',
                               note=f'Referral approved -- assigned to {display_name(assignee)}'
                                    + (f': {note}' if note else '')))
    from_status = _apply_assignment(ticket, assignee, actor, note, record_event=False)
    db.session.commit()
    run_post_transition_hooks(ticket, from_status, ticket.status)
    run_ticket_event_hooks(ticket, 'referral_approved', actor, referral=referral, previous=previous, assignee=assignee)
    return jsonify({'referral': _referral_json(referral), 'ticket': _ticket_json(ticket)})


@bp.route('/referrals/<int:referral_id>/cancel', methods=['POST'])
@require_role()
def cancel_referral(referral_id):
    """The requester withdraws their own pending request."""
    referral = TicketReferral.query.get_or_404(referral_id)
    actor = get_current_actor()
    if referral.requested_by_id != actor.id:
        return jsonify({'error': 'only the person who asked can withdraw this request'}), 403
    if referral.status != 'pending':
        return jsonify({'error': f'this request was already {referral.status}'}), 400
    referral.status = 'cancelled'
    referral.decided_by_id = actor.id
    referral.decided_at = datetime.utcnow()
    referral.decision_note = 'withdrawn by the requester'
    db.session.add(TicketEvent(ticket_id=referral.ticket_id, actor_id=actor.id, event_type='referral_cancelled',
                               note='Referral request withdrawn'))
    db.session.commit()
    run_ticket_event_hooks(referral.ticket, 'referral_cancelled', actor, referral=referral, reason='withdrawn')
    return jsonify(_referral_json(referral))


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
    actor = get_current_actor()
    db.session.add(TicketEvent(ticket_id=ticket.id, actor_id=actor.id, event_type='comment', note=note))
    db.session.commit()
    run_ticket_event_hooks(ticket, 'comment', actor, note=note)
    return jsonify({'ok': True}), 201


@bp.route('/assignees', methods=['GET'])
@require_role()
def list_assignees():
    """Who a ticket can be assigned to -- deliberately not gated on hr-management the way
    the HR security user list is, since dispatching a ticket needs a name, not permissions."""
    users = [u for u in _user_model().query.order_by(_user_model().username).all() if u.is_active is not False]
    out = [{'id': u.id, 'username': u.username, 'role': u.role, 'name': display_name(u)} for u in users]
    return jsonify(sorted(out, key=lambda u: u['name'].lower()))


@bp.route('/tickets/<int:ticket_id>/events', methods=['GET'])
@require_role()
def get_ticket_events(ticket_id):
    Ticket.query.get_or_404(ticket_id)
    events = TicketEvent.query.filter_by(ticket_id=ticket_id).order_by(TicketEvent.created_at).all()
    return jsonify([{
        'id': e.id,
        'actor': e.actor_id and e.actor.username,
        'actor_name': display_name(e.actor) if e.actor_id else None,
        'event_type': e.event_type,
        'from_status': e.from_status,
        'to_status': e.to_status,
        'note': e.note,
        'overrode_warning': e.overrode_warning,
        'created_at': e.created_at.isoformat(),
    } for e in events])


def _assignee_error(user_id):
    try:
        user = _user_model().query.get(int(user_id)) if user_id else None
    except (TypeError, ValueError):
        user = None
    if user is None:
        return 'choose a person to assign the ticket to'
    if user.is_active is False:
        return f'{user.username} is deactivated -- choose someone else'
    return None


def _apply_assignment(ticket, assignee, actor, note, record_event=True):
    """Point the ticket at `assignee`; open/in-progress tickets become 'assigned'. Returns the
    previous status. Caller commits."""
    from_status = ticket.status
    previous = ticket.assigned_to
    ticket.assigned_to_id = assignee.id
    if ticket.status in ('open', 'in_progress'):
        ticket.status = 'assigned'
    if record_event:
        what = (f'Reassigned from {display_name(previous)} to {display_name(assignee)}' if previous
                else f'Assigned to {display_name(assignee)}')
        db.session.add(TicketEvent(ticket_id=ticket.id, actor_id=actor.id, event_type='assignment',
                                   from_status=from_status, to_status=ticket.status,
                                   note=what + (f': {note}' if note else '')))
    elif from_status != ticket.status:
        db.session.add(TicketEvent(ticket_id=ticket.id, actor_id=actor.id, event_type='status_changed',
                                   from_status=from_status, to_status=ticket.status))
    return from_status


def _close_pending_referral(ticket, actor, reason, note):
    referral = ticket.referrals.filter_by(status='pending').first()
    if referral is None:
        return None
    referral.status = 'cancelled'
    referral.decided_by_id = actor.id
    referral.decided_at = datetime.utcnow()
    referral.decision_note = note
    db.session.add(TicketEvent(ticket_id=ticket.id, actor_id=actor.id, event_type='referral_cancelled',
                               note=f'Referral request closed: {note}'))
    return referral


def _person(user):
    return {'id': user.id, 'username': user.username, 'name': display_name(user)} if user else None


def _referral_json(r, with_ticket=False):
    out = {
        'id': r.id, 'ticket_id': r.ticket_id, 'status': r.status, 'reason': r.reason,
        'requested_by': _person(r.requested_by), 'to_user': _person(r.to_user),
        'decided_by': _person(r.decided_by), 'assigned_to': _person(r.assigned_to),
        'decision_note': r.decision_note,
        'decided_at': r.decided_at.isoformat() if r.decided_at else None,
        'created_at': r.created_at.isoformat(),
    }
    if with_ticket:
        out['ticket'] = {'id': r.ticket.id, 'title': r.ticket.title, 'status': r.ticket.status,
                         'priority': r.ticket.priority, 'asset_name': r.ticket.asset.name}
    return out


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
        'assigned_to_name': display_name(ticket.assigned_to) if ticket.assigned_to else None,
        'assigned_to_id': ticket.assigned_to_id,
        'pending_referral': _referral_json(pending) if (pending := ticket.referrals.filter_by(status='pending').first()) else None,
        'created_at': ticket.created_at.isoformat(),
        'resolved_at': ticket.resolved_at.isoformat() if ticket.resolved_at else None,
    }
