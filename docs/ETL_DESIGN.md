# ETL design: project schemas → `public.anomalies`

Status: **proposal, revision 4** (Phase 1, 2026-09-23). The one-time migration **ran on live on 2026-09-24**, see [Live run](#live-run-2026-09-24). The pipeline is built, accepted on a copy, and **ran on live on 2026-09-24** (supervised, not yet scheduled), see [Implementation](#implementation-phase-2-feat-etl-dbt-pipeline). Nothing
described under *Design* exists yet. The audit was read-only: every query ran in a
`default_transaction_read_only` session, and nothing in the database was changed.

Revisions 2–4 apply the decisions of 2026-09-23. **Wilhelmshaven is a fresh start:**
`anomalie_1` is built only from `Magnetic` + `Georadar`, and neither table is changed.
Its `target_id` uses the stored 3-decimal values rather than the Köln rounding. Its
1,583 current rows are replaced once by a
[one-time migration](#one-time-migration-replacing-the-11-24-2736-rows), which has been
dry-run on a copy and verified from an independent session.

Goal: the database is the single source of truth. A dbt pipeline on a schedule reads
each project schema, builds that project's `anomalie_1`, and merges it into
`public.anomalies` when source data changes. There are no CSVs, no hand-run SQL and no
hand-written `id_map`. Adding a project means adding configuration, not SQL.

- [Before building: what the numbers say](#before-building-what-the-numbers-say)
- [Decisions](#decisions)
- [Audit](#audit)
- [Design](#design)
- [One-time migration](#one-time-migration-replacing-the-11-24-2736-rows)
- [Scheduler](#scheduler)
- [Phase 2 plan](#phase-2-plan)

---

## Before building: what the numbers say

Revision 4, 2026-09-23. All figures come from the live database, read-only, and from a
dry run on a copy of it ([One-time migration](#one-time-migration-replacing-the-11-24-2736-rows)).

**1. Columns.** Magnetic and Georadar don't name their coordinates the same way:

| Table | Easting | Northing | Type | As text |
|---|---|---|---|---|
| `Magnetic` | `Rechtswert` (there is no `Rechswert` in this table) | `Hochwert` | `numeric(10,3)` | always 3 decimals, trailing zeros kept: `443656.190` |
| `Georadar` | `East` | `North` | `numeric(23,15)` | 15 decimals, zero-padded: `443860.056540399960000` |
| `Georadar` | `Rechswert` (sic) | `Hochwert` | `numeric`, scale 3 on every row | `443860.057`. Equals `round(East, 3)` on all 1,476 rows |

As decided: Magnetic takes easting/northing **and** `target_id` from
`Rechtswert`/`Hochwert`. Georadar takes **easting/northing from `East`/`North`** and
**`target_id` from `Rechswert`/`Hochwert`**.

**2. How the stored value becomes text.** `numeric::text` prints exactly the column's
declared scale, trailing zeros included. Both `target_id` columns hold 3 decimals, so:
`11-24-2736-443656.190-5935538.441`. That output follows the column type, so the config
pins it (`id_decimals: 3`), and the model renders `round(value, 3)::text`. Today that is
the stored text byte for byte, on all 741 Magnetic and all 1,476 Georadar rows. After a
re-import that changed the column type, it would still be the same text. The 15-decimal
float-noise ids from revision 2 are gone.

**3. Does it reproduce the existing `target_id`s?**

| Source | Distinct `target_id` | Reproduce an existing one |
|---|---:|---:|
| `Magnetic` (`Nord` + `Sued 1`) | 740 | **740 of 740** |
| `Georadar` from `Rechswert`/`Hochwert` | 1,475 | **all 45** existing radar targets, plus 1,430 new |

Where it reproduces a `target_id`, the id is the same (`uuid5` reproduces all 1,583
existing Wilhelmshaven ids), so feedback stays linked with nothing to re-point.

One consequence to know: the pipeline never writes coordinates of existing rows, so the
45 kept radar targets keep their stored 3-decimal easting/northing. The 1,430 new ones
get `East`/`North` at full precision. For those, `target_id` (3 decimals) is not the text
of `easting`/`northing`. That is by design, and it is why the identity test is id ↔
`target_id`.

**4. Category.** Georadar: 988 rows take their category from `Target Pic` (`Kat. 1` ×31,
`Kat. 2` ×924, `Kat. 3` ×33), and **no row** has a null category with an empty or
non-numeric `Target Pic`. Magnetic has no `Target Pic` column. Its original 741 rows all
have `Kat-1`, so the rule applies to 0 of them.

**5. What is removed.** Every old 11-24-2736 row with no counterpart in `Magnetic` or
`Georadar`: **798 anomalies** (`Nord Restflaeche` 351, `Sued 2` 429, the DB-only `Sued 1`
18). The cascade takes **52 feedback rows** with them (34 `Restflaeche`, 18 DB-only). **All
52 are from the 2026-07-15 11:42:02 bulk insert. None is a known-real field submission**,
so the rule to stop does not trigger. None of them carries photos (`[]`). All 798 + 52 are
archived first and verified identical. Expected feedback after the migration: **exactly
16** (Köln 6 + Wilhelmshaven 10). The 7 known-real submissions (`2736-1000` and six Köln
rows) are all among the 16.

**6. D7.** `Magnetic` has no `Sued 2` rows, so the defect does not exist there and
nothing is fixed. The 429 `Sued 2` targets are removed with the old rows. One of them,
`2736-1186`, is `investigated` with no feedback.

**7. Backup.** `backup-nolte_geoservices-20260923-233514.sql` (plain `pg_dump`,
2.07 MB, gitignored like the earlier dumps). It was restored into `nolte_restore_check`
without errors, and **all 52 tables are identical** (row count and md5 over every row),
as are the indexes, constraints, triggers and functions. The only difference is
cosmetic: live stores the owner's default table privileges explicitly
(`{postgres=arwdDxt/postgres}`) where the restore leaves them NULL, which means the
same. `bosco_k`'s grants came back intact.

---

## Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Wilhelmshaven source | **Decided:** `Magnetic` + `Georadar` only, a fresh start. Nothing is copied from `magnetic_data` / `radar_data`, and neither source table is modified |
| D2 | uuid5 | **Decided:** a Python step in the runner, `uuid.uuid5(uuid.NAMESPACE_DNS, target_id)` |
| D3 | Changes to existing rows | **Decided:** staged for approval; new targets go in automatically |
| D4 | Where `anomalie_1` lives | **Decided:** in each project schema |
| D5 | Scheduler | **Decided:** the small runner container |
| D6 | DB-only rows | **Decided:** reported every run; a warning only when the set changes |
| D7 | Sued 2 defect | **Resolved:** not present in `Magnetic` |
| D8 | The unmatched feedback | **Decided:** every old row with no counterpart is removed: 798 anomalies, and by cascade 52 feedback rows, all archived first (anomalies, feedback incl. photos, JSON file). Feedback after = **16** |
| D9 | VM numbers | **Decided:** existing targets keep theirs; new ones continue from the highest ever issued (`2736-1584…`) |
| D10 | Status | **Decided:** `pending` for new rows only |
| D11 | Duplicate positions | **Decided:** collapse; a row whose target has feedback or is `investigated` wins regardless of layer; the dropped one's VM number is retired. Today neither pair has a VM of its own to retire (see the migration) |
| — | D12, D13 (Restflaeche category and geometry) | **Withdrawn:** nothing is added to `Magnetic` |

Backlog, added to [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md): feedback → anomaly
`ON DELETE RESTRICT` instead of `CASCADE`; restricted logins for project-schema editors.

Two things came up that are not decisions for the pipeline, but you should know them:

- **The new Wilhelmshaven tables were built through QGIS as `postgres`**, the superuser
  (created 2026-09-23 between 06:36 and 10:21 UTC). They were built on purpose as the
  new source. Using the superuser for it is now a backlog item in
  [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md): people editing project schemas should use
  restricted logins.
- **What actually ran for Köln differs from the committed SQL.** `vm_nr` for
  `11-26-5151` runs `1..128` over 127 rows. `5151-5` is missing. The committed
  `ROW_NUMBER()` over the filtered 127 rows cannot leave a gap. This is concrete evidence
  for backlog #8 (no migration ledger).

---

## Audit

### Köln: how `anomalie_1` is built from `picks`

Source `sql/anomalie_1_from_picks.sql` (removed 2026-09-25; last present in `cd69945`).
Values marked **[P]** are specific to Köln and must become parameters.

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

Source `sql/append_anomalie_1_to_anomalies.sql` (removed 2026-09-25; last present in
`cd69945`). In one transaction:

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
| Easting | `Rechtswert` float8 | **`Rechtswert`** `numeric(10,3)`, the column used | **`East`** `numeric(23,15)`, the column used; also **`Rechswert`** (sic) `numeric`, = `round(East, 3)` |
| Northing | `Hochwert` float8 | `Hochwert` `numeric(10,3)` | **`North`** `numeric(23,15)`, the column used; also `Hochwert` `numeric`, = `round(North, 3)` |
| Tiefe[m] (depth) | `Tiefe [m]` (with a space) | `Tiefe [m]` | `Tiefe [m]` |
| category | **absent** | `category` (all `Kat-1`) | `category` for the 488 Rebar rows; for the other 988 it is **only in `Target Pic`**, as `Kat. 1` / `Kat. 2` / `Kat. 3` |
| layer | `layer` | `layer` | `layer` |

**Coordinate defect.** All 429 `Stoerkoerper Magnetik Sued 2` rows in `magnetic_data`
have easting ≈ 46,5xx (a missing leading digit) and a shifted northing.
`ingest_anomalies.py` repaired this with a hardcoded `+397000` / `−21000`. One
`Nord Restflaeche` row has null coordinates and `Nummer`. **The new `Magnetic` table has
no `Sued 2` rows, so the defect is not present in the chosen source** (D7).

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

Built only from `Magnetic` + `Georadar`, `target_id` from the 3-decimal columns:

| | Rows |
|---|---:|
| New `anomalie_1` (distinct `target_id`) | **2,215**: 740 magnetic + 1,475 georadar |
| …identical to an existing target (same id, VM number, status, feedback) | **785**: 740 magnetic + 45 georadar |
| …new targets | **1,430**, all georadar, `2736-1584…3013` |
| Existing targets with no counterpart (removed) | **798** |

| Removed layer | Old rows | `investigated` | Feedback (cascades, archived first) |
|---|---:|---:|---:|
| Stoerkoerper Magnetik Nord Restflaeche | 351 | 34 | 34 |
| Stoerkoerper Magnetik Sued 2 | 429 | 1 (`2736-1186`, no feedback) | 0 |
| Stoerkoerper Magnetik Sued 1, DB-only (`2736-1566…1583`) | 18 | 18 | 18 |
| **Total** | **798** | **53** | **52** |

No value differences on the 785 kept rows: instrument, layer, depth and category are the
same in source and live.

Duplicates (D11): `Nummer` 180/181 in `Magnetic` (`Nord`) are one existing target,
`2736-225`. One Georadar position is in both `Array 1` and `Array 2`, with the same
depth and category, and is new.

*Earlier revisions compared the old CSV mirrors (rev. 1), used Georadar's 15-decimal
`East`/`North` for `target_id` (rev. 2), and added `Restflaeche` to `Magnetic` from
`magnetic_data` (rev. 3). All are superseded.*

---

## Design

### Shape

```
 project schemas (QGIS, bosco_k)          etl schema (pipeline-owned)              public (app-owned)
 ┌──────────────────────────┐   dbt    ┌──────────────────────────────┐  merge  ┌──────────────────┐
 │ picks, Magnetic, Georadar├────────► │ stg_candidates (all projects)│ ──────► │ anomalies        │
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
model or macro. Both projects, as decided:

```yaml
projects:
  - project_id: "11-26-5151"
    project_name: "Koeln Deutzerfeld"
    schema: p_11_26_5151_koeln_deutzerfeld
    srid: 25832                  # source frame, used for lat/lon in anomalie_1
    vm_prefix: "5151"
    sources:
      - table: picks
        instrument: georadar
        key: id                  # stable source key, for reports only
        where: "field_3 not in (0, 4)"
        coord_round: 2           # Köln only: round easting/northing to 2 dp first
        id_decimals: 3           # target_id text: 359019.290
        columns:
          easting: field_1
          northing: field_2
          depth: { column: field_5, round: 2 }
          category: { expr: "'Kat-' || field_3" }
          layer: null

  - project_id: "11-24-2736"
    project_name: "Wilhemshaven Rüstersieler Seedeich"
    schema: p_11_24_2736_wilhemshaven_r_stersieler_seedeich
    srid: 25832
    vm_prefix: "2736"
    sources:                     # order = priority for duplicate positions (D11)
      - table: Magnetic
        instrument: magnetic
        key: Nummer
        id_decimals: 3           # numeric(10,3), as stored: 443656.190
        columns:
          easting: Rechtswert
          northing: Hochwert
          depth: { column: "Tiefe [m]" }
          category: { column: category }        # no Target Pic column in this table
          layer: layer
      - table: Georadar
        instrument: georadar
        id_decimals: 3           # target_id from the 3-decimal columns
        id_columns: { easting: Rechswert, northing: Hochwert }   # sic, as spelled in the table
        columns:
          easting: East          # stored easting/northing: full precision
          northing: North
          depth: { column: "Tiefe [m]" }
          category: { column: category, fallback: { column: "Target Pic", rule: trailing_number } }
          layer: layer
```

- `coord_round` (optional) rounds the stored coordinates before anything else. Only Köln
  sets it. Without it, coordinates are used exactly as stored.
- `id_columns` (optional) takes `target_id` from other columns than the stored
  easting/northing. Georadar uses it: `Rechswert`/`Hochwert` for the id, `East`/`North`
  for the position.
- `id_decimals` fixes the number of decimals in `target_id`:
  `round(value::numeric, id_decimals)::text`, which keeps trailing zeros. It is pinned in
  config rather than taken from the column type, so a re-import that changes the column's
  scale cannot silently re-key every target. At the current column types it equals the
  stored text exactly.
- `fallback … rule: trailing_number` applies only where `category` is null. It takes
  the digits at the end of the fallback column (`[0-9]+\s*$`) as an integer and gives
  `Kat-<n>` (`Kat. 2` → `Kat-2`). A row whose category is null and whose fallback is
  empty, missing or doesn't end in a number is **not guessed**. It is left out of
  `anomalie_1` and listed in the run report. Configuring a fallback column that doesn't
  exist in the table is a config error.
- A source table, column or expression that doesn't resolve fails the run before
  anything is written.

Column entries are either a column name (quoted by the macro) or `expr:`, a SQL
expression. Expressions come from a committed file reviewed like code. They never come
from the database or from users.

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

```
e, n      = stored easting/northing, rounded to coord_round first if the source sets it
target_id = project_id || '-' || round(e::numeric, id_decimals)::text
                       || '-' || round(n::numeric, id_decimals)::text
```

Köln: `coord_round 2`, `id_decimals 3` → `11-26-5151-359019.290-5645464.340`. This
reproduces all 127 live Köln `target_id`s, and is the rendering the Köln append
verified against Python's `.3f`. Wilhelmshaven: no rounding, 3 decimals, from
`Rechtswert`/`Hochwert` (Magnetic) and `Rechswert`/`Hochwert` (Georadar)
(see [Before building](#before-building-what-the-numbers-say)).

`id = uuid.uuid5(uuid.NAMESPACE_DNS, target_id)` is computed by **a Python step in the
runner** (D2), with the same call that produced the existing ids (`ingest_anomalies.py`,
the Köln `id_map`). No Postgres extension is needed:

1. dbt builds `stg_candidates`, which carries `target_id`.
2. The runner reads every `target_id` in `stg_candidates` and `public.anomalies` that
   has no entry in `etl.id_registry(target_id PK, id)`, computes the uuid5, and inserts
   it. Entries are only ever added, never changed.
3. dbt builds the rest, joining `id_registry` for the id.

**The id test:** `id_registry` covers every `target_id` in `public.anomalies`, and a dbt
test requires `anomalies.id = id_registry.id` for every row. On first run this repeats
the 1,710 / 1,710 check from 2026-09-22 and must pass before anything is written.

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
5. **DB-only rows** (in `public.anomalies`, produced by no source): listed in every run
   report. The set is stored in `etl.orphans`, and a **warning** is raised only when it
   changes from the previous run, with the added and removed ids (D6). **No `DELETE`
   statement exists in the pipeline, and the role has no `DELETE` privilege.**
6. **Gates** before `COMMIT`: feedback **row count unchanged** (0 orphans is not enough:
   with `ON DELETE CASCADE`, lost feedback leaves no orphan); 0 orphaned feedback; count
   of `investigated` not decreased; every pre-existing `(id, vm_nr)` pair unchanged;
   `vm_nr` unique; row count not decreased; every id equals its registry id.

### When the survey team corrects a coordinate

A corrected easting or northing in a source table gives a different `target_id`, so the
pipeline sees two things at once: a **new target** at the corrected position, and the
old target in `public.anomalies` becoming **DB-only**. Left alone, a new row and a new VM
number would appear beside the old one, and the old one's feedback would stay on the old
row.

**Detection.** In each run, every new candidate is paired with every row that has just
become DB-only in the same project, where they share the same instrument and the same
source key (`Nummer`, `picks.id`, where configured) or lie within `correction_radius`
(config, default 1 m) of each other. Each pair is recorded in `etl.correction_candidates`
with the old and new position, the distance, and whether the old row has feedback or is
`investigated`. The new target is **held back**: it is not inserted while an unresolved
pair exists, so no duplicate VM number is issued.

**Handling**, always by approval (D3), per pair:

- **Accept as a correction.** The runner writes an alias,
  `etl.target_alias(source_target_id → anomaly id)`. From then on the corrected source
  row maps to the **existing** row, so the id, `target_id`, VM number, status and feedback
  all stay. The approved step updates that row's easting/northing, and the trigger
  re-derives geom and lat/lon. This is the only coordinate write the pipeline ever makes,
  and it goes through a separate, approval-only function granted `UPDATE (easting,
  northing)`. The regular run cannot write coordinates. Afterwards `target_id` no longer
  equals the formula over the coordinates, exactly like a field-moved target, which is
  why the identity test checks `id` ↔ `target_id`, not `target_id` ↔ coordinates.
- **Reject: a genuinely different target.** The new target is inserted normally, and the
  old one stays DB-only and is reported.
- **Conflict:** if the old row was moved in the field (its coordinates differ from the
  last position the pipeline wrote, kept in `etl.anomaly_state`), the pair is reported and
  never auto-resolved. The crew's position and the survey's correction disagree, and a
  person must choose.

Unpaired new targets go in automatically, as before. Unpaired DB-only rows are reported
as before.

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
- For Wilhelmshaven, "same logic as Köln" (a random-order renumbering) conflicts with
  this rule. See [D9](#decisions). The design keeps the existing numbers for the 740
  kept targets, and numbers the new ones from `max + 1`.
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

D4 (decided): `anomalie_1` lives in each project schema, so the role gets `CREATE` on
the configured project schemas. That is broader than "write on `public.anomalies`
only", and it is the reason for the grant. The existing Köln `anomalie_1` is owned by
`postgres`. Ownership is transferred to `etl_pipeline` once, in the same migration
(`ALTER TABLE … OWNER TO etl_pipeline`), after which dbt maintains it. The pipeline never
drops a table it does not own.

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
| 2 | Stable identity, no manual map | uuid5 in a Python step, into an append-only `etl.id_registry` (D2); test over every row |
| 3 | `vm_nr` forever, no collisions | No `UPDATE` grant on `vm_nr`; `vm_registry`; max+k allocation; uniqueness test (+ optional unique index) |
| 4 | Never overwrite app columns; `pending` only on insert | Column-level `UPDATE` grant; `status` set only in the `INSERT` |
| 5 | Changes reported per column before applying | `etl.change_log`; staged approval (D3) |
| 6 | Change detection | Fingerprint gate + row-hash diff |
| 7 | Idempotent | Empty diff means no writes; `xmin` test |
| 8 | Nothing hardcoded | `projects.yml`; macros loop over it |
| 9 | Indexes kept, never dropped | dbt-owned indexes on pipeline tables; existence tests on app tables |
| 10 | dbt tests | [above](#dbt-tests) |
| 11 | Orphans reported, never deleted | `etl.orphans`, warning when the set changes (D6); no `DELETE` anywhere in the pipeline |
| 12 | Least-privilege role | `etl_pipeline` [above](#role-and-privileges) |

---

## One-time migration: replacing the 11-24-2736 rows

A separate, one-off script, **not part of the pipeline**. The pipeline keeps its rule of
never deleting. The script needs `DELETE` on `public.anomalies`, which `etl_pipeline`
must never have, so it runs once as an admin role and is then retired.

### Preconditions (live run)

1. You confirm every field device has synced. A device that syncs afterwards with
   feedback for a removed target would have it skipped (`/api/sync` skips feedback
   whose anomaly is missing).
2. Then a **fresh** `pg_dump`, restored into a scratch database and compared table by
   table (row count + md5), taken immediately before the run.
3. **Your explicit go.** Nothing runs on live before that.

### After the run: every device refreshes

The app does not delete anything from a device by itself; it **replaces** the device's
whole target list whenever it downloads one. `fetchFromServer()` and `/api/sync` both
`clear()` the local `points` table and rewrite it from the server's list in one Dexie
transaction (`App.tsx:554`, `:631`). The service worker never caches `/api/`
(`sw.js:74`). So the 798 removed targets vanish from a device, and the 1,430 new ones
appear, at its next download. That happens:

- when the app starts or someone signs in while online, or
- on a sync: the **Sync** button, or automatically when records are queued.

A device that stays open and online with nothing queued does **not** download on its
own. So, after the live run, each device, online, presses **Sync** (or closes and reopens
the app). No cache clearing or reinstall is needed. Check: the Field App's target count
over all projects is **2,342** (2,215 Wilhelmshaven + 127 Köln).

**Until a device has refreshed, nobody should log work on it.** It still shows the
removed targets. Feedback logged on one of them would be **silently lost**: the server
skips feedback whose target no longer exists (`server.py:837-842`, a log warning only),
and the device then drops it from its queue as accepted. Work logged on kept targets
syncs normally.

### Restoring from the backup

The plain `pg_dump` restores every table, index, constraint, trigger, function and
table/schema grant exactly (verified twice). It does **not** carry grants on the
database itself: live allows only `postgres` and `bosco_k` to connect. After restoring a
**whole database**, re-apply `REVOKE CONNECT, TEMPORARY ON DATABASE … FROM PUBLIC;
GRANT CONNECT ON DATABASE … TO bosco_k;`. Rolling back this migration only needs the
archive tables or the affected tables, not a database restore.

### Archive, before the migration transaction

Committed on its own and never touched by the migration:

- `archive.anomalies_11_24_2736_removed_20260923`: all 798 removed anomalies, every column
- `archive.feedback_11_24_2736_removed_20260923`: all 52 feedback rows, every column incl. `photos`
- `archive_removed_11_24_2736.json`: the same rows, kept with the backup

Verified before continuing: counts, md5 over every row against the source rows, and the
JSON file read back and compared. A restore is two `INSERT … SELECT`s, anomalies first.
The script also **stops** if any of the 52 feedback rows is not from the 2026-07-15
bulk insert.

### Steps, in one transaction

```
LOCK public.anomalies, public.feedback          -- no sync can interleave
1. old→new map: identical target_id (785); then same instrument within 0.001 m
   for anything left with feedback (0)
2. kept rows: nothing written (0 value differences; any would be staged, D3)
3. insert the 1,430 new rows: status 'pending', VM 2736-1584…3013 (D9, D10)
4. re-point feedback whose anomaly changed (0)
5. delete the 798 old rows with no counterpart (52 feedback go by cascade)
6. gates, else ROLLBACK:
   feedback = 16 exactly · 0 orphans · feedback.project_id and .target_id match
   their anomaly · 11-24-2736 rows = 2,215 · investigated = 11 ·
   11-26-5151 anomalies and feedback byte-identical · vm_nr unique ·
   every id = uuid5(target_id)
COMMIT
7. record every VM number ever issued for 11-24-2736 in etl.vm_registry,
   including the retired ones, so none is ever reissued
```

The transaction must be **top-level**. A client that already has a transaction open
turns `BEGIN` into a savepoint, and then "committed" means nothing. The script closes
any open transaction first and asserts the session is idle. The result is verified
from a **separate session**.

### Dry run on a copy (2026-09-23, rev. 4)

Fresh copy `nolte_geoservices_etl_test`, made from the verified restore of
`backup-nolte_geoservices-20260923-233514.sql`. Script and outputs in
`scratch/etl-migration/` (gitignored).

| Check | Result |
|---|---|
| Source rows read (`Magnetic` + `Georadar`) | 2,217, excluded for category: 0 |
| Live ids reproduced by uuid5 | 1,583 / 1,583 |
| `anomalie_1` | 2,215 rows, 2,215 distinct `target_id`, 2,215 distinct VM |
| Kept identical | 785 (740 + 45), value differences 0 |
| New | 1,430, `2736-1584…3013` |
| Removed | 798 anomalies, 52 feedback, **0 of the 52 are known-real** |
| Archive | 798 / 52, identical by md5; JSON file matches |
| Gates | feedback **16** ✓, orphans 0 ✓, feedback project/target match ✓, rows 2,215 ✓, investigated 11 ✓, Köln ✓, VM unique ✓, ids ✓ |
| Outcome | **COMMITTED**, confirmed from a new session and again with `psql` |
| Feedback after, by project | 11-24-2736: 10 (incl. known-real `2736-1000`), 11-26-5151: 6 (all known-real) |
| **Köln unchanged** | anomalies and feedback md5 identical to **live** |
| **Kept ids and VM numbers unchanged** | the 785 kept rows identical to **live** in every column |
| **No source table modified** | `Magnetic`, `Georadar`, `Nord`, `Sued 1`, `magnetic_data`, `radar_data` and both `*_raw_data`: identical before and after, and identical to **live** |
| New rows' geometry | 1,430 / 1,430 with `geom` (32632) and lat/lon from the trigger; GIST index present |

**Correction to revision 3:** its dry-run variants reported "COMMITTED", but the script's
migration block ran as a savepoint inside an already-open transaction, and closing the
connection rolled it back. The gate figures were real (measured inside the
transaction), but nothing was persisted. Revision 4 fixed the script and verifies from
an independent session.

### Live run (2026-09-24)

Run at 00:12 on your go, with the same script as the rev-4 dry run
(`scratch/etl-migration/live_migrate.py`, gitignored). It differs only in the database
guard, a baseline check (68 / 1,583 / 64 / max VM 1583, else refuse), and `CREATE`
without `DROP IF EXISTS`.

- **Before:** all devices synced (your confirmation). Fresh backup
  `backup-nolte_geoservices-20260924-000754.sql`, restored into a scratch database: 52
  tables, indexes, constraints, triggers, functions and 208 grants identical. Pre-flight:
  live identical to that backup; no `anomalie_1` or `archive` tables existed.
- **Archive:** `archive.anomalies_11_24_2736_removed_20260923` (798) and
  `archive.feedback_11_24_2736_removed_20260923` (52), identical to the pre-migration
  rows. JSON copy: `archive/archive_removed_11_24_2736.json`
  (gitignored; it holds investigator names). None of the 52 was a known-real submission.
- **Migration:** inserted 1,430, deleted 798, re-pointed 0. All gates passed, **COMMITTED**.
- **Verified from separate sessions:** feedback **16** (11-24-2736: 10, 11-26-5151: 6),
  all 7 known-real submissions present, 0 orphans; 11-24-2736 **2,215** rows (11
  investigated), 11-26-5151 127 (6); **2,342** targets in total; VM numbers unique;
  1,430/1,430 new rows `pending` with geometry and lat/lon from the trigger.
  **Identical to the pre-migration backup:** Köln anomalies and feedback, the 785 kept
  rows in every column, the 10 surviving Wilhelmshaven feedback rows, `Magnetic`,
  `Georadar`, users, permission requests, projects.
- `p_11_24_2736_…anomalie_1` (2,215 rows) now exists, owned by `postgres`. When the
  pipeline is built it takes over the table (D4) and seeds `etl.vm_registry` from
  `public.anomalies` plus the archive, so the retired numbers are never reissued.
- The scratch databases were dropped after verification.

---

## Implementation (Phase 2, `feat/etl-dbt-pipeline`)

Built as designed, in `etl/` (runbook: [etl/README.md](../etl/README.md)):

| Part | Where |
|---|---|
| Configuration, both projects | `etl/config/projects.yml`: Köln from `picks` (`coord_round: 2`, category from `field_3`); Wilhelmshaven from `Magnetic` + `Georadar` (Georadar `target_id` from `Rechswert`/`Hochwert`, easting/northing from `East`/`North`, category falling back to `Target Pic`) |
| dbt models | `stg_candidates` (one `UNION ALL` branch per configured source, generated), `int_candidates` (dedup + uuid5 id), `excluded_rows`, `dup_report`, all in `etl` |
| dbt tests | 33: keys, relationships, uuid5 identity, feedback resolving, every `anomalie_1` agreeing with `public.anomalies`, the app's indexes present; `target_id` vs coordinates as a warning |
| Runner | `etl/runner/run.py`: advisory lock → config validation → checksum gate → dbt → uuid5 registry → one gated merge transaction → dbt test → run record |
| Roles | `etl_pipeline` runs the pipeline: `SELECT` + `INSERT` on `public.anomalies`, **no `UPDATE`, `DELETE` or `TRUNCATE`**. `etl_approver` takes decisions. Both come from `run.py setup-sql`; see [Approvals](#approvals-enforced-by-the-database) |
| Container | `etl/Dockerfile`, compose service `etl` behind the `etl` profile; scheduling off until `ETL_INTERVAL_SECONDS` > 0 |
| Acceptance suite | `etl/tests/acceptance.py <copy>` (refuses the live name) |

### Where the build differs from the design, and why

- **No table lock during the merge.** Taking a lock that blocks other writers needs
  table-wide `UPDATE`/`DELETE`/`TRUNCATE`, which `etl_pipeline` deliberately lacks
  (verified). Instead, runs cannot overlap (an advisory lock). The app only writes
  `status` and field-moved coordinates, which the merge never touches. And every gate
  compares rows that existed when the merge began (ids, VM numbers, every feedback row)
  or counts that may only grow, so it holds under concurrent app writes. The feedback
  gate became "no feedback row present at the start may be gone", stricter than a count.
- **`spatial_ref_sys`.** PUBLIC's read access is revoked in this database, so
  `setup-sql` grants the role `SELECT` on it. It is needed by the models' coordinate
  transforms and by the app's trigger when the pipeline inserts.
- **Approvals are enforced by the database** (added 2026-09-24; the first build did
  them procedurally), see below.
- **Köln `anomalie_1` normalised on the first run** (decided 2026-09-24): its 127 rows
  gained their ids (equal to `public.anomalies`, all 127) and 3-decimal `target_id`s
  (same values). Nothing else changed.
- `anomalie_1.status` is always `pending`, as in both existing tables. It describes the
  source; the investigated state lives in `public.anomalies`.
- The VM registry is seeded every run (insert-if-missing) from `public.anomalies` and
  from every `archive` table that has `project_id`, `vm_nr` and `target_id`. Today that
  is the 798 removed Wilhelmshaven targets, so their numbers are never reissued. The next
  Wilhelmshaven number is `2736-3014`, the next Köln number `5151-129`.

### Approvals, enforced by the database

`etl_pipeline` cannot apply, approve or alter a change to an existing row:

| | `etl_pipeline` | `etl_approver` |
|---|---|---|
| `UPDATE` / `DELETE` / `TRUNCATE` on `public.anomalies` | **none** | none |
| Decide (`etl_admin.decide_change`, `decide_correction`) | no `EXECUTE` | yes |
| Write `etl_approval.decisions` | read only | only through the decide functions |
| Carry out (`etl_admin.apply_change`, `apply_correction`) | yes, **only for an approved, open decision** | no |
| Close a decision unapplied (`close_decision`) | yes: it can only prevent a write | no |

- Decisions live in `etl_approval.decisions`, owned by `postgres`. The decide function
  **snapshots** what is approved (target, column, old and new value; or the new
  coordinates). The apply function writes only that snapshot, and only while the live
  value still equals the approved old value (else `stale`). Editing
  `etl.change_log` after approval changes nothing. The suite tries it, and the
  approved `Kat-3` is applied, not the tampered `Kat-9`.
- A corrected source row maps onto its existing target only through an approver's
  correction decision that has been carried out. `int_candidates` reads the aliases from
  `etl_approval.decisions`, not from any table the pipeline can write.
- The functions are `SECURITY DEFINER`, owned by `postgres`, with a fixed `search_path`.
  Columns are whitelisted (`category`, `layer`, `evaluated_depth`, `instrument`).
- Approvals run from a separate compose service, `etl-approve`, which holds only the
  approver's credentials. The pipeline service never has them.

### How you know something is waiting

Today:

- every run prints `staged N (open N)` and `correction pairs +N (open N)` per project,
  and a WARNING when the set of DB-only rows changes (container log: `docker compose
  logs etl`);
- `docker compose --profile etl run --rm etl-approve` (default command
  `status --approver`) lists staged changes and correction pairs awaiting a decision,
  decisions not yet carried out, DB-only rows and the last runs;
- the same is in `etl.runs.summary` for each run.

Nothing pushes a notification. Showing pending approvals to admins in the app is on the
backlog ([PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md)).

### The gates, in steady state

None of them expects a fixed number. Checked at the end of every merge, against the
state when the merge began:

| Gate | Holds when |
|---|---|
| feedback lost | every feedback row that existed at the start still exists. New rows are fine; feedback grows as crews log work |
| feedback count | not lower than at the start |
| orphaned feedback | 0 |
| existing targets | every target that existed at the start keeps its id and VM number |
| rows / investigated per project | not lower than at the start |
| VM numbers | unique |
| identity | every id = uuid5(`target_id`); every `anomalie_1` id = its `public.anomalies` id |

(The acceptance suite checks "16" only because the copy is frozen at 16.)

**A device syncing during a run** (acceptance section 7, a real run held open for 20 s
before its gates while the suite commits a feedback row and sets the target
`investigated`, exactly as `/api/sync` does): gates `feedback: 17, feedback_lost: 0`,
the run commits, and both the device's row and the run's own new target are in.
**A feedback row that existed before the run disappearing during it** (7b):
`GATES FAILED, rolled back: feedback lost: 1 rows gone (17 -> 16)`. The run's own
insert is rolled back with it, and the next run succeeds once the row is back.

### Acceptance on a copy (2026-09-24): 52 / 52

Sections 1–6 below are as first reported (38 checks). The rerun with the approver
login adds 7 enforcement checks in sections 4 and 5, and section 7 (7 checks, above).


Copy `nolte_etl_acceptance`, restored from `backup-nolte_geoservices-20260924-004051.sql`
(live after the migration: 2,342 targets, 16 feedback), with `setup-sql` applied.

| # | Test | Result |
|---|---|---|
| 1 | First run against the current state | `public.anomalies`, `feedback`, Wilhelmshaven `anomalie_1`, source tables and indexes **byte-identical**. Köln `anomalie_1`: identical apart from `id` and `target_id`; **all 127 ids equal `public.anomalies`'**; `target_id` values unchanged, now 3 decimals |
| 2 | Second run | skipped by the checksum gate. A forced run: 0 inserted, staged, paired or rewritten, every snapshot identical |
| 3 | Test row added to `Magnetic` | exactly 1 target inserted, `pending`, **`2736-3014`** (highest ever issued: 3013), geometry and lat/lon from the trigger; every other target and all feedback unchanged |
| 4 | Category changed in `Georadar` (`2736-1584`, Kat-2 → Kat-3) | **staged, not applied**. `etl_pipeline` cannot approve it, write a decision, update the row, or carry out an unapproved change; `etl_approver` cannot write the table either. After `etl-approve approve-change`, the next run applied the approved value (the pipeline's later edit of its staged row to `Kat-9` had no effect), touching only that row's category |
| 5 | Test row moved 5 cm (`Rechtswert` +0.05) | **paired** with its old target by source key (`Nummer`), held back, not inserted; `public.anomalies` unchanged; DB-only set change reported as a WARNING. `etl_pipeline` cannot approve the pair. After `etl-approve approve-correction`: same id, VM number and `target_id`, new coordinates, still no second target |
| 7 | A device syncs during a run; a pre-existing feedback row disappears during a run | see [The gates, in steady state](#the-gates-in-steady-state) |
| 6 | Invariants | feedback 16 and byte-identical throughout; GIST and query indexes intact; every run `ok` or `skipped`; `dbt test` 32 pass, 1 warning (the corrected test row: `target_id` kept, coordinates changed, by design), 0 errors |

Reported each run and correct for the data: the two duplicate positions (`Nummer`
180/181; `Georadar Array 1`/`Array 2`), and the six Wilhelmshaven tables no source uses
(`Stoerkoerper Magnetik Nord`, `Stoerkoerper Magnetik Sued 1`, `magnetic_data`,
`magnetic_raw_data`, `radar_data`, `radar_raw_data`).

### First supervised run on live (2026-09-24)

- **Backup:** `backup-nolte_geoservices-20260924-085132.sql`, restored into a scratch
  database: all 55 tables identical (count + md5).
- **`setup-sql` applied to live**, the same SQL as tested. Afterwards `etl_pipeline` has
  `SELECT` + `INSERT` on `public.anomalies`, no column `UPDATE`, owns both `anomalie_1`.
- **First attempt stopped in validation, before writing anything:** live revokes
  PUBLIC's `USAGE` on `information_schema` (and PUBLIC's `TEMPORARY` on the database),
  which a restored copy does not reproduce. Fixed in `fix/etl-live-acls`: the runner reads
  `pg_catalog`, `setup-sql` grants `TEMPORARY` to `etl_pipeline`, and the acceptance suite
  now reproduces live's ACLs on the copy (52/52 under them). The attempt left only the
  pipeline's own empty `etl` tables. Live was re-checked identical to the backup before
  the retry.
- **Run 1: ok.** dbt 33/33 pass, 0 warnings. Gates: feedback 16, lost 0, orphaned 0,
  VM duplicates 0, id mismatches 0. Inserted 0, staged 0, correction pairs 0, DB-only 0.
  Köln `anomalie_1` rewritten (127/127), Wilhelmshaven `anomalie_1` untouched.
- **Verified against the pre-run backup:** of the 55 tables, **only Köln `anomalie_1`
  differs**. It is identical in every column except `id` and `target_id`: 127/127 ids
  equal `public.anomalies`', 0 null, and the `target_id` values are the same coordinates,
  now written with 3 decimals. `public.anomalies`, `feedback`, Wilhelmshaven
  `anomalie_1`, every source table and the archive are byte-identical.
- **Run 2: skipped** (no change since run 1).
- The scratch databases (`nolte_etl_acceptance`, the restore check) were dropped after
  verification.

Still yours to decide: the schedule (`ETL_INTERVAL_SECONDS`), and Phase 3 (retiring
`ingest_anomalies.py`, `sql/` and the CSVs; done 2026-09-25).

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
Dagster, which is lighter) later is a matter of wrapping `run.py` in a task.
**Decided (D5): the runner container.**

---

## Phase 2 plan

Not started until this is approved. The live migration waits for your go.

1. `pg_dump -Fc` of the live database, then restore it into a scratch database and
   compare row counts and checksums per table, to prove the dump restores.
2. Restore a second copy (`nolte_geoservices_etl_test`), apply the one-time grants
   there, and run everything against the copy only.
3. Pipeline on the copy. Prove, and report every difference: Köln reproduces live
   exactly (rows, ids, VM numbers, geometry); Wilhelmshaven's `anomalie_1` (2,215 rows)
   comes from the same model with no project-specific code; one added source row
   changes only that row, gets the next VM number, and moves no existing VM; one
   corrected coordinate produces a held-back correction pair, not a duplicate; a second
   run changes nothing; the indexes exist and the trigger derived geometry correctly.
4. The migration on the copy. **Done in advance on 2026-09-23** (see
   [the dry run](#dry-run-on-a-copy-2026-09-23-rev-4)): committed with all gates
   passing, verified from a new session. It is repeated with the built pipeline.
5. Old scripts stay in place. The live run is a separate step you approve, after the
   devices have synced.
