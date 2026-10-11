"""Registry of the permission strings an admin can grant. Whatever assembles the app registers
them (demo/app.py registers one per sidebar tab, from config/ui.json), and everything that
lists or validates permissions -- the account editor, the HR security API -- reads this, so a
new tab shows up in "Fine-tune permissions" without touching either."""

_REGISTRY = {}


def register_permission(key, label, hint=''):
    _REGISTRY[key] = {'key': key, 'label': label, 'hint': hint}


def replace_permissions(items):
    """Swap the whole registry for [(key, label, hint)] in one step (a reloaded config), so a
    request on another thread never sees it half-built."""
    global _REGISTRY
    _REGISTRY = {key: {'key': key, 'label': label, 'hint': hint} for key, label, hint in items}


def registered_permissions():
    """[{key, label, hint}] in registration (sidebar) order."""
    return list(_REGISTRY.values())


def is_registered_permission(key):
    return key in _REGISTRY
