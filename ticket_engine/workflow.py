from .models import ALLOWED_TRANSITIONS


class TransitionError(Exception):
    """Hard stop -- never overridable (mirrors module_app's 'scanning an already-expired
    batch is always a hard 400, never just a warning')."""

    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class TransitionWarning(Exception):
    """Soft stop -- returned as a 409 unless the caller resends the request with
    confirm_override=True. Mirrors the FEFO check on warehouse work-order scans."""

    def __init__(self, message):
        super().__init__(message)
        self.message = message


# Pluggable pre-transition checks. A host app appends its own domain-specific rules here
# instead of editing routes.py -- e.g. a hotel app might add "warn if this asset already has
# another open ticket" the same way module_app's FEFO check warns on out-of-order stock use.
# Each hook is called as hook(ticket, from_status, to_status) and may raise TransitionError
# or TransitionWarning; returning normally means "no objection".
PRE_TRANSITION_HOOKS = []


def register_pre_transition_hook(hook):
    PRE_TRANSITION_HOOKS.append(hook)


def validate_transition(ticket, to_status, actor_role, confirm_override=False):
    """Raises TransitionError/TransitionWarning, or returns silently if the transition is OK."""
    from_status = ticket.status
    allowed = ALLOWED_TRANSITIONS.get(from_status, {})

    if to_status not in allowed:
        raise TransitionError(
            f"cannot move a ticket from '{from_status}' to '{to_status}'", status_code=400
        )

    required_role = allowed[to_status]
    if required_role is not None and actor_role != required_role:
        raise TransitionError(
            f"only a '{required_role}' can move a ticket to '{to_status}'", status_code=403
        )

    for hook in PRE_TRANSITION_HOOKS:
        try:
            hook(ticket, from_status, to_status)
        except TransitionWarning:
            if not confirm_override:
                raise
            # confirmed override -- swallow the warning and let the transition proceed


# Pluggable post-transition side effects -- run only after the transition has already been
# committed, for things like outbound notifications that must never be able to block or
# fail the transition itself (a downed WhatsApp service shouldn't stop a ticket from being
# assigned). Each hook is called as hook(ticket, from_status, to_status); any exception it
# raises is caught and logged by run_post_transition_hooks, never re-raised to the route.
POST_TRANSITION_HOOKS = []


def register_post_transition_hook(hook):
    POST_TRANSITION_HOOKS.append(hook)


def run_post_transition_hooks(ticket, from_status, to_status):
    for hook in POST_TRANSITION_HOOKS:
        try:
            hook(ticket, from_status, to_status)
        except Exception as e:
            print(f"[ticket_engine] post-transition hook {getattr(hook, '__name__', hook)} failed: {e}")
