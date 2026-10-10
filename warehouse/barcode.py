import secrets

# Matches module_app's exact batch barcode convention: 'WB-{id:06d}-{6 hex chars}', opaque,
# resolved by DB lookup on scan -- never parsed for meaning.


def mint_batch_barcode(batch_id):
    return f"WB-{batch_id:06d}-{secrets.token_hex(3)}"
