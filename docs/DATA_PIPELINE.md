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
verification of this: recomputing the rule for all 1583 existing rows reproduced every
stored id with zero mismatches.

## Source CSVs

Two files at the repo root, both semicolon- or comma-separated exports from the survey
processing:

| File | Instrument | Notable columns |
|---|---|---|
| `Magnetic_data.csv` | `magnetic` | `snippet`, `Nummer`, `Rechtswert`, `Hochwert`, `Tiefe [m]`, `layer` |
| `Radar_data.csv` | `georadar` | the same four plus GPR-specific ones (`Filename`, `Dist.(m)`, `East`/`North`, `Target Pic`, `path`) |

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

It also needs **pandas**, which is not in `requirements.txt`; install it separately.

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

## The other ingestion paths

### `POST /api/points/import` (admin)

Backs the Import/Export panel in the UI: paste or upload CSV, and each row becomes an
anomaly. Non-destructive and additive. It converts UTM to lat/lon in Python
(`utm32n_to_latlon`) rather than relying on the trigger, hardcodes `instrument` to
`georadar` and `project_id` to `11-24-2736`, and numbers `vm_nr` from the existing count.

### `POST /api/seed` (admin)

Demo data only. It deletes all feedback, anomalies and projects first. Not part of any
real workflow — useful for a clean UI walkthrough.

## SQL migrations (`sql/`)

Hand-written, single-purpose SQL for bringing an additional project's data into
`public.anomalies`. They are records of specific migrations that were run, not a
migration framework — there is no versioning or replay mechanism.

| File | What it does |
|---|---|
| `anomalie_1_from_picks.sql` | Builds `p_11_26_5151_koeln_deutzerfeld.anomalie_1` from that schema's `picks` table, shaped exactly like `public.anomalies`. Excludes `field_3` categories 0 and 4, leaving 127 of 5592 rows; transforms from the source SRID to compute lat/lon; assigns `vm_nr` as a gap-free random-order sequence. `id` is left NULL. |
| `append_anomalie_1_to_anomalies.sql` | Appends those 127 rows into `public.projects` + `public.anomalies` in one transaction, with `ON CONFLICT DO NOTHING` so a re-run is a no-op. |

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
the project out of `target_id` would give the same answer today (verified: the prefix
matched the anomaly's project on all 1710 anomalies and all 65 feedback rows), but
`target_id` is free text with no constraint behind it, while the foreign key either
resolves or does not.

`database.py` adds the column and backfills any `NULL` on startup, so a database seeded
before it existed repairs itself. It is nullable until a backfill has been confirmed
clean on every deployment.
