from datetime import datetime

from shared_db import db

# Port of module_app's Employee (src/models/user.py) + the core of its attendance system
# (src/models/attendance.py, src/utils/attendance.py). Deliberately NOT ported:
# AttendancePermission (excused-hours), EmployeeVacation, Holiday, and weekly-days-off --
# real refinements in module_app, but administrative surface on top of the core mechanic
# rather than the mechanic itself. See attendance.py for what that leaves intact: the
# closed-sessions-plus-live-open-session worked-hours calculation, including the "today
# only" clip that made this move in real time instead of staying at 0 all day.


class Employee(db.Model):
    __tablename__ = 'hr_employees'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    role = db.Column(db.String(50), nullable=False)  # e.g. Technician, Front Desk, Manager
    phone = db.Column(db.String(20))
    email = db.Column(db.String(100))
    status = db.Column(db.String(20), default='active')  # active | on_leave | terminated
    join_date = db.Column(db.DateTime, default=datetime.utcnow)
    # Not every employee has a system login -- mirrors module_app's Employee.username being
    # nullable and unrelated to auth_engine.User (an employee record and a login account are
    # separate concepts here, same as in module_app).
    username = db.Column(db.String(80))
    photo_data = db.Column(db.LargeBinary)
    photo_mimetype = db.Column(db.String(50))
    photo_updated_at = db.Column(db.DateTime)


class AttendanceSession(db.Model):
    """One row per clock-in/clock-out session (clock_out NULL while open) -- not one row per
    day, so a split shift clocks in/out more than once in the same day."""
    __tablename__ = 'hr_attendance_sessions'

    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.Integer, db.ForeignKey('hr_employees.id', ondelete='CASCADE'),
                             nullable=False, index=True)
    clock_in = db.Column(db.DateTime, nullable=False)
    clock_out = db.Column(db.DateTime)
    recorded_by = db.Column(db.String(80))
    note = db.Column(db.Text)


class HRConfig(db.Model):
    """Single-row attendance/security policy config (HR -> Policy) -- started as the stand-in
    for module_app's LabConfig fields (standard_work_hours_per_day, idle_logout_timeout), now
    also the security policy auth_engine enforces at sign-in (see hr.routes.security_policy,
    wired in by demo/app.py)."""
    __tablename__ = 'hr_config'

    id = db.Column(db.Integer, primary_key=True)
    standard_work_hours_per_day = db.Column(db.Float, nullable=False, default=8.0)
    idle_logout_timeout_minutes = db.Column(db.Integer, nullable=False, default=0)  # 0 = disabled
    # Password rules
    password_min_length = db.Column(db.Integer, nullable=False, default=8, server_default='8')
    password_require_digit = db.Column(db.Boolean, nullable=False, default=True, server_default='1')
    password_require_upper = db.Column(db.Boolean, nullable=False, default=False, server_default='0')
    password_require_symbol = db.Column(db.Boolean, nullable=False, default=False, server_default='0')
    password_expiry_days = db.Column(db.Integer, nullable=False, default=0, server_default='0')  # 0 = never
    # Sign-in protection
    lockout_threshold = db.Column(db.Integer, nullable=False, default=5, server_default='5')
    lockout_minutes = db.Column(db.Integer, nullable=False, default=5, server_default='5')
    # Sign-in page
    login_banner = db.Column(db.Text)
    show_demo_accounts = db.Column(db.Boolean, nullable=False, default=True, server_default='1')
