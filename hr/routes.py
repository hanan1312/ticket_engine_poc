import re
from datetime import date, datetime

from flask import Blueprint, Response, jsonify, request

from auth_engine import (
    ROLE_COLORS, AccountRecoveryRequest, Role, User, all_roles, apply_role, generate_temp_password,
    get_current_user, get_role, is_registered_permission, last_seen, password_rules, presence_status,
    registered_permissions, require_permission, role_members, send_email, sync_user_permissions,
)
from auth_engine.models import UserPermission
from shared_db import db

from .attendance import compute_attendance_summary, get_config
from .models import AttendanceSession, Employee

bp = Blueprint('hr', __name__, url_prefix='/api/hr')

# Which permission strings exist is not hard-coded here: the host app registers one per sidebar
# tab (auth_engine.register_permission, see demo/app.py), and the account editor lists and
# validates against that registry -- so a new tab is grantable as soon as it's in the sidebar.

# What "assign an employee a role" means: a role (auth_engine.Role, managed under HR -> Roles)
# is a coarse auth role (admin bypasses every permission check) plus the permission strings it
# grants. Picking one for an account sets both; the per-permission switches can still fine-tune
# that one account afterwards, until the role itself is next edited.

USERNAME_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{2,39}$')
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


def _is_admin():
    user = get_current_user()
    return user is not None and user.role == 'admin'


# ---- Employees ----

@bp.route('/employees', methods=['GET'])
@require_permission('hr-management')
def list_employees():
    employees = Employee.query.order_by(Employee.name).all()
    return jsonify([_employee_json(e) for e in employees])


@bp.route('/employees', methods=['POST'])
@require_permission('hr-management')
def create_employee():
    data = request.get_json(force=True) or {}
    if not data.get('name') or not data.get('role'):
        return jsonify({'error': 'name and role are required'}), 400
    employee = Employee(
        name=data['name'], role=data['role'], phone=data.get('phone'),
        email=data.get('email'), username=data.get('username'),
    )
    db.session.add(employee)
    db.session.commit()
    return jsonify(_employee_json(employee)), 201


@bp.route('/employees/<int:employee_id>', methods=['PUT'])
@require_permission('hr-management')
def update_employee(employee_id):
    employee = Employee.query.get_or_404(employee_id)
    data = request.get_json(force=True) or {}
    for field in ('name', 'role'):
        if field in data:
            value = (data[field] or '').strip()
            if not value:
                return jsonify({'error': f'{field} cannot be empty'}), 400
            setattr(employee, field, value)
    if 'email' in data:
        email = (data['email'] or '').strip() or None
        if email and not EMAIL_RE.match(email):
            return jsonify({'error': 'email address looks invalid'}), 400
        employee.email = email
    if 'phone' in data:
        employee.phone = (data['phone'] or '').strip() or None
    if 'status' in data:
        if data['status'] not in ('active', 'on_leave', 'terminated'):
            return jsonify({'error': 'status must be active, on_leave or terminated'}), 400
        employee.status = data['status']
    # Keep the linked login's phone in step -- it's what WhatsApp notifications are sent to.
    account = _account_for(employee)
    if account is not None and 'phone' in data:
        account.phone = employee.phone
    db.session.commit()
    return jsonify(_employee_json(employee))


@bp.route('/employees/<int:employee_id>', methods=['DELETE'])
@require_permission('hr-management')
def delete_employee(employee_id):
    employee = Employee.query.get_or_404(employee_id)
    db.session.delete(employee)  # ondelete=CASCADE on attendance_sessions handles the rest
    db.session.commit()
    return jsonify({'success': True})


# ---- Employee photo ----

PHOTO_TYPES = {'image/png', 'image/jpeg', 'image/webp', 'image/gif'}
MAX_PHOTO_BYTES = 3 * 1024 * 1024


@bp.route('/employees/<int:employee_id>/photo', methods=['POST'])
@require_permission('hr-management')
def upload_employee_photo(employee_id):
    employee = Employee.query.get_or_404(employee_id)
    file = request.files.get('photo')
    if file is None or not file.filename:
        return jsonify({'error': 'no photo uploaded'}), 400
    if file.mimetype not in PHOTO_TYPES:
        return jsonify({'error': 'photo must be a PNG, JPG, WebP or GIF image'}), 400
    data = file.read()
    if len(data) > MAX_PHOTO_BYTES:
        return jsonify({'error': 'photo must be under 3MB'}), 400
    employee.photo_data = data
    employee.photo_mimetype = file.mimetype
    employee.photo_updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify(_employee_json(employee))


@bp.route('/employees/<int:employee_id>/photo', methods=['GET'])
def get_employee_photo(employee_id):
    """HR staff can see any photo; everyone else only their own (for the header avatar)."""
    user = get_current_user()
    if user is None:
        return jsonify({'error': 'Authentication required. Please log in.'}), 401
    employee = Employee.query.get_or_404(employee_id)
    if employee.username != user.username and not _can_manage_hr(user):
        return jsonify({'error': 'Permission denied'}), 403
    if not employee.photo_data:
        return jsonify({'error': 'no photo'}), 404
    return Response(employee.photo_data, mimetype=employee.photo_mimetype,
                    headers={'Cache-Control': 'private, max-age=86400'})


@bp.route('/employees/<int:employee_id>/photo', methods=['DELETE'])
@require_permission('hr-management')
def delete_employee_photo(employee_id):
    employee = Employee.query.get_or_404(employee_id)
    employee.photo_data = employee.photo_mimetype = employee.photo_updated_at = None
    db.session.commit()
    return jsonify(_employee_json(employee))


# ---- Attendance ----

@bp.route('/employees/<int:employee_id>/attendance/clock-in', methods=['POST'])
@require_permission('hr-management')
def clock_in(employee_id):
    Employee.query.get_or_404(employee_id)
    if AttendanceSession.query.filter_by(employee_id=employee_id, clock_out=None).first():
        return jsonify({'error': 'this employee is already clocked in'}), 400
    user = get_current_user()
    session_row = AttendanceSession(employee_id=employee_id, clock_in=datetime.utcnow(),
                                     recorded_by=user.username)
    db.session.add(session_row)
    db.session.commit()
    return jsonify(_session_json(session_row)), 201


@bp.route('/employees/<int:employee_id>/attendance/clock-out', methods=['POST'])
@require_permission('hr-management')
def clock_out(employee_id):
    open_session = AttendanceSession.query.filter_by(employee_id=employee_id, clock_out=None).first()
    if open_session is None:
        return jsonify({'error': 'this employee is not clocked in'}), 400
    open_session.clock_out = datetime.utcnow()
    db.session.commit()
    return jsonify(_session_json(open_session))


@bp.route('/employees/<int:employee_id>/attendance/sessions', methods=['GET'])
@require_permission('hr-management')
def list_sessions(employee_id):
    sessions = (AttendanceSession.query.filter_by(employee_id=employee_id)
                .order_by(AttendanceSession.clock_in.desc()).all())
    return jsonify([_session_json(s) for s in sessions])


@bp.route('/employees/<int:employee_id>/attendance/summary', methods=['GET'])
@require_permission('hr-management')
def attendance_summary(employee_id):
    Employee.query.get_or_404(employee_id)
    date_from_raw = request.args.get('date_from')
    date_to_raw = request.args.get('date_to')
    today = date.today()
    date_from = datetime.strptime(date_from_raw, '%Y-%m-%d').date() if date_from_raw else today.replace(day=1)
    date_to = datetime.strptime(date_to_raw, '%Y-%m-%d').date() if date_to_raw else today
    try:
        tz_offset = max(-840, min(840, int(request.args.get('tz_offset', 0))))
    except ValueError:
        tz_offset = 0
    return jsonify(compute_attendance_summary(employee_id, date_from, date_to, tz_offset))


# ---- Security (permission management + policy config) ----

@bp.route('/security/roles', methods=['GET'])
@require_permission('hr-management')
def list_roles():
    counts = {}
    for u in User.query.all():
        counts.setdefault(u.access_role, [0, 0])
        counts[u.access_role][0 if u.is_active is not False else 1] += 1
    return jsonify([_role_json(r, *counts.get(r.key, [0, 0])) for r in all_roles()])


@bp.route('/security/roles', methods=['POST'])
@require_permission('hr-management')
def create_role():
    if not _is_admin():
        return jsonify({'error': 'only an admin can create roles'}), 403
    data = request.get_json(force=True) or {}
    label = (data.get('label') or '').strip()
    if not label:
        return jsonify({'error': 'give the role a name'}), 400
    if len(label) > 60:
        return jsonify({'error': 'role name must be 60 characters or fewer'}), 400
    if Role.query.filter(db.func.lower(Role.label) == label.lower()).first():
        return jsonify({'error': f'a role called "{label}" already exists'}), 400
    role = Role(key=_role_key(label), label=label, is_system=False, is_admin=False)
    error = _apply_role_fields(role, data)
    if error:
        return jsonify({'error': error}), 400
    db.session.add(role)
    db.session.commit()
    return jsonify(_role_json(role, 0, 0)), 201


@bp.route('/security/roles/<key>', methods=['PUT'])
@require_permission('hr-management')
def update_role(key):
    """Edit a role; the new permissions and sign-in switch apply to everyone holding it."""
    if not _is_admin():
        return jsonify({'error': 'only an admin can change roles'}), 403
    role = Role.query.filter_by(key=key).first_or_404()
    data = request.get_json(force=True) or {}
    if 'label' in data:
        label = (data.get('label') or '').strip()
        if not label:
            return jsonify({'error': 'role name cannot be empty'}), 400
        if Role.query.filter(db.func.lower(Role.label) == label.lower(), Role.id != role.id).first():
            return jsonify({'error': f'a role called "{label}" already exists'}), 400
        role.label = label[:60]
    error = _apply_role_fields(role, data)
    if error:
        return jsonify({'error': error}), 400
    members = role_members(role)
    for user in members:
        apply_role(user, role)
    db.session.commit()
    active = sum(1 for u in members if u.is_active is not False)
    return jsonify(_role_json(role, active, len(members) - active))


@bp.route('/security/roles/<key>', methods=['DELETE'])
@require_permission('hr-management')
def delete_role(key):
    """Delete a custom role. Anyone holding it (deactivated accounts included, so their record
    stays meaningful) must be moved to another role in the same call (`reassign_to`)."""
    if not _is_admin():
        return jsonify({'error': 'only an admin can delete roles'}), 403
    role = Role.query.filter_by(key=key).first_or_404()
    if role.is_system:
        return jsonify({'error': 'built-in roles can be edited but not deleted'}), 400
    members = role_members(role)
    data = request.get_json(force=True, silent=True) or {}
    if members:
        target = get_role(data.get('reassign_to'))
        if target is None or target.id == role.id:
            return jsonify({'error': f'{len(members)} account(s) have this role -- choose a role to move them to',
                            'members': len(members)}), 400
        for user in members:
            apply_role(user, target)
    db.session.delete(role)
    db.session.commit()
    return jsonify({'success': True, 'moved': len(members)})


@bp.route('/security/permissions', methods=['GET'])
@require_permission('hr-management')
def list_permissions():
    """Every grantable permission -- one per sidebar tab -- in sidebar order."""
    return jsonify(registered_permissions())


@bp.route('/security/users', methods=['GET'])
@require_permission('hr-management')
def list_security_users():
    users = User.query.order_by(User.username).all()
    perms_by_user = {}
    for row in UserPermission.query.all():
        perms_by_user.setdefault(row.user_id, []).append(row.permission)
    employees = {e.username: e for e in Employee.query.filter(Employee.username.isnot(None)).all()}
    roles = {r.key: r for r in Role.query.all()}
    return jsonify([_account_json(u, perms_by_user.get(u.id, []), employees.get(u.username), roles)
                    for u in users])


@bp.route('/security/accounts', methods=['POST'])
@require_permission('hr-management')
def create_account():
    """Give an employee a login: pick a role preset, get a one-time temporary password.
    The owner is forced to replace it on first login (see auth_engine's must_change_password
    guard), and the recovery email is what forgot-password links go to afterwards."""
    if not _is_admin():
        return jsonify({'error': 'only an admin can create accounts'}), 403
    data = request.get_json(force=True) or {}
    employee = Employee.query.get(data.get('employee_id'))
    if employee is None:
        return jsonify({'error': 'pick an employee'}), 400
    if _account_for(employee) is not None:
        return jsonify({'error': f'{employee.name} already has an account ({employee.username})'}), 400
    role = get_role(data.get('access_role'))
    if role is None:
        return jsonify({'error': 'pick a role'}), 400
    email = (data.get('email') or employee.email or '').strip()
    if not EMAIL_RE.match(email):
        return jsonify({'error': 'a valid recovery email is required (used for forgot-password links)'}), 400
    username = (data.get('username') or '').strip().lower() or _suggest_username(employee.name)
    error = _username_error(username)
    if error:
        return jsonify({'error': error}), 400

    temp_password = generate_temp_password()
    user = _new_user(username, role, email, employee.phone, temp_password)
    employee.username = user.username
    if not employee.email:
        employee.email = email
    db.session.commit()
    emailed = _email_credentials(user, temp_password, 'Your account has been created')
    return jsonify({'account': _account_json(user, role.permission_list(), employee),
                    'temp_password': temp_password, 'emailed': emailed}), 201


@bp.route('/security/users/<int:user_id>', methods=['PUT'])
@require_permission('hr-management')
def update_account(user_id):
    if not _is_admin():
        return jsonify({'error': 'only an admin can change accounts'}), 403
    user = User.query.get_or_404(user_id)
    me = get_current_user()
    data = request.get_json(force=True) or {}

    if 'access_role' in data:
        role = get_role(data['access_role'])
        if role is None:
            return jsonify({'error': 'unknown role'}), 400
        if user.role == 'admin' and not role.is_admin:
            if user.id == me.id:
                return jsonify({'error': "you can't remove your own admin role"}), 400
            if _active_admin_count() <= 1:
                return jsonify({'error': 'this is the last active admin'}), 400
        apply_role(user, role)
    if 'permissions' in data and user.role != 'admin':
        requested = set(data['permissions'] or [])
        invalid = {p for p in requested if not is_registered_permission(p)}
        if invalid:
            return jsonify({'error': f'unknown permission(s): {sorted(invalid)}'}), 400
        sync_user_permissions(user, ','.join(sorted(requested)))
    if 'email' in data:
        email = (data['email'] or '').strip()
        if email and not EMAIL_RE.match(email):
            return jsonify({'error': 'email address looks invalid'}), 400
        user.email = email or None
    if 'is_active' in data:
        active = bool(data['is_active'])
        if not active and user.id == me.id:
            return jsonify({'error': "you can't deactivate your own account"}), 400
        if not active and user.role == 'admin' and _active_admin_count() <= 1:
            return jsonify({'error': 'this is the last active admin'}), 400
        user.is_active = active
    db.session.commit()
    perms = [p.permission for p in UserPermission.query.filter_by(user_id=user.id).all()]
    return jsonify(_account_json(user, perms, Employee.query.filter_by(username=user.username).first()))


@bp.route('/security/users/<int:user_id>/reset-password', methods=['POST'])
@require_permission('hr-management')
def admin_reset_password(user_id):
    """Admin-issued temporary password, for someone who can't use the emailed reset link."""
    if not _is_admin():
        return jsonify({'error': 'only an admin can reset passwords'}), 403
    user = User.query.get_or_404(user_id)
    temp_password = generate_temp_password()
    user.set_password(temp_password)
    user.must_change_password = True
    db.session.commit()
    emailed = _email_credentials(user, temp_password, 'Your password has been reset')
    return jsonify({'username': user.username, 'temp_password': temp_password, 'emailed': emailed})


@bp.route('/security/recovery-requests', methods=['GET'])
@require_permission('hr-management')
def list_recovery_requests():
    rows = AccountRecoveryRequest.query.order_by(AccountRecoveryRequest.created_at.desc()).all()
    return jsonify([_recovery_json(r) for r in rows])


@bp.route('/security/recovery-requests/<int:request_id>/approve', methods=['POST'])
@require_permission('hr-management')
def approve_recovery_request(request_id):
    """Replaces an unrecoverable account: the old login is deactivated (kept, not deleted,
    so tickets/audit rows that reference it stay intact) and a new one is issued with the
    same role, linked to the same employee record."""
    if not _is_admin():
        return jsonify({'error': 'only an admin can approve account recovery'}), 403
    req = AccountRecoveryRequest.query.get_or_404(request_id)
    if req.status != 'pending':
        return jsonify({'error': f'this request was already {req.status}'}), 400
    data = request.get_json(force=True) or {}
    old = User.query.get(req.user_id) if req.user_id else None
    employee = (Employee.query.get(data['employee_id']) if data.get('employee_id')
                else Employee.query.filter_by(username=old.username).first() if old else None)
    if employee is None:
        return jsonify({'error': 'pick the employee this request belongs to'}), 400
    role = (get_role(data.get('access_role')) or (get_role(old.access_role) if old else None)
            or get_role('admin' if old and old.role == 'admin' else 'technician'))
    email = (data.get('email') or (req.contact if EMAIL_RE.match(req.contact or '') else '')
             or employee.email or '').strip()
    if not EMAIL_RE.match(email):
        return jsonify({'error': 'a valid recovery email for the new account is required'}), 400
    username = (data.get('username') or '').strip().lower() or _suggest_username(employee.name)
    error = _username_error(username)
    if error:
        return jsonify({'error': error}), 400
    me = get_current_user()
    if old is not None and old.id == me.id:
        return jsonify({'error': "you can't replace your own account"}), 400

    temp_password = generate_temp_password()
    user = _new_user(username, role, email, employee.phone, temp_password)
    if old is not None:
        old.is_active = False
    employee.username = user.username
    req.status = 'approved'
    req.new_user_id = user.id
    req.decided_by = me.username
    req.decided_at = datetime.utcnow()
    db.session.commit()
    emailed = _email_credentials(user, temp_password, 'Your new account is ready')
    return jsonify({'request': _recovery_json(req), 'username': user.username,
                    'temp_password': temp_password, 'emailed': emailed})


@bp.route('/security/recovery-requests/<int:request_id>/reject', methods=['POST'])
@require_permission('hr-management')
def reject_recovery_request(request_id):
    if not _is_admin():
        return jsonify({'error': 'only an admin can reject account recovery'}), 403
    req = AccountRecoveryRequest.query.get_or_404(request_id)
    if req.status != 'pending':
        return jsonify({'error': f'this request was already {req.status}'}), 400
    req.status = 'rejected'
    req.decided_by = get_current_user().username
    req.decided_at = datetime.utcnow()
    db.session.commit()
    return jsonify(_recovery_json(req))


@bp.route('/security/users/<int:user_id>/permissions', methods=['PUT'])
@require_permission('hr-management')
def update_user_permissions(user_id):
    if not _is_admin():
        return jsonify({'error': 'only an admin can change permissions'}), 403
    user = User.query.get_or_404(user_id)
    data = request.get_json(force=True) or {}
    requested = set(data.get('permissions') or [])
    invalid = {p for p in requested if not is_registered_permission(p)}
    if invalid:
        return jsonify({'error': f'unknown permission(s): {sorted(invalid)}'}), 400
    sync_user_permissions(user, ','.join(sorted(requested)))
    db.session.commit()
    return jsonify({'id': user.id, 'username': user.username, 'permissions': sorted(requested)})


@bp.route('/security/policy', methods=['GET'])
@require_permission('hr-management')
def get_policy():
    config = get_config()
    return jsonify(_config_json(config))


# field -> (type, min, max). Booleans have no range.
POLICY_FIELDS = {
    'standard_work_hours_per_day': (float, 0, 24),
    'idle_logout_timeout_minutes': (int, 0, 24 * 60),
    'password_min_length': (int, 8, 64),
    'password_require_digit': (bool, None, None),
    'password_require_upper': (bool, None, None),
    'password_require_symbol': (bool, None, None),
    'password_expiry_days': (int, 0, 3650),
    'lockout_threshold': (int, 1, 50),
    'lockout_minutes': (int, 1, 24 * 60),
    'show_demo_accounts': (bool, None, None),
}


@bp.route('/security/policy', methods=['PUT'])
@require_permission('hr-management')
def update_policy():
    if not _is_admin():
        return jsonify({'error': 'only an admin can change policy settings'}), 403
    data = request.get_json(force=True) or {}
    config = get_config()
    for field, (kind, low, high) in POLICY_FIELDS.items():
        if field not in data:
            continue
        if kind is bool:
            setattr(config, field, bool(data[field]))
            continue
        try:
            value = kind(data[field])
        except (TypeError, ValueError):
            return jsonify({'error': f'{field.replace("_", " ")} must be a number'}), 400
        if not low <= value <= high:
            return jsonify({'error': f'{field.replace("_", " ")} must be between {low} and {high}'}), 400
        setattr(config, field, value)
    if 'login_banner' in data:
        banner = (data['login_banner'] or '').strip()
        if len(banner) > 500:
            return jsonify({'error': 'the sign-in notice must be 500 characters or fewer'}), 400
        config.login_banner = banner or None
    db.session.commit()
    return jsonify(_config_json(config))


def security_policy():
    """auth_engine's policy provider (see demo/app.py): HR -> Policy as auth_engine's keys."""
    c = get_config()
    return {
        'password_min_length': c.password_min_length, 'password_require_digit': c.password_require_digit,
        'password_require_upper': c.password_require_upper, 'password_require_symbol': c.password_require_symbol,
        'password_expiry_days': c.password_expiry_days, 'lockout_threshold': c.lockout_threshold,
        'lockout_minutes': c.lockout_minutes, 'idle_logout_minutes': c.idle_logout_timeout_minutes,
        'login_banner': c.login_banner or '', 'show_demo_accounts': c.show_demo_accounts,
    }


def _can_manage_hr(user):
    return user.role == 'admin' or UserPermission.query.filter_by(
        user_id=user.id, permission='hr-management').first() is not None


def profile_for_user(user):
    """Display fields for the logged-in user's header chip: the linked employee's name and
    photo (see auth_engine.set_profile_provider)."""
    employee = Employee.query.filter_by(username=user.username).first()
    if employee is None:
        return {'display_name': None, 'photo_url': None}
    photo = (f'/api/hr/employees/{employee.id}/photo?v={int(employee.photo_updated_at.timestamp())}'
             if employee.photo_data and employee.photo_updated_at else None)
    return {'display_name': employee.name, 'photo_url': photo}


def _account_for(employee):
    return User.query.filter_by(username=employee.username).first() if employee.username else None


def _active_admin_count():
    return sum(1 for u in User.query.filter_by(role='admin').all() if u.is_active is not False)


def _suggest_username(full_name):
    base = re.sub(r'[^a-z0-9]+', '.', (full_name or 'user').lower()).strip('.') or 'user'
    base = base[:30] if len(base) >= 3 else f'{base}.user'
    candidate, n = base, 2
    while User.query.filter_by(username=candidate).first() is not None:
        candidate, n = f'{base}{n}', n + 1
    return candidate


def _username_error(username):
    if not USERNAME_RE.match(username):
        return 'username must be 3-40 characters: lowercase letters, digits, dot, dash or underscore'
    if User.query.filter_by(username=username).first() is not None:
        return f"username '{username}' is already taken"
    return None


def _new_user(username, role, email, phone, temp_password):
    user = User(username=username, email=email, phone=phone, must_change_password=True, is_active=True)
    user.set_password(temp_password)
    db.session.add(user)
    db.session.flush()
    apply_role(user, role)
    return user


def _role_key(label):
    base = re.sub(r'[^a-z0-9]+', '_', label.lower()).strip('_')[:24] or 'role'
    if not base[0].isalpha():
        base = f'r_{base}'[:24]
    candidate, n = base, 2
    while Role.query.filter_by(key=candidate).first() is not None:
        candidate, n = f'{base}_{n}', n + 1
    return candidate


def _apply_role_fields(role, data):
    """description / permissions / can_login / color from a create or update payload.
    Returns an error message or None. The Administrator role keeps full access and sign-in."""
    if 'description' in data:
        role.description = (data.get('description') or '').strip()[:255] or None
    if 'color' in data:
        if data['color'] not in ROLE_COLORS:
            return f'colour must be one of {", ".join(ROLE_COLORS)}'
        role.color = data['color']
    if 'permissions' in data and not role.is_admin:
        requested = set(data.get('permissions') or [])
        invalid = {p for p in requested if not is_registered_permission(p)}
        if invalid:
            return f'unknown permission(s): {sorted(invalid)}'
        order = [p['key'] for p in registered_permissions()]
        role.permissions = ','.join(sorted(requested, key=order.index))
    if 'can_login' in data:
        if role.is_admin and not data['can_login']:
            return 'the Administrator role must always be able to sign in'
        role.can_login = bool(data['can_login'])
    return None


def _role_json(role, active_users, inactive_users):
    return {
        'key': role.key, 'label': role.label, 'description': role.description or '',
        'is_admin': role.is_admin, 'permissions': role.permission_list(), 'is_system': role.is_system,
        'can_login': role.can_login, 'color': role.color, 'user_count': active_users,
        'inactive_user_count': inactive_users,
        # Legacy field from the ROLE_PRESETS days.
        'role': 'admin' if role.is_admin else 'staff',
    }


def _email_credentials(user, temp_password, subject):
    link = request.host_url.rstrip('/')
    return send_email(user.email, subject,
                      f'Hello,\n\nYour login for {link} :\n\n  Username: {user.username}\n'
                      f'  Temporary password: {temp_password}\n\n'
                      'You will be asked to choose your own password the first time you log in.')


def _account_json(user, permissions, employee, roles=None):
    role = roles.get(user.access_role) if roles is not None else get_role(user.access_role)
    customised = bool(role and not role.is_admin and sorted(role.permission_list()) != sorted(permissions))
    return {
        'id': user.id, 'username': user.username, 'role': user.role,
        'access_role': user.access_role,
        'access_role_label': role.label if role else ('Administrator' if user.role == 'admin' else 'Custom'),
        'role_color': role.color if role else 'slate',
        'role_can_login': role.can_login if role else True,
        'permissions_customised': customised,
        'email': user.email, 'phone': user.phone, 'is_active': user.is_active is not False,
        'must_change_password': bool(user.must_change_password),
        'presence': presence_status(user.username) if user.is_active is not False else 'offline',
        'last_seen': (datetime.utcfromtimestamp(last_seen(user.username)).isoformat()
                      if last_seen(user.username) else None),
        'password_changed_at': user.password_changed_at.isoformat() if user.password_changed_at else None,
        'permissions': sorted(permissions),
        'employee_id': employee.id if employee else None,
        'employee_name': employee.name if employee else None,
        'created_at': user.created_at.isoformat() if user.created_at else None,
    }


def _recovery_json(r):
    old = User.query.get(r.user_id) if r.user_id else None
    new = User.query.get(r.new_user_id) if r.new_user_id else None
    employee = Employee.query.filter_by(username=old.username).first() if old else None
    return {
        'id': r.id, 'full_name': r.full_name, 'old_username': r.old_username, 'contact': r.contact,
        'reason': r.reason, 'status': r.status, 'matched_user': old.username if old else None,
        'matched_employee_id': employee.id if employee else None,
        'matched_access_role': old.access_role if old else None,
        'new_username': new.username if new else None, 'decided_by': r.decided_by,
        'decided_at': r.decided_at.isoformat() if r.decided_at else None,
        'created_at': r.created_at.isoformat(),
    }


def _employee_json(employee):
    account = _account_for(employee)
    return {
        'id': employee.id, 'name': employee.name, 'role': employee.role,
        'phone': employee.phone, 'email': employee.email, 'status': employee.status,
        'join_date': employee.join_date.isoformat() if employee.join_date else None,
        'username': employee.username,
        # Cache-busting token for the photo URL; None when there's no photo.
        'photo_version': int(employee.photo_updated_at.timestamp()) if employee.photo_data and employee.photo_updated_at else None,
        # Live presence from the login's heartbeats; an employee without a login is offline.
        'presence': presence_status(account.username) if account and account.is_active is not False else 'offline',
        'last_seen': (datetime.utcfromtimestamp(last_seen(account.username)).isoformat()
                      if account and last_seen(account.username) else None),
        'account': {
            'id': account.id, 'username': account.username, 'access_role': account.access_role,
            'is_active': account.is_active is not False,
        } if account else None,
        'clocked_in': AttendanceSession.query.filter_by(employee_id=employee.id, clock_out=None).first() is not None,
    }


def _session_json(session_row):
    return {
        'id': session_row.id, 'employee_id': session_row.employee_id,
        'clock_in': session_row.clock_in.isoformat(),
        'clock_out': session_row.clock_out.isoformat() if session_row.clock_out else None,
        'recorded_by': session_row.recorded_by, 'is_open': session_row.clock_out is None,
    }


def _config_json(config):
    out = {field: getattr(config, field) for field in POLICY_FIELDS}
    out['login_banner'] = config.login_banner or ''
    out['password_rules'] = password_rules(security_policy())
    return out
