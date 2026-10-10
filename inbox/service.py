from shared_db import db

from .models import Notification

# Pluggable extra delivery channels (e.g. WhatsApp), same idea as ticket_engine's
# POST_TRANSITION_HOOKS: each hook is called as hook(user, title, body) after the in-app
# notification is committed, and any exception is swallowed -- an unreachable side channel
# must never fail the action that raised the notification.
DELIVERY_HOOKS = []


def register_delivery_hook(hook):
    DELIVERY_HOOKS.append(hook)


def notify(users, title, body=None, kind='info', link_type=None, link_id=None, deliver_externally=True):
    """Create one notification per distinct user (User objects; None entries ignored).
    deliver_externally=False skips the DELIVERY_HOOKS -- for callers that already send
    their own WhatsApp message and record its outcome (ticket transitions do)."""
    seen, recipients = set(), []
    for user in users:
        if user is not None and user.id not in seen:
            seen.add(user.id)
            recipients.append(user)
    for user in recipients:
        db.session.add(Notification(user_id=user.id, title=title, body=body, kind=kind,
                                    link_type=link_type, link_id=link_id))
    db.session.commit()
    for user in (recipients if deliver_externally else []):
        for hook in DELIVERY_HOOKS:
            try:
                hook(user, title, body)
            except Exception as e:
                print(f"[inbox] delivery hook {getattr(hook, '__name__', hook)} failed: {e}")
    return len(recipients)


def notify_admins(title, body=None, extra_users=(), **kwargs):
    """Every active admin, plus any extra users (deduplicated)."""
    from auth_engine import User
    admins = [u for u in User.query.filter_by(role='admin').all() if u.is_active is not False]
    return notify(list(admins) + list(extra_users), title, body, **kwargs)
