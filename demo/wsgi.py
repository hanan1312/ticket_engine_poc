"""WSGI entry point for gunicorn: `gunicorn --config deploy/gunicorn.conf.py demo.wsgi:app`
(run from the project root). See deploy/README.md."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import create_app  # noqa: E402

app = create_app()
