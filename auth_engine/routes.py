import hashlib
import secrets
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request, session

from shared_db import db

from .decorators import get_current_user, login_required
from .mailer import send_email, send_email_detailed, smtp_configured
from .models import AccountRecoveryRequest, PasswordResetToken, User, UserPermission
from .passwords import validate_new_password
from .policy import get_policy, password_rules, public_policy
from .presence import PRESENCE_TIMEOUT_SECONDS, heartbeat, idle_seconds, is_stale, mark_online
from .roles import login_allowed, role_for_user
from .rate_limit import clear_failed_login, lockout_seconds_remaining, record_failed_login


def _permissions_for(user):
    """An admin bypasses every require_permission() check regardless of these rows (see
    decorators.py) -- None is a sentinel the frontend reads as "admin, everything visible"
    rather than an empty list, which would otherwise look identical to "no permissions"."""
    if user.role == 'admin':
        return None
    return sorted(p.permission for p in UserPermission.query.filter_by(user_id=user.id).all())

bp = Blueprint('auth_engine', __name__, url_prefix='/api/auth')

# Paths that must stay reachable without a session -- same idea as module_app's
# PUBLIC_API_PATHS in main.py.
PUBLIC_PATHS = {
    '/api/auth/login', '/api/auth/logout', '/api/auth/forgot-password',
    '/api/auth/reset-password', '/api/auth/recovery-requests', '/api/auth/policy',
}
# Still reachable while an account is flagged must_change_password -- everything else under
# /api/ is refused until the temporary password has been replaced (see register_presence_enforcement).
PASSWORD_CHANGE_ALLOWED_PATHS = PUBLIC_PATHS | {'/api/auth/current_user', '/api/auth/change-password',
                                                '/api/auth/presence', '/api/settings'}

RESET_TOKEN_LIFETIME = timedelta(hours=1)

# Called as hook(recovery_request) after a new account-recovery request is saved -- lets the
# host app notify admins without auth_engine depending on any notification module.
RECOVERY_REQUEST_HOOKS = []


def register_recovery_request_hook(hook):
    RECOVERY_REQUEST_HOOKS.append(hook)


# Called as hook(user_or_None, identifier, reason) when a forgot-password request couldn't be
# emailed (email not set up, no recovery email on file, or the send failed) -- so the host
# app can tell an admin to issue a temporary password instead of the person waiting forever.
RESET_UNDELIVERED_HOOKS = []


def register_reset_undelivered_hook(hook):
    RESET_UNDELIVERED_HOOKS.append(hook)


def _reset_undelivered(user, identifier, reason):
    for hook in RESET_UNDELIVERED_HOOKS:
        try:
            hook(user, identifier, reason)
        except Exception as e:
            print(f'[auth_engine] reset-undelivered hook failed: {e}')


# Set by the host app: fn(user) -> dict of extra display fields (e.g. the linked employee's
# name and photo URL), merged into the current-user JSON. auth_engine itself knows nothing
# about employees.
_profile_provider = lambda user: {}  # noqa: E731


def set_profile_provider(fn):
    global _profile_provider
    _profile_provider = fn


def password_expired(user, policy=None):
    days = int((policy or get_policy())['password_expiry_days'] or 0)
    return bool(days and user.password_changed_at
                and user.password_changed_at < datetime.utcnow() - timedelta(days=days))


def needs_password_change(user):
    """A temporary password (admin-issued) or one older than the policy allows."""
    return bool(user.must_change_password) or password_expired(user)


def _user_json(user):
    role = role_for_user(user)
    expired = password_expired(user)
    out = {'id': user.id, 'username': user.username, 'role': user.role,
           'access_role': user.access_role,
           'role_label': role.label if role else ('Administrator' if user.role == 'admin' else 'Custom'),
           'role_color': role.color if role else None, 'email': user.email,
           'must_change_password': bool(user.must_change_password) or expired,
           'password_change_reason': 'temporary' if user.must_change_password else 'expired' if expired else None,
           'permissions': _permissions_for(user)}
    try:
        out.update(_profile_provider(user) or {})
    except Exception as e:
        print(f'[auth_engine] profile provider failed: {e}')
    return out


def _hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


@bp.route('/login', methods=['POST'])
def login():
    data = request.get_json(force=True) or {}
    username = (data.get('username') or '').strip().lower()
    password = data.get('password') or ''
    if not username or not password:
        return jsonify({'error': 'Missing username or password'}), 400

    locked = lockout_seconds_remaining(username)
    if locked > 0:
        return jsonify({'error': f'Too many failed attempts. Try again in {locked} seconds.',
                        'locked_seconds': locked}), 429

    user = User.query.filter_by(username=username).first()
    if not user or not user.check_password(password):
        left = record_failed_login(username)
        if left == 0:
            locked = lockout_seconds_remaining(username)
            return jsonify({'error': f'Too many failed attempts. Try again in {locked} seconds.',
                            'locked_seconds': locked}), 429
        return jsonify({'error': 'Invalid username or password', 'attempts_left': left}), 401
    if user.is_active is False:
        return jsonify({'error': 'This account has been deactivated. Contact an administrator.'}), 403
    allowed, reason = login_allowed(user)
    if not allowed:
        return jsonify({'error': reason}), 403

    clear_failed_login(username)
    if user.password_changed_at is None:  # account older than password expiry -- start its clock
        user.password_changed_at = datetime.utcnow()
        db.session.commit()
    session['user_id'] = user.id
    session['role'] = user.role
    session['username'] = user.username
    mark_online(username)
    return jsonify(_user_json(user))


@bp.route('/policy', methods=['GET'])
def policy():
    """What the sign-in, reset and change-password screens show: password rules, lockout
    limits, the notice banner and whether to show demo accounts. Public -- it describes the
    system, not any account."""
    out = public_policy()
    out['password_rules'] = password_rules()
    return jsonify(out)


@bp.route('/logout', methods=['POST'])
def logout():
    if session.get('username'):
        heartbeat(session['username'], 'offline')  # shows as offline right away in HR
    session.clear()
    return jsonify({'success': True})


@bp.route('/current_user', methods=['GET'])
def current_user():
    user = get_current_user()
    if user is None or user.is_active is False:
        return jsonify(None)
    return jsonify(_user_json(user))


@bp.route('/change-password', methods=['POST'])
@login_required
def change_password():
    user = get_current_user()
    data = request.get_json(force=True) or {}
    if not user.check_password(data.get('current_password') or ''):
        return jsonify({'error': 'current password is incorrect'}), 400
    new_password = data.get('new_password') or ''
    error = validate_new_password(new_password)
    if error:
        return jsonify({'error': error}), 400
    if user.check_password(new_password):
        return jsonify({'error': 'new password must be different from the current one'}), 400
    user.set_password(new_password)
    user.must_change_password = False
    db.session.commit()
    return jsonify(_user_json(user))


@bp.route('/forgot-password', methods=['POST'])
def forgot_password():
    """Emails a one-hour, single-use reset link to the account's recovery email.

    Whether an account exists is never revealed: a real account and an unknown one get the
    same answer. What *is* said plainly is when email isn't set up on this server -- that's
    configuration, not account data, and pretending "a link has been sent" when nothing can
    be sent left people waiting for an email that would never come. Whenever a link can't be
    delivered, admins are notified (see RESET_UNDELIVERED_HOOKS) so they can issue a
    temporary password."""
    data = request.get_json(force=True) or {}
    identifier = (data.get('identifier') or '').strip().lower()
    if not identifier:
        return jsonify({'error': 'enter your username or recovery email'}), 400
    # Only active accounts: after an approved recovery the old (deactivated) login keeps the
    # same email as its replacement, and must not shadow it.
    active = db.or_(User.is_active.is_(True), User.is_active.is_(None))
    user = (User.query.filter(db.func.lower(User.email) == identifier, active).order_by(User.id.desc()).first()
            or User.query.filter(User.username == identifier, active).first())

    if not smtp_configured():
        _reset_undelivered(user, identifier, 'email sending is not set up on the server')
        return jsonify({
            'delivered': False,
            'message': "Password-reset emails aren't set up on this system yet, so no email can be "
                       "sent. An administrator has been notified and can give you a temporary "
                       "password — or use \u201cCan't access your account?\u201d to send a request.",
        })

    generic = {'delivered': None,
               'message': 'If that account has a recovery email on file, a reset link has been sent to it. '
                          "It can take a few minutes — check your spam folder. If nothing arrives, use "
                          "\u201cCan't access your account?\u201d."}
    if user is None:
        return jsonify(generic)
    if not user.email:
        _reset_undelivered(user, identifier, 'the account has no recovery email on file')
        return jsonify(generic)

    token = secrets.token_urlsafe(32)
    db.session.add(PasswordResetToken(user_id=user.id, token_hash=_hash_token(token),
                                      expires_at=datetime.utcnow() + RESET_TOKEN_LIFETIME))
    db.session.commit()
    link = f"{request.host_url.rstrip('/')}/?reset_token={token}"
    sent, reason = send_email_detailed(
        user.email, 'Reset your password',
        f'Hello {user.username},\n\nSomeone (hopefully you) asked to reset your password.\n'
        f'Open this link within 1 hour to choose a new one:\n\n{link}\n\n'
        f"If you didn't ask for this, you can ignore this email.")
    if not sent:
        _reset_undelivered(user, identifier, f'sending to {user.email} failed: {reason}')
    return jsonify(generic)


@bp.route('/reset-password', methods=['POST'])
def reset_password():
    data = request.get_json(force=True) or {}
    token = data.get('token') or ''
    row = PasswordResetToken.query.filter_by(token_hash=_hash_token(token)).first()
    if row is None or row.used_at is not None or row.expires_at < datetime.utcnow():
        return jsonify({'error': 'this reset link is invalid or has expired -- request a new one'}), 400
    new_password = data.get('new_password') or ''
    error = validate_new_password(new_password)
    if error:
        return jsonify({'error': error}), 400
    user = User.query.get(row.user_id)
    user.set_password(new_password)
    user.must_change_password = False
    row.used_at = datetime.utcnow()
    db.session.commit()
    clear_failed_login(user.username)
    return jsonify({'message': 'Password updated -- you can now log in.', 'username': user.username})


@bp.route('/recovery-requests', methods=['POST'])
def create_recovery_request():
    """'I can't get back into my account at all' -- queued for an admin to approve."""
    data = request.get_json(force=True) or {}
    full_name = (data.get('full_name') or '').strip()
    contact = (data.get('contact') or '').strip()
    if not full_name or not contact:
        return jsonify({'error': 'your full name and a way to contact you are required'}), 400
    old_username = (data.get('old_username') or '').strip().lower() or None
    if AccountRecoveryRequest.query.filter_by(status='pending', full_name=full_name,
                                              old_username=old_username).first():
        return jsonify({'message': 'A request for this account is already waiting for admin approval.'})
    matched = User.query.filter_by(username=old_username).first() if old_username else None
    req = AccountRecoveryRequest(full_name=full_name, old_username=old_username, contact=contact,
                                 reason=(data.get('reason') or '').strip() or None,
                                 user_id=matched.id if matched else None)
    db.session.add(req)
    db.session.commit()
    for hook in RECOVERY_REQUEST_HOOKS:
        try:
            hook(req)
        except Exception as e:
            print(f'[auth_engine] recovery-request hook failed: {e}')
    return jsonify({'message': 'Request sent. An administrator will review it and contact you.'}), 201


@bp.route('/presence', methods=['POST'])
def presence():
    username = session.get('username')
    if not username:
        return jsonify({'error': 'not authenticated'}), 401
    # force=True: navigator.sendBeacon (used for 'offline' on tab close) posts text/plain.
    data = request.get_json(force=True, silent=True) or {}
    status = data.get('status', 'online')
    heartbeat(username, status if status in ('online', 'idle', 'offline') else 'online', data.get('idle_for'))
    return jsonify({'success': True})


def register_presence_enforcement(app):
    """Force-expire a session on a stale heartbeat only -- never on an explicit 'offline'
    report (see presence.py). Admins are exempt, same as module_app. Call once on the app
    returned by create_app()."""
    @app.before_request
    def _enforce_presence_timeout():
        if not request.path.startswith('/api/') or request.path in PUBLIC_PATHS:
            return
        role = (session.get('role') or '').lower()
        username = session.get('username')
        if username and role != 'admin' and is_stale(username):
            session.clear()
            return jsonify({'error': 'Session ended due to offline status'}), 401
        # Idle logout (HR -> Policy): applies to everyone, admins included. Measured from the
        # browser's heartbeats, so background polling doesn't count as activity.
        idle_minutes = int(get_policy()['idle_logout_minutes'] or 0)
        if username and idle_minutes and idle_seconds(username) > idle_minutes * 60:
            heartbeat(username, 'offline')
            session.clear()
            return jsonify({'error': f'You were signed out after {idle_minutes} minutes of inactivity.',
                            'reason': 'idle'}), 401

    @app.before_request
    def _enforce_account_state():
        """Server-side half of the forced password change (the UI's change-password screen
        is only the friendly half): a session on a temporary password, or on an account
        deactivated since login, can't reach the rest of the API."""
        if not request.path.startswith('/api/') or request.path in PASSWORD_CHANGE_ALLOWED_PATHS:
            return
        user = get_current_user()
        if user is None:
            return
        if user.is_active is False:
            session.clear()
            return jsonify({'error': 'This account has been deactivated.'}), 401
        allowed, reason = login_allowed(user)
        if not allowed:
            session.clear()
            return jsonify({'error': reason}), 401
        if needs_password_change(user):
            return jsonify({'error': 'You must set a new password before continuing.',
                            'must_change_password': True}), 403
