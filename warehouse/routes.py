import re
import secrets
from datetime import date, datetime

from flask import Blueprint, Response, jsonify, request

from auth_engine import User, get_current_user, login_required, require_permission
from auth_engine.models import UserPermission
from inbox import notify, notify_admins
from shared_db import db

from . import pdf
from .barcode import mint_batch_barcode
from .models import (
    WarehouseBatch, WarehouseBill, WarehouseItem, WarehouseWorkOrder, WarehouseWorkOrderScan,
)

bp = Blueprint('warehouse', __name__, url_prefix='/api/warehouse')

BILL_STATUSES = {'demanded', 'ordered', 'delivered'}


def _is_admin():
    user = get_current_user()
    return user is not None and user.role == 'admin'


def _has_warehouse_access(user):
    return user is not None and (user.role == 'admin' or UserPermission.query.filter_by(
        user_id=user.id, permission='warehouse').first() is not None)


def _parse_date(raw, field):
    """Returns (date, None) or (None, error_response)."""
    if not raw:
        return None, (jsonify({'error': f'{field} is required'}), 400)
    try:
        return datetime.strptime(raw, '%Y-%m-%d').date(), None
    except ValueError:
        return None, (jsonify({'error': f'{field} must be YYYY-MM-DD'}), 400)


SKU_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/-]{1,49}$')


def _normalize_sku(raw):
    return (raw or '').strip().upper()


def _sku_error(sku, item_id=None):
    """Validates a (normalized) SKU; returns an error message or None."""
    if not SKU_RE.match(sku):
        return 'SKU must be 2-50 characters: letters, digits, dot, dash, slash or underscore'
    clash = WarehouseItem.query.filter(db.func.upper(WarehouseItem.sku) == sku).first()
    if clash is not None and clash.id != item_id:
        return f"SKU {sku} is already used by {clash.name}"
    return None


def default_sku(item_id):
    return f'SKU-{item_id:05d}'


def _pdf_response(data, filename):
    return Response(data, mimetype='application/pdf',
                    headers={'Content-Disposition': f'inline; filename="{filename}"'})


# ---- Items ----

@bp.route('/items', methods=['GET'])
@require_permission('warehouse')
def list_items():
    items = WarehouseItem.query.order_by(WarehouseItem.name).all()
    return jsonify([_item_json(i) for i in items])


@bp.route('/items', methods=['POST'])
@require_permission('warehouse')
def create_item():
    data = request.get_json(force=True) or {}
    if not data.get('name'):
        return jsonify({'error': 'name is required'}), 400
    sku = _normalize_sku(data.get('sku'))
    if sku:
        error = _sku_error(sku)
        if error:
            return jsonify({'error': error}), 400
    item = WarehouseItem(
        name=data['name'], category=data.get('category', 'general'),
        unit=data.get('unit', 'unit'), critical_level=int(data.get('critical_level', 5)),
        quantity=0, sku=sku or None,
    )
    db.session.add(item)
    db.session.flush()
    if not item.sku:
        item.sku = default_sku(item.id)
    db.session.commit()
    return jsonify(_item_json(item)), 201


@bp.route('/items/<int:item_id>', methods=['PUT'])
@require_permission('warehouse')
def update_item(item_id):
    """Edits an item's descriptive fields. Quantity is deliberately not editable here --
    it only ever moves through receiving a bill, scanning out a work order, or disposal,
    so the stock figure always matches the batch/scan audit trail."""
    item = WarehouseItem.query.get_or_404(item_id)
    data = request.get_json(force=True) or {}
    for field in ('name', 'category', 'unit'):
        if field in data:
            value = (data[field] or '').strip()
            if field == 'name' and not value:
                return jsonify({'error': 'name cannot be empty'}), 400
            setattr(item, field, value or ('general' if field == 'category' else None))
    if 'sku' in data:
        sku = _normalize_sku(data['sku'])
        if not sku:
            return jsonify({'error': 'SKU cannot be empty'}), 400
        error = _sku_error(sku, item_id=item.id)
        if error:
            return jsonify({'error': error}), 400
        item.sku = sku
    if 'critical_level' in data:
        try:
            level = int(data['critical_level'])
        except (TypeError, ValueError):
            return jsonify({'error': 'critical_level must be a whole number'}), 400
        if level < 0:
            return jsonify({'error': 'critical_level cannot be negative'}), 400
        item.critical_level = level
    # Keep denormalized names on not-yet-received bills in step with the rename.
    WarehouseBill.query.filter_by(item_id=item.id, status='demanded').update({'item_name': item.name})
    db.session.commit()
    return jsonify(_item_json(item))


@bp.route('/items/<int:item_id>', methods=['DELETE'])
@require_permission('warehouse')
def delete_item(item_id):
    item = WarehouseItem.query.get_or_404(item_id)
    # RESTRICT-style check -- same reasoning as module_app: purchase/batch history
    # shouldn't be silently cascaded away by deleting the item it's about.
    in_use = (
        WarehouseBill.query.filter_by(item_id=item_id).first()
        or WarehouseBatch.query.filter_by(item_id=item_id).first()
        or WarehouseWorkOrder.query.filter_by(item_id=item_id).first()
    )
    if in_use:
        return jsonify({'error': 'This item has purchase/batch/work-order history and cannot be deleted'}), 409
    db.session.delete(item)
    db.session.commit()
    return jsonify({'success': True})


# ---- Bills ----

@bp.route('/bills', methods=['GET'])
@require_permission('warehouse')
def list_bills():
    bills = WarehouseBill.query.order_by(WarehouseBill.id.desc()).all()
    received_ids = {b.bill_id for b in WarehouseBatch.query.filter(WarehouseBatch.bill_id.isnot(None)).all()}
    return jsonify([_bill_json(b, received=b.id in received_ids) for b in bills])


@bp.route('/bills', methods=['POST'])
@require_permission('warehouse')
def create_bill():
    data = request.get_json(force=True) or {}
    bill, error = _build_bill(data, group_ref=None)
    if error:
        return error
    db.session.commit()
    notify_admins(f'New bill {bill.order_id} awaiting approval',
                  f'{bill.created_by} requested {bill.ordered_stock} {bill.unit or ""} of {bill.item_name}.',
                  kind='warning', link_type='bill', link_id=bill.id)
    return jsonify(_bill_json(bill, received=False)), 201


@bp.route('/bills/bulk', methods=['POST'])
@require_permission('warehouse')
def create_bills_bulk():
    """One purchase order with several lines (e.g. every low-stock item ticked at once).
    Each line is still its own WarehouseBill -- they're tied together by group_ref -- and
    all of them wait in 'demanded' until an admin approves."""
    data = request.get_json(force=True) or {}
    lines = data.get('lines') or []
    if not lines:
        return jsonify({'error': 'select at least one item'}), 400
    group_ref = f"PO-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(2).upper()}"
    bills = []
    for i, line in enumerate(lines, start=1):
        bill, error = _build_bill({**line, 'note': data.get('note')}, group_ref=group_ref, line_no=i)
        if error:
            db.session.rollback()
            return error
        bills.append(bill)
    db.session.commit()
    user = get_current_user()
    notify_admins(f'New purchase order {group_ref} awaiting approval',
                  f'{user.username} requested {len(bills)} item(s): ' + ', '.join(b.item_name for b in bills[:5])
                  + (' ...' if len(bills) > 5 else ''),
                  kind='warning', link_type='bill', link_id=bills[0].id)
    return jsonify({'group_ref': group_ref, 'bills': [_bill_json(b, received=False) for b in bills]}), 201


@bp.route('/bills/<int:bill_id>', methods=['GET'])
@require_permission('warehouse')
def get_bill(bill_id):
    bill = WarehouseBill.query.get_or_404(bill_id)
    return jsonify(_bill_json(bill, received=_batch_for_bill(bill) is not None))


@bp.route('/bills/<int:bill_id>/pdf', methods=['GET'])
@require_permission('warehouse')
def bill_pdf(bill_id):
    bill = WarehouseBill.query.get_or_404(bill_id)
    group = (WarehouseBill.query.filter_by(group_ref=bill.group_ref).order_by(WarehouseBill.id).all()
             if bill.group_ref else [bill])
    batches = {b.id: _batch_for_bill(b) for b in group}
    return _pdf_response(pdf.purchase_order_pdf(group, batches), f'{bill.group_ref or bill.order_id}.pdf')


def _build_bill(data, group_ref, line_no=None):
    """Validates one bill line and adds it to the session (uncommitted)."""
    item = WarehouseItem.query.get(data.get('item_id'))
    if item is None:
        return None, (jsonify({'error': 'unknown item_id'}), 400)
    try:
        ordered_stock = int(data.get('ordered_stock', 0))
        price_per_unit = float(data.get('price_per_unit') or 0)
    except (TypeError, ValueError):
        return None, (jsonify({'error': f'{item.name}: quantity and price must be numbers'}), 400)
    if ordered_stock <= 0:
        return None, (jsonify({'error': f'{item.name}: quantity must be greater than zero'}), 400)
    if price_per_unit < 0:
        return None, (jsonify({'error': f'{item.name}: price cannot be negative'}), 400)
    user = get_current_user()
    stamp = datetime.utcnow().strftime('%Y%m%d%H%M%S')
    bill = WarehouseBill(
        order_id=f'{group_ref}-{line_no}' if group_ref else f'PO-{stamp}-{item.id}-{secrets.token_hex(2).upper()}',
        item_id=item.id, item_name=item.name, ordered_stock=ordered_stock,
        unit=item.unit, price_per_unit=price_per_unit,
        total_price=round(price_per_unit * ordered_stock, 2), category=item.category,
        created_by=user.username, status='demanded', group_ref=group_ref,
        note=(data.get('note') or '').strip() or None,
    )
    db.session.add(bill)
    return bill, None


def _batch_for_bill(bill):
    return WarehouseBatch.query.filter_by(bill_id=bill.id).first()


@bp.route('/bills/<int:bill_id>/status', methods=['PUT'])
@require_permission('warehouse')
def update_bill_status(bill_id):
    data = request.get_json(force=True) or {}
    new_status = data.get('status')
    if new_status not in BILL_STATUSES:
        return jsonify({'error': f"status must be one of {sorted(BILL_STATUSES)}"}), 400
    if new_status == 'ordered' and not _is_admin():
        return jsonify({'error': 'only an admin can confirm (mark as ordered) a bill'}), 403
    bill = WarehouseBill.query.get_or_404(bill_id)
    user = get_current_user()
    if new_status == 'ordered':
        if bill.status != 'demanded':
            return jsonify({'error': f"only a bill awaiting approval can be approved (this one is '{bill.status}')"}), 400
        bill.approved_by = user.username
        bill.approved_at = datetime.utcnow()
    bill.status = new_status
    db.session.commit()
    if new_status == 'ordered':
        creator = User.query.filter_by(username=bill.created_by).first()
        notify([creator], f'Bill {bill.order_id} approved',
               f'{user.username} approved {bill.ordered_stock} {bill.unit or ""} of {bill.item_name}.',
               kind='success', link_type='bill', link_id=bill.id)
    return jsonify(_bill_json(bill, received=_batch_for_bill(bill) is not None))


@bp.route('/bills/<int:bill_id>/receive', methods=['POST'])
@require_permission('warehouse')
def receive_bill(bill_id):
    """Logs a delivered bill into the warehouse as a dated batch -- this, not marking a bill
    'delivered', is the only thing that increments WarehouseItem.quantity."""
    data = request.get_json(force=True) or {}
    bill = WarehouseBill.query.get_or_404(bill_id)
    # An approved ('ordered') bill can be received in one step -- that marks it delivered
    # too; the separate "mark delivered" step is kept for bills already sitting in 'delivered'.
    if bill.status not in ('ordered', 'delivered'):
        return jsonify({'error': 'the bill must be approved by an admin before its delivery can be received'}), 400
    if _batch_for_bill(bill):
        return jsonify({'error': 'this bill has already been received into warehouse'}), 400

    expiry_date, error = _parse_date(data.get('expiry_date'), 'expiry_date')
    if error:
        return error
    delivered_on, error = _parse_date(data.get('delivered_on') or date.today().isoformat(), 'delivered_on')
    if error:
        return error
    if delivered_on > date.today():
        return jsonify({'error': "delivery date can't be in the future"}), 400

    try:
        quantity_received = int(data.get('quantity_received') or bill.ordered_stock or 0)
    except (TypeError, ValueError):
        return jsonify({'error': 'quantity_received must be a whole number'}), 400
    if quantity_received <= 0:
        return jsonify({'error': 'quantity_received must be greater than zero'}), 400

    user = get_current_user()
    accepter = User.query.get(data['accepted_by_user_id']) if data.get('accepted_by_user_id') else user
    if accepter is None or accepter.is_active is False:
        return jsonify({'error': 'the person who accepted the delivery must be an active user'}), 400

    item = WarehouseItem.query.get(bill.item_id)
    batch = WarehouseBatch(
        item_id=item.id, bill_id=bill.id, expiry_date=expiry_date,
        quantity_received=quantity_received, quantity_remaining=quantity_received,
        status='active', received_by=accepter.username,
    )
    db.session.add(batch)
    db.session.flush()
    batch.barcode = mint_batch_barcode(batch.id)
    item.quantity += quantity_received
    bill.status = 'delivered'
    bill.delivered_on = delivered_on
    bill.accepted_by = accepter.username
    bill.accepted_by_user_id = accepter.id
    db.session.commit()
    notify_admins(f'Delivery received: {bill.order_id}',
                  f'{quantity_received} {bill.unit or ""} of {item.name} delivered on {delivered_on.isoformat()}, '
                  f'accepted by {accepter.username}. New batch barcode {batch.barcode}.',
                  extra_users=[accepter], kind='success', link_type='bill', link_id=bill.id)
    return jsonify(_batch_json(batch)), 201


# ---- Batches ----

@bp.route('/batches', methods=['GET'])
@require_permission('warehouse')
def list_batches():
    batches = WarehouseBatch.query.order_by(WarehouseBatch.expiry_date.asc()).all()
    return jsonify([_batch_json(b) for b in batches])


@bp.route('/batches/barcode/<code>', methods=['GET'])
@require_permission('warehouse')
def resolve_batch_barcode(code):
    batch = WarehouseBatch.query.filter_by(barcode=code).first()
    if batch is None:
        return jsonify({'error': 'unknown barcode'}), 404
    return jsonify(_batch_json(batch))


@bp.route('/batches/<int:batch_id>/dispose', methods=['POST'])
@require_permission('warehouse')
def dispose_batch(batch_id):
    if not _is_admin():
        return jsonify({'error': 'only an admin can dispose a batch'}), 403
    data = request.get_json(force=True) or {}
    batch = WarehouseBatch.query.get_or_404(batch_id)
    if batch.status != 'active':
        return jsonify({'error': 'batch is not active'}), 400
    if batch.expiry_date >= date.today():
        return jsonify({'error': 'this batch has not expired yet'}), 400
    reason = (data.get('reason') or '').strip()
    if not reason:
        return jsonify({'error': 'a disposal reason is required'}), 400

    item = WarehouseItem.query.get(batch.item_id)
    disposed_qty = batch.quantity_remaining
    if item:
        item.quantity -= disposed_qty
    user = get_current_user()
    batch.status = 'disposed'
    batch.quantity_remaining = 0
    batch.disposed_by = user.username
    batch.disposed_at = datetime.utcnow()
    batch.disposal_reason = reason
    db.session.commit()
    return jsonify({'success': True, 'disposed_quantity': disposed_qty})


# ---- Work orders ----

@bp.route('/work-orders', methods=['GET'])
@require_permission('warehouse')
def list_work_orders():
    orders = WarehouseWorkOrder.query.order_by(WarehouseWorkOrder.id.desc()).all()
    return jsonify([_work_order_json(o) for o in orders])


@bp.route('/work-orders', methods=['POST'])
@require_permission('warehouse')
def create_work_order():
    """Records a request to issue stock -- stock is NOT touched here. Requested quantity may
    legitimately exceed current stock; that's only a constraint at scan time."""
    data = request.get_json(force=True) or {}
    item = WarehouseItem.query.get(data.get('item_id'))
    if item is None:
        return jsonify({'error': 'unknown item_id'}), 400
    quantity = int(data.get('quantity', 0))
    if quantity <= 0:
        return jsonify({'error': 'quantity must be greater than zero'}), 400
    user = get_current_user()
    order = WarehouseWorkOrder(item_id=item.id, quantity=quantity, requested_by=user.username,
                               note=(data.get('note') or '').strip() or None)
    db.session.add(order)
    db.session.commit()
    notify_admins(f'Work order #{order.id} awaiting approval',
                  f'{user.username} requested {quantity} x {item.name}.',
                  kind='warning', link_type='work_order', link_id=order.id)
    return jsonify(_work_order_json(order)), 201


@bp.route('/work-orders/<int:order_id>', methods=['GET'])
@login_required
def get_work_order(order_id):
    """Readable by warehouse staff and by the employee it's being delivered to -- who may
    have no warehouse permission at all but still needs to see and confirm it."""
    order = WarehouseWorkOrder.query.get_or_404(order_id)
    user = get_current_user()
    staff = _has_warehouse_access(user)
    if not (staff or order.deliver_to_user_id == user.id):
        return jsonify({'error': 'Permission denied'}), 403
    # The recipient doesn't get the issued batch barcodes until they've confirmed -- they
    # have to read one off the goods (or the SKU off the label), not copy it from this screen.
    return jsonify(_work_order_json(order, with_scans=staff or order.delivery_confirmed_at is not None))


@bp.route('/work-orders/<int:order_id>/pdf', methods=['GET'])
@login_required
def work_order_pdf(order_id):
    order = WarehouseWorkOrder.query.get_or_404(order_id)
    user = get_current_user()
    staff = _has_warehouse_access(user)
    if not (staff or order.deliver_to_user_id == user.id):
        return jsonify({'error': 'Permission denied'}), 403
    if not staff and order.delivery_confirmed_at is None:
        # The delivery note carries the SKU and batch barcodes -- the paper copy travels with
        # the goods; the recipient gets the digital one once they've confirmed receipt.
        return jsonify({'error': 'the delivery note is available after you confirm receipt'}), 403
    scans = WarehouseWorkOrderScan.query.filter_by(work_order_id=order.id).order_by(WarehouseWorkOrderScan.scanned_at).all()
    return _pdf_response(pdf.work_order_pdf(order, scans), f'WO-{order.id:05d}.pdf')


@bp.route('/my-deliveries', methods=['GET'])
@login_required
def my_deliveries():
    user = get_current_user()
    orders = (WarehouseWorkOrder.query.filter_by(deliver_to_user_id=user.id)
              .order_by(WarehouseWorkOrder.id.desc()).all())
    return jsonify([_work_order_json(o) for o in orders])


@bp.route('/work-orders/<int:order_id>/confirm-delivery', methods=['POST'])
@login_required
def confirm_delivery(order_id):
    """Only the named recipient can confirm, and only by proving the items are in hand.

    - Items not issued yet (status 'approved'): the recipient receives them directly. Each
      scanned batch barcode hands over one unit (taking it out of stock, same rules as a
      warehouse scan); the scan that completes the order also confirms receipt. Typing the
      SKU instead hands over every remaining unit at once, from the soonest-expiring batches.
    - Items already issued by warehouse staff (status 'completed'): scanning any one of the
      issued batch barcodes, or typing the SKU, confirms receipt.

    Which proof was used is recorded -- an SKU is weaker evidence than a scan."""
    order = WarehouseWorkOrder.query.get_or_404(order_id)
    user = get_current_user()
    if order.deliver_to_user_id != user.id:
        return jsonify({'error': 'only the employee this delivery is addressed to can confirm it'}), 403
    if order.delivery_confirmed_at is not None:
        return jsonify({'error': 'this delivery was already confirmed'}), 400
    if order.status not in ('approved', 'completed'):
        return jsonify({'error': 'this work order has not been approved yet'}), 400

    data = request.get_json(silent=True) or {}
    barcode = (data.get('barcode') or '').strip()
    sku = _normalize_sku(data.get('sku'))
    if not barcode and not sku:
        return jsonify({'error': "scan a barcode from the items you received, or enter the item's SKU"}), 400
    if sku and not barcode and (not order.item.sku or sku != _normalize_sku(order.item.sku)):
        return jsonify({'error': "that SKU doesn't match the item on this work order -- "
                                 "check the label or delivery note"}), 400

    if order.status == 'completed':
        if barcode:
            issued = {WarehouseBatch.query.get(sc.batch_id).barcode
                      for sc in WarehouseWorkOrderScan.query.filter_by(work_order_id=order.id).all()}
            if barcode not in issued:
                return jsonify({'error': "that barcode isn't on any batch issued for this work order -- "
                                         "check the label, or enter the item's SKU instead"}), 400
        return _finish_confirmation(order, user, 'barcode' if barcode else 'sku')

    # status == 'approved': hand the items over to the recipient now.
    if barcode:
        batch, older_available, error = _batch_for_order(order, barcode)
        if error:
            return error
        # No FEFO prompt here -- the recipient can't pick a different shelf; it's recorded instead.
        complete = _issue_unit(order, batch, user.username, older_available is not None)
        if not complete:
            db.session.commit()
            return jsonify(_work_order_json(order))
        return _finish_confirmation(order, user, 'barcode')

    remaining = order.quantity - order.quantity_fulfilled
    today = date.today()
    batches = (WarehouseBatch.query.filter(
        WarehouseBatch.item_id == order.item_id, WarehouseBatch.status == 'active',
        WarehouseBatch.quantity_remaining > 0, WarehouseBatch.expiry_date >= today)
        .order_by(WarehouseBatch.expiry_date.asc(), WarehouseBatch.id.asc()).all())
    if sum(b.quantity_remaining for b in batches) < remaining:
        return jsonify({'error': f'the warehouse only has {sum(b.quantity_remaining for b in batches)} usable '
                                 f'{order.item.unit or "unit"}(s) of {order.item.name} in stock -- ask the storekeeper'}), 400
    for batch in batches:
        while remaining and batch.quantity_remaining > 0:
            _issue_unit(order, batch, user.username, False)
            remaining -= 1
    return _finish_confirmation(order, user, 'sku')


def _finish_confirmation(order, user, via):
    order.delivery_confirmed_at = datetime.utcnow()
    order.delivery_confirmed_via = via
    db.session.commit()
    requester = User.query.filter_by(username=order.requested_by).first()
    method = 'by scanning the items' if via == 'barcode' else 'by typing the SKU (barcode not scanned)'
    notify_admins(f'Delivery confirmed: work order #{order.id}',
                  f'{user.username} confirmed receiving {order.quantity} x {order.item.name} {method}.',
                  extra_users=[user, requester], kind='success', link_type='work_order', link_id=order.id)
    return jsonify(_work_order_json(order, with_scans=True))


@bp.route('/work-orders/<int:order_id>/approve', methods=['PUT'])
@require_permission('warehouse')
def approve_work_order(order_id):
    if not _is_admin():
        return jsonify({'error': 'only an admin can approve a work order'}), 403
    order = WarehouseWorkOrder.query.get_or_404(order_id)
    if order.status != 'requested':
        return jsonify({'error': f"cannot approve a work order in status '{order.status}'"}), 400
    data = request.get_json(silent=True) or {}
    recipient = User.query.get(data.get('deliver_to_user_id')) if data.get('deliver_to_user_id') else None
    if recipient is None or recipient.is_active is False:
        return jsonify({'error': 'pick the employee the items will be delivered to'}), 400
    delivery_date, error = _parse_date(data.get('delivery_date'), 'delivery_date')
    if error:
        return error
    if delivery_date < date.today():
        return jsonify({'error': "delivery date can't be in the past"}), 400
    user = get_current_user()
    order.status = 'approved'
    order.approved_by = user.username
    order.approved_at = datetime.utcnow()
    order.deliver_to_user_id = recipient.id
    order.deliver_to = recipient.username
    order.delivery_date = delivery_date
    db.session.commit()
    notify_admins(f'Work order #{order.id} approved -- delivery to {recipient.username}',
                  f'{order.quantity} x {order.item.name} will be delivered to {recipient.username} on '
                  f'{delivery_date.isoformat()}. Please confirm receipt once you have them.',
                  extra_users=[recipient], kind='info', link_type='work_order', link_id=order.id)
    return jsonify(_work_order_json(order))


@bp.route('/work-orders/<int:order_id>/reject', methods=['PUT'])
@require_permission('warehouse')
def reject_work_order(order_id):
    if not _is_admin():
        return jsonify({'error': 'only an admin can reject a work order'}), 403
    order = WarehouseWorkOrder.query.get_or_404(order_id)
    if order.status != 'requested':
        return jsonify({'error': f"cannot reject a work order in status '{order.status}'"}), 400
    user = get_current_user()
    order.status = 'rejected'
    order.approved_by = user.username
    order.approved_at = datetime.utcnow()
    db.session.commit()
    return jsonify(_work_order_json(order))


def _batch_for_order(order, barcode):
    """Validates a scanned batch barcode against a work order. Returns
    (batch, older_available_batch_or_None, None) or (None, None, error_response). An expired
    batch is a hard 400 (never just a warning -- it's already excluded from availability)."""
    batch = WarehouseBatch.query.filter_by(barcode=barcode).first()
    if batch is None:
        return None, None, (jsonify({'error': 'unknown barcode'}), 404)
    if batch.item_id != order.item_id:
        return None, None, (jsonify({'error': f'this barcode is not a batch of {order.item.name}'}), 400)
    if batch.status != 'active' or batch.quantity_remaining <= 0:
        return None, None, (jsonify({'error': f'this batch is {batch.status} and cannot be used'}), 400)
    today = date.today()
    if batch.expiry_date < today:
        return None, None, (jsonify({'error': 'this batch is expired -- flagged for disposal, not usable'}), 400)
    older_available = WarehouseBatch.query.filter(
        WarehouseBatch.item_id == batch.item_id, WarehouseBatch.id != batch.id,
        WarehouseBatch.status == 'active', WarehouseBatch.quantity_remaining > 0,
        WarehouseBatch.expiry_date >= today, WarehouseBatch.expiry_date < batch.expiry_date,
    ).first()
    return batch, older_available, None


def _issue_unit(order, batch, username, fefo_violation):
    """Moves one unit out of stock onto the work order (uncommitted). Returns True when that
    completes the order."""
    batch.quantity_remaining -= 1
    if batch.quantity_remaining <= 0:
        batch.status = 'exhausted'
    if batch.item:
        batch.item.quantity -= 1
    order.quantity_fulfilled += 1
    db.session.add(WarehouseWorkOrderScan(work_order_id=order.id, batch_id=batch.id,
                                          scanned_by=username, fefo_violation=fefo_violation))
    if order.quantity_fulfilled >= order.quantity:
        order.status = 'completed'
        return True
    return False


@bp.route('/work-orders/<int:order_id>/scan', methods=['POST'])
@require_permission('warehouse')
def scan_work_order(order_id):
    """Warehouse staff issuing one unit of an approved work order by scanning a batch
    barcode. An available older batch of the same item is a soft 409 unless resent with
    confirm_fefo_override (see _batch_for_order for the hard rules)."""
    data = request.get_json(force=True) or {}
    barcode = (data.get('barcode') or '').strip()
    confirm_override = bool(data.get('confirm_fefo_override'))
    if not barcode:
        return jsonify({'error': 'barcode is required'}), 400

    order = WarehouseWorkOrder.query.get_or_404(order_id)
    if order.status != 'approved':
        return jsonify({'error': f"work order must be approved, not '{order.status}'"}), 400
    if order.quantity_fulfilled >= order.quantity:
        return jsonify({'error': 'this work order is already fully fulfilled'}), 400

    batch, older_available, error = _batch_for_order(order, barcode)
    if error:
        return error
    if older_available is not None and not confirm_override:
        return jsonify({
            'error': 'check shelf for older item of the same name please!',
            'confirm_fefo_override_required': True,
            'older_batch_expiry': older_available.expiry_date.isoformat(),
        }), 409

    line_complete = _issue_unit(order, batch, get_current_user().username, older_available is not None)
    db.session.commit()
    if line_complete and order.deliver_to_user_id:
        notify([User.query.get(order.deliver_to_user_id)],
               f'Work order #{order.id} is ready -- please confirm receipt',
               f'All {order.quantity} x {order.item.name} have been issued to you. Open this notification '
               "and scan one of the items (or enter the item's SKU) to confirm you received them.",
               kind='warning', link_type='work_order', link_id=order.id)

    return jsonify({
        'success': True, 'item_name': order.item.name,
        'quantity_remaining_in_batch': batch.quantity_remaining,
        'line_fulfilled': order.quantity_fulfilled, 'line_requested': order.quantity,
        'line_complete': line_complete,
    })


@bp.route('/barcodes/pdf', methods=['POST'])
@login_required
def barcode_labels_pdf():
    """A printable sheet of Code128 labels with adjustable page margins, label size and
    spacing. Takes the labels themselves in the request ({code, title, subtitle}), so it
    prints batch barcodes and ticket-asset barcodes alike."""
    data = request.get_json(force=True) or {}
    labels = [l for l in (data.get('labels') or []) if (l.get('code') or '').strip()]
    if not labels:
        return jsonify({'error': 'no barcodes to print'}), 400
    try:
        options = pdf.LabelOptions.from_dict(data.get('options') or {})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    return _pdf_response(pdf.barcode_labels_pdf(labels, options), 'barcodes.pdf')


def _item_json(item):
    return {
        'id': item.id, 'name': item.name, 'sku': item.sku, 'category': item.category,
        'quantity': item.quantity, 'critical_level': item.critical_level, 'unit': item.unit,
        'low_stock': item.quantity < item.critical_level,
    }


def _bill_json(bill, received):
    batch = _batch_for_bill(bill) if received else None
    return {
        'id': bill.id, 'order_id': bill.order_id, 'item_id': bill.item_id, 'item_name': bill.item_name,
        'ordered_stock': bill.ordered_stock, 'unit': bill.unit, 'price_per_unit': bill.price_per_unit,
        'total_price': bill.total_price, 'category': bill.category, 'created_by': bill.created_by,
        'created_at': bill.created_at.isoformat(), 'status': bill.status, 'received': received,
        'group_ref': bill.group_ref, 'note': bill.note,
        'approved_by': bill.approved_by,
        'approved_at': bill.approved_at.isoformat() if bill.approved_at else None,
        'delivered_on': bill.delivered_on.isoformat() if bill.delivered_on else None,
        'accepted_by': bill.accepted_by,
        'batch': _batch_json(batch) if batch else None,
    }


def _batch_json(batch):
    return {
        'id': batch.id, 'item_id': batch.item_id, 'item_name': batch.item.name if batch.item else None,
        'item_sku': batch.item.sku if batch.item else None,
        'bill_id': batch.bill_id, 'barcode': batch.barcode, 'expiry_date': batch.expiry_date.isoformat(),
        'quantity_received': batch.quantity_received, 'quantity_remaining': batch.quantity_remaining,
        'status': batch.status, 'is_expired': batch.is_expired,
        'received_by': batch.received_by,
        'received_at': batch.received_at.isoformat() if batch.received_at else None,
        'disposal_reason': batch.disposal_reason,
    }


def _work_order_json(order, with_scans=False):
    out = {
        'id': order.id, 'item_id': order.item_id, 'item_name': order.item.name if order.item else None,
        'unit': order.item.unit if order.item else None,
        'quantity': order.quantity, 'quantity_fulfilled': order.quantity_fulfilled,
        'requested_by': order.requested_by, 'created_at': order.created_at.isoformat(),
        'status': order.status, 'approved_by': order.approved_by,
        'approved_at': order.approved_at.isoformat() if order.approved_at else None,
        'note': order.note,
        'deliver_to': order.deliver_to, 'deliver_to_user_id': order.deliver_to_user_id,
        'delivery_date': order.delivery_date.isoformat() if order.delivery_date else None,
        'delivery_confirmed_at': order.delivery_confirmed_at.isoformat() if order.delivery_confirmed_at else None,
        'delivery_confirmed_via': order.delivery_confirmed_via,
    }
    if with_scans:
        scans = (WarehouseWorkOrderScan.query.filter_by(work_order_id=order.id)
                 .order_by(WarehouseWorkOrderScan.scanned_at).all())
        out['scans'] = [{
            'barcode': WarehouseBatch.query.get(sc.batch_id).barcode, 'scanned_by': sc.scanned_by,
            'scanned_at': sc.scanned_at.isoformat(), 'fefo_violation': sc.fefo_violation,
        } for sc in scans]
    return out
