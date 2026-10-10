from datetime import date, datetime

from shared_db import db

# Faithful port of module_app's warehouse schema (src/models/user.py) -- unlike
# ticket_engine (which deliberately generalizes this into Asset/Ticket), this is the literal
# stock/quantity-tracking concept: items have a quantity, batches expire, work orders draw
# stock down one scan at a time. Field names match the original so anyone cross-referencing
# module_app's CLAUDE.md finds the same shape here.


class WarehouseItem(db.Model):
    __tablename__ = 'warehouse_items'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(150), nullable=False)
    # Human-readable stock code, printed on labels and delivery notes -- the fallback a
    # recipient types to confirm a delivery when a barcode won't scan. Unique (enforced in
    # routes.py, since SQLite can't add a UNIQUE constraint to an existing table).
    sku = db.Column(db.String(50), index=True)
    category = db.Column(db.String(50), nullable=False)
    quantity = db.Column(db.Integer, default=0)
    critical_level = db.Column(db.Integer, default=5)
    unit = db.Column(db.String(50))
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class WarehouseBill(db.Model):
    """Stock coming IN via purchase. Status lifecycle demanded -> ordered -> delivered.
    Marking 'delivered' does NOT touch stock by itself -- only /receive (which creates a
    WarehouseBatch) does that, matching module_app's post-batches design."""
    __tablename__ = 'warehouse_bills'
    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.String(50), unique=True, nullable=False)
    item_id = db.Column(db.Integer, db.ForeignKey('warehouse_items.id'), nullable=False)
    item_name = db.Column(db.String(150))
    ordered_stock = db.Column(db.Integer)
    unit = db.Column(db.String(50))
    price_per_unit = db.Column(db.Float)
    total_price = db.Column(db.Float)
    category = db.Column(db.String(50))
    created_by = db.Column(db.String(80))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    status = db.Column(db.String(20), default='demanded')  # demanded | ordered | delivered
    # Bills raised together (e.g. the low-stock multi-select) share a group_ref, so they print
    # as one purchase order with several lines.
    group_ref = db.Column(db.String(50), index=True)
    note = db.Column(db.String(255))
    approved_by = db.Column(db.String(80))
    approved_at = db.Column(db.DateTime)
    delivered_on = db.Column(db.Date)  # the date the supplier actually delivered
    accepted_by = db.Column(db.String(80))  # who physically accepted the delivery
    accepted_by_user_id = db.Column(db.Integer, db.ForeignKey('auth_engine_users.id'))

    item = db.relationship('WarehouseItem')


class WarehouseBatch(db.Model):
    """A physical delivery batch -- the unit expiry dates and barcodes attach to.
    WarehouseItem.quantity is just the aggregate across all of an item's active batches.
    'Expired' is derived (status=='active' and expiry_date < today), never stored, so it
    can't go stale without a cron job."""
    __tablename__ = 'warehouse_batches'
    id = db.Column(db.Integer, primary_key=True)
    item_id = db.Column(db.Integer, db.ForeignKey('warehouse_items.id'), nullable=False)
    bill_id = db.Column(db.Integer, db.ForeignKey('warehouse_bills.id'), nullable=True)
    barcode = db.Column(db.String(64), unique=True, nullable=True, index=True)
    expiry_date = db.Column(db.Date, nullable=False)
    quantity_received = db.Column(db.Integer, nullable=False)
    quantity_remaining = db.Column(db.Integer, nullable=False)
    status = db.Column(db.String(20), nullable=False, default='active')  # active | exhausted | disposed
    received_by = db.Column(db.String(80))
    received_at = db.Column(db.DateTime, default=datetime.utcnow)
    disposed_by = db.Column(db.String(80))
    disposed_at = db.Column(db.DateTime)
    disposal_reason = db.Column(db.String(255))

    item = db.relationship('WarehouseItem')

    @property
    def is_expired(self):
        return self.status == 'active' and self.expiry_date < date.today()


class WarehouseWorkOrder(db.Model):
    """Stock going OUT for use. Lifecycle: requested (no stock effect) -> approved (admin) ->
    completed (scans reach `quantity`) or rejected (admin, no stock effect ever). Stock is
    only ever decremented one unit at a time via a successful scan -- never at creation or
    approval time."""
    __tablename__ = 'warehouse_work_orders'
    id = db.Column(db.Integer, primary_key=True)
    item_id = db.Column(db.Integer, db.ForeignKey('warehouse_items.id'), nullable=False)
    quantity = db.Column(db.Integer, nullable=False)
    quantity_fulfilled = db.Column(db.Integer, default=0)
    requested_by = db.Column(db.String(80))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    status = db.Column(db.String(20), default='requested')  # requested | approved | completed | rejected
    approved_by = db.Column(db.String(80))
    approved_at = db.Column(db.DateTime)
    note = db.Column(db.String(255))
    # Hand-over: approving names the employee the items go to and when; once every unit has
    # been scanned out, that employee confirms receipt themselves.
    deliver_to_user_id = db.Column(db.Integer, db.ForeignKey('auth_engine_users.id'))
    deliver_to = db.Column(db.String(80))
    delivery_date = db.Column(db.Date)
    delivery_confirmed_at = db.Column(db.DateTime)
    delivery_confirmed_via = db.Column(db.String(20))  # 'barcode' | 'sku' -- how receipt was verified

    item = db.relationship('WarehouseItem')


class WarehouseWorkOrderScan(db.Model):
    """Per-scan audit trail -- who, when, whether it broke FEFO order."""
    __tablename__ = 'warehouse_work_order_scans'
    id = db.Column(db.Integer, primary_key=True)
    work_order_id = db.Column(db.Integer, db.ForeignKey('warehouse_work_orders.id'), nullable=False)
    batch_id = db.Column(db.Integer, db.ForeignKey('warehouse_batches.id'), nullable=False)
    scanned_by = db.Column(db.String(80))
    scanned_at = db.Column(db.DateTime, default=datetime.utcnow)
    fefo_violation = db.Column(db.Boolean, default=False)
