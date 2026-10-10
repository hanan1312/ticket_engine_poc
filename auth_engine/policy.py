"""Security policy (password rules, sign-in lockout, password expiry, idle logout, what the
sign-in page shows). auth_engine doesn't store it: the host app sets a provider returning a
dict (demo/app.py wires in the HR tab's Policy settings), and anything missing falls back to
DEFAULT_POLICY -- the rules this module always had."""

DEFAULT_POLICY = {
    'password_min_length': 8,
    'password_require_digit': True,     # letters *and* digits
    'password_require_upper': False,    # at least one upper- and one lower-case letter
    'password_require_symbol': False,
    'password_expiry_days': 0,          # 0 = never expires
    'lockout_threshold': 5,             # failed attempts within the window before lockout
    'lockout_minutes': 5,
    'idle_logout_minutes': 0,           # 0 = off
    'login_banner': '',                 # notice shown on the sign-in page
    'show_demo_accounts': True,         # demo credentials hint on the sign-in page
}

# What the (unauthenticated) sign-in page may read: everything it needs to explain the rules
# before someone types a password. Nothing here identifies an account.
PUBLIC_KEYS = tuple(DEFAULT_POLICY)

_provider = lambda: {}  # noqa: E731


def set_policy_provider(fn):
    global _provider
    _provider = fn


def get_policy():
    policy = dict(DEFAULT_POLICY)
    try:
        policy.update({k: v for k, v in (_provider() or {}).items() if k in DEFAULT_POLICY and v is not None})
    except Exception as e:
        print(f'[auth_engine] policy provider failed, using defaults: {e}')
    return policy


def public_policy():
    policy = get_policy()
    return {k: policy[k] for k in PUBLIC_KEYS}


def password_rules(policy=None):
    """Human-readable rule list, in the order the sign-in page shows them."""
    policy = policy or get_policy()
    rules = [f"At least {policy['password_min_length']} characters"]
    if policy['password_require_digit']:
        rules.append('Letters and numbers')
    if policy['password_require_upper']:
        rules.append('Upper- and lower-case letters')
    if policy['password_require_symbol']:
        rules.append('At least one symbol (e.g. ! ? # @)')
    return rules
