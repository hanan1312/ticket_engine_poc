# Gunicorn settings for the Flask app (demo/wsgi.py). Started by deploy/ticket-engine.service.
import os

# Only nginx talks to gunicorn, so listen on loopback. Set BIND=0.0.0.0:4044 in the env file
# only if you serve the app directly without nginx (then open port 4044 instead of 80/443).
bind = os.environ.get('BIND', f"127.0.0.1:{os.environ.get('PORT', '4044')}")

# ONE worker process: login lockout counters and online/idle presence are kept in memory
# (auth_engine/rate_limit.py, presence.py), so several processes would each see a different
# copy. Threads give concurrency inside that one process.
workers = 1
threads = int(os.environ.get('GUNICORN_THREADS', '8'))
worker_class = 'gthread'

timeout = 120          # PDF generation (purchase orders, hotel layout) can take a few seconds
graceful_timeout = 30
keepalive = 5

accesslog = '-'        # stdout/stderr -> journald (journalctl -u ticket-engine)
errorlog = '-'
loglevel = os.environ.get('LOG_LEVEL', 'info')
forwarded_allow_ips = '127.0.0.1'
proc_name = 'ticket-engine'
