from datetime import datetime

from flask import Blueprint, jsonify

from auth_engine import get_current_user, login_required
from shared_db import db

from .models import Notification

bp = Blueprint('inbox', __name__, url_prefix='/api/notifications')


@bp.route('', methods=['GET'])
@login_required
def list_notifications():
    user = get_current_user()
    rows = (Notification.query.filter_by(user_id=user.id)
            .order_by(Notification.created_at.desc()).limit(50).all())
    unread = Notification.query.filter_by(user_id=user.id, read_at=None).count()
    return jsonify({'unread': unread, 'items': [_json(n) for n in rows]})


@bp.route('/<int:notification_id>/read', methods=['POST'])
@login_required
def mark_read(notification_id):
    n = Notification.query.filter_by(id=notification_id, user_id=get_current_user().id).first_or_404()
    if n.read_at is None:
        n.read_at = datetime.utcnow()
        db.session.commit()
    return jsonify(_json(n))


@bp.route('/read-all', methods=['POST'])
@login_required
def mark_all_read():
    now = datetime.utcnow()
    Notification.query.filter_by(user_id=get_current_user().id, read_at=None).update({'read_at': now})
    db.session.commit()
    return jsonify({'success': True})


def _json(n):
    return {
        'id': n.id, 'title': n.title, 'body': n.body, 'kind': n.kind,
        'link_type': n.link_type, 'link_id': n.link_id,
        'created_at': n.created_at.isoformat(), 'read': n.read_at is not None,
    }
