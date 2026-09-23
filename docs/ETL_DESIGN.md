# ETL design: project schemas → `public.anomalies`

Status: **proposal, awaiting approval** (Phase 1, 2026-09-23). Nothing described under
*Design* exists yet. The audit was read-only: every query ran in a
`default_transaction_read_only` session, and nothing in the database was changed.

Goal: the database is the single source of truth. A dbt pipeline on a schedule reads
each project schema, builds that project's `anomalie_1`, and merges it into
`public.anomalies` when source data changes. There are no CSVs, no hand-run SQL and no
hand-written `id_map`. Adding a project means adding configuration, not SQL.

- [Decisions needed](#decisions-needed)
- [Audit](#audit)
- [Design](#design)
- [Scheduler](#scheduler)
- [Phase 2 plan](#phase-2-plan)

---

## Decisions needed

The design below works with any of these answers; each one changes configuration or
grants, not the model.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | **Wilhelmshaven source tables** | **A** `magnetic_data` + `radar_data` (the CSV mirrors). **B** today's QGIS tables `Magnetic` + `Georadar`. **C** a mix per layer. See [the comparison](#wilhelmshaven-against-the-1583-live-rows). | None. Yours to decide, as agreed. |
| D2 | How to compute uuid5 inside Postgres | `CREATE EXTENSION pgcrypto` once (as `postgres`) vs. a Python step in the runner that writes ids to a table | pgcrypto, see [Identity](#identity) |
| D3 | Changes to existing values | Staged for approval, applied on the next run once approved, vs. reported and applied in the same run | Staged for approval |
| D4 | Where `anomalie_1` lives | In each project schema (the pipeline role needs `CREATE` there) vs. in the `etl` schema | Project schema, see [Role](#role-and-privileges) |
| D5 | Scheduler | Airflow vs. one small runner container | Runner container, see [Scheduler](#scheduler) |
| D6 | The 18 DB-only rows (and any future row no source produces) | Reported on every run vs. listed once in an acknowledged-orphans table and then reported only if their state changes | Acknowledged list |
| D7 | Sued 2 coordinate defect (only if D1 = A) | A correction rule in configuration vs. fixing the 429 rows in the source table | Your call. Fixing at source also fixes what QGIS users see. |

Two things came up that are not decisions for the pipeline, but you should know them:

- **Someone is building Wilhelmshaven tables right now.** Four tables in
  `p_11_24_2736_…` did not exist during the 2026-09-22 audit. They were created today
  between 06:36 and 10:21 UTC by the `postgres` role, and a `QGIS3 desktop` session is
  connected as `postgres` and querying that schema. If that is not you, it is the same
  unaccounted-for superuser access noted in ARCHITECTURE's open questions.
- **What actually ran for Köln differs from the committed SQL.** `vm_nr` for
  `11-26-5151` runs `1..128` over 127 rows. `5151-5` is missing. The committed
  `ROW_NUMBER()` over the filtered 127 rows cannot leave a gap. This is concrete evidence
  for backlog #8 (no migration ledger).

---

## Audit

### Köln: how `anomalie_1` is built from `picks`

Source `sql/anomalie_1_from_picks.sql`. Values marked **[P]** are specific to Köln and
must become parameters.

| Step | What it does | Köln value |
|---|---|---|
| 1 | Source table | **[P]** `p_11_26_5151_koeln_deutzerfeld.picks` (5,592 rows) |
| 2 | Filter | **[P]** `field_3 NOT IN (0, 4)` → 127 rows. Kat-4 is the bulk (5,464), Kat-0 a single sentinel row |
| 3 | `project_id` | **[P]** literal `'11-26-5151'` |
| 4 | `instrument` | **[P]** literal `'georadar'` |
| 5 | `easting` / `northing` | **[P]** `field_1` / `field_2`, **[P]** rounded to **2** decimals |
| 6 | `latitude` / `longitude` | `ST_Transform(ST_SetSRID(ST_MakePoint(e, n), ST_SRID(geom)), 4326)` on the **unrounded** source values. SRID comes from the row's `geom` (25832). *Overwritten by the trigger on insert, see below.* |
| 7 | `vm_nr` | **[P]** `split_part(project_id, '-', 3) \|\| '-' \|\| ROW_NUMBER() OVER (ORDER BY random())` gives `5151-1..N` in random order |
| 8 | `category` | **[P]** `'Kat-' \|\| field_3` |
| 9 | `layer` | **[P]** `NULL` (Köln has no layer column) |
| 10 | `status` | `'pending'` |
| 11 | `target_id` | `project_id \|\| '-' \|\| ROUND(e_2dp, 2)::text \|\| '-' \|\| ROUND(n_2dp, 2)::text`, 2-decimal text. **The append re-renders it at 3 decimals**, which is what is stored. |
| 12 | `evaluated_depth` | **[P]** `field_5`, rounded to 2 decimals |
| 13 | `id` | `NULL`, assigned later by the append |

Reproduction check, done now from `picks` with those parameters: **127 / 127** rows
match live `public.anomalies` on `target_id`, with **0** differences in easting,
northing, category, depth or instrument. `anomalie_1.vm_nr` equals live `vm_nr` for
all 127.

`picks.field_4` (1,918 distinct values) and `field_6` (48 file names such as
`LA010003.02T`) are not used. Their meaning is not documented.

### Köln: the append and `id_map`

Source `sql/append_anomalie_1_to_anomalies.sql`. In one transaction:

1. Inserts the `projects` row `('11-26-5151', 'Koeln Deutzerfeld')` with `ON CONFLICT DO NOTHING`.
2. Inserts the anomalies by joining `anomalie_1` to **`id_map`**, a `VALUES` list of 127
   hand-computed `(target_id, uuid5)` pairs. Postgres has no SHA-1 without `pgcrypto`,
   which is not installed, so the ids were computed in Python and pasted in. `geom`,
   `latitude` and `longitude` are left for the trigger to derive.
3. Runs four gates (project row exists, appended = source count, `target_id` matches
   coordinates, no orphaned feedback) and raises to roll back on failure.

**What breaks today when a new row appears in `anomalie_1`:**

- **It is silently dropped.** The insert is an inner `JOIN id_map`, so a row without a
  hand-written entry never reaches `public.anomalies`.
- **Then gate 2 fails the whole run** (appended ≠ source count), so nothing new can be
  appended until someone hand-computes the uuid5 and edits the file.
- **Rebuilding `anomalie_1` renumbers every VM**, because `ORDER BY random()` runs
  again. Existing rows are protected only because `ON CONFLICT (id) DO NOTHING` ignores
  the new numbers. A new row gets a number from the reshuffled sequence, and that
  number can equal one already in use (`vm_nr` has no unique index).
- **Changes to existing rows never propagate.** `DO NOTHING` also ignores a corrected
  category or depth.
- **Removed picks are never noticed.**

### Project schemas

Row counts, types and null rates as of 2026-09-23. `*` = column name exactly as stored,
including spaces and brackets.

**`p_11_26_5151_koeln_deutzerfeld`** (writable by `bosco_k`)

| Table | Rows | Columns (type, null %) |
|---|---:|---|
| `picks` | 5,592 | `id` int4 PK, `geom` POINT 25832 (2D), `field_1` float8 0%, `field_2` float8 0%, `field_3` int4 0% (values 0/2/3/4), `field_4` float8 0%, `field_5` float8 0%, `field_6` varchar 0% |
| `anomalie_1` | 127 | shaped like `public.anomalies` minus `geom`. `id` and `layer` 100% null, everything else 0% |

**`p_11_24_2736_wilhemshaven_r_stersieler_seedeich`** (writable only by `postgres`)

| Table | Rows | Created | Columns (type, null %) |
|---|---:|---|---|
| `magnetic_data` | 1,522 | before 2026-07 | `snippet` text 40.3%, `Nummer` float8 0.1%, `Rechtswert` float8 0.1%, `Hochwert` float8 0.1%, `Tiefe [m]` float8 0.1%, `layer` text 0%. **No geometry, no category.** |
| `magnetic_raw_data` | 1,522 | before 2026-07 | identical to `magnetic_data` |
| `radar_data` | 45 | before 2026-07 | `Filename`, `Dist.(m)`, `East(°)`, `North(°)`, `Target Pic`, `Target P_1`, `Name` (100% null), `Target P_2` (97.8% null), `layer`, `path`, `Nummer`, `Rechtswert`, `Hochwert`, `Tiefe [m]`. All 0% null unless noted. **No geometry, no category.** |
| `radar_raw_data` | 45 | before 2026-07 | identical to `radar_data` |
| `Magnetic` | 741 | **today** | `geom` (column SRID 0, rows 25832, 479 2D + 262 3D), `Nummer` int8, `Rechtswert` numeric, `Hochwert` numeric, `Tiefe [m]` numeric 0.1%, `layer` text, `category` varchar 0% (all `Kat-1`) |
| `Stoerkoerper Magnetik Nord` | 479 | **today** | `geom` POINT 25832, `Nummer`, `Rechtswert`, `Hochwert`, `Tiefe [m]` 0.2%, `layer` |
| `Stoerkoerper Magnetik Sued 1` | 262 | **today** | as Nord, but POINT**Z** 25832. Z runs −0.343 to −0.339 and is not the depth. |
| `Georadar` | 1,476 | **today** | `geom` POINT 25832, `Dist.(m)` 2.0%, `East`, `North`, `Target Pic`, `Tiefe [m]`, `category` **66.9% null**, **`Rechswert`** (sic, not `Rechtswert`), `Hochwert`, `layer` |

The four new tables show dropped columns (`attisdropped`), which is what QGIS's DB
Manager leaves behind when columns are removed after import. `Magnetic` is exactly
`Nord` + `Sued 1`.

**The `*_raw_data` pairs do not differ in content at all.** `EXCEPT ALL` in both
directions returns 0 rows for each pair, and an md5 over every row, sorted, is identical
(`3ef9c2de…` magnetic, `c0dc59d1…` radar). This includes the nulls, the float values and
the multi-line `snippet` text. What "raw" was meant to distinguish is still unknown.
Nothing here chooses between them.

**Your expected Wilhelmshaven columns:**

| Expected | `magnetic_data` / `radar_data` | `Magnetic` | `Georadar` |
|---|---|---|---|
| Rechtswert (easting) | `Rechtswert` float8 | `Rechtswert` numeric | **`Rechswert`** numeric (typo) |
| Hochwert (northing) | `Hochwert` float8 | `Hochwert` numeric | `Hochwert` numeric |
| Tiefe[m] (depth) | `Tiefe [m]` (with a space) | `Tiefe [m]` | `Tiefe [m]` |
| category | **absent** | `category` (all `Kat-1`) | `category` for the 488 Rebar rows; for the other 988 it is **only in `Target Pic`**, as `Kat. 1` / `Kat. 2` / `Kat. 3` |
| layer | `layer` | `layer` | `layer` |

**Coordinate defect.** All 429 `Stoerkoerper Magnetik Sued 2` rows in `magnetic_data`
have easting ≈ 46,5xx (a missing leading digit) and a shifted northing.
`ingest_anomalies.py` repaired this with a hardcoded `+397000` / `−21000`. One
`Nord Restflaeche` row has null coordinates and `Nummer`.

### SRID / UTM zone per project

| Where | SRID |
|---|---|
| `picks.geom` (Köln) | 25832 (ETRS89 / UTM 32N), every row |
| Wilhelmshaven new tables' `geom` | 25832, every row |
| Wilhelmshaven `*_data` tables | no geometry. Coordinate range 442,9xx–443,9xx E / 5,935,0xx–5,937,1xx N, which is UTM zone 32 |
| `public.anomalies.geom` | **32632** (WGS84 / UTM 32N), column-typed and hardcoded in the trigger |

Both projects are zone 32 on the ETRS89 datum. `public.anomalies` stores the same
numbers labelled WGS84. PostGIS treats the two as the same frame here: lat/lon from 25832
vs 32632 differ by at most 1.1 × 10⁻⁹ degrees (≈ 0.1 mm) over all 1,710 rows. So "each
project's own SRID" costs nothing and changes nothing today. It will matter for a
project in another zone, and there the trigger's hardcoded 32632 would be **wrong**.
See [Trigger](#the-spatial-trigger-under-a-merge).

### How source rows arrive

- **Köln:** `bosco_k` (the only non-superuser role) has `SELECT, INSERT, UPDATE, DELETE,
  TRUNCATE` on `picks`, plus default privileges on any new table in that schema. Rows can
  be added, edited, removed or truncated at any time.
- **Wilhelmshaven:** only `postgres` can write. The new tables came in through QGIS
  (`application_name = 'QGIS3 desktop'`, connected as `postgres`), which imports by
  **creating a table**, and re-importing typically drops and recreates it.
- Consequences for the pipeline: sources can gain, lose or change rows; a table can
  disappear and come back mid-run; a column can be renamed. There are no timestamps on
  any source table.

### The spatial trigger under a merge

`trigger_sync_anomaly_geom_coordinates`, `BEFORE INSERT OR UPDATE` on
`public.anomalies`, runs `sync_anomaly_geom_and_coordinates()`. **The app recreates it on
every startup** (`database.py:233-275`), so the pipeline must never define it.

| Pipeline action | Case that fires | Effect |
|---|---|---|
| `INSERT` with `geom` NULL, easting/northing set | Case 2 | `geom := (e, n)` as SRID 32632; lat/lon derived from that. **Any lat/lon the pipeline supplies is overwritten.** |
| `INSERT` with `geom` set | Case 1 | easting/northing **overwritten from `geom`**. The pipeline must never supply `geom`: a 25832 value would also violate the column's 32632 type. |
| `UPDATE` of category/layer/depth only | none | No-op. Nothing coordinate-related changes. |
| `UPDATE` of easting/northing | Case 2 | Re-derives `geom` and lat/lon. The pipeline never does this, see [Merge](#merge-semantics). |

Three legacy trigger functions (`sync_point_geom_and_coordinates`, `sync_feedback_geom`,
`update_associated_feedback_geom`) exist but are attached to nothing.

### Foreign keys into `public.anomalies` and the feedback split

| FK | ON DELETE |
|---|---|
| `feedback.anomaly_id → anomalies.id` | **CASCADE**: deleting an anomaly deletes its feedback |
| `anomalies.project_id → projects.project_id` | **CASCADE** |
| `feedback.project_id → projects.project_id` | **CASCADE**: deleting a `projects` row deletes that project's targets *and* feedback |

| Project | Feedback | Of which 2026-07-15 bulk | Investigated anomalies | Investigated with no feedback |
|---|---:|---:|---:|---:|
| 11-24-2736 Wilhelmshaven | 62 | 61 | 64 | 2 (`2736-1186`, `2736-1040`) |
| 11-26-5151 Köln | 6 | 0 | 6 | 0 |

All 18 DB-only Sued 1 rows (`2736-1566..1583`) are `investigated` and each has feedback.

### Indexes

| Table | Indexes |
|---|---|
| `public.anomalies` | PK `id`; **UNIQUE** `ix_anomalies_target_id`; `ix_anomalies_vm_nr` (btree, **not unique**); `idx_anomalies_geom` (**GIST**) |
| `public.feedback` | PK `id`; `ix_feedback_target_id`; `ix_feedback_project_id`. **No index on `anomaly_id`**, the FK column. |
| `public.projects` | PK `project_id` |
| `picks` | PK `id` only. No spatial index. |
| All eight Wilhelmshaven tables | **none** |

The GIST index is created by SQLAlchemy/GeoAlchemy in `create_all`, so the app owns it.

### Columns the app writes after ingestion

| Column(s) | Written by | When |
|---|---|---|
| `status` | `POST /api/sync` (`server.py:858`) | set to `investigated` when feedback syncs. Nothing ever sets it back. |
| `easting`, `northing`, `latitude`, `longitude` (+ `geom` via the trigger) | `POST /api/sync` `point_updates` (`server.py:895-902`) | when a crew drags the target's marker in the feedback form (`FieldMap.tsx:670`, `App.tsx:731-739`). **`target_id` and `id` are not changed**, so a moved target no longer satisfies `target_id = f(easting, northing)`. No live row has been moved yet: the rule holds for 1,710 / 1,710. |
| all columns (insert) | `POST /api/points/import` | admin, no UI path |
| **everything (delete)** | `POST /api/seed` | admin, no UI path. Deletes all feedback, anomalies and projects. Least privilege on the pipeline does not protect against this endpoint. |

### Wilhelmshaven against the 1,583 live rows

`target_id` = `11-24-2736-{round(e,3)}-{round(n,3)}` computed from each candidate, then
joined to live `public.anomalies`:

| | **A** `magnetic_data` + `radar_data` (Sued 2 repaired) | **B** `Magnetic` + `Georadar` |
|---|---:|---:|
| Source rows / distinct `target_id` | 1,566 / 1,565 | 2,217 / 2,215 |
| **Match live** | **1,565 (98.9%)** | **785 (49.6%)** |
| New (not in live) | **0** | **1,430**, all georadar (Array 1: 325, Array 2: 149, HW 1 WILHECT001: 324, HW 1 WILHEL0907: 450, HW 2: 155, HW 3: 28) |
| Live rows the source does not produce | **18** (the DB-only Sued 1 block) | **798**: Nord Restflaeche 351, Sued 2 429, the 18 |
| …of which carry feedback | 18 | 52 |
| …of which `investigated` | 18 | 53 |
| Value differences on matched rows (instrument, layer, depth) | 0 | 0 |
| Category on matched rows | none in source. The live `Kat-1` placeholder stays. | 45 radar: `category` is `Kat-1` ×14 and **NULL ×31**. With `Target Pic` as fallback, all 45 are `Kat-1`, so no change. 741 magnetic: `Kat-1`, no change. |
| Category on new rows | n/a | `Kat-2` ×1,333, `Kat-3` ×98 (via `Target Pic` fallback) |

**Diagnosis: the match rate is not a precision problem.** Where a candidate covers a
layer, every row matches exactly, with 0 value differences. A's only misses are the
known 18. B's low rate is coverage: it lacks two whole magnetic layers, and its
`Georadar` looks like the full pick set from which the 45 live radar targets were
selected. Adopting B as-is would add 1,430 targets and leave 780 live targets (52 with
feedback) orphaned. Orphans are reported, never deleted, but they would be unmaintained
from then on.

Duplicates the pipeline must handle deterministically:

- A: `Nummer` 180 and 181 in `magnetic_data` are the same point with identical values.
  Live holds it once, as `2736-225`.
- B: the same duplicate in `Nord`, plus `443850.325 / 5935276.922` present in both
  `Georadar Array 1` and `Array 2` (same depth and category, different layer).

---

## Design

### Shape

```
 project schemas (QGIS, bosco_k)          etl schema (pipeline-owned)              public (app-owned)
 ┌──────────────────────────┐   dbt    ┌──────────────────────────────┐  merge  ┌──────────────────┐
 │ picks, magnetic_data, …  ├────────► │ stg_candidates (all projects)│ ──────► │ anomalies        │
 └──────────────────────────┘  select  │ <project>.anomalie_1         │ insert  │ projects         │
             ▲                         │ anomaly_diff, change_log,    │ + gated │ (feedback: read) │
             │ fingerprint             │ vm_registry, runs, orphans   │ update  └──────────────────┘
             └──────── runner ─────────┴──────────────────────────────┘
                   (advisory lock → fingerprint gate → dbt build → merge → dbt test → report)
```

- **`public.anomalies` is never a dbt model.** dbt owns only what it builds; a
  `--full-refresh` on a model that owned `public.anomalies` would drop and recreate it.
  The merge is an explicit macro, run by the runner in one transaction. On top of that,
  the pipeline role does not own `public.anomalies`, so it *cannot* drop or truncate it.
- Every dbt model is `full_refresh: false` where incremental, and all state tables are
  in `etl`.

### Configuration

One file, `etl/config/projects.yml`, loaded as dbt vars. No project names appear in any
model or macro. Example for both projects (Wilhelmshaven shown with option A; option B
only changes `sources`):

```yaml
projects:
  - project_id: "11-26-5151"
    project_name: "Koeln Deutzerfeld"
    schema: p_11_26_5151_koeln_deutzerfeld
    srid: 25832                  # source frame, used for lat/lon in anomalie_1
    coord_decimals: 2            # round easting/northing before target_id
    vm_prefix: "5151"
    sources:
      - table: picks
        instrument: georadar
        key: id                  # stable source key, for reports only
        where: "field_3 not in (0, 4)"
        columns:
          easting: field_1
          northing: field_2
          depth: field_5
          depth_decimals: 2
          category: "'Kat-' || field_3"
          layer: null

  - project_id: "11-24-2736"
    project_name: "Wilhemshaven Rüstersieler Seedeich"
    schema: p_11_24_2736_wilhemshaven_r_stersieler_seedeich
    srid: 25832
    coord_decimals: 3
    vm_prefix: "2736"
    sources:
      - table: magnetic_data
        instrument: magnetic
        key: Nummer
        where: '"Rechtswert" is not null and "Hochwert" is not null'
        corrections:             # D7, only if not fixed at source
          - when: '"Rechtswert" < 100000'
            easting_offset: 397000
            northing_offset: -21000
        columns: { easting: Rechtswert, northing: Hochwert, depth: "Tiefe [m]",
                   category: "'Kat-1'", layer: layer }
      - table: radar_data
        instrument: georadar
        key: Nummer
        columns: { easting: Rechtswert, northing: Hochwert, depth: "Tiefe [m]",
                   category: "'Kat-1'", layer: layer }
    dedup_priority: [magnetic_data, radar_data]   # which source wins a shared target_id
```

Column entries are either a column name (quoted by the macro) or a SQL expression (in
`'…'` or with operators). Expressions come from a committed file reviewed like code.
They never come from the database or from users.

A run also lists every table in each configured schema that no source mentions, so a
new QGIS import is reported rather than silently ignored.

### Models

| Model | Materialisation | Content |
|---|---|---|
| `stg_candidates` | view, `etl` | `UNION ALL` over every configured source, generated by a macro from the config: `project_id, source_table, source_key, instrument, easting, northing, depth, category, layer, src_lat, src_lon` |
| `int_candidates_dedup` | view | one row per `(project_id, target_id)`. Identical duplicates collapse; conflicting ones resolve by `dedup_priority` then `source_key`, and are listed in `etl.dup_report` |
| `<schema>.anomalie_1` | table per project (D4), built by one macro looping over the config | exactly the Köln `anomalie_1` columns and types. `id` = uuid5; `vm_nr` = existing or newly allocated; `status` = `pending` |
| `anomaly_diff` | table, `etl` | full outer join of candidates vs `public.anomalies` on `id`: `new` / `changed(column, old, new)` / `orphan` |

### Identity

`target_id = project_id || '-' || round(e, 3)::text || '-' || round(n, 3)::text`, where
`e` and `n` are first rounded to `coord_decimals` and cast to `numeric` so the text keeps
trailing zeros (`359019.290`). This is exactly the rendering the Köln append verified
against Python's `.3f`.

`id = uuid5(NAMESPACE_DNS, target_id)`, computed in SQL (D2):

```sql
-- first 16 bytes of sha1(namespace || name), version nibble 5, RFC 4122 variant
with h as (select digest(decode('6ba7b8109dad11d180b400c04fd430c8', 'hex')
                         || convert_to(target_id, 'UTF8'), 'sha1') as b)
select encode(set_byte(set_byte(substring(b from 1 for 16),
              6, (get_byte(b, 6) & 15) | 80),
              8, (get_byte(b, 8) & 63) | 128), 'hex')   -- then format 8-4-4-4-12
```

That needs `pgcrypto` (`digest`). It is shipped with the PostGIS image and is a trusted
extension, but the committed SQL deliberately avoided installing it on production, so
this is your call. The alternative is a Python step in the runner that fills
`etl.id_registry(target_id, id)`. It is automatic, so not a manual map, but it adds a
moving part. Either way, **a dbt test recomputes the id for every row in
`public.anomalies` and fails on any mismatch** (1,710 / 1,710 must pass before
anything is written).

Because the id depends only on `target_id`, a rerun or a new row never needs mapping
(requirement 2). A target moved in the field keeps its id and `target_id`, and the
pipeline never touches coordinates, so moved targets stay matched and stay where the
crew put them.

### Merge semantics

One transaction per run, rolled back entirely if any gate fails.

1. **Projects:** `INSERT … ON CONFLICT DO NOTHING` for configured projects that are missing.
2. **New targets** (`id` not in `public.anomalies`): `INSERT … ON CONFLICT (id) DO
   NOTHING` with `status = 'pending'`, a newly allocated `vm_nr`, and `geom`/lat/lon left
   to the trigger.
3. **Changed values on existing targets:** only `category`, `layer`,
   `evaluated_depth` and `instrument`. Each is written to `etl.change_log` (run, id,
   vm_nr, column, old, new). With D3 = staged, they are applied on a later run once
   approved (`etl approve <run_id>`, or setting `approved_at` on the row). A change *to*
   NULL is always staged, never automatic.
4. **Never written for existing rows:** `id`, `target_id`, `vm_nr`, `status`, `easting`,
   `northing`, `latitude`, `longitude`, `geom`. This is enforced by column-level grants,
   not only by the SQL.
5. **Orphans** (in `public.anomalies`, produced by no source): written to `etl.orphans`
   and reported. **No `DELETE` statement exists in the pipeline, and the role has no
   `DELETE` privilege.**
6. **Gates** before `COMMIT`: 0 orphaned feedback; count of `investigated` not decreased;
   every pre-existing `(id, vm_nr)` pair unchanged; `vm_nr` unique; row count not
   decreased; the id rule holds for every row.

### VM numbers

- Existing rows keep their `vm_nr` forever. The role cannot update the column.
- New rows get `vm_prefix-(max + k)`, where `max` is the highest number ever issued for
  that project, taken from `etl.vm_registry` and `public.anomalies`. `k` runs 1..N ordered
  by `target_id`, so the order is deterministic.
- Gaps are never filled. `5151-5` stays unused, in case anyone ever saw it on a map or in
  an export.
- `etl.vm_registry(project_id, vm_nr, target_id, issued_run)` records every number ever
  issued, so a number can never be reissued, even if its row were removed by someone
  else.
- A unique index on `public.anomalies.vm_nr` would make a collision impossible rather
  than only tested for. It is a one-time owner migration (see [Indexes](#indexes-1)).
  Today's data is already unique.

### Change detection

`public.anomalies` and the source tables have no timestamps. Options:

| Option | How | Cost | Verdict |
|---|---|---|---|
| **1. Fingerprint gate + row-hash diff** | Per source table, `count(*)` + `md5` over its rows. If no table changed since the last successful run, skip. Otherwise recompute candidates (≈8k rows, well under a second) and diff them against `public.anomalies` on `id`. | No DDL on source or app tables. State lives in `etl`. Detects inserts, updates **and deletes**. | **Recommended** |
| 2. `updated_at` + trigger on source tables | Add columns and triggers to every source table | DDL on QGIS-managed tables. A QGIS re-import recreates the table and silently loses both. Deletes are invisible. | No |
| 3. `pg_stat_user_tables` counters as a watermark | `n_tup_ins/upd/del` | Free, but the counters reset on crash recovery (they did on 2026-09-15; `stats_reset` is NULL now) | Only as a hint |
| 4. Logical replication / CDC | `wal_level=logical`, a slot, a consumer (Debezium, wal2json) | A Postgres restart, a slot that fills the disk if the consumer stops, another service | Overkill |
| 5. Columns on `public.anomalies` | `created_at`, `updated_at`, `source_hash` | An `ALTER` on the app's table. `updated_at` also needs a trigger to catch app writes. Useful for audit: it would have dated the 18 rows. | Optional, and not needed for detection. `etl.anomaly_state.first_seen_run` gives "when did this target appear" without touching the app table. |

### Idempotency

The second run with unchanged sources is skipped at the fingerprint gate. A forced
rerun computes an empty diff and issues no `INSERT` or `UPDATE`. The test compares
`xmin` of every `public.anomalies` row before and after, and it must be unchanged.

### dbt tests

- `stg_candidates` / `anomalie_1`: `unique` + `not_null` on `(project_id, target_id)`
  and `id`; `not_null` on easting, northing, instrument; `accepted_values` for
  instrument.
- `public.anomalies` (as a dbt source): `unique` on `id`, `target_id`, `vm_nr`;
  `not_null` on `id`, `project_id`, `instrument`, `easting`, `northing`;
  `relationships` `project_id → projects`.
- **Identity:** `id = uuid5(target_id)` for every row (error). `target_id = f(easting,
  northing)` is a **warning**, not an error, because a field-moved target legitimately
  breaks it.
- **Feedback:** every `feedback.anomaly_id` resolves (error); per-project feedback count
  not decreased since the previous run (error).
- **Preservation:** the 18 DB-only rows are present and unchanged (error). `investigated`
  count not decreased (error).
- **Indexes:** the required indexes exist (see below) (error).

### Role and privileges

The pipeline connects as `etl_pipeline`, never `postgres`. Its credentials come from
`ETL_DATABASE_URL` in the environment, never from a committed file.

```sql
-- once, as postgres (versioned migration, recorded in a ledger: backlog #8)
CREATE ROLE etl_pipeline LOGIN PASSWORD :'from_env';
GRANT CONNECT ON DATABASE nolte_geoservices TO etl_pipeline;
CREATE SCHEMA etl AUTHORIZATION etl_pipeline;
-- per configured project schema
GRANT USAGE ON SCHEMA <schema> TO etl_pipeline;
GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO etl_pipeline;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA <schema>
      GRANT SELECT ON TABLES TO etl_pipeline;        -- QGIS imports run as postgres
GRANT CREATE ON SCHEMA <schema> TO etl_pipeline;     -- only if D4 = project schema
-- public
GRANT USAGE ON SCHEMA public TO etl_pipeline;
GRANT SELECT ON public.anomalies, public.projects, public.feedback TO etl_pipeline;
GRANT INSERT ON public.anomalies, public.projects TO etl_pipeline;
GRANT UPDATE (category, layer, evaluated_depth, instrument) ON public.anomalies TO etl_pipeline;
-- deliberately absent: DELETE, TRUNCATE, UPDATE of any other column, anything on feedback
```

The trigger is `SECURITY INVOKER` and only modifies `NEW`, so it runs fine under this
role. `spatial_ref_sys` is readable by everyone by default.

On D4: `GRANT CREATE` on a project schema is broader than "write on `public.anomalies`
only". The alternative is `etl.anomalie_1__<schema>`. The existing Köln `anomalie_1` is
owned by `postgres`, so the pipeline would build its own table (or `postgres` transfers
ownership once). The pipeline never drops a table it does not own.

### Indexes

- Tables the pipeline owns (`anomalie_1`, `etl.*`): created and kept by dbt
  (`indexes:` config), with btree on `id`, `target_id`, `(project_id, vm_nr)`.
- `public.anomalies`: the GIST and `target_id` indexes belong to the app, and a
  non-owner **cannot** create or drop indexes on it. The pipeline **tests** that
  `idx_anomalies_geom` (GIST), `ix_anomalies_target_id` (unique) and `anomalies_pkey`
  exist, and fails the run if not. It never drops one. Proposed one-time owner
  migrations: `UNIQUE` on `vm_nr`, and an index on `feedback.anomaly_id` (the FK has
  none).
- Source tables are owned by `postgres` and recreated by QGIS, so the pipeline cannot
  keep indexes on them. At a few thousand rows none are needed.

### Requirements

| # | Requirement | How |
|---|---|---|
| 1 | No rebuild, truncate or delete-and-reinsert | Merge macro only; `public.anomalies` not a dbt model; role lacks `DELETE`/`TRUNCATE` and ownership |
| 2 | Stable identity, no manual map | uuid5 in SQL (D2); test over every row |
| 3 | `vm_nr` forever, no collisions | No `UPDATE` grant on `vm_nr`; `vm_registry`; max+k allocation; uniqueness test (+ optional unique index) |
| 4 | Never overwrite app columns; `pending` only on insert | Column-level `UPDATE` grant; `status` set only in the `INSERT` |
| 5 | Changes reported per column before applying | `etl.change_log`; staged approval (D3) |
| 6 | Change detection | Fingerprint gate + row-hash diff |
| 7 | Idempotent | Empty diff means no writes; `xmin` test |
| 8 | Nothing hardcoded | `projects.yml`; macros loop over it |
| 9 | Indexes kept, never dropped | dbt-owned indexes on pipeline tables; existence tests on app tables |
| 10 | dbt tests | [above](#dbt-tests) |
| 11 | Orphans reported, never deleted | `etl.orphans`; no `DELETE` anywhere |
| 12 | Least-privilege role | `etl_pipeline` [above](#role-and-privileges) |

---

## Scheduler

What running Airflow beside this stack would cost, on this machine (31 GB RAM, 16
cores; Docker has 15 GB; the current stack, Postgres + pgAdmin, uses ≈370 MB):

| | Airflow | Runner container (recommended) | Windows Task Scheduler |
|---|---|---|---|
| Services | api-server/webserver, scheduler, DAG processor, triggerer, plus a metadata database (at minimum a second database in the existing Postgres); Celery adds Redis and workers | one container: a loop or `supercronic` running `python run.py` | none |
| Memory | Airflow's own Docker Compose guide asks for at least 4 GB for Docker (8 GB ideal). A trimmed LocalExecutor setup is still in the 1–2 GB range, all the time | ≈100–300 MB while a run is going, near zero idle | none |
| Maintenance | version upgrades with metadata migrations, log and metadata cleanup, another web UI with its own users and secrets to secure | a pinned image (dbt-core + dbt-postgres), one compose entry, `restart: unless-stopped` | tied to a logged-in Windows user; the Python and dbt install lives on the host |
| What you get | UI, retries, backfills, lineage, alerting | run history in `etl.runs`, a log file, an advisory lock against overlap, exit status in `docker ps` | a run log only |

For one job, two projects and a few thousand rows every N minutes, Airflow is a lot of
machinery. The dbt project does not depend on the scheduler, so moving to Airflow (or
Dagster, which is lighter) later is a matter of wrapping `run.py` in a task. **Your
decision (D5). I will not switch without asking.**

---

## Phase 2 plan

Not started until this is approved.

1. `pg_dump -Fc` of the live database, then restore it into a scratch database and
   compare row counts and checksums per table, to prove the dump restores.
2. Restore a second copy (`nolte_geoservices_etl_test`), apply the one-time grants and
   `pgcrypto` there, and run the pipeline against the copy only.
3. Prove, and report every difference: Köln reproduces live exactly (rows, ids, VM
   numbers, geometry); Wilhelmshaven's `anomalie_1` comes from the same model with no
   project-specific code; 68/68 feedback resolve; every investigated target stays
   investigated; one added source row changes only that row, gets the next VM number,
   and moves no existing VM; the 18 are untouched; a second run changes nothing; the
   indexes exist and the trigger derived geometry correctly.
4. Old scripts stay in place. The live run is a separate step you approve.
