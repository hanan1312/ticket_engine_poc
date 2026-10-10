import os
import smtplib
import socket
from email.message import EmailMessage
from email.utils import formataddr

# Outbound email for password-reset links and temporary-password handover.
#
# Where the SMTP settings come from, in order:
#   1. the host app's config provider (see set_config_provider) -- the demo app stores them
#      in Preferences -> Email, so an admin can set them up without touching the server;
#   2. environment variables: SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASSWORD,
#      SMTP_FROM (defaults to SMTP_USER), SMTP_SSL=1 for implicit TLS on port 465.
# With neither configured, messages are printed to the server console instead -- and
# callers are told so (send_email_detailed returns the reason), never told it was sent.

_config_provider = lambda: None  # noqa: E731


def set_config_provider(fn):
    """fn() -> dict(host, port, security='starttls'|'ssl'|'none', user, password, from_addr,
    from_name) or None when not configured."""
    global _config_provider
    _config_provider = fn


def _config():
    try:
        cfg = _config_provider()
    except Exception as e:
        print(f'[mailer] reading email settings failed: {e}')
        cfg = None
    if cfg and cfg.get('host'):
        return cfg
    if os.environ.get('SMTP_HOST'):
        return {
            'host': os.environ['SMTP_HOST'], 'port': int(os.environ.get('SMTP_PORT', 587)),
            'security': 'ssl' if os.environ.get('SMTP_SSL') == '1' else 'starttls',
            'user': os.environ.get('SMTP_USER'), 'password': os.environ.get('SMTP_PASSWORD', ''),
            'from_addr': os.environ.get('SMTP_FROM') or os.environ.get('SMTP_USER'), 'from_name': None,
        }
    return None


def smtp_configured():
    return _config() is not None


def send_email_detailed(to, subject, body):
    """Returns (True, None) once an SMTP server accepted the message, or (False, reason).
    Never raises."""
    if not to:
        return False, 'no recipient address'
    cfg = _config()
    if cfg is None:
        print(f'\n[mailer] email is not configured -- NOT sent, printed here instead\n'
              f'  To: {to}\n  Subject: {subject}\n  ---\n{body}\n  ---\n')
        return False, 'email sending is not set up on this server (Preferences -> Email)'

    from_addr = cfg.get('from_addr') or cfg.get('user')
    if not from_addr:
        return False, 'no "from" address configured'
    msg = EmailMessage()
    msg['From'] = formataddr((cfg.get('from_name') or '', from_addr)) if cfg.get('from_name') else from_addr
    msg['To'] = to
    msg['Subject'] = subject
    msg.set_content(body)
    host, port, security = cfg['host'], int(cfg.get('port') or 587), cfg.get('security') or 'starttls'
    try:
        if security == 'ssl':
            server = smtplib.SMTP_SSL(host, port, timeout=15)
        else:
            server = smtplib.SMTP(host, port, timeout=15)
            if security == 'starttls':
                server.starttls()
        with server:
            if cfg.get('user'):
                server.login(cfg['user'], cfg.get('password') or '')
            server.send_message(msg)
        return True, None
    except smtplib.SMTPAuthenticationError as e:
        reason = ('the mail server rejected the username/password'
                  + (' -- Gmail and Outlook need an "app password", not your normal password'
                     if any(d in host for d in ('gmail', 'google', 'office365', 'outlook')) else '')
                  + f' ({e.smtp_code})')
    except smtplib.SMTPRecipientsRefused:
        reason = f'the mail server refused the recipient address {to}'
    except smtplib.SMTPSenderRefused as e:
        reason = f'the mail server refused the "from" address {from_addr} ({e.smtp_code})'
    except (socket.timeout, TimeoutError):
        reason = f'timed out connecting to {host}:{port} -- check the host, port and security setting'
    except (socket.gaierror, ConnectionRefusedError, OSError) as e:
        reason = f'could not connect to {host}:{port} ({e})'
    except smtplib.SMTPException as e:
        reason = f'mail server error: {e}'
    print(f'[mailer] sending to {to} failed: {reason}')
    return False, reason


def send_email(to, subject, body):
    """Best-effort wrapper: True if an SMTP server accepted it, False otherwise."""
    return send_email_detailed(to, subject, body)[0]
