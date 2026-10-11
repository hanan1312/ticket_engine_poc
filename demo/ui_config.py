"""The app's navigation and wording, driven by one JSON file (config/ui.json by default, or the
path in the UI_CONFIG environment variable): which left-panel tabs exist and in what order,
their names, icons, page titles, sub-tabs, extra tabs of your own, and the sign-in page texts.

The file is re-read whenever it changes (checked on each request), so an edit shows up on the
next page reload -- no restart. A broken file never takes the app down: the last good version
(or, on first start, the built-in defaults below) stays in use and the problem is reported in
the server log and to admins in the browser.

Built-in tabs are wired to code (their routes check a fixed permission string, their sub-tabs
are real panes), so for those the file can rename, re-icon, reorder, hide or drop them and
their sub-tabs, and add custom sub-tabs -- but not change their id or permission. Custom tabs
and sub-tabs show a page of HTML, embed a URL, or open a link."""

import json
import logging
import os
import re
import threading

from auth_engine import replace_permissions

log = logging.getLogger(__name__)

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PATH = os.path.join(PROJECT_DIR, 'config', 'ui.json')

ID_RE = re.compile(r'^[a-z][a-z0-9_-]{0,39}$')
CUSTOM_TYPES = ('page', 'iframe', 'link')
# A custom tab with sub-tabs uses its id as the sub-tab group, so it can't take a built-in one's.
RESERVED_GROUPS = {'wh', 'ha'}

# How each built-in tab's sub-tabs work, which permission guards it, and its defaults.
#   kind 'pane'   -> real sub-tabs (top bar + sidebar links), group = the bar's data-group
#   kind 'filter' -> sidebar links that filter the tab's table (Assets condition)
#   kind 'scroll' -> sidebar links that scroll to a card (Preferences sections)
BUILTIN_TABS = {
    'dashboard': {'permission': None, 'kind': None, 'label': 'Dashboard', 'icon': 'dashboard',
                  'subtitle': 'Assets, tickets and their lifecycle', 'children': []},
    'assets': {'permission': 'assets', 'kind': 'filter', 'label': 'Assets', 'icon': 'wrench',
               'subtitle': 'Condition, location and maintenance of every asset',
               'description': 'Add, edit, delete assets and register new ones',
               'children': [('all', 'All assets'), ('good', 'Good'), ('fair', 'Fair'), ('broken', 'Broken')]},
    'warehouse': {'permission': 'warehouse', 'kind': 'pane', 'group': 'wh', 'label': 'Warehouse', 'icon': 'package',
                  'subtitle': 'Stock, purchase bills, batches and work orders',
                  'description': 'Stock, purchase bills, batches and work orders',
                  'children': [('wh-items', 'Items'), ('wh-bills', 'Purchase bills'),
                               ('wh-batches', 'Batches & barcodes'), ('wh-orders', 'Work orders')]},
    'hr': {'permission': 'hr-management', 'kind': 'pane', 'group': 'hr', 'label': 'HR', 'icon': 'users',
           'subtitle': 'Employees, attendance, users, roles and policy',
           'description': 'Employees, attendance, users, roles and policy',
           'children': [('hr-employees', 'Employees'), ('hr-attendance', 'Attendance'), ('hr-accounts', 'Users'),
                        ('hr-roles', 'Roles'), ('hr-policy', 'Policy')]},
    'hotel': {'permission': 'hotel', 'kind': 'pane', 'group': 'ha', 'label': 'Hotel architecture', 'icon': 'building',
              'subtitle': 'Buildings, floors, rooms and the site plan',
              'description': 'Edit buildings, floors, rooms and the site plan',
              'children': [('ha-buildings', 'Buildings'), ('ha-floors', 'Floors'), ('ha-rooms', 'Rooms')]},
    'preferences': {'permission': 'preferences', 'kind': 'scroll', 'label': 'Preferences', 'icon': 'sliders',
                    'subtitle': 'Branding, WhatsApp notifications and email',
                    'description': 'Branding, WhatsApp and email settings',
                    'children': [('branding', 'Branding'), ('whatsapp', 'WhatsApp'), ('email', 'Email')]},
}

DEFAULT_APP = {
    'sidebar_subtitle': 'Operations suite',
    'sidebar_section': 'Workspace',
    'footer': 'Ticket Engine POC',
    'default_tab': 'dashboard',
}
DEFAULT_LOGIN = {
    'tagline': 'Hotel operations suite',
    'heading': 'Sign in to your workspace',
    'lead': 'Assets, tickets, stock and your team — all in one place.',
    'art_kicker': 'Built for hotel operations',
    'art_heading': 'Every asset, ticket and delivery — tracked end to end.',
    'art_points': [
        'Scan a barcode, raise a ticket, follow it from open to resolved.',
        'Expiry-aware stock, purchase orders and printable labels.',
        'Role-based access — everyone sees exactly what their role allows.',
    ],
}


def config_path():
    return os.environ.get('UI_CONFIG', '').strip() or DEFAULT_PATH


def _text(value, fallback, max_len=200):
    if isinstance(value, str) and value.strip():
        return value.strip()[:max_len]
    return fallback


def _custom_content(entry, where, warnings):
    """type/html/url of a custom tab or sub-tab, or None (with a warning) if unusable."""
    kind = entry.get('type')
    if kind not in CUSTOM_TYPES:
        warnings.append(f'{where}: "type" must be one of {", ".join(CUSTOM_TYPES)} -- skipped')
        return None
    if kind == 'page':
        html = entry.get('html')
        if isinstance(html, list):  # long pages read better as a list of lines
            html = '\n'.join(str(line) for line in html)
        return {'type': 'page', 'html': html if isinstance(html, str) else ''}
    url = entry.get('url')
    if not isinstance(url, str) or not re.match(r'^(https?://|/)', url.strip()):
        warnings.append(f'{where}: "url" must start with http://, https:// or / -- skipped')
        return None
    return {'type': kind, 'url': url.strip()}


def _children(tab_id, spec, raw_children, tab_label, warnings, seen_ids):
    builtin = dict(spec['children']) if spec else {}
    kind = spec['kind'] if spec else 'pane'
    if raw_children is None:  # not listed: keep every built-in sub-tab as it is
        raw_children = [{'id': cid} for cid in builtin]
    if not isinstance(raw_children, list):
        warnings.append(f'tab "{tab_id}": "children" must be a list -- using the defaults')
        raw_children = [{'id': cid} for cid in builtin]

    out = []
    for i, raw in enumerate(raw_children):
        where = f'tab "{tab_id}" sub-tab #{i + 1}'
        if not isinstance(raw, dict) or not isinstance(raw.get('id'), str):
            warnings.append(f'{where}: needs an "id" -- skipped')
            continue
        cid = raw['id'].strip()
        if raw.get('enabled', True) is False:
            continue
        if cid in seen_ids:
            warnings.append(f'{where}: id "{cid}" is used twice -- skipped')
            continue
        child = {'id': cid}
        if cid in builtin:
            child['builtin'] = True
            child['label'] = _text(raw.get('label'), builtin[cid], 60)
        else:
            if kind != 'pane':
                warnings.append(f'{where}: "{tab_id}" has no sub-tab pages, so a custom sub-tab "{cid}" '
                                'cannot be added there -- skipped')
                continue
            if not ID_RE.match(cid):
                warnings.append(f'{where}: id "{cid}" must be lowercase letters, digits, - or _ -- skipped')
                continue
            content = _custom_content(raw, where, warnings)
            if content is None:
                continue
            child.update(content, builtin=False, label=_text(raw.get('label'), cid, 60))
        child['title'] = _text(raw.get('title'), f"{tab_label} · {child['label']}")
        child['subtitle'] = _text(raw.get('subtitle'), '', 300)
        seen_ids.add(cid)
        out.append(child)
    return out


def normalize(raw):
    """Turn the file's contents into the complete config the browser uses. Returns
    (config, warnings); anything unusable is dropped with a warning rather than failing."""
    warnings = []
    if not isinstance(raw, dict):
        raise ValueError('the file must contain a JSON object ({ ... })')

    app = {k: _text((raw.get('app') or {}).get(k), v) for k, v in DEFAULT_APP.items()}
    raw_login = raw.get('login') or {}
    login = {k: _text(raw_login.get(k), v, 300) for k, v in DEFAULT_LOGIN.items() if k != 'art_points'}
    points = raw_login.get('art_points')
    login['art_points'] = ([str(p)[:300] for p in points if str(p).strip()]
                           if isinstance(points, list) else DEFAULT_LOGIN['art_points'])

    raw_tabs = raw.get('tabs')
    if raw_tabs is None:
        raw_tabs = [{'id': tid} for tid in BUILTIN_TABS]
    if not isinstance(raw_tabs, list):
        raise ValueError('"tabs" must be a list')

    tabs, seen_ids, seen_perms = [], set(), set()
    for i, raw_tab in enumerate(raw_tabs):
        where = f'tab #{i + 1}'
        if not isinstance(raw_tab, dict) or not isinstance(raw_tab.get('id'), str):
            warnings.append(f'{where}: needs an "id" -- skipped')
            continue
        tid = raw_tab['id'].strip()
        where = f'tab "{tid}"'
        if raw_tab.get('enabled', True) is False:
            continue
        if tid in seen_ids:
            warnings.append(f'{where}: listed twice -- skipped')
            continue
        spec = BUILTIN_TABS.get(tid)
        tab = {'id': tid, 'builtin': spec is not None}
        if spec:
            if 'permission' in raw_tab and raw_tab['permission'] != spec['permission']:
                warnings.append(f'{where}: the permission of a built-in tab is fixed '
                                f'("{spec["permission"]}") -- ignoring "permission"')
            tab.update(permission=spec['permission'], kind=spec['kind'], group=spec.get('group'))
            tab['label'] = _text(raw_tab.get('label'), spec['label'], 60)
            tab['icon'] = _text(raw_tab.get('icon'), spec['icon'], 4000)
            tab['subtitle'] = _text(raw_tab.get('subtitle'), spec['subtitle'], 300)
            tab['description'] = _text(raw_tab.get('description'), spec.get('description', ''), 300)
        else:
            if not ID_RE.match(tid):
                warnings.append(f'{where}: id must be lowercase letters, digits, - or _ -- skipped')
                continue
            if tid in RESERVED_GROUPS:
                warnings.append(f'{where}: "{tid}" is reserved for a built-in tab\'s sub-tabs -- skipped')
                continue
            perm = raw_tab.get('permission')
            if perm is not None and (not isinstance(perm, str) or not ID_RE.match(perm)):
                warnings.append(f'{where}: "permission" must be lowercase letters, digits, - or _ -- '
                                'tab is open to everyone instead')
                perm = None
            has_children = isinstance(raw_tab.get('children'), list)
            tab.update(permission=perm, kind='pane' if has_children else None,
                       group=tid if has_children else None)
            tab['label'] = _text(raw_tab.get('label'), tid, 60)
            tab['icon'] = _text(raw_tab.get('icon'), 'file', 4000)
            tab['subtitle'] = _text(raw_tab.get('subtitle'), '', 300)
            tab['description'] = _text(raw_tab.get('description'), '', 300)
            if not has_children:
                content = _custom_content(raw_tab, where, warnings)
                if content is None:
                    continue
                tab.update(content)
        tab['title'] = _text(raw_tab.get('title'), tab['label'], 120)

        if tab['kind']:
            tab['children'] = _children(tid, spec, raw_tab.get('children'), tab['label'], warnings, seen_ids)
            if tab['kind'] == 'pane' and not tab['children']:
                warnings.append(f'{where}: no sub-tabs left -- the tab is hidden')
                continue
        else:
            tab['children'] = []
        if tab['permission']:
            if tab['permission'] in seen_perms:
                warnings.append(f'{where}: permission "{tab["permission"]}" is shared with another tab')
            seen_perms.add(tab['permission'])
        seen_ids.add(tid)
        tabs.append(tab)

    if not tabs:
        raise ValueError('no usable tabs')
    if app['default_tab'] not in {t['id'] for t in tabs}:
        warnings.append(f'app.default_tab "{app["default_tab"]}" is not a visible tab -- using "{tabs[0]["id"]}"')
        app['default_tab'] = tabs[0]['id']
    return {'app': app, 'login': login, 'tabs': tabs}, warnings


class _State:
    lock = threading.Lock()
    mtime = None
    path = None
    config = None
    warnings = []


def _register_permissions(config):
    """One grantable permission per visible tab that has one (HR -> Roles / Users lists these,
    labelled with the tab's name). A hidden tab's permission stops being grantable."""
    replace_permissions([(t['permission'], t['label'], t['description'])
                         for t in config['tabs'] if t['permission']])


def current():
    """The config in use, re-read if the file changed since last time. Returns (config, warnings)."""
    path = config_path()
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        mtime = None
    with _State.lock:
        if _State.config is not None and mtime == _State.mtime and path == _State.path:
            return _State.config, _State.warnings
        _State.mtime, _State.path = mtime, path
        try:
            if mtime is None:
                raise FileNotFoundError(f'{path} not found')
            with open(path, encoding='utf-8') as f:
                config, warnings = normalize(json.load(f))
        except (OSError, ValueError) as exc:  # json.JSONDecodeError is a ValueError
            fallback = 'using the built-in defaults' if _State.config is None else 'still using the last good version'
            config = normalize({})[0] if _State.config is None else _State.config
            warnings = [f'{path}: {exc} -- {fallback}']
        for w in warnings:
            log.warning('UI config: %s', w)
        _State.config, _State.warnings = config, warnings
        _register_permissions(config)
        return config, warnings
