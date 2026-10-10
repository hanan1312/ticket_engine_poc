from functools import wraps

from flask import jsonify, session

from .models import User, UserPermission


def get_current_user():
    user_id = session.get('user_id')
    if user_id is None:
        return None
    return User.query.get(user_id)


def login_required(f):
    @wraps(f)
    def wrapped(*args, **kwargs):
        if 'user_id' not in session:
            return jsonify({'error': 'Authentication required. Please log in.'}), 401
        return f(*args, **kwargs)
    return wrapped


def require_permission(permission_name):
    """Generalized from module_app's require_permission (src/main.py) -- admins always
    pass, matching the client-side rule that shows/hides UI by the same permission strings;
    everyone else needs the exact permission string in their UserPermission rows."""
    def decorator(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            if 'user_id' not in session:
                return jsonify({'error': 'Authentication required. Please log in.'}), 401
            role = (session.get('role') or '').lower()
            if role == 'admin':
                return f(*args, **kwargs)
            user_id = session.get('user_id')
            has_permission = UserPermission.query.filter_by(
                user_id=user_id, permission=permission_name).first() is not None
            if not has_permission:
                return jsonify({'error': 'Permission denied'}), 403
            return f(*args, **kwargs)
        return wrapped
    return decorator
