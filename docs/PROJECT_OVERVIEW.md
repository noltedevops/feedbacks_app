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
| Backend API | Python / FastAPI (`server.py`), endpoints: `/api/points`, `/api/sync`, `/api/points/import`, `/api/stats`, `/api/seed` |
| Database | PostgreSQL 16 + PostGIS (Docker), automatic SQLite fallback for offline/local use |
| Frontend | React + TypeScript (Vite), served as a PWA from `static/` |
| Offline store | IndexedDB (Dexie) with a pending-sync queue + service worker |
| Mapping | Leaflet (CartoDB tiles), UTM 32N ↔ WGS84 conversion server-side |
| Tooling | docker-compose (PostGIS + pgAdmin), CSV ingestion script (`ingest_anomalies.py`) |

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
- **Testing** — only ad-hoc UTM conversion scripts exist (`test_utm.py`,
  `scratch/`); no automated test suite or CI yet.
- **Multi-project workflow** — one project loaded today; the project dropdown
  exists but ingestion/management of additional projects should be exercised.
- **`POST /api/points` is hardcoded to project `11-24-2736`** — `server.py`
  fixes the project, the `vm_nr` prefix and the `target_id` prefix to that one
  project, so targets added through it land in Wilhelmshaven whichever project
  the crew meant. Self-consistent, so it does not violate the identity rule, but
  a second project cannot be imported through that endpoint. `ingest_anomalies.py`
  has the same constant. Found while adding `feedback.project_id`; deliberately
  left alone there.

## Screenshots

Current running application (also in this `docs/` folder):

- `shot_dashboard.png` — Clearance Analytics Dashboard with live data
- `shot_fieldapp.png` — Field app: target listing + map (Wilhelmshaven Seedeich)
- `app_main.png` — Landing / sign-in page
