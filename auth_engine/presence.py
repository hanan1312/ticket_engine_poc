import time

# Generalized from module_app's PRESENCE_STORE (src/main.py) -- in-memory, resets on every
# restart. A session is force-expired only on a stale heartbeat, never on an explicit
# 'offline' report: module_app's frontend reports 'offline' via navigator.sendBeacon on
# beforeunload, and a beacon queued while offline can be delivered late by the browser --
# tagged with whatever session is current *at delivery time*. If the user reconnects and logs
# back in before that queued beacon lands, an offline-report-kills-instantly rule would
# retroactively kill the new session. Time-based-only enforcement closes that race, since an
# actively-used session keeps its own last_seen fresh regardless of a stale queued signal.

PRESENCE_STORE = {}
PRESENCE_TIMEOUT_SECONDS = 16 * 60


def mark_online(username):
    """Call on every successful login -- resets any stale flag left by a prior session
    (idle timeout, manual logout, or the beacon race above) so a fresh login can never be
    poisoned by leftover presence state."""
    PRESENCE_STORE[username] = {'status': 'online', 'last_seen': time.time()}


def heartbeat(username, status='online', idle_for=None):
    """idle_for: seconds since the browser last saw mouse/keyboard input, if it says -- the
    browser only reports 'idle' after a few minutes, so without it idle time would be undercounted."""
    now = time.time()
    previous = PRESENCE_STORE.get(username) or {}
    # idle_since: when this run of inactivity began -- the idle-logout policy measures from it.
    idle_since = None
    if status == 'idle':
        candidates = [previous.get('idle_since') or now]
        if isinstance(idle_for, (int, float)) and 0 <= idle_for <= 86400:
            candidates.append(now - idle_for)
        idle_since = min(candidates)
    PRESENCE_STORE[username] = {'status': status, 'last_seen': now, 'idle_since': idle_since}


def idle_seconds(username):
    """How long the user has been continuously idle (no mouse/keyboard, or tab hidden), per
    their heartbeats; 0 while active."""
    entry = PRESENCE_STORE.get(username)
    if not entry or not entry.get('idle_since'):
        return 0
    return time.time() - entry['idle_since']


def is_stale(username):
    entry = PRESENCE_STORE.get(username)
    if entry is None:
        return False
    return (time.time() - entry['last_seen']) > PRESENCE_TIMEOUT_SECONDS


# How long after the last heartbeat someone still counts as present. The frontend sends one
# every 45s (see core.js), so missing ~3 in a row means the tab is gone.
ONLINE_WINDOW_SECONDS = 150
PRESENCE_STATES = ('online', 'idle', 'offline')


def presence_status(username):
    """'online' | 'idle' | 'offline' for display (HR employee list). Separate from
    is_stale(), which is only about force-expiring sessions."""
    entry = PRESENCE_STORE.get(username) if username else None
    if entry is None or (time.time() - entry['last_seen']) > ONLINE_WINDOW_SECONDS:
        return 'offline'
    return entry['status'] if entry['status'] in PRESENCE_STATES else 'online'


def last_seen(username):
    entry = PRESENCE_STORE.get(username) if username else None
    return entry['last_seen'] if entry else None
