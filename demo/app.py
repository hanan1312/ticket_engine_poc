import os
import secrets
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask, jsonify, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

from auth_engine import (
    User, auth_engine_bp, display_name, get_current_user, infer_role_key,
    register_presence_enforcement, register_recovery_request_hook, register_reset_undelivered_hook,
    seed_default_roles, set_mail_config_provider, set_policy_provider, set_profile_provider,
)
from branding import bp as branding_bp, get_settings, mail_config, whatsapp_enabled
from hotel import hotel_bp
from hr import Employee, hr_bp
from inbox import inbox_bp, notify, notify_admins, register_delivery_hook
from notifications_client import send_whatsapp
from shared_db import upgrade_schema
from ticket_engine import (
    Ticket, TicketEvent, db, register_post_transition_hook, register_pre_transition_hook,
    register_ticket_event_hook, ticket_engine_bp,
)
from ticket_engine.workflow import TransitionWarning
from warehouse import WarehouseItem, warehouse_bp
from warehouse import pdf as warehouse_pdf
import ui_config

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(os.path.dirname(BASE_DIR), 'database', 'ticket_engine.db')
SECRET_KEY_FILE = os.path.join(os.path.dirname(BASE_DIR), 'database', '.secret_key')
DEFAULT_PORT = 4044


def env_flag(name, default=False):
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in ('1', 'true', 'yes', 'on')


def load_secret_key():
    """Signs the session cookie, so it must be secret and stable. SECRET_KEY from the
    environment wins (set it in deploy/ticket-engine.env); otherwise a random key is generated
    once and kept in database/.secret_key (owner-only), so sessions survive restarts."""
    key = os.environ.get('SECRET_KEY', '').strip()
    if key:
        return key
    try:
        with open(SECRET_KEY_FILE, encoding='utf-8') as f:
            key = f.read().strip()
    except FileNotFoundError:
        key = ''
    if not key:
        key = secrets.token_hex(32)
        fd = os.open(SECRET_KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(key)
    return key


def warn_on_duplicate_open_ticket(ticket, from_status, to_status):
    """Example pluggable hook (see ticket_engine/workflow.py) -- demonstrates the same shape
    as module_app's FEFO check: block-with-override rather than a hard rule. Here: warn when
    assigning a ticket while another open/in_progress ticket already exists for the same asset,
    since a tech about to be dispatched should know someone's already on it."""
    if to_status != 'assigned':
        return
    duplicate = (
        Ticket.query.filter(Ticket.asset_id == ticket.asset_id, Ticket.id != ticket.id,
                             Ticket.status.in_(['open', 'assigned', 'in_progress']))
        .first()
    )
    if duplicate is not None:
        raise TransitionWarning(
            f"asset already has an active ticket (#{duplicate.id}) -- resend with "
            "confirm_override to assign this one anyway"
        )


def notify_on_ticket_transition(ticket, from_status, to_status):
    """Wires the copied notifications/ WhatsApp microservice into the ticket workflow. Runs
    as a post-transition hook (see ticket_engine/workflow.py) so a downed/unpaired WhatsApp
    service can never block or fail the transition itself -- only the outcome is recorded,
    as a TicketEvent, same audit trail every other transition already writes to."""
    recipient, message = None, None
    if to_status == 'assigned' and ticket.assigned_to is not None:
        recipient = ticket.assigned_to
        message = (f'New ticket assigned: #{ticket.id} "{ticket.title}" on '
                   f'{ticket.asset.name} ({ticket.asset.location or "no location"}).')
    elif to_status == 'resolved' and ticket.created_by is not None:
        recipient = ticket.created_by
        message = f'Your ticket #{ticket.id} "{ticket.title}" has been resolved.'

    if recipient is None:
        return
    # Don't message someone about their own action (e.g. an admin resolving a ticket they
    # raised themselves) -- they already know, and it just adds a failed/noisy send.
    actor = get_current_user()
    if actor is not None and actor.id == recipient.id:
        return

    # In-app (bell icon) notification always; WhatsApp only when switched on in Preferences.
    notify([recipient], message, kind='success' if to_status == 'resolved' else 'info',
           link_type='ticket', link_id=ticket.id, deliver_externally=False)
    if not whatsapp_enabled():
        return

    if not recipient.phone:
        outcome = f'WhatsApp to {recipient.username} skipped -- no phone number on file'
    else:
        sent, error = send_whatsapp(recipient.phone, message)
        if sent is True:
            outcome = f'WhatsApp sent to {recipient.username} ({recipient.phone})'
        elif sent is False:
            outcome = f'WhatsApp to {recipient.username} not sent -- service rejected it: {error}'
        else:
            outcome = (f'WhatsApp to {recipient.username} not sent -- notifications service is not '
                       f'running ({error})')

    db.session.add(TicketEvent(ticket_id=ticket.id, event_type='notification', note=outcome))
    db.session.commit()


def restore_condition_on_resolve(ticket, from_status, to_status):
    """Keeps the Assets tab's condition in step with the ticket process: once a ticket on a
    fair/broken asset is resolved, the asset is back in good condition (recorded on the ticket's
    timeline). Rejecting a ticket leaves the condition alone -- nothing was fixed."""
    asset = ticket.asset
    if to_status != 'resolved' or asset.condition == 'good':
        return
    if Ticket.query.filter(Ticket.asset_id == asset.id, Ticket.id != ticket.id,
                           Ticket.status.in_(['open', 'assigned', 'in_progress'])).count():
        return  # other work still open on it -- not fixed yet
    previous, asset.condition = asset.condition, 'good'
    db.session.add(TicketEvent(ticket_id=ticket.id, event_type='notification',
                               note=f'Asset condition changed from {previous} to good'))
    db.session.commit()


def notify_on_ticket_event(ticket, event, actor, **info):
    """In-app (+ WhatsApp, when on) notifications for assignment changes, referral requests and
    decisions, and comments -- to the people involved, never to the person who did it. The new
    assignee's "New ticket assigned" message comes from notify_on_ticket_transition."""
    ref = f'#{ticket.id} "{ticket.title}"'
    who = display_name(actor)

    def send(users, title, body=None, kind='info'):
        notify([u for u in users if u is not None and u.id != actor.id], title, body, kind=kind,
               link_type='ticket', link_id=ticket.id)

    def admins():
        return [u for u in User.query.filter_by(role='admin').all() if u.is_active is not False]

    if event == 'assigned':
        previous, assignee = info.get('previous'), info['assignee']
        note = f" Note: {info['note']}" if info.get('note') else ''
        if previous is not None and previous.id != assignee.id:
            send([previous], f'Ticket {ref} was reassigned',
                 f'{who} assigned it to {display_name(assignee)}. You no longer need to work on it.{note}')
        if ticket.created_by is not None and ticket.created_by.id != assignee.id:
            send([ticket.created_by], f'Your ticket {ref} is assigned to {display_name(assignee)}', note.strip() or None)
    elif event == 'referral_requested':
        r = info['referral']
        target = display_name(r.to_user) if r.to_user else 'someone else (your choice)'
        send(admins(), f'Referral request for ticket {ref}',
             f'{who} asks to hand it to {target}. Reason: {r.reason}', kind='warning')
    elif event == 'referral_approved':
        r, assignee = info['referral'], info['assignee']
        note = f' Note from {who}: {r.decision_note}' if r.decision_note else ''
        send([r.requested_by], f'Referral approved: ticket {ref} now goes to {display_name(assignee)}',
             f'You no longer need to work on it.{note}', kind='success')
        send([u for u in admins() if u.id != actor.id], f'Referral for ticket {ref} approved by {who}',
             f'Assigned to {display_name(assignee)}.')
        if ticket.created_by is not None and ticket.created_by.id not in (assignee.id, r.requested_by_id):
            send([ticket.created_by], f'Your ticket {ref} is now assigned to {display_name(assignee)}')
    elif event == 'referral_rejected':
        r = info['referral']
        note = f' Note from {who}: {r.decision_note}' if r.decision_note else ''
        send([r.requested_by], f'Referral declined: ticket {ref} stays with you',
             f'Please carry on with it.{note}', kind='warning')
        send([u for u in admins() if u.id != actor.id], f'Referral for ticket {ref} declined by {who}')
    elif event == 'referral_cancelled':
        r, reason = info['referral'], info.get('reason')
        if reason == 'withdrawn':
            send(admins(), f'Referral request for ticket {ref} withdrawn', f'{who} will keep working on it.')
        else:
            send([r.requested_by], f'Your referral request for ticket {ref} was closed', r.decision_note)
    elif event == 'comment':
        send([ticket.assigned_to, ticket.created_by], f'New comment on ticket {ref}', f'{who}: {info["note"]}')


def whatsapp_delivery_hook(user, title, body):
    """Mirrors in-app notifications (warehouse approvals/deliveries, recovery requests) to
    WhatsApp when the service is switched on and the user has a phone on file. Best-effort --
    inbox swallows anything this raises."""
    if not user.phone or not whatsapp_enabled():
        return
    send_whatsapp(user.phone, f'{title}\n{body}' if body else title)


def notify_admins_of_recovery_request(req):
    notify_admins(f'Account recovery request from {req.full_name}',
                  f"Old username: {req.old_username or 'unknown'} · contact: {req.contact}. "
                  'Review it in HR → Accounts & security.',
                  kind='warning', link_type='recovery_request', link_id=req.id)


def notify_admins_of_undelivered_reset(user, identifier, reason):
    """Someone asked for a password-reset link that couldn't be emailed -- make sure an admin
    knows, so they can issue a temporary password instead of the person waiting forever."""
    who = user.username if user else f'"{identifier}" (no matching account)'
    notify_admins(f'Password reset for {who} could not be emailed',
                  f'Reason: {reason}. ' + ('Open HR → Accounts & security → this account → "Issue temporary password".'
                                           if user else 'Check the name with the person who asked.'),
                  kind='warning', link_type='account' if user else None, link_id=user.id if user else None)


def create_app():
    app = Flask(__name__)
    app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{DB_PATH}'
    app.config['SECRET_KEY'] = load_secret_key()
    app.config['SESSION_COOKIE_HTTPONLY'] = True
    app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
    # Behind HTTPS (nginx + certbot) set SESSION_COOKIE_SECURE=1 so the cookie is never sent
    # over plain HTTP. Off by default so a plain http://localhost run still works.
    app.config['SESSION_COOKIE_SECURE'] = env_flag('SESSION_COOKIE_SECURE')
    if env_flag('BEHIND_PROXY'):
        # Trust nginx's X-Forwarded-For/-Proto/-Host (one hop), so request.host_url -- used in
        # password-reset links and account emails -- is the public https:// address.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    db.init_app(app)
    app.register_blueprint(auth_engine_bp)
    app.register_blueprint(ticket_engine_bp)
    app.register_blueprint(branding_bp)
    app.register_blueprint(warehouse_bp)
    app.register_blueprint(hr_bp)
    app.register_blueprint(inbox_bp)
    app.register_blueprint(hotel_bp)
    register_pre_transition_hook(warn_on_duplicate_open_ticket)
    register_delivery_hook(whatsapp_delivery_hook)
    register_recovery_request_hook(notify_admins_of_recovery_request)
    register_reset_undelivered_hook(notify_admins_of_undelivered_reset)
    set_mail_config_provider(mail_config)
    from hr.routes import profile_for_user, security_policy
    set_profile_provider(profile_for_user)
    set_policy_provider(security_policy)  # HR -> Policy drives sign-in rules
    warehouse_pdf.set_company_name_provider(lambda: get_settings().company_name)
    warehouse_pdf.set_logo_provider(lambda: get_settings().logo_data)
    register_post_transition_hook(notify_on_ticket_transition)
    register_post_transition_hook(restore_condition_on_resolve)
    register_ticket_event_hook(notify_on_ticket_event)
    register_presence_enforcement(app)

    # Tabs, sub-tabs, names and sign-in texts come from config/ui.json (see demo/ui_config.py).
    # Checking it before each request picks up edits -- and re-registers one grantable
    # permission per visible tab -- without a restart.
    ui_config.current()

    @app.before_request
    def refresh_ui_config():
        ui_config.current()  # must not return anything: a before_request return value is the response

    # Outside /api/ on purpose: the sign-in screen needs it too, so it must never be refused
    # by the session checks (stale heartbeat, forced password change) that guard /api/.
    @app.route('/ui-config.json')
    def get_ui_config():
        config, warnings = ui_config.current()
        user = get_current_user()
        # Problems in the file are for whoever maintains it, not every visitor.
        return jsonify({**config, 'warnings': warnings if user is not None and user.role == 'admin' else []})

    @app.route('/')
    def index():
        return send_from_directory(os.path.join(BASE_DIR, 'static'), 'scan.html')

    with app.app_context():
        db.create_all()
        upgrade_schema()
        _seed_demo_data()

    return app


def _seed_demo_data():
    seed_default_roles()
    if User.query.count() == 0:
        # Fake demo numbers -- replace with real ones (and a real paired WhatsApp session in
        # notifications/) for actual delivery.
        admin = User(username='admin', role='admin', access_role='admin', phone='201234567890')
        admin.set_password('admin123')
        tech = User(username='tech', role='staff', access_role='technician', phone='201098765432')
        tech.set_password('tech123')
        db.session.add_all([admin, tech])
        db.session.commit()

    # Accounts created before roles existed: infer the role from admin flag + permissions so
    # the Users table shows e.g. "Technician" rather than "Custom".
    for user in User.query.filter(User.access_role.is_(None)).all():
        user.access_role = infer_role_key(user)
    db.session.commit()

    from warehouse.routes import default_sku
    for item in WarehouseItem.query.filter(WarehouseItem.sku.is_(None)).all():
        item.sku = default_sku(item.id)
    db.session.commit()

    if WarehouseItem.query.count() == 0:
        db.session.add_all([
            WarehouseItem(name='Nitrile Gloves (Box)', category='PPE', unit='box', critical_level=20, quantity=8),
            WarehouseItem(name='HVAC Filter 20x20', category='Maintenance', unit='piece', critical_level=10, quantity=25),
            WarehouseItem(name='Pool Chlorine Tablets', category='Pool', unit='kg', critical_level=15, quantity=6),
        ])
        db.session.commit()
        for item in WarehouseItem.query.all():
            item.sku = item.sku or default_sku(item.id)
        db.session.commit()

    if Employee.query.count() == 0:
        db.session.add_all([
            Employee(name='Mona Kamal', role='Front Desk Manager', phone='201155512345', username='admin'),
            Employee(name='Youssef Adel', role='Maintenance Technician', phone='201155567890', username='tech'),
            Employee(name='Rana Fathy', role='Housekeeping Supervisor', phone='201155599999'),
        ])
        db.session.commit()


if __name__ == '__main__':
    # Development server only -- in production run gunicorn (see deploy/README.md).
    # FLASK_DEBUG=1 turns on the reloader and the interactive debugger, which lets anyone who
    # can reach the port run code on this machine: never use it on a reachable server.
    app = create_app()
    debug = env_flag('FLASK_DEBUG')
    host = os.environ.get('HOST', '127.0.0.1' if debug else '0.0.0.0')
    app.run(host=host, port=int(os.environ.get('PORT', DEFAULT_PORT)), debug=debug)
