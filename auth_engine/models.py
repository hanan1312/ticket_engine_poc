from datetime import datetime

from werkzeug.security import check_password_hash, generate_password_hash

# Shares the same SQLAlchemy instance as ticket_engine (see shared_db.py) rather than
# creating a second one -- in a real host app both modules would instead import the app's
# own single `db` object. See this project's README for how that swap works.
from shared_db import db


class User(db.Model):
    """Generalized from module_app's User (src/models/user.py) + admins.json master-admin
    accounts, collapsed into one table. Dropped: the clnc_*/lab_* username-prefix workspace
    routing and the separate JSON-file admin bypass, both specific to module_app's
    dual-workspace design. Kept: hashed password, a coarse admin-bypass role, and everything
    finer-grained handled by permission strings (see UserPermission)."""
    __tablename__ = 'auth_engine_users'

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default='staff')  # 'staff' | 'admin'
    # Not in module_app's User -- added here so the notifications hook (see demo/app.py) has
    # somewhere to send a ticket-assigned/resolved WhatsApp message.
    phone = db.Column(db.String(30))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    # Account-lifecycle fields: recovery email for forgot-password links, a forced password
    # change after an admin issues a temporary one, soft-deactivation (an account replaced by
    # an approved recovery request is disabled, never deleted, so its audit trail survives),
    # and which role preset (see hr/routes.py ROLE_PRESETS) the account was created from.
    email = db.Column(db.String(120))
    must_change_password = db.Column(db.Boolean, nullable=False, default=False, server_default='0')
    is_active = db.Column(db.Boolean, nullable=False, default=True, server_default='1')
    access_role = db.Column(db.String(30))
    # When the current password was set -- drives the policy's password expiry. NULL on
    # accounts from before this column existed; the clock starts at their next sign-in.
    password_changed_at = db.Column(db.DateTime)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)
        self.password_changed_at = datetime.utcnow()

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class UserPermission(db.Model):
    """Generalized from module_app's UserPermission (src/models/junctions.py) -- same
    (user_id, permission) pair shape, replacing a delimited string column."""
    __tablename__ = 'auth_engine_user_permissions'

    user_id = db.Column(db.Integer, db.ForeignKey('auth_engine_users.id', ondelete='CASCADE'),
                         primary_key=True)
    permission = db.Column(db.String(50), primary_key=True)


def sync_user_permissions(user, permissions):
    """Rebuild a user's permission rows from a comma-separated string. Call after any
    permission change, once user.id exists; caller commits."""
    UserPermission.query.filter_by(user_id=user.id).delete()
    for perm in (permissions or '').split(','):
        perm = perm.strip()
        if perm:
            db.session.add(UserPermission(user_id=user.id, permission=perm))


class Role(db.Model):
    """A named access role: what "assign an employee a role" means. Each role is a coarse auth
    role (is_admin bypasses every permission check) plus the permission strings it grants.
    Users point at a role by key (User.access_role); editing a role's permissions re-syncs
    every user holding it (see roles.apply_role). Roles are managed in HR -> Roles; the
    built-in ones are seeded from roles.DEFAULT_ROLES."""
    __tablename__ = 'auth_engine_roles'

    id = db.Column(db.Integer, primary_key=True)
    key = db.Column(db.String(30), unique=True, nullable=False)
    label = db.Column(db.String(60), nullable=False)
    description = db.Column(db.String(255))
    is_admin = db.Column(db.Boolean, nullable=False, default=False, server_default='0')
    permissions = db.Column(db.Text, nullable=False, default='', server_default='')  # comma-separated
    # Built-in roles can be edited but not deleted; the Administrator role can't lose admin.
    is_system = db.Column(db.Boolean, nullable=False, default=False, server_default='0')
    # Switching this off blocks sign-in for everyone holding the role (checked at login and on
    # every request), e.g. to suspend all contractors at once.
    can_login = db.Column(db.Boolean, nullable=False, default=True, server_default='1')
    color = db.Column(db.String(20), nullable=False, default='violet', server_default='violet')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def permission_list(self):
        return [] if self.is_admin else [p for p in (self.permissions or '').split(',') if p]


class PasswordResetToken(db.Model):
    """A single-use forgot-password link. Only a hash of the token is stored, so a leaked
    database can't be used to reset anyone's password."""
    __tablename__ = 'auth_engine_password_resets'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('auth_engine_users.id', ondelete='CASCADE'),
                         nullable=False)
    token_hash = db.Column(db.String(64), unique=True, nullable=False, index=True)
    expires_at = db.Column(db.DateTime, nullable=False)
    used_at = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class AccountRecoveryRequest(db.Model):
    """Filed from the login screen by someone who can't recover their account (lost access to
    the recovery email too). Nothing happens until an admin approves it, which disables the
    old account and issues a brand-new one -- see hr/routes.py."""
    __tablename__ = 'auth_engine_recovery_requests'

    id = db.Column(db.Integer, primary_key=True)
    full_name = db.Column(db.String(120), nullable=False)
    old_username = db.Column(db.String(80))
    contact = db.Column(db.String(120))  # new email/phone to reach them on
    reason = db.Column(db.Text)
    status = db.Column(db.String(20), nullable=False, default='pending')  # pending | approved | rejected
    user_id = db.Column(db.Integer, db.ForeignKey('auth_engine_users.id'))  # matched old account, if any
    new_user_id = db.Column(db.Integer, db.ForeignKey('auth_engine_users.id'))
    decided_by = db.Column(db.String(80))
    decided_at = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
