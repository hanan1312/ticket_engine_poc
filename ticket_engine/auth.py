from functools import wraps

from flask import jsonify

# get_current_actor is the one seam this module needs from whatever auth system the host
# app has -- originally a private session lookup (see this file's git history in the POC
# README), now pointed at the real, pluggable auth_engine module instead. Swapping in a
# different auth system means changing only this import.
from auth_engine import get_current_user as get_current_actor


def require_role(role=None):
    """role=None means 'any authenticated actor'; a role string requires an exact match --
    same two-tier shape as auth_engine's require_permission (logged in vs. specific check).
    """
    def decorator(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            actor = get_current_actor()
            if actor is None:
                return jsonify({'error': 'not authenticated'}), 401
            if role is not None and actor.role != role:
                return jsonify({'error': f"requires role '{role}'"}), 403
            return fn(*args, **kwargs)
        return wrapped
    return decorator
