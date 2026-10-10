# Deploying on an Ubuntu server (Oracle Cloud)

```
 internet ──80/443──▶ nginx ──127.0.0.1:4044──▶ gunicorn (1 worker, 8 threads) ── demo/wsgi.py
                                                     │
                                                     └──127.0.0.1:5050──▶ WhatsApp service (optional)
```

| Port | Who listens | Open in the firewall? |
|---|---|---|
| 80, 443 | nginx | **Yes** — the only public ports |
| 4044 | gunicorn (the app), loopback only | No (nginx forwards to it) |
| 5050 | WhatsApp notifications service | **Never** — anyone reaching it could send messages from your number |
| 587 / 465 out | SMTP for emails | Outbound only; allowed by default |

## Files

| File | Installed to | Purpose |
|---|---|---|
| `gunicorn.conf.py` | used in place | Bind `127.0.0.1:4044`, one worker (lockout and presence are in memory), 8 threads, logs to journald |
| `ticket-engine.service` | `/etc/systemd/system/` | Runs gunicorn as user `ticketengine`, restarts on failure, read-only filesystem except `database/` |
| `ticket-engine-whatsapp.service` | `/etc/systemd/system/` | Optional: the Node WhatsApp service on port 5050 |
| `nginx-ticket-engine.conf` | `/etc/nginx/sites-available/ticket-engine` | Public port 80 → 4044, 6 MB uploads, security headers; certbot adds 443 |
| `ticket-engine.env.example` | `/etc/ticket-engine/ticket-engine.env` (mode 600) | `SECRET_KEY`, `PORT`, `BEHIND_PROXY`, `SESSION_COOKIE_SECURE`, … |
| `install.sh` | — | Does all of the below in one go; safe to re-run for updates |

## Quick install

1. Copy the project to the server (from your machine):
   ```bash
   rsync -av --exclude venv --exclude node_modules --exclude __pycache__ \
     ticket_engine_poc/ ubuntu@<server-ip>:~/ticket_engine_poc/
   ```
2. On the server:
   ```bash
   cd ~/ticket_engine_poc
   sudo bash deploy/install.sh                  # web app only
   # or: sudo WITH_WHATSAPP=1 bash deploy/install.sh   (also installs Node 20 + the WhatsApp service)
   ```
   The first run copies `database/ticket_engine.db` along; later runs update the code only and
   never touch the server's database, secret key or WhatsApp session.
3. **Oracle Cloud console** → Networking → Virtual Cloud Networks → your VCN → Security Lists →
   *Add Ingress Rules*: source `0.0.0.0/0`, TCP, destination port `80`; again for `443`.
   (Oracle's Ubuntu images also block ports in iptables — `install.sh` opens 80 and 443 there.)
4. Open `http://<server-ip>/`, sign in, and **change the `admin` password** (demo: `admin`/`admin123`).
   In HR → Policy, consider turning off "Show the demo accounts".

## HTTPS (strongly recommended — passwords are sent at sign-in)

Needs a domain name with an A record pointing at the server's public IP.
```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo sed -i 's/server_name _;/server_name hotel.example.com;/' /etc/nginx/sites-available/ticket-engine
sudo certbot --nginx -d hotel.example.com          # adds port 443 and the HTTP→HTTPS redirect
sudo sed -i 's/^SESSION_COOKIE_SECURE=.*/SESSION_COOKIE_SECURE=1/' /etc/ticket-engine/ticket-engine.env
sudo systemctl restart ticket-engine
```

## Day-to-day

```bash
sudo systemctl status ticket-engine            # is it running?
journalctl -u ticket-engine -f                 # live logs (requests + errors)
sudo systemctl restart ticket-engine           # after editing the env file
cd ~/ticket_engine_poc && sudo bash deploy/install.sh   # deploy a new version of the code
sudo -u ticketengine sqlite3 /opt/ticket-engine/database/ticket_engine.db ".backup '/tmp/te-backup.db'"   # backup
```

WhatsApp pairing: start the service (`sudo systemctl start ticket-engine-whatsapp`), switch it on
in Preferences, then click the WhatsApp pill in the header to scan the QR code.

## Settings (`/etc/ticket-engine/ticket-engine.env`)

| Variable | Default | Meaning |
|---|---|---|
| `SECRET_KEY` | random, written by `install.sh` | Signs session cookies. Changing it signs everyone out. If empty, the app generates one in `database/.secret_key` |
| `PORT` | `4044` | Port gunicorn listens on (nginx's `upstream` must match) |
| `BIND` | `127.0.0.1:$PORT` | Set `0.0.0.0:4044` only if you skip nginx — then open 4044 instead of 80/443, without HTTPS |
| `BEHIND_PROXY` | `1` | Trust nginx's `X-Forwarded-*` so reset links use the public `https://` address |
| `SESSION_COOKIE_SECURE` | `0` | Set `1` once HTTPS works |
| `FLASK_DEBUG` | `0` | Only for `python demo/app.py` on your own machine. Never `1` on a server: the debugger allows remote code execution |
| `NOTIFICATIONS_URL` | `http://127.0.0.1:5050` | WhatsApp service address |

## Why one worker

Login lockout counters and online/idle presence live in the process's memory
(`auth_engine/rate_limit.py`, `presence.py`). With several gunicorn workers each would keep its
own copy — lockouts could be dodged and presence would flicker. One worker with threads handles
a hotel's staff comfortably; scaling out needs those moved to a shared store (e.g. Redis) and
SQLite replaced.
