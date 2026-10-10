from datetime import datetime, time, timedelta

from .models import AttendanceSession, HRConfig


def get_config():
    config = HRConfig.query.first()
    if config is None:
        from shared_db import db
        config = HRConfig()
        db.session.add(config)
        db.session.commit()
    return config


def _open_session_live_seconds(employee_id, window_start, window_end):
    """Live (in-progress) seconds contributed by a still-open session, clipped to "now" and
    to the window -- only ever nonzero when "now" actually falls inside the window (i.e.
    only for a window covering today), so a session left open for days can't inflate a past
    day's total; only the day actually in progress gets live credit. Ported as-is from
    module_app's src/utils/attendance.py -- this is the one nuance worth preserving exactly,
    everything else in this file is a simplified version of the original."""
    now = datetime.utcnow()
    if not (window_start <= now <= window_end):
        return 0.0
    open_session = AttendanceSession.query.filter_by(employee_id=employee_id, clock_out=None).first()
    if not open_session:
        return 0.0
    clipped_start = max(open_session.clock_in, window_start)
    clipped_end = min(now, window_end)
    return max((clipped_end - clipped_start).total_seconds(), 0)


def compute_worked_hours(employee_id, date_from, date_to, tz_offset_minutes=0):
    """Sums closed sessions overlapping [date_from, date_to], clipped to those boundaries,
    plus whatever a still-open session has accrued so far today.

    date_from/date_to are calendar days in the *viewer's* timezone; sessions are stored in
    UTC. tz_offset_minutes is JavaScript's getTimezoneOffset() (UTC minus local, e.g. -180
    for UTC+3), so a local midnight is at local + offset in UTC."""
    shift = timedelta(minutes=tz_offset_minutes)
    range_start = datetime.combine(date_from, time.min) + shift
    range_end = datetime.combine(date_to, time.max) + shift
    sessions = AttendanceSession.query.filter(
        AttendanceSession.employee_id == employee_id,
        AttendanceSession.clock_out.isnot(None),
        AttendanceSession.clock_in <= range_end,
        AttendanceSession.clock_out >= range_start,
    ).all()

    total_seconds = 0.0
    for s in sessions:
        clipped_start = max(s.clock_in, range_start)
        clipped_end = min(s.clock_out, range_end)
        total_seconds += max((clipped_end - clipped_start).total_seconds(), 0)
    total_seconds += _open_session_live_seconds(employee_id, range_start, range_end)
    return total_seconds / 3600.0


def compute_attendance_summary(employee_id, date_from, date_to, tz_offset_minutes=0):
    """Simplified stand-in for module_app's compute_attendance_percentage() -- same shape
    (worked / expected, capped at 100), but expected hours here is just calendar days times
    a standard rate (no weekly-days-off/holiday/vacation carve-outs -- see this package's
    module docstring for what that drops)."""
    config = get_config()
    today = (datetime.utcnow() - timedelta(minutes=tz_offset_minutes)).date()  # viewer's today
    effective_to = min(date_to, today)
    days_elapsed = max((effective_to - date_from).days + 1, 0)
    expected = days_elapsed * config.standard_work_hours_per_day
    worked = compute_worked_hours(employee_id, date_from, date_to, tz_offset_minutes)
    percentage = 0.0 if expected == 0 else min(100.0, round(worked / expected * 100, 1))
    return {
        'employee_id': employee_id,
        'date_from': date_from.isoformat(),
        'date_to': date_to.isoformat(),
        'expected_hours': round(expected, 2),
        'worked_hours': round(worked, 2),
        'percentage': percentage,
    }
