# Data pipeline

How survey anomalies get into the database, and the identity rule everything downstream
depends on.

## The identity rule

Two derived values hold this system together, and every insert path computes them the
same way:

```
target_id = f"{project_id}-{easting:.3f}-{northing:.3f}"
id        = uuid5(NAMESPACE_DNS, target_id)
```

Because the id is derived from the position rather than generated randomly, re-ingesting
the same survey produces the same rows, and `feedback.anomaly_id` keeps resolving. This
is what makes the ingestion re-runnable at all.

`models.py` declares `default=uuid4()` on `Anomaly.id`, but no insert path reaches it —
`ingest_anomalies.py`, `POST /api/points/import`, `POST /api/seed` and the SQL migrations
all pass an explicit uuid5. `sql/append_anomalie_1_to_anomalies.sql` documents a
verification of this against the 1,583 rows that existed when it was written.

**Re-verified 2026-09-22 against all 1,710 rows now in `public.anomalies`:**

| Check | Result |
|---|---|
| `uuid5(NAMESPACE_DNS, target_id)` reproduces the stored `id` | 1,710 / 1,710, **0 mismatches** |
| `target_id` equals `{project_id}-{easting:.3f}-{northing:.3f}` | 1,710 / 1,710, **0 mismatches** |
| NULL `target_id` | 0 |
| Distinct `target_id` | 1,710 (all unique) |
| `feedback.project_id` disagreeing with its parent anomaly | 0 of 68 |
| `feedback.target_id` disagreeing with its parent anomaly | 0 of 68 |
| Orphaned feedback (`anomaly_id` with no anomaly) | 0 |

The rule holds perfectly across both projects.

## Source CSVs

Two files at the repo root, both semicolon- or comma-separated exports from the survey
processing:

| File | Instrument | Records | Notable columns |
|---|---|---:|---|
| `Magnetic_data.csv` | `magnetic` | 1,522 | `snippet`, `Nummer`, `Rechtswert`, `Hochwert`, `Tiefe [m]`, `layer` |
| `Radar_data.csv` | `georadar` | 45 | the same four plus GPR-specific ones (`Filename`, `Dist.(m)`, `East`/`North`, `Target Pic`, `path`) |

Both files as committed are in fact comma-separated, despite the `;`-first reading.
`Magnetic_data.csv` has embedded newlines inside its quoted `snippet` field, so a line
count overstates it — 2,431 lines, 1,522 records.

Only `Rechtswert` → `easting`, `Hochwert` → `northing`, `Tiefe [m]` → `evaluated_depth`
and `layer` are carried into the database. Coordinates are UTM 32N (EPSG:32632).

**These files must stay at the repo root.** `ingest_anomalies.py` resolves them as bare
relative paths against the current working directory, and does the same for `.env`. Run
the script from the repo root or it will not find either.

It looks for `georadar.csv` then `Radar_data.csv`, and `magnetic.csv` then
`Magnetic_data.csv` — the unprefixed names take precedence if you drop in a newer export.

## `ingest_anomalies.py`

```powershell
.venv\Scripts\python ingest_anomalies.py
```

> **This script is destructive.** It drops `feedback`, `anomalies` and `projects` with
> `CASCADE` and rebuilds them. Every excavation record already collected is deleted. It
> is a first-load tool, not an incremental import — take a dump first
> (see [OPERATIONS.md](OPERATIONS.md)) if the database holds real work.

> **It would also lose 18 targets that are not in the committed CSV.** See
> [The CSVs no longer reproduce the live data](#the-csvs-no-longer-reproduce-the-live-data)
> below. Do not run this script against the live database until that is resolved.

It also needs **pandas**, which is not in `requirements.txt`; install it separately. As
of 2026-09-22 it is not installed in the repo `.venv` either, so the script cannot run
as the repo currently stands.

What it does, in order:

1. **Load `.env` by hand** into `os.environ` and read `DATABASE_URL`, rewriting the
   driver to `postgresql+psycopg`. (This is the script's own loader — the app itself
   reads `.env` through pydantic-settings and never populates `os.environ`.)
2. **Read both CSVs** with `;` as the separator, falling back to `,` when that yields a
   single column, and strip whitespace from the headers.
3. **Tag and concatenate** — `instrument` is set to `georadar` / `magnetic` before the
   two frames are merged, which is the only thing distinguishing them afterwards.
4. **Rename** `Rechtswert`/`Hochwert`/`Tiefe [m]` to `easting`/`northing`/
   `evaluated_depth` and drop rows missing coordinates.
5. **Correct a known coordinate defect** in the `Stoerkoerper Magnetik Sued 2` layer
   (and anything with `easting < 100000`): easting is missing a leading digit and
   northing has a transposed one, so `+397000` / `−21000` is applied. This is a
   data-specific fix for the Wilhelmshaven export, not a general transform.
6. **Deduplicate by coordinate pair** — `target_id` is derived from the position and is
   `UNIQUE`, so two rows at the same point cannot both exist.
7. **Derive** `project_id` `11-24-2736`, `status` `pending`, `category` `Kat-1`,
   `vm_nr` as `2736-<n>`, then `target_id` and `id` by the rule above.
8. **Build WKT** `POINT(easting northing)` for the geometry column.
9. **Rebuild the schema** — drop the three tables, then call `database.init_db()` so the
   tables, PostGIS extension and the coordinate trigger are recreated exactly as the app
   expects.
10. **Load** — seed the `projects` row, write the frame to `temp_staging_anomalies`,
    `INSERT ... SELECT` into `public.anomalies` with `ST_GeomFromText(wkt_geom, 32632)`,
    drop the staging table. All in one transaction.
11. **Report** the georadar / magnetic / total counts.

Note that the project id and name are hardcoded to `11-24-2736` /
*Wilhemshaven Rüstersieler Seedeich*. Loading a different project means editing the
script or using one of the other two paths below.

## The CSVs no longer reproduce the live data

**Re-running `ingest_anomalies.py` today would silently drop 18 targets**, on top of
destroying every feedback row. This was found on 2026-09-22 and is not yet resolved.

Replaying the script's transformations over the committed CSVs yields **1,565** rows for
project `11-24-2736`. The database holds **1,583**. The gap is entirely in one layer:

| Layer | CSV (after offset + dedup) | Live `anomalies` |
|---|---:|---:|
| Stoerkoerper Magnetik Nord | 478 | 478 |
| Stoerkoerper Magnetik Nord Restflaeche | 351 | 351 |
| Stoerkoerper Magnetik Sued 2 | 429 | 429 |
| **Stoerkoerper Magnetik Sued 1** | **262** | **280** |
| Georadar (all six layers) | 45 | 45 |

### What was ruled out

- **A later edit to the CSV.** `Magnetic_data.csv` has exactly one commit in its whole
  history — `a83177f`, 2026-07-16, the commit that added it. It has never been modified
  since, and the working tree matches. There is no earlier version in git to compare.
- **`POST /api/points/import`.** That endpoint hardcodes `instrument='georadar'` and
  `layer='Stoerkoerper Georadar'` (`server.py:780`, `:790`). All 18 rows are
  `instrument='magnetic'`, `layer='Stoerkoerper Magnetik Sued 1'`. They cannot have come
  through it.
- **Dating the rows directly.** `public.anomalies` has **no** `created_at` or `updated_at`
  column — only `projects` has those. The rows themselves cannot be dated.
- **`nolte_local.db`.** This legacy SQLite file at the repo root holds an older schema
  (a `points` table with `calculated_depth`, 6,123 rows). None of the 18 coordinate
  pairs appear in it.

### What the evidence points to

Two things line up:

1. **The 18 occupy the final contiguous `vm_nr` block**, `2736-1566` through `2736-1583`
   — the last 18 of 1,583. `ingest_anomalies.py:118` assigns `vm_nr` by DataFrame
   position, and the magnetic frame is concatenated last (`:84`), so these were the
   trailing rows of the magnetic CSV at the time the script ran.
2. **Their feedback was written in the same bulk insert as 43 other rows.** All 18 carry
   feedback timestamped `2026-07-15 11:42:02`, within 86 ms of each other, as
   `eric.musonera` — the day *before* the CSV was committed.

The most likely explanation is that the ingest ran against a version of
`Magnetic_data.csv` that had 18 more `Sued 1` rows at the end, and the version committed
on 2026-07-16 is a trimmed one. That version was never committed, so this cannot be
proven — but the rows themselves are well-formed, obey the identity rule exactly, and
carry real-looking evaluated depths. **Treat them as genuine survey targets, not as
injected test data.**

### The feedback timeline

Worth knowing before anyone reads a progress figure, because it changes what "68
excavation records" means:

| When | Rows | What it is |
|---|---:|---|
| 2026-07-15 11:42:02 (188 ms span) | **61** | One bulk insert, all as `eric.musonera`. **Provenance not established** — see the warning below. |
| 2026-08-18 → 2026-09-14 | **7** | Individual submissions through the field app, one at a time, by `collector_nord` and `eric.musonera`. These are ordinary sync traffic and are what they appear to be. |

> ### ⚠ The provenance of 90% of the feedback is unknown
>
> **We do not know whether those 61 rows are real excavation results or test data.**
> Asked directly in September 2026, the person who would know could not say with
> confidence. Both readings fit the evidence:
>
> - *Real results, migrated.* The burst lands the same day as `b39c85b`, the commit that
>   moved anomalies onto uuid5 ids. Rebuilding `anomalies` would have required
>   re-pointing existing feedback, and a migration script would look exactly like this.
> - *Test data, loaded to populate the app.* 61 excavations cannot be logged by hand in
>   188 ms, so nothing about the burst itself argues for real fieldwork, and the app had
>   no crew using it at that point.
>
> No script for it survives in the repo — `scratch/` holds nothing from that date — and
> `public.feedback` has no created/imported column, so there is no record to appeal to.
>
> **What follows from this.** Every figure on the Dashboard — progress, findings by type,
> Sohle split, sensor accuracy, mean error, estimation bias, empty-hole rate, excavated
> volume — is computed over all 68 rows, so **90% of every one of those numbers rests on
> data of unknown provenance.** Do not quote them to a customer, put them in a report, or
> use them to judge sensor performance until this is settled. Only 7 rows are known to be
> real field submissions.
>
> One thing *is* established: the four demo rows `/api/seed` writes (`fb-uuid-161` and
> friends) are **not** present, so whatever wrote the 61, it was not that endpoint.

## The other ingestion paths

### `POST /api/points/import` (admin)

Paste or upload CSV, and each row becomes an anomaly. Non-destructive and additive. It
converts UTM to lat/lon in Python (`utm32n_to_latlon`) rather than relying on the
trigger, and hardcodes `project_id` `11-24-2736`, `instrument` `georadar`, `category`
`Kat-1`, `layer` `Stoerkoerper Georadar`, `status` `pending`, numbering `vm_nr` from the
existing row count for that project (`server.py:760-791`).

It was written to back the Import/Export panel, but **no UI path reaches that panel** —
see the endpoint notes in [ARCHITECTURE.md](ARCHITECTURE.md#endpoints). It is callable
only against the API directly.

Several fields in `PointCreate` are accepted and then silently ignored: `vm_nr` (it is
recomputed), `opening_length`, `opening_width`, `opening_depth`, `opening_volume`,
`find_description`, `image_id` and `remarks` (`server.py:92-103` vs `:778-792`). Only
`easting`, `northing` and `evaluated_depth` survive the call.

### `POST /api/seed` (admin)

Demo data only: it deletes all feedback, anomalies and projects first, then writes 29
hardcoded Wilhelmshaven targets and 4 feedback rows. Not part of any real workflow, and
like the import panel it has **no reachable UI path**. Note the 4 feedback rows it writes
do not set `project_id` (`server.py:1141-1229`) — they rely on the startup backfill in
`database.py:174-178` to fill it in on the next boot.

## The project schemas

Alongside `public`, the database carries one schema per project. **No application code
reads or writes any of these** — there is no reference to a project schema anywhere in
the backend. They are landing zones for imported survey data.

| Schema | Table | Rows | What it is |
|---|---|---:|---|
| `p_11_24_2736_wilhemshaven_r_stersieler_seedeich` | `magnetic_data` | 1,522 | Columns mirror `Magnetic_data.csv` exactly. No geometry, no category |
| | `magnetic_raw_data` | 1,522 | **Identical content** to `magnetic_data`, row for row |
| | `radar_data` | 45 | Mirrors `Radar_data.csv` (14 columns) |
| | `radar_raw_data` | 45 | **Identical content** to `radar_data`, row for row |
| | `Magnetic` | 741 | **New 2026-09-23** (QGIS import). `Nord` + `Sued 1` with `geom` (25832) and `category` (all `Kat-1`) |
| | `Stoerkoerper Magnetik Nord` | 479 | **New 2026-09-23.** POINT 25832 |
| | `Stoerkoerper Magnetik Sued 1` | 262 | **New 2026-09-23.** POINTZ 25832 |
| | `Georadar` | 1,476 | **New 2026-09-23.** Six radar layers; easting column is spelled `Rechswert`; `category` is null for 988 rows, which carry it in `Target Pic` instead |
| `p_11_26_5151_koeln_deutzerfeld` | `picks` | 5,592 | PK `id`, `geom` POINT **SRID 25832**, `field_1..field_6` |
| | `anomalie_1` | 127 | Staging table shaped like `public.anomalies`; no constraints, no `geom` |

Every source geometry in both schemas is SRID 25832 (ETRS89 / UTM 32N);
`public.anomalies` stores 32632. For these two projects the difference in derived lat/lon
is below 0.1 mm. The full inventory, with column types and null rates, is in
[ETL_DESIGN.md](ETL_DESIGN.md#project-schemas).

Two things to know:

- **The `11-24-2736` tables are not the source of `public.anomalies`.**
  `ingest_anomalies.py` reads the CSV files from disk, not these tables. They hold 1,522
  magnetic rows where `public.anomalies` holds 1,538 — the same discrepancy discussed
  above, plus the rows dropped by dedup and the missing-coordinate filter.
- **The `*_raw_data` pairs are unexplained**, and do not differ in content at all:
  `EXCEPT ALL` in both directions is empty and an md5 over every row matches (checked
  2026-09-23). See [Open questions](#open-questions).
- **Replaying the old script's logic over `magnetic_data` + `radar_data` reproduces
  1,565 of the 1,583 live rows exactly.** The misses are exactly the 18 DB-only rows. The
  new QGIS tables cover only two of the four magnetic layers and add 1,430 radar picks.
  See [ETL_DESIGN.md](ETL_DESIGN.md#wilhelmshaven-against-the-1583-live-rows).

The `11-26-5151` tables *are* on a live path, but only through the hand-run `sql/`
scripts below.

The `tiger` (35 tables) and `topology` (2 tables) schemas are artefacts of the
`postgis_tiger_geocoder` and `postgis_topology` extensions. Nothing here touches them.

## SQL migrations (`sql/`)

Hand-written, single-purpose SQL for bringing an additional project's data into
`public.anomalies`. They are records of specific migrations that were run, not a
migration framework — there is no versioning or replay mechanism, and **no record in the
database of which of them have been applied.** A `schema_migrations` ledger, so the
database can be verified against the committed SQL, is on the backlog.

| File | What it does |
|---|---|
| `anomalie_1_from_picks.sql` | Builds `p_11_26_5151_koeln_deutzerfeld.anomalie_1` from that schema's `picks` table, shaped exactly like `public.anomalies`. Excludes `field_3` categories 0 and 4, leaving 127 of 5592 rows; transforms from the source SRID to compute lat/lon; assigns `vm_nr` as a gap-free random-order sequence. `id` is left NULL. |
| `append_anomalie_1_to_anomalies.sql` | Appends those 127 rows into `public.projects` + `public.anomalies` in one transaction, with `ON CONFLICT DO NOTHING` so a re-run is a no-op. |

**What ran is not exactly what is committed.** Live `vm_nr` for `11-26-5151` spans
`5151-1` to `5151-128` over 127 rows, with `5151-5` missing. The committed
`ROW_NUMBER()` over the 127 filtered rows cannot produce a gap. Every other column
reproduces exactly from `picks`.

These scripts are to be replaced by the pipeline proposed in
[ETL_DESIGN.md](ETL_DESIGN.md), which also explains what breaks in them when a new row
appears.

The second file is worth reading before writing any similar migration — its header
documents the constraints it checked, the collision pre-flight it ran, and two things
that are easy to get wrong:

- **Postgres cannot compute UUIDv5 here.** It needs SHA-1, which core Postgres lacks, and
  neither `pgcrypto` nor `uuid-ossp` is installed. The 127 ids are precomputed in Python
  and carried in an `id_map` CTE rather than installing an extension on production.
- **The trigger overwrites the lat/lon you supply.** Inserting with `geom` NULL and
  easting/northing present fires the trigger's Case 2, which re-derives lat/lon from
  SRID 32632 — diverging from `anomalie_1`'s 25832-derived values by at most 0.0069 m.
  That is intentional: it makes new rows consistent with how every existing row got its
  coordinates.

## Data flowing back

Excavation results take the opposite path: the field app queues them in IndexedDB and
`POST /api/sync` upserts them into `feedback`, marking the parent anomaly
`investigated`. See [ARCHITECTURE.md](ARCHITECTURE.md#sync). From there they leave again
as CSV or PDF via `/api/reports/*`.

`feedback.target_id` is a denormalised copy — nothing joins on it. The foreign key is
`feedback.anomaly_id → anomalies.id`, which is why the uuid5 rule is what keeps records
linkable across a re-ingestion.

`feedback.project_id` is denormalised too, so feedback can be filtered and reported on
by project without joining `anomalies` every time. It is written from the parent
anomaly's `project_id` during sync, never from the payload — the field app has no
project input, it only displays the one it read off the target. Deriving it by parsing
the project out of `target_id` would give the same answer today (re-verified 2026-09-22:
the prefix matched the anomaly's project on all 1,710 anomalies and all 68 feedback
rows), but `target_id` is free text with no constraint behind it, while the foreign key
either resolves or does not.

`database.py` adds the column and backfills any `NULL` on startup, so a database seeded
before it existed repairs itself. It is nullable until a backfill has been confirmed
clean on every deployment.

## Current contents

Live counts as of 2026-09-22, for orientation. These drift; re-read them rather than
trusting the numbers.

| Table | Rows |
|---|---:|
| `public.projects` | 2 — `11-24-2736` Wilhemshaven Rüstersieler Seedeich, `11-26-5151` Koeln Deutzerfeld |
| `public.anomalies` | 1,710 — 1,640 pending / 70 investigated |
| `public.feedback` | 68 — but only **7** are known to be real field submissions; the other 61 are of [unestablished provenance](#-the-provenance-of-90-of-the-feedback-is-unknown) |
| `public.users` | 3 |
| `public.permission_requests` | 5 — 4 approved, 1 denied, 0 pending |

Anomalies by project and instrument:

| Project | Instrument | Category | Pending | Investigated |
|---|---|---|---:|---:|
| 11-24-2736 | georadar | Kat-1 | 45 | 0 |
| 11-24-2736 | magnetic | Kat-1 | 1,474 | 64 |
| 11-26-5151 | georadar | Kat-2 | 62 | 5 |
| 11-26-5151 | georadar | Kat-3 | 59 | 1 |

`category` is the survey's classification, known before anyone digs. `Kat-1` is a
hardcoded default in every CSV, import and seed path; the real values (`Kat-2`, `Kat-3`)
come only from the `sql/` migration, which derives them from `picks.field_3`. It is
**not** the Fundstück — that is what was found on excavation, and lives on the feedback
row.

Photos are small so far: 6 feedback rows carry any, 139 kB in total, largest row 35 kB.
The base64-in-a-text-column design has not yet cost anything, which is worth knowing
before prioritising the move to object storage.

## Open questions

Unresolved as of 2026-09-22. See also the open questions in
[ARCHITECTURE.md](ARCHITECTURE.md#open-questions).

- **Which version of `Magnetic_data.csv` was actually ingested.** 18 live targets are
  not in the committed file; the evidence says they were the trailing rows of an earlier
  version that was never committed, but this cannot be proven. Until it is settled,
  `ingest_anomalies.py` must not be run against the live database. The cleanest fix is
  probably to export the 1,583 live rows back out to a CSV that *does* reproduce them.
- **What `*_raw_data` means**, and whether either table of each pair can be retired.
  Being followed up. Nothing should be deleted or reorganised in the meantime. As of
  2026-09-23 each pair is identical in content, not only in shape.
- **Who is importing into the Wilhelmshaven schema, and which tables are meant to be the
  source.** Four tables appeared on 2026-09-23 through a QGIS session connected as
  `postgres`. See [ETL_DESIGN.md](ETL_DESIGN.md#decisions-needed), decision D1.
- **Whether the `sql/` migrations were run exactly as committed.** No ledger exists;
  see the note above.
- **Whether the 61 bulk-inserted feedback rows are real excavation results or test data**,
  and what wrote them. This is the most consequential unknown in the project: it decides
  whether the Dashboard's numbers mean anything. Asked directly in September 2026, the
  person who would know could not say with confidence, and no script, log or timestamp
  column survives to settle it. See
  [the warning above](#-the-provenance-of-90-of-the-feedback-is-unknown). Worth one more
  attempt via the 2026-07-15 shell history or an earlier database dump, if either exists.
- **Why `2736-1186` and `2736-1040` are `investigated` with no feedback row.** No code
  path can produce this; see ARCHITECTURE's open questions.
