# Nolte Geoservices — UXO Target Sync Platform

Offline-first field inspection and analytics for UXO (Kampfmittel) clearance: survey
anomalies go out to the crew, excavation results come back to the office.

## What this is

Geophysical surveys (magnetic and georadar) produce a list of *anomalies* — points in
UTM 32N that might be ordnance. This platform takes that list into a PostgreSQL/PostGIS
database and puts it in front of the people who dig.

- **Field app** — an installable PWA. The crew sees the targets on a Leaflet map,
  opens one, and records what the excavation found: Sohle-Status, Fundstück, actual
  depth, Länge/Breite/m³, photos, notes, and the Trupp & Geräte block. It works with no
  network: targets are cached in IndexedDB and submissions queue locally.
- **Sync** — when a connection returns, queued feedback and moved point coordinates are
  posted to the backend, which upserts them and returns the authoritative point list.
- **Dashboard** — progress, findings breakdown, Sohle split, evaluated-vs-excavated
  depth accuracy, excavated volume; plus CSV export and a PDF report laid out after
  `reportTemplate.pdf`.

Access is per surface, not per role: an account carries `can_field`, `can_dashboard`
and `is_admin` flags, and users can request a surface they lack for an admin to decide.

For project status, live data volumes and the open-items list, see
[docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md).

## Tech stack

| Layer | What is used |
|---|---|
| API | Python 3.13, FastAPI + uvicorn (`server.py`) |
| ORM / models | SQLAlchemy 2 + GeoAlchemy2 (`models.py`, `database.py`) |
| Database | PostgreSQL 16 + PostGIS 3.4 (Docker), SRID 32632 geometry |
| Auth | PBKDF2-HMAC-SHA256 (stdlib `hashlib`), HMAC-signed bearer tokens |
| Reports | reportlab — CSV + landscape A4 PDF (`report.py`) |
| Frontend | React 19, TypeScript, Vite 8 |
| Map | Leaflet / react-leaflet, three basemaps (CartoDB dark, OSM, Esri aerial) |
| Charts | Recharts |
| Offline store | Dexie (IndexedDB) + a hand-written service worker (`frontend/public/sw.js`) |
| Tooling | docker-compose (PostGIS + pgAdmin), pandas for CSV ingestion |

Deeper detail lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/DATA_PIPELINE.md](docs/DATA_PIPELINE.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Prerequisites

- **Python 3.13** with a virtualenv at `.venv`
- **Docker Desktop** — for Postgres/PostGIS and pgAdmin
- **Node.js 22** — only needed to rebuild the frontend. `static/` is committed, so the
  app runs without Node. To get a toolchain:

  ```
  python install_node.py
  ```

  This downloads Node 22.13.0 (win-x64) and unpacks it to `c:\Apps\feedbackapp\node`.
  The path is hardcoded in the script; on another machine, edit `TARGET_DIR` or install
  Node yourself. `node/` is gitignored.

## Setup

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

`requirements.txt` covers the application. **`ingest_anomalies.py` additionally needs
`pandas`**, which is not pinned there — install it separately if you run the ingestion.

### Environment

Copy `.env.example` to `.env` and fill it in. **`.env.example` is the source of truth
for what each variable means** — it carries the explanation next to every key, and this
README deliberately does not restate the values.

```powershell
copy .env.example .env
```

`.env` is gitignored and is read by two different consumers: pydantic-settings (the app)
and docker-compose (the containers). See the gotchas below before you pick passwords.

### Database services

```powershell
docker compose up -d
```

Brings up:

| Service | Container | Address |
|---|---|---|
| PostgreSQL 16 + PostGIS | `feedback_postgres_db` | `127.0.0.1:5432` |
| pgAdmin 4 | `nolte-pgadmin` | http://127.0.0.1:8080 |

Both bind to loopback only — nothing is exposed to the LAN. pgAdmin waits on the
database healthcheck, and both restart unless stopped.

## Running

### Backend

```powershell
.venv\Scripts\python server.py
```

Serves on `0.0.0.0:8000`. On startup it connects to the database (retrying for up to 30
seconds), creates missing tables, enables PostGIS, installs the coordinate-sync trigger,
and seeds the default accounts **only if the users table is empty**.

If `static/` exists it is mounted at `/`, so http://localhost:8000 serves the built
frontend and the API from one origin. That is how the field app is meant to run.

### Frontend

The build output in `static/` is committed, so you only need this when changing the UI.

```powershell
cd frontend
..\node\node-v22.13.0-win-x64\npm.cmd install
..\node\node-v22.13.0-win-x64\npm.cmd run dev     # dev server, proxies /api to :8000
..\node\node-v22.13.0-win-x64\npm.cmd run build   # writes to ../static
```

The dev server binds `host: true`, so a tablet on the same network can reach it for
real-device testing. `vite build` uses `emptyOutDir` — everything in `static/` is
deleted and rewritten, so nothing that is not produced by the build may live there.

## Gotchas

These are the things that have actually cost time here.

### 1. Three unrelated passwords

| Variable | Who consumes it | When it matters |
|---|---|---|
| `POSTGRES_PASSWORD` | docker-compose → Postgres `initdb` | **Only when the `postgres_data` volume is first created.** On an existing volume it is inert. |
| the password inside `DATABASE_URL` | the app (and `ingest_anomalies.py`) | **Every connection.** This is the one that makes logins work. |
| `PGADMIN_DEFAULT_PASSWORD` | docker-compose → pgAdmin | Only when the `pgadmin_data` volume is first created. Change it inside pgAdmin afterwards. |

They are three different things that happen to look alike. Rotating the database
password on a live volume means `ALTER USER postgres WITH PASSWORD '...'` **and**
updating `DATABASE_URL` — `POSTGRES_PASSWORD` alone changes nothing. `config.py` prints a
warning when the first two disagree, because a recreated volume would then initialise
with a password the app does not have.

### 2. `ALLOW_SQLITE_FALLBACK` is read from the process environment, not `.env`

A failed database connection is fatal by design — the app used to fall through to an
empty SQLite file, which looked like a clean start where every login failed. The escape
hatch for deliberate offline work is `ALLOW_SQLITE_FALLBACK=1`, and `database.py` reads
it with `os.getenv`. **Nothing loads `.env` into `os.environ`**, so putting it in `.env`
has no effect at all. Set it in the shell:

```powershell
$env:ALLOW_SQLITE_FALLBACK = "1"
```

The same is true of `DB_CONNECT_RETRY_SECONDS` (default `30`).

### 3. The sample CSVs must stay at the repo root

`Magnetic_data.csv` and `Radar_data.csv` are resolved by `ingest_anomalies.py` as bare
relative paths against the current working directory — as is `.env`. Run the ingestion
**from the repo root**, and do not move or rename the CSVs:

```powershell
.venv\Scripts\python ingest_anomalies.py
```

Note that this script is destructive — it drops and rebuilds `projects`, `anomalies` and
`feedback`. Read [docs/DATA_PIPELINE.md](docs/DATA_PIPELINE.md) before running it.

### 4. `scripts/doctor.py` diagnoses the database and credentials

```powershell
.venv\Scripts\python scripts\doctor.py
```

Read-only; changes nothing; prints no passwords. It checks that `POSTGRES_PASSWORD` and
`DATABASE_URL` agree, which credential Postgres actually accepts, whether the app would
start against Postgres or the SQLite fallback, whether `pg_hba` still uses `trust`, and
whether any pgAdmin account is locked. Exit status is 1 on any failure.

Run it **first** whenever the app will not start, logins fail, accounts look missing, or
pgAdmin refuses you.

### 5. `static/` is committed build output

Frontend changes are only live after `npm run build`, which rewrites `static/`. Keep
asset rebuilds in their own commit — see the existing `chore: rebuild frontend assets`
commits.

## Troubleshooting

**Logins fail, or the accounts are gone.**
Almost always the database connection, not the accounts. Run `scripts/doctor.py`. Likely
causes, in order:

1. The app is running against the **SQLite fallback** — an empty database with no users.
   `doctor.py` reports this explicitly. Unset `ALLOW_SQLITE_FALLBACK` and fix the real
   connection.
2. `DATABASE_URL` carries a password Postgres does not accept (see gotcha 1).
3. `AUTH_SECRET` is unset or changed. Unset means a random key per process, so **every
   restart signs everyone out**; changing it does the same, once.
4. The account genuinely has no access to that surface. Use `manage_access.py list`.

To get back in without the web app:

```powershell
.venv\Scripts\python manage_access.py list
.venv\Scripts\python manage_access.py grant <username> --admin --dashboard
.venv\Scripts\python manage_access.py set-password <username>
```

`set-password` needs an interactive terminal — it will refuse piped input rather than
hang. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

**`SEED_PASSWORD` did nothing.**
Default accounts are seeded only into an *empty* users table. Once any account exists,
`SEED_PASSWORD` is ignored — use `manage_access.py set-password`.

**Offline mode is not working.**
The service worker (`frontend/public/sw.js`, cache `uxo-tracker-v2`) precaches the app
shell on install. It caches each asset individually on purpose: `cache.addAll()` is
atomic, so a single 404 previously failed the whole install and left the app with *no*
offline cache while `register()` still logged success. If offline mode misbehaves:

- Open DevTools → Application → Service Workers. Check the worker is activated and look
  for `Precache skipped:` warnings in the console.
- Bump `CACHE_NAME` when changing the precache list — the activate handler deletes every
  cache that does not match the current name, and that rename is what evicts a bad one.
- `/api/` requests bypass the cache entirely; they are never served stale.
- A hard reload with "Update on reload" checked is the fastest way to get a clean worker.

**The map renders but the tiles are blank offline.**
Basemap tiles come from CartoDB/OSM/Esri and are not precached — only tiles already
fetched while online remain available. Target markers come from IndexedDB and work
regardless.

**Mobile layout looks like the desktop one.**
`vite.config.ts` pins `cssTarget`; without it esbuild minifies media queries into range
syntax that older browsers discard, taking every mobile rule with it. Do not remove that
pin.

## Repository layout

```
server.py               FastAPI app: auth, points, sync, reports, stats, static mount
models.py               SQLAlchemy models: Project, Anomaly, Feedback, User, PermissionRequest
database.py             Engine, retry/fallback, init_db, PostGIS trigger, UTM32N <-> WGS84
config.py               pydantic-settings; warns on password mismatch
report.py               CSV + PDF report generation (reportlab)
ingest_anomalies.py     Survey CSV -> PostGIS ingestion (destructive rebuild)
manage_access.py        CLI: list / grant / revoke / set-password
install_node.py         Downloads and unpacks the Node toolchain
scripts/doctor.py       Read-only database and pgAdmin diagnostics
docker-compose.yml      PostGIS + pgAdmin, loopback-bound
frontend/               React + TypeScript + Vite source
static/                 Committed build output, mounted at / by FastAPI
sql/                    One-off migration SQL for additional projects
docs/                   Architecture, data pipeline, operations, project overview
*.csv                   Sample survey data — must stay at the repo root
```
