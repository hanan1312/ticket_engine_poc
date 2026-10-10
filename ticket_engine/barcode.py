import secrets

# Generalized from module_app's WarehouseBatch barcodes (src/models/user.py, 'WB-{id:06d}-{6
# hex chars}'). Same idea: the code carries no encoded meaning of its own, it's just a unique
# key minted at creation time and resolved by a DB lookup on scan. Keeping it opaque means a
# scan handler never needs to parse the string, only look it up.


def mint_barcode(prefix: str, entity_id: int) -> str:
    """Mint a unique-enough barcode for a newly created row.

    Called AFTER the row has an id (so it must be a two-step create: insert, flush to get
    the id, set the barcode, commit) -- same two-step the warehouse batch code uses.
    """
    suffix = secrets.token_hex(3)  # 6 hex chars, matches the original convention
    return f"{prefix}-{entity_id:06d}-{suffix}"
