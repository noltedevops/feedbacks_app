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
                                            PostgreSQL 16 + PostGIS
                                                   ▲   │
  project schemas ──► etl/ (dbt + runner) ────────►│   │
                                                   │   │
                                        SQLAlchemy │   │ SELECT
                                                   │   ▼
                                            ┌──────────────────┐
                            Mistral API ◄───┤  FastAPI         │
                            (no DB access)  │  server.py       │
                                            │  + static/ mount │
                                            └──────────────────┘
                                                ▲          ▲
                        POST /api/sync          │          │  GET /api/projects
                        GET  /api/points        │          │  GET /api/reports/*
                                                │          │
                                     ┌──────────┴──────────┴──────────┐
                                     │  ONE React bundle              │
                                     │                                │
                                     │  Dexie/IndexedDB + service     │
                                     │  worker                        │
                                     │     │                          │
                                     │     ├──► Field app             │
                                     │     └──► Dashboard (Recharts)  │
                                     └────────────────────────────────┘
```

Both surfaces read from the same local Dexie store. The field app is built to survive
with no network; the dashboard is not, but that is a matter of which *other* calls it
makes (`/api/projects`, `/api/reports/*`) rather than where its numbers come from.

**The dashboard does not read analytics from the server.** Every total, chart and
derived statistic on it is computed in the browser from the Dexie `points` array it is
handed (`App.tsx:1910-1913`, `Dashboard.tsx:141-155`). `GET /api/stats` computes the
same figures server-side but **has no caller** — there is no reference to it anywhere in
`frontend/src/` or in the built bundle. Treat it as dead code until something calls it.

> ⚠ **Before quoting any Dashboard figure:** 61 of the 68 feedback rows it aggregates
> are of unestablished provenance — possibly real results migrated from an earlier
> record, possibly test data. See
> [DATA_PIPELINE.md](DATA_PIPELINE.md#-the-provenance-of-90-of-the-feedback-is-unknown).

## Backend

`server.py` is a single module holding the whole API. `init_db()` runs at import time and
the lifespan hook seeds default users before the first request.

### Data model (`models.py`)

| Table | Purpose |
|---|---|
| `projects` | `project_id` (e.g. `11-24-2736`) + name |
| `anomalies` | One survey target: `geom` (SRID 32632), `easting`/`northing`, `latitude`/`longitude`, `instrument`, `vm_nr`, `layer`, `category`, `evaluated_depth`, `status`, `target_id` |
| `feedback` | One excavation record per anomaly: `tief`, `laenge`, `breite`, `m_cube`, `fundstueck`, `sohle_status`, `bilder_n`, `photos`, `notes`, `investigator`, `teams_tools` (JSON), plus the denormalised `project_id` and `target_id` — see [DATA_PIPELINE.md](DATA_PIPELINE.md#data-flowing-back) |
| `users` | `password_hash`, `role`, and the access flags `can_field` / `can_dashboard` / `is_admin` / `must_change_password` |
| `permission_requests` | A user asking for a surface they lack; an admin approves or denies |

`anomalies.target_id` is `{project_id}-{easting:.3f}-{northing:.3f}` and `anomalies.id` is
`uuid5(NAMESPACE_DNS, target_id)`. That rule is what makes re-ingestion safe: the same
target always gets the same id, so existing feedback keeps pointing at it. Every insert
path computes it explicitly — `models.py` also declares a `uuid4` default, but no code
path reaches it.

A target moved in the field (the draggable marker in the feedback form, synced as
`point_updates`) gets new easting/northing/lat/lon but keeps its `id` and `target_id`.
After a move, `target_id` no longer equals the formula over the stored coordinates. That
is expected, so the id → `target_id` relation is the invariant to test, not
`target_id` → coordinates. No live target has been moved as of 2026-09-23.

The columns the app writes after ingestion (`status`, and the four coordinates via
`point_updates`) are the ones the proposed ETL pipeline must never overwrite. See
[ETL_DESIGN.md](ETL_DESIGN.md#columns-the-app-writes-after-ingestion).

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

`database.py` also carries a pure-Python `latlon_to_utm32n()`, which nothing in the app
calls. Its inverse, `utm32n_to_latlon()`, was removed on 2026-09-25 with its only callers,
`POST /api/points/import` and `POST /api/seed`. `test_utm.py` and `scratch/` check the
conversions against known points.

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
| GET | `/api/projects` | authenticated |
| GET | `/api/stats` | dashboard |
| GET | `/api/reports/feedback.pdf` | dashboard |
| GET | `/api/reports/feedback.csv` | field or dashboard |
| GET | `/api/reports/bilder/{feedback_id}` | **no auth at all** — link target from the PDF (see below) |
| POST | `/api/assistant` | open — the landing page, before sign-in |
| POST | `/api/permissions/request` | authenticated |
| GET | `/api/permissions/requests` | admin |
| POST | `/api/permissions/requests/{id}/decide` | admin |
| GET | `/api/admin/users` | admin |
| PATCH | `/api/admin/users/{id}/access` | admin |
| POST | `/api/admin/users/{id}/reset-password` | admin |

`POST /api/points/import` and `POST /api/seed` were removed on 2026-09-25 together with
`ImportExport.tsx`, the panel that called them. No UI path reached any of the three.
They are in git at `e0aa3a3`.

**`GET /api/reports/bilder/{feedback_id}` has no auth dependency whatsoever**
(`server.py:935-936`). Anyone who can reach the server and has or guesses a feedback id
gets that excavation's full photo gallery. That is deliberate — it is the link target
from the PDF, and requiring a session would break reports opened outside a signed-in
browser — but it is an unauthenticated read of operational site photos and should be
weighed again before the app leaves the LAN.

`CORSMiddleware` is configured `allow_origins=["*"]` with `allow_credentials=True`
(`server.py:52-58`). Auth is a bearer token in a header rather than a cookie, so this is
not the classic credential-leak hole, but it does mean any site a signed-in user visits
can call this API with a script-supplied token. Worth tightening when there is a real
origin to name.

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

### The landing assistant (`assistant.py`)

`POST /api/assistant` backs the "Ask AI Assistant" box on the landing page. It is
registered as its own `APIRouter` and included *before* the static mount
(`server.py:995`), which answers every path that reaches it.

**It touches no user data and no database.** It takes no `db` dependency, imports no
models, and keeps no conversation history. Its only state is an in-process rate limiter
(`assistant.py:132-160`), which is per-process and resets on restart.

**Provider.** Mistral's EU-hosted API, pay-as-you-go, with training switched off in the
organisation's admin panel. The model is pinned to the dated id `ministral-8b-2512`
rather than a `-latest` alias, so it cannot change underneath; when Mistral retires it,
calls fail, the page falls back to its predefined answers, and `assistant.py:44` is the
fix. One POST with the standard library — no SDK. The key is read from
`MISTRAL_API_KEY` **in the process environment and nowhere else**, deliberately not
through `config.py`, which also reads `.env`.

**It is public**, because the landing page is what a visitor sees before signing in, so
it is fenced in on every side: 10 questions per IP per 10 minutes, 300/day across all
visitors, a 500-character cap on the question and 400 tokens on the reply.

**It never shows a visitor an error.** No key, limit reached, Mistral down, slow, or
replying in an unexpected shape all come back as an ordinary 200 with status `limited`
or `unavailable`, and the page falls back to its predefined answers.

Two safety details worth knowing before touching it:

- **Ordnance questions never reach the model.** `_is_ordnance_question` matches first and
  returns a fixed referral sentence (`assistant.py:376-378`), so no prompt change and no
  model quirk can turn it into advice about handling real munitions.
- **Question text is never logged.** A visitor may type anything, personal data included.

### Deployment

There is one deployment: **local**, uvicorn on `:8000`, with Postgres and pgAdmin in
Docker (`docker-compose.yml`). `MISTRAL_API_KEY` is set on that server, and the
assistant has been probed live against it. There is no hosted environment, no HTTPS
and no second instance — so "production" in any comment or commit message means this
machine.

## Frontend

`frontend/src/App.tsx` is the shell: landing page, sign-in, sidebar, surface switching,
online/offline state, sync orchestration, admin dialogs and the EN/DE toggle. Components:

| File | Role |
|---|---|
| `components/FieldMap.tsx` | Leaflet map, marker colouring by resolved status, three basemaps, marker drag |
| `components/FeedbackForm.tsx` | The excavation form, including camera capture and the Trupp & Geräte block |
| `components/Dashboard.tsx` | Recharts analytics |
| `components/FilterBar.tsx` | VM-Nr. / instrument / status filtering |
| `components/ReportDialog.tsx` | Project and date range for the CSV/PDF exports |
| `db/indexedDb.ts` | Dexie schema, types, and `getResolvedStatus()` |
| `auth.ts` | Token storage, access flags, `authFetch`, offline login policy |
| `i18n.ts` | EN/DE lookup where the English string is the key |

The build writes to `../static` with `emptyOutDir`, and `cssTarget` is pinned so esbuild
does not minify media queries into range syntax that older mobile browsers discard.

## The offline model

Two independent mechanisms. They are often confused; they solve different problems.

### 1. Service worker — the app shell

`frontend/public/sw.js`, cache `uxo-tracker-v4`.

- **Install** precaches `/`, `/index.html`, `/manifest.json` and `/favicon.svg` — each
  with its own `cache.add()`, not `addAll()`. `addAll()` is atomic, so one failed request
  rejects the whole install and the worker never activates, leaving *nothing* cached
  while `register()` still resolves successfully. That is exactly what a stale
  `/favicon.ico` entry used to do. Individual adds mean one unreachable URL costs only
  that asset. The typeface is self-hosted in the bundle, so it is cached on first use.
- **Activate** deletes every cache whose name is not `CACHE_NAME`. Renaming the cache is
  therefore how a bad cache is evicted — bump it whenever the precache list changes.
- **Fetch**: `/api/` always goes to the network, never cached. The document (`/`,
  `/index.html`, any navigation) is network-first with the cache as the offline
  fallback: assets are hash-named, so a new build is reachable only through a fresh
  `index.html`, and serving it cache-first pinned devices to the previous build.
  Everything else is stale-while-revalidate — a cached response is served immediately
  and refreshed in the background; a miss goes to the network and is cached if it is a
  basic 200 (this is what captures Vite's hash-named JS/CSS). A failed navigation falls
  back to `/index.html`.

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
refreshed point list. `project_id` is taken from the parent anomaly, never from the
payload (`server.py:809`), so the stored project cannot disagree with the target.

#### The `visit_date` guard

This is the load-bearing line of the whole sync path (`server.py:760-764`):

```python
stmt = insert(table).values(**values).on_conflict_do_update(
    index_elements=[table.c.id],
    set_=updatable,
    where=(table.c.visit_date.is_(None)) | (table.c.visit_date <= values["visit_date"]),
)
```

`DO UPDATE` rather than `DO NOTHING`, because a crew can reopen a target and correct its
measurements — those corrections have to reach the server. The `WHERE` clause is what
keeps that safe in the other direction: **a stale copy that has been sitting in an
offline queue for days can never clobber a newer visit already stored.**

The consequence to remember when reading logs: a skipped update is silent. The request
still returns success and the client still drops the queued record, so
*"Synchronized 5 logs"* means five records were *accepted*, not that five rows changed.
That is intentional — a stale record has nothing to contribute — but it means the count
is not a write count.

Re-editing a target reuses the existing feedback id (`App.tsx:721`), which is what makes
the second submission an update rather than a second row. There is therefore **no
history**: `feedback` holds one row per anomaly, and a correction overwrites the
previous values. `GET /api/points` still orders by `visit_date DESC` and takes the first
(`server.py:656-661`), so it would cope if that ever changed.

One field is accepted and then dropped on the floor: `FeedbackCreate.status`
(`server.py:73`) is never written — it is absent from the values dict at `:862-888`. The
status shown everywhere is re-derived on read by the rule above. The client's `status`
is dead weight on the wire.

### Offline sign-in

Nobody can verify a password with no network, so `auth.ts` records every account the
server *has* authenticated on this device (`nolte_known_users`). Offline, only such an
account may sign in, and it is granted the **field app only** — the dashboard and admin
screens are server-backed and could otherwise show data the person is no longer allowed.
That record deliberately outlives sign-out: it describes the device's history, not the
current session.

## Open questions

Things a reader will notice and that nobody has yet been able to answer. Recorded so the
next person does not spend the same hours on them. See also the open questions in
[DATA_PIPELINE.md](DATA_PIPELINE.md#open-questions), which cover the ingested data.

- **What `*_raw_data` means.** The `p_11_24_2736_…` schema holds `magnetic_data` /
  `magnetic_raw_data` and `radar_data` / `radar_raw_data`. Each pair has identical
  columns and identical row counts (1,522 and 45), no constraints and no comments, and
  no code reads any of them. Checked 2026-09-23, their **content** is identical too,
  row for row. What distinguishes "raw" from the other is unknown and being followed up. **Do not delete or reorganise them on the assumption they are
  duplicates.**
- **Why two anomalies are `investigated` with no feedback row** (`2736-1186`,
  `2736-1040`). The only `DELETE` the backend ever had was `/api/seed` (removed 2026-09-25;
  `server.py` at `e0aa3a3`, lines 1059-1061), which wiped `feedback`, `anomalies` and
  `projects` together and so could not have produced this state. `anomalies.status` is
  never reset by anything, so these two rows will stay out of step until someone
  corrects them.
- **Who has been editing the database by hand, and with what authority.** Three `users`
  rows were deleted through pgAdmin's admin login (`admin@nolte-geoservices.com`) on
  2026-09-15, 06:26–06:43 UTC — established from pgAdmin's own query history. The two
  orphaned anomalies above have the same character: a change with no code path behind
  it. **Who was at the keyboard is not established.** Asked in September 2026, the
  project owner could not confirm it was him, and does not know who else holds that
  login. Until that is answered, treat the admin pgAdmin credential as shared and
  unaccounted for, and assume manual edits can appear in any table without a trace.
  - The `pg_stat_user_tables` counters that evidenced the user deletions have since been
    reset (`stats_reset` is NULL, all counters zero), so that avenue is closed for any
    future question of this kind.
- **Whether the `sql/` migrations were run exactly as committed.** There is no record of
  which migrations have been applied. The assertion gates in
  `append_anomalie_1_to_anomalies.sql` (removed 2026-09-25, last present in `cd69945`)
  passed and the 127 rows are present and correct, but a modified-then-run version would
  be indistinguishable from the committed one.
  A `schema_migrations` ledger is on the backlog.
