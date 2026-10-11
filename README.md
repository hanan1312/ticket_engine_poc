# Ticket Engine POC

A standalone extraction of the "barcode scan → workflow ticket" mechanism from
`module_app`'s Warehouse module (`WarehouseBill`/`WarehouseBatch`/`WarehouseWorkOrder`/
`WarehouseWorkOrderScan`), generalized so it isn't tied to inventory/stock at all.

This is a proof of concept, not a finished library — it exists to show the shape of the
extraction before deciding whether to invest in the rest (auth, notifications, PDF/i18n/Excel,
per the scoping discussion). Domain fit it's aimed at: the hotel ticketing/asset-management
system described in `Hotel_ticketing_system.md`'s "Build from Scratch" option, where every
maintenance/support ticket must be linked to a specific physical asset via barcode scan.

## What's generalized vs. what's a stub

| Piece | Status |
|---|---|
| Barcode minting (`ticket_engine/barcode.py`) | Generalized, same convention as the original (`PREFIX-{id:06d}-{hex}`, opaque, resolved by DB lookup) |
| Ticket status state machine + role-gated transitions (`ticket_engine/models.py`, `workflow.py`) | Generalized — `ALLOWED_TRANSITIONS` and `PRE_TRANSITION_HOOKS` are the two things a new app edits, not the routes |
| Pluggable pre-transition warning + override (`workflow.py`'s `TransitionWarning`) | Generalized — same block-unless-confirmed shape as the original's FEFO check; `demo/app.py`'s `warn_on_duplicate_open_ticket` is a worked example of writing a new one |
| Per-event audit trail (`TicketEvent`) | Generalized, same idea as `WarehouseWorkOrderScan` |
| Auth (`auth_engine/`) | **Generalized, phase 2 done.** Hashed-password login, permission-string checks (`require_permission`), in-memory login-attempt lockout, and presence-heartbeat session expiry, all extracted from `src/routes/user.py`/`main.py`. Dropped: the `clnc_*`/`lab_*` workspace prefix routing, the separate `admins.json` master-admin bypass, and the dual clinic/lab DB-engine binding — all specific to `module_app`'s dual-workspace design. `ticket_engine/auth.py`'s `get_current_actor()` now points at `auth_engine.get_current_user`, and `Ticket.created_by`/`assigned_to` are real FKs to `auth_engine.User` — see "Two modules, wired together" below. |
| Notifications (`notifications/` + `demo/notifications_client.py`) | **Copied and wired in.** `server.js`/`whatsapp.js` are byte-for-byte copies of `module_app`'s WhatsApp/SMS microservice. `ticket_engine/workflow.py` gained a second hook point, `POST_TRANSITION_HOOKS` (mirroring the existing pre-transition hooks, but running only after a transition is already committed) so a downed/unpaired WhatsApp service can never block or fail a ticket transition. `demo/app.py`'s `notify_on_ticket_transition` uses it: assigning a ticket messages the assignee, resolving one messages whoever created it. The outcome (sent / rejected by the service / service unreachable / no phone on file) is written to the ticket's own `TicketEvent` audit trail either way, and the frontend surfaces it in the activity log right after the transition. See "Verifying the notifications wiring" below for how this was tested without a real WhatsApp account. |
| Warehouse (`warehouse/`) | **Full replica, separate from `ticket_engine`.** The literal stock/quantity-tracking concept `ticket_engine` deliberately generalized away from, rebuilt as its own thing at the user's request: `WarehouseItem`/`WarehouseBill`/`WarehouseBatch`/`WarehouseWorkOrder`/`WarehouseWorkOrderScan` with the same field names and lifecycle as `module_app` (demanded→ordered→delivered bills; receive-into-batch mints a barcode and is the only thing that increments stock; FEFO-enforced scan-to-fulfill with a hard block on expired batches and a soft 409+override on an available older batch; admin-only dispose with a required reason). Multi-item purchase orders are several one-item bills sharing a `group_ref` (e.g. the low-stock multi-select), printed together as one PO. On top of module_app's lifecycle: editable items, a named "accepted by" + delivery date when a bill is received, and work-order hand-over (approval names the recipient employee and delivery date; that employee confirms receipt themselves). PDFs (purchase order, work-order delivery note) and Code128 label sheets with adjustable margins are in `warehouse/pdf.py` (reportlab). |
| HR (`hr/`) | **Full replica, core + simplified attendance.** `Employee` list, clock-in/clock-out (`AttendanceSession`, one row per session so a split shift can clock in/out more than once a day), worked-hours computed the same way as `module_app`'s `compute_worked_hours` — closed sessions plus whatever a still-open session has accrued *today only*, so it moves in real time instead of sitting at 0 until clock-out. A Security panel reuses `auth_engine`'s existing `UserPermission`/`require_permission` machinery (not a separate system) to grant/revoke the `warehouse`/`hr-management` permission strings per user, plus a simple attendance/idle-logout policy form. **Not ported**: `AttendancePermission` (excused-hours), `EmployeeVacation`, `Holiday`, weekly-days-off — real refinements in `module_app`, administrative surface on top of the core mechanic rather than the mechanic itself, cut for scope. |
| In-app notifications (`inbox/`) | **New.** One `Notification` row per user, listed under the bell icon in the header (polled every 20s). `inbox.notify()`/`notify_admins()` are called by warehouse approvals/deliveries, ticket assign/resolve and account-recovery requests. A `register_delivery_hook()` seam mirrors each one to WhatsApp when that's switched on in Preferences. |
| Accounts (`auth_engine/` + `hr/routes.py`) | **New.** Role presets (Administrator / Manager / Storekeeper / HR officer / Technician) that set the auth role plus permission strings in one step. Creating an account issues a one-time temporary password; the owner must replace it on first login (enforced server-side, not just in the UI). Forgot-password emails a 1-hour single-use reset link to the recovery email (`auth_engine/mailer.py`, SMTP via env vars, printed to the console when SMTP isn't configured). "Can't access your account" files a recovery request; an admin approving it deactivates (never deletes) the old login and issues a new one. |
| Hotel architecture (`hotel/`) | **New.** Buildings → floors → rooms with derived IDs (`A` → `A_2` → `A_2_204`), kept in sync when a building is edited; a site-plan whiteboard (SVG shapes linked to buildings); a PDF of the whole layout. View for everyone, edit admin-only. |
| Navigation config (`config/ui.json` + `demo/ui_config.py`) | **New.** Tabs, sub-tabs, names, icons, order, page headings, custom tabs (HTML page / embedded URL / link) and sign-in texts come from one JSON file, re-read on change without a restart. The grantable permissions follow the visible tabs. See "Customizing tabs and names" below. |
| PDF (Arabic-safe text), i18n, Excel | Warehouse PDFs done (Latin text only). Arabic-safe PDF text, i18n and Excel still not included. |

**A bug worth knowing about**: `auth_engine`'s `DEFAULT_PERMISSIONS` (there is none here — new users get zero permissions until explicitly granted) means a freshly-created non-admin user can't see the Warehouse or HR tabs at all until an admin grants them via the Security panel. This is a *faithful reproduction* of a real gap in `module_app` itself (its `DEFAULT_PERMISSIONS` string omits `warehouse`/`hr-management` too — see `src/models/junctions.py:24`), not a bug introduced here.

## Running it

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python demo/app.py
```

To actually deliver WhatsApp notifications (optional — tickets work fine without it), run
the notifications service in a second terminal and pair a phone once:

```bash
cd notifications && npm install && npm start
# scan the QR code it prints with WhatsApp → Linked devices on the sending phone
```

Flask sends through the service's `lab` session (the only one `server.js` starts on boot;
override with `NOTIFICATIONS_CENTER_ID`) at `NOTIFICATIONS_URL` (default
`http://localhost:5050`). The seeded `admin`/`tech` phone numbers are fake — set real ones
on `auth_engine_users.phone` or sends will be rejected as "Number not registered".

Password-reset links and temporary passwords are sent by email. Set that up as admin in
**Preferences → Email**: pick Gmail / Outlook / Other, enter the SMTP server, username and
password (Gmail and Outlook need an *app password*), **Save**, then **Send test email**.
Environment variables still work as a fallback
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_SSL=1`). Until
email is set up, "Forgot password?" says so plainly (instead of claiming a link was sent) and
every admin gets a bell notification to issue a temporary password; the same happens if a
send fails or the account has no recovery email. The SMTP password is stored in the app's
database (never returned to the browser) — use a dedicated mailbox/app password for this.

An existing `database/ticket_engine.db` is upgraded in place on startup (new columns are
added by `shared_db.upgrade_schema()`; nothing is dropped).

Open http://localhost:4044 (or whatever `PORT` is set to) and sign in as `admin`/`admin123`
or `tech`/`tech123` on the login screen. See "Testing each feature, practically" below for a
full walkthrough of every tab.

Everything above, plus login/logout, the 5-attempt lockout, `require_permission`, and
presence-timeout enforcement, has been exercised end-to-end with curl/pytest-style checks
during development (not just read through) — see the module docstrings for what each piece
replaces from `module_app`.

## Customizing tabs and names (`config/ui.json`)

The left panel is built from one JSON file, `config/ui.json`: which tabs exist and in what order,
their names, icons, page titles, sub-tabs, tabs of your own, and the sign-in page texts. Edit it,
save, **reload the page** — no restart. (Point the `UI_CONFIG` environment variable at another
file to use that instead.) The company name and logo are not in this file; they're set live in
**Preferences → Branding**.

```jsonc
{
  "app": {
    "sidebar_subtitle": "Operations suite",   // under the company name in the sidebar
    "sidebar_section": "Workspace",           // small heading above the tabs
    "footer": "Ticket Engine POC",            // bottom of the sidebar
    "default_tab": "dashboard"                // tab opened on first sign-in
  },
  "login": { "tagline": "...", "heading": "...", "lead": "...",
             "art_kicker": "...", "art_heading": "...", "art_points": ["...", "..."] },
  "tabs": [
    { "id": "warehouse", "label": "Stores", "icon": "package",
      "title": "Stores", "subtitle": "Stock and deliveries", "description": "Shown in HR → Roles",
      "children": [
        { "id": "wh-items", "label": "Stock items", "subtitle": "..." },
        { "id": "wh-bills", "label": "Purchase orders" },
        { "id": "wh-batches", "enabled": false }
      ] }
  ]
}
```

What you can do:

| To… | Do this |
|---|---|
| Rename a tab or sub-tab | Change its `label`. The page heading follows (`title` / `subtitle` override it); for sub-tabs the heading defaults to "Tab · Sub-tab". The new name also shows in HR → Users / Roles. |
| Reorder | Move entries up or down in `tabs` / `children`. |
| Remove | Delete the entry, or set `"enabled": false` (easier to bring back). A removed tab also stops being grantable in HR → Roles. |
| Change an icon | `icon` is a name — `dashboard`, `wrench`, `package`, `users`, `building`, `sliders`, `home`, `calendar`, `chart`, `clipboard`, `link`, `globe`, `map`, `shield`, `mail`, `file`, `info`, `bell`, `truck`, `key`, `user`, `printer`, `barcode` — or raw SVG markup for a 24×24 icon (e.g. `"<circle cx='12' cy='12' r='9'/>"`). |
| Add a tab of your own | A new entry with an unused `id` (lowercase letters, digits, `-`, `_`) and a `type`: `"page"` (`"html"`: a string, or a list of lines), `"iframe"` (`"url"`: embeds that page) or `"link"` (`"url"`: opens it in a new browser tab). Give it `"children"` instead to make it a group of sub-tabs, each with its own `type`. |
| Restrict a custom tab | Add `"permission": "some-key"`. It then appears in HR → Users / Roles to grant like any other tab; without it, everyone sees the tab. |
| Add a sub-tab to Warehouse, HR or Hotel architecture | Add a child with a new `id` and a `type`, as above. |

The built-in tabs and their sub-tab ids — `dashboard`; `assets` (`all`, `good`, `fair`, `broken`);
`warehouse` (`wh-items`, `wh-bills`, `wh-batches`, `wh-orders`); `hr` (`hr-employees`,
`hr-attendance`, `hr-accounts`, `hr-roles`, `hr-policy`); `hotel` (`ha-buildings`, `ha-floors`,
`ha-rooms`); `preferences` (`branding`, `whatsapp`, `email`) — are wired to code, so keep their
`id`s; their permission is fixed too (the server checks it). Leaving a tab's `children` out keeps
all its sub-tabs; listing them makes the list exact. Hiding an Assets filter hides its stat card,
and hiding a Preferences section hides its card. Assets and Preferences can't take custom sub-tabs
(their links filter or scroll rather than open pages). A disabled example `help` tab at the end of
the file shows all three custom types.

Hiding a tab is a navigation change, not a security boundary: its API stays protected only by
the permission it already had. HTML in `"page"` is shown as written, so only trusted people should
be able to edit this file. Mistakes never break the app: an unusable entry is skipped, invalid
JSON keeps the last good version (or the built-in defaults on first start), and the problem is
logged by the server and shown to admins as a message after they sign in.

### How it works (for whoever changes this code next)

Before this, the sidebar, the sub-tab bars and the page headings were hard-coded in three
places: buttons in `scan.html`, `TAB_META`/`PANE_META` in `core.js`, and the list of grantable
permissions, which `demo/app.py` got by parsing the sidebar HTML at startup. All three now come
from `config/ui.json`. **The tabs' content is unchanged**: each built-in tab's `<section id="tab-…">`
and its sub-panes are still written in `scan.html` and filled by their own JS file. The config only
decides which of them can be reached, in what order and under what name.

```
config/ui.json ──► demo/ui_config.py ──► GET /ui-config.json ──► core.js buildNavigation()
                   (check + fill defaults)                        (sidebar, sub-tab bars, headings)
                          │
                          └──► auth_engine.replace_permissions()  (HR → Users / Roles switches)
```

| File | Role |
|---|---|
| `config/ui.json` | The file you edit. Only the values you list matter; anything left out takes the default. |
| `demo/ui_config.py` | Reads the file and turns it into a complete config (`normalize()`). `BUILTIN_TABS` is the list of built-in tabs: each one's permission, default label/icon, sub-tab ids, and how its sub-tabs behave (`pane` = real sub-tab, `filter` = Assets condition filter, `scroll` = Preferences card). `current()` caches the result by the file's modification time. |
| `demo/app.py` | Calls `ui_config.current()` before each request (cheap, since it only re-reads when the file changed) and serves the result at `/ui-config.json`. The old `_SidebarPermissions` HTML parser is gone. |
| `auth_engine/permissions.py` | New `replace_permissions()`: swaps the whole permission list in one step, so a request on another gunicorn thread never sees it half-built while the config reloads. |
| `demo/static/scan.html` | The sidebar `<nav id="sb-nav">` and the `.subtabs` bars are now empty; the sign-in texts have ids so they can be replaced. |
| `demo/static/js/core.js` | `boot()` fetches the config first, then `buildNavigation()` creates the sidebar buttons, sub-tab buttons, `TAB_META`/`PANE_META`, and the sections/panes for custom tabs. Clicks are handled by one listener on the sidebar and one for all `.subtabs`, because the buttons don't exist when the script loads. Tab icons now live in `ICONS`. |
| `demo/static/js/hr.js` | The "Dashboard" label in the permission switches and the roles matrix comes from the config (`tabLabel('dashboard')`). |
| `demo/static/css/app.css` | Styles for `"page"` / `"iframe"` content (`.custom-page`, `.custom-embed`). |

Decisions worth knowing:
- **The server checks the file, not the browser.** Python fills in defaults and drops anything it
  can't use, with a readable warning; the browser just draws what it gets. Warnings go to the server
  log and, after sign-in, to admins only.
- **The config is served at `/ui-config.json`, outside `/api/`, on purpose.** The sign-in screen
  needs it, and every `/api/` request goes through the session checks (stale heartbeat, forced
  password change) that could refuse it.
- **Built-in ids and permissions can't be changed from the file.** Routes check fixed strings
  (`@require_permission('warehouse')`), and the JS looks up panes by id (`switchSubtab('wh', 'wh-bills')`).
  A `"permission"` set on a built-in tab is ignored, with a warning.
- **A hidden tab is hidden, not deleted.** Its section stays in the page (other code still updates
  it, e.g. the dashboard counters after a ticket changes). `switchTab()`/`switchSubtab()` refuse a tab or
  sub-tab that isn't in the config and fall back to the first allowed one, so a notification
  pointing at a hidden tab doesn't break anything.
- **Permissions follow the visible tabs.** On each reload of the file, the permission list is rebuilt
  from the visible tabs, labelled with their names. A role that already had a hidden tab's permission
  keeps it in the database, so showing the tab again restores access.
- **Reserved ids:** `wh` and `ha` are the sub-tab groups of Warehouse and Hotel architecture,
  so a custom tab can't use them (a custom tab's id is also its group name).

To add a new **built-in** tab later (one with real code behind it): write its
`<section id="tab-xyz">` in `scan.html` (with `<div class="subtabs" data-group="…">` and
`.subpane`s if it has sub-tabs), its JS file registering `TAB_LOADERS.xyz`, and an entry in
`BUILTIN_TABS` in `demo/ui_config.py`. Then list it in `config/ui.json`. A tab with only
static content or a link needs none of that: a `"type"` in the JSON is enough.

Tested by running the app headless (puppeteer) against a copy of the database with a modified
config: renamed and reordered tabs, a custom sub-tab inside Warehouse, a hidden tab and a hidden
filter, a custom tab with all three types, the remembered tab after a reload, the collapsed
sidebar, the `tech` user's restricted view, editing the file while the app runs, and invalid JSON.

## Testing each feature, practically

Demo accounts: `admin`/`admin123` (full access), `tech`/`tech123` (no `warehouse` or
`hr-management` permission until you grant it — see the Security section below).

**1. Login / logout**
- Go to http://localhost:4044. You land on a dedicated sign-in screen, not the dashboard.
- Type a wrong password 5 times in a row for the same username, then try the *correct*
  password on the 6th attempt — you should still be locked out for 5 minutes (this is the
  brute-force lockout, and it doesn't reset just because you finally got it right).
- Log in correctly. You land on the dashboard, your username/role/avatar appear
  top-right — click them for **Change password** / **Log out**. Log out drops you straight back to the
  sign-in screen, and reloading the page doesn't silently re-enter you.

**2. Barcode ticket engine (Dashboard tab)**
- "Register a new asset": give it a name, pick its location from the dropdown (every building,
  floor and room from **Hotel architecture**), click **Create asset & mint barcode**
  — a confirmation with a barcode like `AST-000001-xxxxxx` appears and the "Assets tracked"
  stat card increments. Copy that barcode.
- Paste it into the **Scan asset barcode** box and press Enter (this simulates what a USB
  scanner does) — the asset's name/location appears below the box.
- Type a title in "Raise a ticket for this asset" and click **Create ticket** — it appears
  in the Tickets panel as `open`.
- As `admin`, click **Assign** on it, then **Start work**, then **Resolve** — watch the
  colored left-border and badge change at each step, and the stat cards update live.
- Create a *second* ticket against the *same* asset and try to **Assign** it while the first
  one is still open/assigned/in_progress — you should get a confirm dialog ("asset already
  has an active ticket...") rather than it silently succeeding. Confirm through it to see the
  override go through anyway.
- Log in as `tech` instead — the **Assign**/**Reject** buttons aren't offered at all (the UI
  mirrors `ALLOWED_TRANSITIONS`), and the server would 403 them anyway; `tech` can only create
  tickets and advance ones already in `assigned`/`in_progress`.

**2a. Drill-down stat cards + full ticket lifecycle**
- Click any of the four stat cards at the top of the Dashboard — a panel expands underneath
  listing exactly what that number counts (assets, open, in-progress, resolved tickets). Click
  the same card again (or ✕) to collapse it.
- Click an item in that panel (or any row in the Tickets list) to open its detail view:
  - **Asset**: barcode (with copy), ticket counts, average time-to-resolve, its full ticket
    history, and a form to raise a new ticket against it directly.
  - **Ticket**: a lifecycle stepper (Open → Assigned → In progress → Resolved, or where it
    was Rejected) with the time each stage was reached, time-to-assign/start/resolve, and the
    full audit trail — who moved it, when, how long after the previous step, per-step notes,
    overridden warnings, notification outcomes, and comments.
- End-to-end: raise a ticket (title, priority, optional details) → it opens straight into its
  detail view → pick an assignee and click **Assign** (this is the only place a person is
  chosen, so the WhatsApp hook actually has someone to notify) → **Start work** → add a
  comment → **Resolve** with a note. Every step shows up in the History timeline.

**2a. Assigning and referring tickets**
- **Assignment** (admins): every active ticket's detail view has an Assignment panel — assign
  or reassign it to any active user at any stage, with an optional note. A ticket that is
  *assigned* but names nobody is flagged **No assignee** in the lists (and can't be started)
  until someone is picked. An in-progress ticket that changes hands goes back to *Assigned*.
- **Referral** (the assignee): "Can't do this one? **Ask to refer it to someone else**" —
  suggest a person (or let an admin choose) and give a reason. The ticket stays with you
  until an admin decides; you can withdraw the request meanwhile.
- **Decision** (admins): pending requests are listed on the Dashboard (**Referral requests**)
  and flagged **Referral requested** on the ticket. In the ticket: pick who gets it (the
  suggested person is pre-selected, any other name can be chosen), add a comment, then
  **Approve & assign** or **Decline**. Assigning the ticket directly also closes the request.
- **Notifications** (bell + WhatsApp when on), never to the person who acted:
  new assignee ← "New ticket assigned"; previous assignee ← "reassigned"; ticket creator ←
  "now assigned to …"; admins ← referral requested / withdrawn / decided by another admin;
  requester ← approved (with who got it) or declined, plus the admin's comment; assignee and
  creator ← new comments. Every step is also on the ticket's History timeline.

**2b. Assets tab**
- Sidebar → **Assets**: every asset with ID, name, category, condition (good / fair / broken),
  location, its current ticket and a comment. The three cards at the top (Good green, Fair
  orange, Broken red) show counts and filter the table; click again to clear.
- Admins: **+ Asset**, click a row to edit (location is picked from Hotel architecture — the
  same field the Dashboard shows), tick rows and **Delete selected**. Assets with an active
  ticket can't be deleted; finished tickets are deleted with the asset.
- **Maintain** (on broken assets with no active ticket, plus **Maintain selected** under the
  Broken filter) raises a ticket — admins can assign it in the same step. It's the normal
  Dashboard ticket; resolving it there puts the asset back to **Good** and the Assets table
  shows the ticket's status throughout. The Dashboard's asset view shows condition, location
  and comment, with **Edit asset** for admins.

**3. Layout**
- The navigation is a left sidebar. The ☰ button in the header collapses it to icons (the
  choice is remembered per browser); on a phone-width screen it slides in over the page
  instead. Warehouse and HR each split into sub-tabs, and the app remembers which sub-tab
  you were on. Every table row opens a detail view.
- **Back** (← in the header) returns to the previous tab / sub-tab; the phone's back gesture
  and the browser's Back button do the same (with a detail window open, they close it first).
- On a phone, the notification and account menus open full-width under the header.
- Tabs, sub-tabs, their names and order come from `config/ui.json` — rename a tab there,
  reload, and the sidebar, page heading and HR → Roles all show the new name (see
  "Customizing tabs and names" above).

**4. Preferences (admin only)**
- **Branding**: change the company name / upload a logo — the sidebar, sign-in screen and
  printed PDFs pick it up.
- **WhatsApp**: enter the sending number (international format), switch "Send notifications
  over WhatsApp" on and **Save**. A WhatsApp status pill appears in the header (green =
  paired, amber = waiting for a QR scan, red = not paired / service offline). Click it: if the
  service is waiting for pairing it shows the QR code to scan (Linked devices → Link a
  device) and refreshes itself; once connected you can send a test message. Switched off, no
  WhatsApp send is attempted anywhere — in-app notifications keep working.

**5. Notifications (bell icon)**
- Approvals, deliveries, ticket assignment/resolution and recovery requests create in-app
  notifications for the people involved (and every admin, where relevant). The bell shows an
  unread count; clicking a notification opens the thing it's about. New arrivals also pop up
  as a toast.
- Ticket assign/resolve still records its WhatsApp outcome on the ticket's History timeline.
  Nobody is notified about their own action.

**6. Warehouse (needs the `warehouse` permission — `admin` has it by default)**
- **Items**: click a row to edit name/SKU/category/unit/critical level and see its batches
  and bills. Every item has a unique SKU (auto-generated as `SKU-00012` if left blank,
  editable; existing items were given one on upgrade). Quantity isn't editable by hand — it only moves by receiving, issuing or disposing.
- **Low stock**: items under their critical level show a red banner — **New bill for low
  stock** lists them with checkboxes (select one, several or all), a suggested quantity and
  a unit price, and creates one purchase order that waits for admin approval.
- **Bills**: click one for its progress (Requested → Approved → Delivered → In stock). Admin
  clicks **Approve bill**; then **Receive delivery** asks for the delivery date, who accepted
  it, quantity and expiry — that adds the stock, mints a new batch barcode and opens the
  label printer. Admins and the accepter get a notification. **Purchase order PDF** prints
  the whole PO (all lines, deliveries, sign-off boxes). Purchase orders and delivery notes
  carry the uploaded logo top-left and as a faint watermark behind the page (PNG/JPG/WebP
  logos; an SVG logo is skipped in PDFs). Barcode label sheets stay plain.
- **Batches & barcodes**: tick rows (or the header box for all) → **Print barcodes**. The
  print dialog has label-sheet presets (A4 21/65/14-up, Letter 30-up, large), editable page
  margins, label size, gaps, padding, copies, and toggles for name/code/cut guides, with a
  to-scale preview of page 1. **Print** / **Open PDF** generate the real PDF.
- **Work orders**: **+ New work order** → admin opens it, picks **Deliver to employee** and a
  delivery date, **Approve** (the employee and admins are notified). The employee opens the
  notification (or **My deliveries** on their Dashboard) and confirms receipt — only they can:
  - If the items haven't been issued yet, they **scan the barcode on each item** as it's
    handed over ("1 of 2 received"...). Each scan takes one unit out of stock; the last one
    confirms receipt.
  - If the scanner or label fails, "Enter the SKU instead" → typing the item's SKU (printed on
    the labels and the delivery note) confirms all remaining units, taken from the
    soonest-expiring batches. It's refused if there isn't enough usable stock.
  - Warehouse staff can still issue the items first (scan box in the dialog or the tab); the
    employee then scans any one of them, or types the SKU, to confirm.
  A wrong barcode/SKU is rejected; admins are told which method was used. Until they confirm,
  the employee can't see the issued barcodes or open the delivery note in the app, so they
  have to read the code off the goods. **Delivery note PDF** prints the SKU and batches used.
- FEFO warning (older batch available → confirm to override) and the hard block on expired
  batches work as before; admins can **Dispose** an expired batch from the Batches tab.

**7. Hotel architecture (everyone can view; only admins change it)**
- **+ New building**: give it an ID (e.g. `A`) and a name, set the number of floors and rooms
  per floor (**Apply to every floor**), or change any single floor's room count. Floors get IDs
  like `A_2` and rooms like `A_2_204`.
- **Buildings / Floors / Rooms** sub-tabs list everything; click a row to open it. Editing a
  building's floors or rooms and saving adds or removes floors and rooms to match (you're asked
  first if anything would be removed). In a floor you can rename it and edit door numbers.
- **Open whiteboard**: **+ Add shape** (rectangle, rounded, ellipse, triangle, diamond,
  hexagon), drag it, resize it with the handles, type the text inside it, or link it to a
  building on the right (or **+ Create a new building…** from it). A linked shape shows the
  building's name / ID; clicking it opens the building. Buildings not drawn yet have a
  **Place** button.
- **Print design (PDF)** (also on the whiteboard): site plan, buildings summary and every
  building's floors and rooms.

**8. HR (needs the `hr-management` permission — `admin` has it by default)**

HR opens a group in the left panel: **Employees, Attendance, Users, Roles, Policy** (the same
five sub-tabs are also across the top of the page). Assets (All / Good / Fair / Broken),
Warehouse (its four sub-tabs), Hotel architecture (Buildings / Floors / Rooms) and Preferences
(Branding / WhatsApp / Email) open the same kind of group.
- **Employees**: each row shows the employee's photo and a live presence dot — green
  **Online**, orange **Idle** (no mouse/keyboard for 5 minutes, or the tab is in the
  background), red **Offline** (logged out, tab closed, or no login account). It refreshes
  every 20s. Click a row to upload/change their photo, edit their profile and status, clock
  them in/out, see their login, or delete them.
- **Attendance**: pick an employee and a date range; worked hours include a still-open
  session live. From/To are read in your browser's timezone (sessions are stored in UTC).
- **Users** (changes are admin-only): counts (users, online, awaiting first login,
  deactivated), search, filter by role and status.
  - **+ New user** (or **Create account** on an employee): choose the employee, a role
    card, username and recovery email → a temporary password is shown once (and emailed if
    SMTP is set up). Log in as that user: you're forced to choose your own password first.
  - Click a user to change their role, fine-tune their permissions (one switch per
    left-panel tab), change the recovery email, issue a new temporary password, or deactivate it.
  - **Can't access your account?** requests from the sign-in screen appear here (and in the
    admin's bell); **Review & approve** deactivates the old login and issues a new one.
- **Roles** (changes are admin-only): one card per role with its tabs, sign-in state and
  users, plus an access matrix. **New role** → name, colour, tabs, and whether its users can
  sign in. Saving a role re-applies it to everyone who has it. Turning **sign-in** off
  suspends all its users at once (they're signed out on their next request). Built-in roles
  can be edited but not deleted; deleting a custom role moves its users to a role you pick.
- **Policy** (changes are admin-only), with a live preview of what users will see:
  password rules (minimum length, letters + numbers, upper/lower case, symbol, expiry in
  days), lockout (failed attempts and lock length), idle sign-out, a notice shown on the
  sign-in page, whether the demo accounts are shown, and attendance hours/day.

**The sign-in page follows the policy**: it shows the notice and the rules in its footer,
warns how many attempts are left and counts down a lockout, ticks off password rules live
when you set a new password, asks for a new password when the old one has expired, and
refuses sign-in for a role whose sign-in is off. It also has show/hide password, a Caps Lock
warning, **Remember me** (remembers the username in this browser) and click-to-fill demo
accounts. **Forgot password?** emails a reset link (printed in the server console without
SMTP — open it to set a new password).

## Two modules, wired together

`auth_engine` and `ticket_engine` share one SQLAlchemy instance (`shared_db.py`, at the
project root, owned by neither package) rather than importing each other's internals —
`ticket_engine.Ticket.created_by_id`/`assigned_to_id` are real foreign keys to
`auth_engine.User.id`, referenced only by table/class name (never a direct Python import,
which would be circular: `auth_engine.models` needs the shared `db`, and `ticket_engine`
needs `auth_engine.User`). `demo/app.py` is what actually assembles the two — a real host
app's own `db`/`User` would take `shared_db`/`auth_engine.User`'s place the same way.

## Verifying the notifications wiring

`notifications/`'s real WhatsApp client needs an actual phone to scan a QR code, so it can't
be exercised in an automated/headless environment. What *can* and was tested here: the
Flask-side integration (`demo/notifications_client.py` + the post-transition hook) against a
throwaway Flask app implementing the exact same two-field contract the real service uses
(`POST /api/whatsapp/send` → `{success: true}` or a 400 with `{error: ...}`). That confirmed
all three outcomes end to end — sent, rejected by the service, and unreachable — each
correctly written to the ticket's audit trail without the transition itself ever failing.
Point `NOTIFICATIONS_URL` (default `http://localhost:5050`) at a real running `notifications/`
instance to get actual delivery once it's paired.

## Adapting this for a real app

1. Rename tabs, sub-tabs and sign-in texts in `config/ui.json` (no code changes needed), then rename `Asset`/`Ticket` fields to match the domain (e.g. add `room_number`, `equipment_type`).
2. Edit `ALLOWED_TRANSITIONS` in `ticket_engine/models.py` for the real workflow (add stages, change who can do what).
3. Point `shared_db.db` and `auth_engine.User` at the host app's own `db`/user table instead of these standalone ones (see "Two modules, wired together" above).
4. Add domain-specific `PRE_TRANSITION_HOOKS` (validation/warnings) and `POST_TRANSITION_HOOKS` (side effects like notifications) instead of editing route handlers.
5. Give real users real phone numbers (`auth_engine.User.phone`) and get `notifications/` paired with a real WhatsApp account; add `arabic_text.py` from `module_app` too if Arabic report text is needed.
