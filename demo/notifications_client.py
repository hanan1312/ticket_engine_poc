import os

import requests

# Base URL of the copied notifications/ microservice (server.js) -- see that folder's own
# README note. Configurable because in a real deployment this Flask process and the Node
# notifications service almost always run on different hosts/ports.
NOTIFICATIONS_URL = os.environ.get('NOTIFICATIONS_URL', 'http://localhost:5050')

# Which WhatsApp session inside the service to send through. server.js only ever starts (and
# prints a QR code for) the 'lab' session on boot, and sendMessage refuses any centerId whose
# session was never started -- so this must name a session the service actually runs.
NOTIFICATIONS_CENTER_ID = os.environ.get('NOTIFICATIONS_CENTER_ID', 'lab')

REQUEST_TIMEOUT_SECONDS = 5


def send_whatsapp(phone, message):
    """Best-effort -- a downed or not-yet-paired WhatsApp service must never break the
    ticket workflow that triggered this (see ticket_engine.workflow.run_post_transition_hooks,
    which already swallows any exception this raises).

    Returns (result, error): result is True (service accepted and sent it), False (service
    reachable but rejected the send -- e.g. number not registered, or WhatsApp not paired
    yet), or None (service unreachable); error is the reason text when there is one. The
    caller only uses these to build a human-readable audit note.
    """
    if not phone:
        return None, 'no phone number'
    try:
        resp = requests.post(
            f'{NOTIFICATIONS_URL}/api/whatsapp/send',
            json={'centerId': NOTIFICATIONS_CENTER_ID, 'phone': phone, 'message': message},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as e:
        print(f'[notifications] WhatsApp service unreachable at {NOTIFICATIONS_URL}: {e}')
        return None, f'nothing answering at {NOTIFICATIONS_URL}'

    if resp.ok:
        return True, None
    error = (resp.json().get('error') if resp.headers.get('content-type', '').startswith('application/json') else None)
    print(f'[notifications] WhatsApp send rejected ({resp.status_code}): {error or resp.text}')
    return False, error or f'HTTP {resp.status_code}'


def get_whatsapp_status():
    """{'reachable': bool, 'status': 'connected'|'qr'|'initializing'|'offline'|'error'|..., 
    'message': str, 'qr': raw pairing payload when status == 'qr'}."""
    try:
        resp = requests.get(f'{NOTIFICATIONS_URL}/api/whatsapp/status',
                            params={'centerId': NOTIFICATIONS_CENTER_ID}, timeout=REQUEST_TIMEOUT_SECONDS)
        body = resp.json()
    except (requests.RequestException, ValueError):
        return {'reachable': False, 'status': 'unreachable',
                'message': f'The notifications service is not running at {NOTIFICATIONS_URL}. '
                           'Start it with: cd notifications && npm install && npm start'}
    return {'reachable': True, 'status': body.get('status', 'offline'),
            'message': body.get('message') or '', 'qr': body.get('qrCode')}
