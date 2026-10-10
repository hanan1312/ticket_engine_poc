from datetime import datetime

from .db import db

# The actor identity FKs below point at auth_engine.User -- the real, pluggable auth module
# (see auth_engine/) -- rather than a private stand-in table. Referenced only by table/class
# name (FK string, relationship('User', ...)), never imported directly: auth_engine.models
# itself imports ticket_engine.db, so a direct class import here would be circular. SQLAlchemy
# resolves string relationship targets lazily, once both modules have been imported by
# whatever assembles the app (see demo/app.py) -- they just both need to happen before the
# first query.


class Asset(db.Model):
    """A physical thing that gets a barcode sticker and can have tickets raised against it.

    Generalized from module_app's WarehouseItem -- but an Asset isn't consumed the way stock
    is, so there's no quantity/batch/expiry here, just identity + location.
    """
    __tablename__ = 'ticket_engine_assets'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    category = db.Column(db.String(100))
    location = db.Column(db.String(200))
    # Nullable at the DB level only because minting the barcode needs asset.id first, which
    # means a two-step create: insert (barcode still None), flush, set barcode, commit --
    # the same order module_app's WarehouseBatch creation follows.
    barcode = db.Column(db.String(40), unique=True, nullable=True, index=True)
    status = db.Column(db.String(20), nullable=False, default='active')  # active | retired
    # Physical condition, set by people (Assets tab) -- and back to 'good' when a ticket on
    # it is resolved (demo/app.py's post-transition hook). Distinct from `status` above.
    condition = db.Column(db.String(20), nullable=False, default='good', server_default='good')
    comment = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    tickets = db.relationship('Ticket', backref='asset', lazy='dynamic')


# Generalized from module_app's WarehouseWorkOrder status lifecycle (requested -> approved ->
# completed / rejected). Hotel maintenance tickets need one more step in between (an assignee
# has to actually go do the work) so this adds 'assigned' / 'in_progress'.
TICKET_STATUSES = ('open', 'assigned', 'in_progress', 'resolved', 'rejected')
ACTIVE_TICKET_STATUSES = ('open', 'assigned', 'in_progress')
ASSET_CONDITIONS = ('good', 'fair', 'broken')

# {from_status: {to_status: required_role_or_None}}. None means any authenticated actor can
# make that transition; a role string means only an actor with that role can.
ALLOWED_TRANSITIONS = {
    'open':        {'assigned': 'admin', 'rejected': 'admin'},
    'assigned':    {'in_progress': None, 'rejected': 'admin'},
    'in_progress': {'resolved': None, 'assigned': 'admin'},
    'resolved':    {},
    'rejected':    {},
}


class Ticket(db.Model):
    __tablename__ = 'ticket_engine_tickets'

    id = db.Column(db.Integer, primary_key=True)
    asset_id = db.Column(db.Integer, db.ForeignKey('ticket_engine_assets.id'), nullable=False)
    title = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text)
    priority = db.Column(db.String(20), nullable=False, default='normal')  # low | normal | high
    status = db.Column(db.String(20), nullable=False, default='open')
    created_by_id = db.Column(db.Integer, db.ForeignKey('auth_engine_users.id'))
    assigned_to_id = db.Column(db.Integer, db.ForeignKey('auth_engine_users.id'))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    resolved_at = db.Column(db.DateTime)

    created_by = db.relationship('User', foreign_keys=[created_by_id])
    assigned_to = db.relationship('User', foreign_keys=[assigned_to_id])
    events = db.relationship('TicketEvent', backref='ticket', lazy='dynamic',
                              order_by='TicketEvent.created_at')


# Generalized from WarehouseWorkOrderScan -- the audit trail of who did what to a ticket and
# when, including whether a transition overrode a workflow warning (see workflow.py).
class TicketEvent(db.Model):
    __tablename__ = 'ticket_engine_ticket_events'

    id = db.Column(db.Integer, primary_key=True)
    ticket_id = db.Column(db.Integer, db.ForeignKey('ticket_engine_tickets.id'), nullable=False)
    actor_id = db.Column(db.Integer, db.ForeignKey('auth_engine_users.id'))
    event_type = db.Column(db.String(30), nullable=False)  # created | status_changed | comment
    from_status = db.Column(db.String(20))
    to_status = db.Column(db.String(20))
    note = db.Column(db.Text)
    overrode_warning = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    actor = db.relationship('User')
