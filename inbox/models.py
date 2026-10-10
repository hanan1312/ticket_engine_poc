from datetime import datetime

from shared_db import db


class Notification(db.Model):
    """One in-app notification for one user -- what the bell icon in the app header lists.
    `link_type`/`link_id` let the frontend open the thing the notification is about (a work
    order, a bill, a ticket, an account-recovery request) instead of just showing text."""
    __tablename__ = 'inbox_notifications'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('auth_engine_users.id', ondelete='CASCADE'),
                         nullable=False, index=True)
    title = db.Column(db.String(200), nullable=False)
    body = db.Column(db.Text)
    kind = db.Column(db.String(20), nullable=False, default='info')  # info | success | warning
    link_type = db.Column(db.String(30))
    link_id = db.Column(db.Integer)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    read_at = db.Column(db.DateTime)
