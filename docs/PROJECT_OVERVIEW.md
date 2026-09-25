# Nolte Geoservices — UXO Target Sync Platform

**Project status overview — 20 July 2026**
Prepared for the sync meeting with Uwe.

## What the application does

A field-feedback platform for UXO (Kampfmittel) clearance work. Office staff load
detected anomaly targets (magnetic + georadar) into the system; field investigators
open the app on a tablet/phone, navigate the target map, and log the excavation
result for each point — status (clear / scrap / UXO / false alarm), actual depth,
Sohle status, Fundstück details, dimensions, photos, and notes. Results sync back
to the office database for analytics.

**Current live data:** project *11-24-2736 — Wilhelmshaven Seedeich*,
1,583 targets loaded (1,538 magnetic, 45 georadar), 61 investigated so far (~4%).

## Architecture

| Layer | Technology |
|---|---|
| Backend API | Python / FastAPI (`server.py`), endpoints: `/api/points`, `/api/sync`, `/api/stats` |
| Database | PostgreSQL 16 + PostGIS (Docker), automatic SQLite fallback for offline/local use |
| Frontend | React + TypeScript (Vite), served as a PWA from `static/` |
| Offline store | IndexedDB (Dexie) with a pending-sync queue + service worker |
| Mapping | Leaflet (CartoDB tiles), UTM 32N ↔ WGS84 conversion server-side |
| Tooling | docker-compose (PostGIS + pgAdmin), survey data pipeline (`etl/`, dbt) |

## What is done

- **Backend API** with full point/feedback data model, including the German field
  vocabulary (Sohle-Status, Fundstück, Länge/Breite, m³, Bilder-N).
- **PostgreSQL/PostGIS integration** with PL/pgSQL triggers for bidirectional
  coordinate/geometry sync, plus SQLite fallback when Postgres is unreachable.
- **Stable UUID5 target IDs** so re-ingesting CSV data never breaks references or
  duplicates feedback (commit `b39c85b`).
- **CSV ingestion** of magnetic and radar survey data with UTM→lat/lon conversion.
- **Offline-first field app (PWA)**: targets cached in IndexedDB, feedback queued
  offline and synced when back online; installable with service worker.
- **Field app UI**: searchable/filterable target list (VM-Nr., instrument, status),
  interactive map with investigated/pending markers, feedback form with camera
  snapshot preview.
- **Analytics dashboard**: totals and progress, grouped findings chart, Sohle
  status split, evaluated-vs-excavated depth accuracy (mean error ±0.13 m,
  bias −0.01 m, empty-hole FPR 16%), target dimension profiling, excavated
  volume tracking (42.2 m³), instrument filter, project dropdown.
- **Docker environment** for PostGIS + pgAdmin; repo cleaned up (.gitignore,
  docker-compose committed) and pushed to GitHub (`noltedevops/feedbacks_app`).

## What remains / open items

- **Real authentication** — sign-in is currently client-side only (role derived
  from username in localStorage, no password verification). Needs a proper
  backend auth (users table, hashed passwords, tokens/sessions).
- **Photo storage** — photos travel as base64 strings in the feedback payload;
  should move to proper file/object storage with thumbnails.
- **PostGIS extension error handling** — the extension-enable step in
  `database.py` only logs on failure; wants investigation/hardening so a failed
  PostGIS setup is surfaced clearly instead of silently continuing.
- **Branch cleanup** — `backendtest` is one commit behind `main` with nothing
  unique; fast-forward or delete. It also only exists locally.
- **Deployment** — currently runs locally (uvicorn + Docker). Needs a hosted
  environment, HTTPS, and backup strategy for the Postgres volume.
- **Testing** — the ETL pipeline is tested: `dbt test` on every run, and a full
  acceptance suite (`etl/tests/acceptance.py`) run against a copy of the database. The
  application itself has no automated tests, and there is no CI. `scripts/doctor.py`
  exits 1 on any failure and would be a reasonable first gate.
- **Adding a project by configuration alone is untested** — two projects
  (`11-24-2736` Wilhelmshaven, `11-26-5151` Köln) are loaded through the ETL config
  (`etl/config/projects.yml`). What has not been exercised is bringing in a third one
  purely by configuration, end to end: a new project schema, an entry in
  `projects.yml`, a re-run of `setup-sql` for its grants, then the first run, the
  targets in the app and a feedback round-trip.
- **Restricted logins for editing project schemas** — the QGIS session that built
  the new Wilhelmshaven source tables on 2026-09-23 was connected as `postgres`, the
  superuser. People editing project schemas should use their own restricted logins
  (like `bosco_k` on the Köln schema: write access to that schema only), so an import
  cannot touch `public`, other projects or roles, and each change can be traced to
  a person.
- **`feedback → anomalies` should be `ON DELETE RESTRICT`, not `CASCADE`** — today
  deleting an anomaly silently deletes its excavation record, and a check for orphaned
  feedback still passes because nothing is left to be orphaned. With `RESTRICT` an
  accidental delete fails loudly. The one-time Wilhelmshaven migration deliberately
  removes 798 targets and, by cascade, 52 feedback rows (archived first), so change the constraint
  after that migration, or have it delete those 18 feedback rows explicitly. See
  [ETL_DESIGN.md](ETL_DESIGN.md#foreign-keys-into-publicanomalies-and-the-feedback-split).
- **Feedback for a target that no longer exists is silently lost** — `/api/sync` skips
  it with only a server log warning (`server.py:777-782`), still answers success, and
  the device then drops it from its queue as if it had been sent (`App.tsx`,
  `handleSync`). The server should reject it explicitly (per record, in the response),
  and the device should keep that record queued and warn the user, so no field work can
  disappear without anyone knowing. Became concrete with the 2026-09-24 Wilhelmshaven
  migration, which removed 798 targets.
- **A failed sync tells the crew nothing useful** — the field app shows only a generic
  "Cloud database sync failed" toast (`App.tsx`, `handleSync`) and throws away the
  response body, so the server's reason never reaches the user. That includes the
  2026-09-25 message that says targets come from the ETL pipeline. The app should show
  the reason the server gives, at least for a sync the crew asked for.
- **A device left open and online never refreshes its target list on its own** — the
  list is downloaded only at app start / sign-in, on the Sync button, or when records are
  queued. Removed or new targets reach an idle device only when someone presses Sync.
  It should refresh periodically (and on regaining connectivity), so the list does not
  depend on a person remembering to sync.

- **Show pending ETL approvals to admins in the app** — staged changes to existing
  targets and coordinate-correction pairs wait for the `etl_approver` login, and today
  the only ways to see them are the runner's log and the command-line status view
  (`docker compose --profile etl run --rm etl-approve`). An admin screen, or at least a
  badge with the count, would stop decisions from waiting unnoticed. See
  [ETL_DESIGN.md](ETL_DESIGN.md#how-you-know-something-is-waiting).

## Screenshots

Current running application (also in this `docs/` folder):

- `shot_dashboard.png` — Clearance Analytics Dashboard with live data
- `shot_fieldapp.png` — Field app: target listing + map (Wilhelmshaven Seedeich)
- `app_main.png` — Landing / sign-in page
