"""Registry of the permission strings an admin can grant. Whatever assembles the app registers
them (demo/app.py registers one per sidebar tab, read from the page's nav), and everything that
lists or validates permissions -- the account editor, the HR security API -- reads this, so a
new tab shows up in "Fine-tune permissions" without touching either."""

_REGISTRY = {}


def register_permission(key, label, hint=''):
    _REGISTRY[key] = {'key': key, 'label': label, 'hint': hint}


def registered_permissions():
    """[{key, label, hint}] in registration (sidebar) order."""
    return list(_REGISTRY.values())


def is_registered_permission(key):
    return key in _REGISTRY
