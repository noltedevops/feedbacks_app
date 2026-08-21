# Architecture

How the field app, the dashboard, the backend and the sync path fit together.
See [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) for status and open items, and
[OPERATIONS.md](OPERATIONS.md) for running it.

## Shape of the system

There is one backend process and one bundle. Both surfaces — field app and dashboard —
are views inside the same React application, chosen by which access flags the account
carries. FastAPI serves the API *and* the built bundle from `static/`, so everything is
same-origin and the frontend calls `/api/...` with an empty base URL.

```
  survey CSVs  ──► ingest_anomalies.py ──►  PostgreSQL 16 + PostGIS
                                                   ▲   │
                                                   │   │
                                        SQLAlchemy │   │ SELECT
                                                   │   ▼
                                            ┌──────────────────┐
                                            │  FastAPI         │
                                            │  server.py       │
                                            │  + static/ mount │
                                            └──────────────────┘
                                                ▲          ▲
                        POST /api/sync          │          │  GET /api/stats
                        GET  /api/points        │          │  GET /api/reports/*
                                                │          │
                                     ┌──────────┴───┐  ┌───┴──────────┐
                                     │  Field app   │  │  Dashboard   │
                                     │  Dexie +     │  │  Recharts    │
                                     │  service     │  │  (online     │
                                     │  worker      │  │   only)      │
                                     └──────────────┘  └──────────────┘
```

The asymmetry is deliberate: the field app is built to survive with no network, the
dashboard is not. Analytics are read straight from the server; the crew's work is not.

## Backend

`server.py` is a single module holding the whole API. `init_db()` runs at import time and
the lifespan hook seeds default users before the first request.

### Data model (`models.py`)

| Table | Purpose |
|---|---|
| `projects` | `project_id` (e.g. `11-24-2736`) + name |
| `anomalies` | One survey target: `geom` (SRID 32632), `easting`/`northing`, `latitude`/`longitude`, `instrument`, `vm_nr`, `layer`, `category`, `evaluated_depth`, `status`, `target_id` |
| `feedback` | One excavation record per anomaly: `tief`, `laenge`, `breite`, `m_cube`, `fundstueck`, `sohle_status`, `bilder_n`, `photos`, `notes`, `investigator`, `teams_tools` (JSON) |
| `users` | `password_hash`, `role`, and the access flags `can_field` / `can_dashboard` / `is_admin` / `must_change_password` |
| `permission_requests` | A user asking for a surface they lack; an admin approves or denies |

`anomalies.target_id` is `{project_id}-{easting:.3f}-{northing:.3f}` and `anomalies.id` is
`uuid5(NAMESPACE_DNS, target_id)`. That rule is what makes re-ingestion safe: the same
target always gets the same id, so existing feedback keeps pointing at it. Every insert
path computes it explicitly — `models.py` also declares a `uuid4` default, but no code
path reaches it.

`feedback.photos` is a JSON-serialised array of base64 data URLs stored in a text column.
That is the current design; moving photos to object storage is a known open item.

### Coordinates

Two representations of the same position have to stay consistent, because the data is
edited from several directions: the ingestion writes UTM, QGIS/ArcGIS may write `geom`,
and dragging a marker in Leaflet writes lat/lon.

On PostgreSQL, `database.py` installs a `BEFORE INSERT OR UPDATE` trigger,
`sync_anomaly_geom_and_coordinates()`, that detects which of the three was changed and
derives the other two via `ST_Transform` between EPSG:32632 and EPSG:4326. Nothing in the
application has to remember to do it.

`database.py` also carries pure-Python `utm32n_to_latlon()` / `latlon_to_utm32n()`
implementations, used where PostGIS is not in the path — notably `POST /api/points/import`
and the SQLite fallback. `test_utm.py` and `scratch/` check them against known points.

### Startup behaviour (`database.py`)

1. `postgresql://` URLs are rewritten to `postgresql+psycopg://` for SQLAlchemy 2.
2. The first connection is retried for `DB_CONNECT_RETRY_SECONDS` (default 30) — a cold
   boot starts the app and the database together, and nothing supervises this process.
3. **Failure is fatal** unless `ALLOW_SQLITE_FALLBACK=1` is set *in the process
   environment*. This is not read from `.env`; see the README gotchas.
4. `init_db()` enables PostGIS, runs `create_all`, then applies additive migrations by
   hand — `create_all` never alters an existing table, so columns added later
   (`feedback.teams_tools`, the four user flags) are added with explicit `ALTER TABLE`
   and backfilled once from `role`.
5. The coordinate trigger is created or replaced, and legacy triggers dropped.

Logged connection URLs are masked with `safe_url()` — the password never reaches
scrollback or CI output.

### Authentication and access

Passwords are PBKDF2-HMAC-SHA256 via `hashlib`, encoded as
`pbkdf2_sha256$<iterations>$<salt>$<hash>` — no external crypto dependency to install on
a field laptop. Tokens are HMAC-signed with `AUTH_SECRET`; unset means a random key per
process, so every restart invalidates every session.

Authorisation is by **surface**, not by role. `role` only decides the landing view and
the sidebar label. The dependencies in `server.py` are:

- `current_user` — valid token required
- `require_surface("field")` / `require_surface("dashboard")` — the matching flag; a 403
  carries the surface name so the UI can offer to request it
- `require_any_surface(...)` — either flag (the CSV export)
- `require_admin` — `is_admin`

`must_change_password` blocks every surface until the user sets their own password.

### Endpoints

| Method | Path | Guard |
|---|---|---|
| POST | `/api/auth/register` | open |
| POST | `/api/auth/login` | open |
| POST | `/api/auth/change-password` | authenticated |
| GET | `/api/auth/me` | authenticated |
| GET | `/api/points` | authenticated (both surfaces) |
| POST | `/api/sync` | field |
| POST | `/api/points/import` | admin |
| GET | `/api/projects` | authenticated |
| GET | `/api/stats` | dashboard |
| GET | `/api/reports/feedback.pdf` | dashboard |
| GET | `/api/reports/feedback.csv` | field or dashboard |
| GET | `/api/reports/bilder/{feedback_id}` | open (link target from the PDF) |
| POST | `/api/permissions/request` | authenticated |
| GET | `/api/permissions/requests` | admin |
| POST | `/api/permissions/requests/{id}/decide` | admin |
| GET | `/api/admin/users` | admin |
| PATCH | `/api/admin/users/{id}/access` | admin |
| POST | `/api/admin/users/{id}/reset-password` | admin |
| POST | `/api/seed` | admin — **wipes** feedback, anomalies and projects, then inserts demo data |

`GET /api/points` is the shared read model: for each anomaly it attaches the most recent
feedback and derives a display status — `false_alarm` when Fundstück is `ohne Fund`,
`uxo` when the notes mention ordnance keywords, `scrap` when Sohle-Status is
`Nicht Frei`, otherwise `clear`. The same rule is implemented client-side in
`getResolvedStatus()` (`frontend/src/db/indexedDb.ts`) so an offline device classifies
its own records identically.

### Reports (`report.py`)

`reportTemplate.pdf` is an Excel export with no form fields, so it cannot be filled in.
`report.py` reproduces its landscape A4 layout instead, with coordinates extracted from
the template — hence the unrounded point values in the source. The crew header reads
`teams_tools` for the whole selected project while the table below honours the date
filter. Each row's *Bild* link points at `/api/reports/bilder/{feedback_id}`, a
standalone gallery page, using the origin the report was requested from so a PDF pulled
over the LAN keeps working. The CSV is written with a BOM so Excel renders umlauts.

## Frontend

`frontend/src/App.tsx` is the shell: landing page, sign-in, sidebar, surface switching,
online/offline state, sync orchestration, admin dialogs and the EN/DE toggle. Components:

| File | Role |
|---|---|
| `components/FieldMap.tsx` | Leaflet map, marker colouring by resolved status, three basemaps, marker drag |
| `components/FeedbackForm.tsx` | The excavation form, including camera capture and the Trupp & Geräte block |
| `components/Dashboard.tsx` | Recharts analytics |
| `components/FilterBar.tsx` | VM-Nr. / instrument / status filtering |
| `components/ImportExport.tsx` | CSV paste or file upload into `/api/points/import` |
| `components/ReportDialog.tsx` | Project and date range for the CSV/PDF exports |
| `db/indexedDb.ts` | Dexie schema, types, and `getResolvedStatus()` |
| `auth.ts` | Token storage, access flags, `authFetch`, offline login policy |
| `i18n.ts` | EN/DE lookup where the English string is the key |

The build writes to `../static` with `emptyOutDir`, and `cssTarget` is pinned so esbuild
does not minify media queries into range syntax that older mobile browsers discard.

## The offline model

Two independent mechanisms. They are often confused; they solve different problems.

### 1. Service worker — the app shell

`frontend/public/sw.js`, cache `uxo-tracker-v2`.

- **Install** precaches `/`, `/index.html`, `/manifest.json`, `/favicon.svg` and the
  Google Fonts stylesheet — each with its own `cache.add()`, not `addAll()`. `addAll()`
  is atomic, so one failed request rejects the whole install and the worker never
  activates, leaving *nothing* cached while `register()` still resolves successfully.
  That is exactly what a stale `/favicon.ico` entry used to do. Individual adds mean an
  unreachable cross-origin font stylesheet costs only that stylesheet.
- **Activate** deletes every cache whose name is not `CACHE_NAME`. Renaming the cache is
  therefore how a bad cache is evicted — bump it whenever the precache list changes.
- **Fetch**: `/api/` always goes to the network, never cached. Everything else is
  stale-while-revalidate — a cached response is served immediately and refreshed in the
  background; a miss goes to the network and is cached if it is a basic 200 (this is what
  captures Vite's hash-named JS/CSS). A failed navigation falls back to `/index.html`.

Map tiles are third-party and not precached: only tiles fetched while online survive.

### 2. Dexie / IndexedDB — the data

`NolteFieldDb`, version 2, three tables:

| Table | Contents |
|---|---|
| `points` | The full target list mirrored locally, with the latest feedback embedded |
| `pendingFeedback` | Submissions not yet accepted by the server |
| `pendingPointUpdates` | Marker positions moved on the map, not yet accepted |

Reads always come from Dexie, never directly from the API — the UI has no online path to
special-case. Saving a feedback record writes to `points` and `pendingFeedback` and
updates immediately; whether the network exists only affects when it leaves the device.

### Sync

`handleSync()` in `App.tsx`, triggered on login, on a save, on the `online` event, and
whenever the pending count is non-zero.

1. Snapshot `pendingFeedback` and `pendingPointUpdates`, keeping their ids.
2. `POST /api/sync` with both arrays.
3. On success, delete **only the snapshotted ids** — a record queued while the request
   was in flight survives for the next cycle, and an accepted record is never re-sent.
4. Replace the local `points` table with the point list the response carries, so the
   device ends the cycle holding the server's view.

Concurrent runs are coalesced through `syncInFlightRef` / `syncQueuedRef`: a save starts a
sync *and* bumps the counter the auto-sync effect watches, so two cycles used to POST the
same row and the loser came back a duplicate-key 400. Background runs are silent —
failure is harmless, the records stay queued.

Server-side, `/api/sync` upserts each record by primary key (dialect-specific
`ON CONFLICT`), skips any feedback whose parent anomaly does not exist rather than
raising a foreign-key error, normalises the incoming ISO-8601 `Z` timestamp to naive UTC
to match `TIMESTAMP WITHOUT TIME ZONE`, marks the anomaly `investigated`, and returns the
refreshed point list.

### Offline sign-in

Nobody can verify a password with no network, so `auth.ts` records every account the
server *has* authenticated on this device (`nolte_known_users`). Offline, only such an
account may sign in, and it is granted the **field app only** — the dashboard and admin
screens are server-backed and could otherwise show data the person is no longer allowed.
That record deliberately outlives sign-out: it describes the device's history, not the
current session.
