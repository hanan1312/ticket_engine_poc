"""Access roles: the built-in defaults, seeding, and applying a role to a user.

A role is stored in auth_engine_roles (see models.Role). Assigning one sets the user's coarse
auth role ('admin' bypasses every permission check) and rebuilds their permission rows from the
role's list; editing a role re-applies it to everyone who holds it."""
import re

from shared_db import db

from .models import Role, User, UserPermission, sync_user_permissions

# Seeded into an empty roles table. Same five presets the HR tab always had.
DEFAULT_ROLES = [
    {'key': 'admin', 'label': 'Administrator', 'is_admin': True, 'permissions': [], 'color': 'gold',
     'description': 'Full access to everything, including approvals and accounts.'},
    {'key': 'manager', 'label': 'Manager', 'permissions': ['assets', 'warehouse', 'hr-management', 'hotel'],
     'color': 'violet', 'description': 'Assets, warehouse, HR and hotel architecture, plus tickets. No approvals.'},
    {'key': 'storekeeper', 'label': 'Storekeeper', 'permissions': ['warehouse'], 'color': 'teal',
     'description': 'Warehouse stock, bills and work orders, plus tickets.'},
    {'key': 'hr_officer', 'label': 'HR officer', 'permissions': ['hr-management'], 'color': 'rose',
     'description': 'Employees and attendance, plus tickets.'},
    {'key': 'technician', 'label': 'Technician / staff', 'permissions': [], 'color': 'blue',
     'description': 'Raises and works on tickets; confirms deliveries sent to them.'},
]
ROLE_COLORS = ('violet', 'gold', 'teal', 'rose', 'blue', 'green', 'orange', 'slate')
ROLE_KEY_RE = re.compile(r'^[a-z][a-z0-9_]{1,29}$')


def seed_default_roles():
    """Create the built-in roles that are missing (by key). Call inside an app context."""
    existing = {r.key for r in Role.query.all()}
    for spec in DEFAULT_ROLES:
        if spec['key'] in existing:
            continue
        db.session.add(Role(key=spec['key'], label=spec['label'], description=spec['description'],
                            is_admin=spec.get('is_admin', False), permissions=','.join(spec['permissions']),
                            is_system=True, can_login=True, color=spec['color']))
    db.session.commit()


def get_role(key):
    return Role.query.filter_by(key=key).first() if key else None


def all_roles():
    """Built-in roles first (in their default order), then custom ones by name."""
    order = {spec['key']: i for i, spec in enumerate(DEFAULT_ROLES)}
    return sorted(Role.query.all(), key=lambda r: (order.get(r.key, len(order)), r.label.lower()))


def apply_role(user, role):
    """Give a user this role: auth role + permission rows. Caller commits."""
    user.role = 'admin' if role.is_admin else 'staff'
    user.access_role = role.key
    sync_user_permissions(user, ','.join(role.permission_list()))


def role_members(role):
    return User.query.filter_by(access_role=role.key).all()


def role_for_user(user):
    return get_role(user.access_role)


def login_allowed(user):
    """(allowed, reason). Admin accounts can always sign in, so an admin can never lock the
    whole system out by disabling a role."""
    if user.role == 'admin':
        return True, None
    role = role_for_user(user)
    if role is not None and not role.can_login:
        return False, f'Sign-in is currently disabled for the {role.label} role. Contact an administrator.'
    return True, None


def infer_role_key(user):
    """For accounts from before roles existed: the role whose admin flag and permission set
    match the user's exactly, else None ("Custom")."""
    perms = sorted(p.permission for p in UserPermission.query.filter_by(user_id=user.id).all())
    for role in all_roles():
        if role.is_admin == (user.role == 'admin') and (role.is_admin or sorted(role.permission_list()) == perms):
            return role.key
    return None
