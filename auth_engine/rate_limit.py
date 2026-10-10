import time

from .policy import get_policy

# Generalized from module_app's login-attempt throttling (src/routes/user.py) -- in-memory,
# keyed by username rather than IP (fine for a small internal app with a handful of accounts;
# an internet-facing app would need IP-keying too). Threshold and lockout length come from the
# security policy (HR -> Policy).

LOGIN_ATTEMPTS = {}
LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60


def _limits():
    policy = get_policy()
    return max(1, int(policy['lockout_threshold'])), max(1, int(policy['lockout_minutes'])) * 60


def lockout_seconds_remaining(username):
    entry = LOGIN_ATTEMPTS.get(username)
    if not entry or not entry.get('locked_until'):
        return 0
    return max(0, int(entry['locked_until'] - time.time()))


def record_failed_login(username):
    """Returns how many attempts are left before lockout (0 = now locked)."""
    threshold, lockout_seconds = _limits()
    now = time.time()
    entry = LOGIN_ATTEMPTS.get(username)
    if not entry or now - entry['first_fail_at'] > LOGIN_ATTEMPT_WINDOW_SECONDS or (
            entry.get('locked_until') and entry['locked_until'] <= now):
        entry = {'fails': 0, 'first_fail_at': now, 'locked_until': None}
    entry['fails'] += 1
    if entry['fails'] >= threshold:
        entry['locked_until'] = now + lockout_seconds
    LOGIN_ATTEMPTS[username] = entry
    return max(0, threshold - entry['fails'])


def clear_failed_login(username):
    LOGIN_ATTEMPTS.pop(username, None)
