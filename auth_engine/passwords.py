import secrets
import string

from .policy import get_policy

MIN_PASSWORD_LENGTH = 8  # floor -- the policy can raise it but never go below this


def generate_temp_password(length=None):
    """Readable one-time password handed to a new/recovered account's owner -- no 0/O/1/l/I
    look-alikes, since it's often read aloud or copied off a screen. Always satisfies the
    current policy (length, letters+digits, upper+lower, symbol)."""
    policy = get_policy()
    length = max(length or 10, policy['password_min_length'])
    alphabet = ''.join(c for c in string.ascii_letters + string.digits if c not in '0O1lI')
    while True:
        candidate = ''.join(secrets.choice(alphabet) for _ in range(length))
        if policy['password_require_symbol']:
            candidate = candidate[:-1] + secrets.choice('!#?@%+')
        if validate_new_password(candidate, policy) is None:
            return candidate


def validate_new_password(password, policy=None):
    """Returns an error message, or None if acceptable under the current security policy."""
    policy = policy or get_policy()
    min_length = max(MIN_PASSWORD_LENGTH, int(policy['password_min_length']))
    if not password or len(password) < min_length:
        return f'password must be at least {min_length} characters'
    if policy['password_require_digit'] and not (any(c.isdigit() for c in password)
                                                 and any(c.isalpha() for c in password)):
        return 'password must mix letters and numbers'
    if policy['password_require_upper'] and not (any(c.isupper() for c in password)
                                                 and any(c.islower() for c in password)):
        return 'password must include both upper- and lower-case letters'
    if policy['password_require_symbol'] and all(c.isalnum() for c in password):
        return 'password must include at least one symbol'
    return None
