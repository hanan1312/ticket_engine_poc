from .decorators import get_current_user, login_required, require_permission
from .mailer import send_email, send_email_detailed, set_config_provider as set_mail_config_provider, smtp_configured
from .models import (
    AccountRecoveryRequest, PasswordResetToken, Role, User, UserPermission, sync_user_permissions,
)
from .permissions import (
    is_registered_permission, register_permission, registered_permissions, replace_permissions,
)
from .presence import last_seen, presence_status
from .passwords import generate_temp_password, validate_new_password
from .policy import DEFAULT_POLICY, get_policy, password_rules, set_policy_provider
from .roles import (
    DEFAULT_ROLES, ROLE_COLORS, ROLE_KEY_RE, all_roles, apply_role, get_role, infer_role_key, role_members,
    seed_default_roles,
)
from .routes import (
    bp as auth_engine_bp, display_name, register_presence_enforcement, register_recovery_request_hook,
    register_reset_undelivered_hook, set_profile_provider,
)

__all__ = [
    'User', 'UserPermission', 'sync_user_permissions', 'AccountRecoveryRequest',
    'PasswordResetToken', 'send_email', 'generate_temp_password', 'validate_new_password',
    'presence_status', 'last_seen', 'get_current_user', 'login_required', 'require_permission',
    'auth_engine_bp', 'register_presence_enforcement', 'register_recovery_request_hook',
    'register_reset_undelivered_hook', 'set_profile_provider', 'send_email_detailed', 'set_mail_config_provider', 'smtp_configured',
    'register_permission', 'registered_permissions', 'replace_permissions', 'is_registered_permission',
    'Role', 'DEFAULT_ROLES', 'ROLE_COLORS', 'ROLE_KEY_RE', 'all_roles', 'apply_role', 'get_role',
    'infer_role_key', 'role_members', 'seed_default_roles',
    'display_name', 'DEFAULT_POLICY', 'get_policy', 'password_rules', 'set_policy_provider',
]
