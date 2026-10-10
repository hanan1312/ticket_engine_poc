from datetime import datetime

from flask import Blueprint, Response, jsonify, request

from auth_engine import UserPermission, get_current_user
from ticket_engine.db import db

# Demo-app-specific presentation config (company name + uploaded logo) -- deliberately not
# part of either reusable module (auth_engine/ticket_engine), since branding preferences
# aren't domain logic, just how this particular deployment presents itself.

bp = Blueprint('branding', __name__, url_prefix='/api/settings')

ALLOWED_LOGO_TYPES = {'image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'}
MAX_LOGO_BYTES = 2 * 1024 * 1024  # 2MB is plenty for a header logo


class AppSettings(db.Model):
    """Single-row table -- there's only ever one active branding config per deployment."""
    __tablename__ = 'app_settings'

    id = db.Column(db.Integer, primary_key=True)
    company_name = db.Column(db.String(120), nullable=False, default='AssetFlow')
    logo_data = db.Column(db.LargeBinary)
    logo_mimetype = db.Column(db.String(50))
    # WhatsApp notifications master switch + the business number that's paired with the
    # notifications/ service. Off means no WhatsApp send is even attempted anywhere.
    whatsapp_enabled = db.Column(db.Boolean, nullable=False, default=False, server_default='0')
    whatsapp_number = db.Column(db.String(30))
    # Outgoing email (password-reset links, temporary passwords). Stored here so an admin can
    # set it up from Preferences; environment variables still work as a fallback (see
    # auth_engine/mailer.py). The password is write-only over the API -- never returned.
    smtp_host = db.Column(db.String(120))
    smtp_port = db.Column(db.Integer)
    smtp_security = db.Column(db.String(10))  # starttls | ssl | none
    smtp_user = db.Column(db.String(120))
    smtp_password = db.Column(db.String(255))
    smtp_from = db.Column(db.String(120))
    smtp_from_name = db.Column(db.String(120))
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


def get_settings():
    settings = AppSettings.query.first()
    if settings is None:
        settings = AppSettings()
        db.session.add(settings)
        db.session.commit()
    return settings


def _settings_json(settings):
    out = {'company_name': settings.company_name, 'has_logo': settings.logo_data is not None,
           'whatsapp_enabled': bool(settings.whatsapp_enabled)}
    if _can_manage(get_current_user()):
        out['whatsapp_number'] = settings.whatsapp_number
    return out


def whatsapp_enabled():
    return bool(get_settings().whatsapp_enabled)


def _can_manage(user):
    """Admins, or anyone granted the Preferences tab (its sidebar permission)."""
    return user is not None and (user.role == 'admin' or UserPermission.query.filter_by(
        user_id=user.id, permission='preferences').first() is not None)


def _require_admin():
    """Returns (user, None) on success or (None, (response, status)) to return directly.
    "Admin" here means whoever may manage Preferences -- see _can_manage."""
    user = get_current_user()
    if user is None:
        return None, (jsonify({'error': 'Authentication required. Please log in.'}), 401)
    if not _can_manage(user):
        return None, (jsonify({'error': "requires the 'preferences' permission"}), 403)
    return user, None


@bp.route('', methods=['GET'])
def read_settings():
    """Public -- the topbar needs to render brand name/logo even for a logged-out visitor."""
    return jsonify(_settings_json(get_settings()))


@bp.route('', methods=['PUT'])
def update_settings():
    _, error = _require_admin()
    if error:
        return error
    data = request.get_json(force=True) or {}
    name = (data.get('company_name') or '').strip()
    if not name:
        return jsonify({'error': 'company_name is required'}), 400
    settings = get_settings()
    settings.company_name = name
    db.session.commit()
    return jsonify(_settings_json(settings))


@bp.route('/logo', methods=['POST'])
def upload_logo():
    _, error = _require_admin()
    if error:
        return error
    file = request.files.get('logo')
    if file is None or not file.filename:
        return jsonify({'error': 'no file uploaded'}), 400
    if file.mimetype not in ALLOWED_LOGO_TYPES:
        return jsonify({'error': f'unsupported image type {file.mimetype}'}), 400
    data = file.read()
    if len(data) > MAX_LOGO_BYTES:
        return jsonify({'error': 'logo must be under 2MB'}), 400

    settings = get_settings()
    settings.logo_data = data
    settings.logo_mimetype = file.mimetype
    db.session.commit()
    return jsonify(_settings_json(settings))


@bp.route('/logo', methods=['GET'])
def get_logo():
    """Public, same reasoning as read_settings -- serves raw image bytes for an <img> tag."""
    settings = get_settings()
    if not settings.logo_data:
        return jsonify({'error': 'no logo set'}), 404
    return Response(settings.logo_data, mimetype=settings.logo_mimetype)


@bp.route('/logo', methods=['DELETE'])
def remove_logo():
    _, error = _require_admin()
    if error:
        return error
    settings = get_settings()
    settings.logo_data = None
    settings.logo_mimetype = None
    db.session.commit()
    return jsonify(_settings_json(settings))


@bp.route('/whatsapp', methods=['PUT'])
def update_whatsapp():
    _, error = _require_admin()
    if error:
        return error
    data = request.get_json(force=True) or {}
    settings = get_settings()
    if 'whatsapp_number' in data:
        number = ''.join(ch for ch in str(data['whatsapp_number'] or '') if ch.isdigit())
        if number and not 8 <= len(number) <= 15:
            return jsonify({'error': 'enter the number in international format, digits only (e.g. 201012345678)'}), 400
        settings.whatsapp_number = number or None
    if 'whatsapp_enabled' in data:
        enabled = bool(data['whatsapp_enabled'])
        if enabled and not settings.whatsapp_number:
            return jsonify({'error': 'set the WhatsApp number before turning the service on'}), 400
        settings.whatsapp_enabled = enabled
    db.session.commit()
    return jsonify(_settings_json(settings))


@bp.route('/whatsapp/status', methods=['GET'])
def whatsapp_status():
    """Pairing state of the notifications/ service, with the pairing QR code rendered as SVG
    when it's waiting for a scan. Asking for the status is also what makes the service start
    a session (and so generate a QR) if it hasn't yet."""
    _, error = _require_admin()
    if error:
        return error
    from notifications_client import get_whatsapp_status
    status = get_whatsapp_status()
    if status.get('qr'):
        status['qr_svg'] = _qr_svg(status.pop('qr'))
    status['configured_number'] = get_settings().whatsapp_number
    return jsonify(status)


@bp.route('/whatsapp/test', methods=['POST'])
def whatsapp_test():
    user, error = _require_admin()
    if error:
        return error
    data = request.get_json(force=True) or {}
    phone = ''.join(ch for ch in str(data.get('phone') or user.phone or '') if ch.isdigit())
    if not phone:
        return jsonify({'error': 'enter a phone number to send the test to'}), 400
    from notifications_client import send_whatsapp
    sent, reason = send_whatsapp(phone, f'Test message from {get_settings().company_name} -- WhatsApp notifications are working.')
    if sent:
        return jsonify({'message': f'Test message sent to {phone}.'})
    return jsonify({'error': f'Not sent: {reason}'}), 502


def _qr_svg(payload):
    from reportlab.graphics import renderSVG
    from reportlab.graphics.barcode.qr import QrCodeWidget
    from reportlab.graphics.shapes import Drawing
    widget = QrCodeWidget(payload)
    x1, y1, x2, y2 = widget.getBounds()
    size = 260
    drawing = Drawing(size, size, transform=[size / (x2 - x1), 0, 0, size / (y2 - y1), 0, 0])
    drawing.add(widget)
    svg = renderSVG.drawToString(drawing)
    return svg[svg.index('<svg'):]  # drop the XML declaration/doctype -- this is inlined into HTML


EMAIL_RE = __import__('re').compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')


def mail_config():
    """For auth_engine's mailer (set_mail_config_provider): the stored SMTP settings, or None."""
    st = get_settings()
    if not st.smtp_host:
        return None
    return {'host': st.smtp_host, 'port': st.smtp_port or 587, 'security': st.smtp_security or 'starttls',
            'user': st.smtp_user, 'password': st.smtp_password, 'from_addr': st.smtp_from or st.smtp_user,
            'from_name': st.smtp_from_name or st.company_name}


def _email_json(st):
    import os
    source = 'settings' if st.smtp_host else ('environment' if os.environ.get('SMTP_HOST') else 'none')
    return {'host': st.smtp_host or '', 'port': st.smtp_port or 587, 'security': st.smtp_security or 'starttls',
            'user': st.smtp_user or '', 'has_password': bool(st.smtp_password), 'from_addr': st.smtp_from or '',
            'from_name': st.smtp_from_name or '', 'source': source}


@bp.route('/email', methods=['GET'])
def get_email_settings():
    _, error = _require_admin()
    if error:
        return error
    return jsonify(_email_json(get_settings()))


@bp.route('/email', methods=['PUT'])
def update_email_settings():
    _, error = _require_admin()
    if error:
        return error
    data = request.get_json(force=True) or {}
    st = get_settings()
    host = (data.get('host') or '').strip()
    if not host:  # clearing the host turns stored email settings off
        st.smtp_host = None
        db.session.commit()
        return jsonify(_email_json(st))
    try:
        port = int(data.get('port') or 587)
    except (TypeError, ValueError):
        return jsonify({'error': 'port must be a number'}), 400
    if not 1 <= port <= 65535:
        return jsonify({'error': 'port must be between 1 and 65535'}), 400
    security = data.get('security') or 'starttls'
    if security not in ('starttls', 'ssl', 'none'):
        return jsonify({'error': 'security must be starttls, ssl or none'}), 400
    from_addr = (data.get('from_addr') or '').strip()
    user = (data.get('user') or '').strip()
    if from_addr and not EMAIL_RE.match(from_addr):
        return jsonify({'error': '"from" address looks invalid'}), 400
    if not from_addr and not EMAIL_RE.match(user):
        return jsonify({'error': 'enter a "from" address (or use an email address as the username)'}), 400
    st.smtp_host, st.smtp_port, st.smtp_security = host, port, security
    st.smtp_user = user or None
    st.smtp_from = from_addr or None
    st.smtp_from_name = (data.get('from_name') or '').strip() or None
    if data.get('password'):  # blank = keep the stored password
        st.smtp_password = data['password']
    if data.get('clear_password'):
        st.smtp_password = None
    db.session.commit()
    return jsonify(_email_json(st))


@bp.route('/email/test', methods=['POST'])
def test_email_settings():
    user, error = _require_admin()
    if error:
        return error
    from auth_engine import send_email_detailed
    to = ((request.get_json(force=True) or {}).get('to') or user.email or '').strip()
    if not EMAIL_RE.match(to):
        return jsonify({'error': 'enter an email address to send the test to'}), 400
    sent, reason = send_email_detailed(
        to, f'Test email from {get_settings().company_name}',
        'This is a test from the Preferences -> Email page. If you can read this, password-reset '
        'emails will be delivered.')
    if sent:
        return jsonify({'message': f'Test email sent to {to}. Check the inbox (and spam folder).'})
    return jsonify({'error': f'Not sent: {reason}'}), 502
