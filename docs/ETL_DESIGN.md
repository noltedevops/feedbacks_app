# ETL design: project schemas → `public.anomalies`

Status: **proposal, revision 2, awaiting approval** (Phase 1, 2026-09-23). Nothing
described under *Design* exists yet. The audit was read-only: every query ran in a
`default_transaction_read_only` session, and nothing in the database was changed.

Revision 2 applies the decisions of 2026-09-23. Wilhelmshaven's source is the new
`Magnetic` + `Georadar` tables, its `target_id` uses the stored values rather than the Köln
rounding, and its 1,583 current rows are replaced once by a
[one-time migration](#one-time-migration-replacing-the-11-24-2736-rows).

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

All figures below are from the live database on 2026-09-23. They were computed
read-only, with the configuration exactly as specified.

**1. Column names.** Magnetic and Georadar do not name their coordinates the same way:

| Table | Easting | Northing | Type | As text |
|---|---|---|---|---|
| `Magnetic` | **`Rechtswert`** (there is no `Rechswert` in this table) | `Hochwert` | `numeric(10,3)` | always 3 decimals, trailing zeros kept: `443656.190` |
| `Georadar` | `East` | `North` | `numeric(23,15)` | always 15 decimals, zero-padded: `443860.056540399960000` |
| `Georadar` (also present) | `Rechswert` (sic) | `Hochwert` | `numeric`, scale 3 on every row | `443860.057`. Equals `round(East, 3)` on all 1,476 rows |

Both are right. Georadar has `East`/`North` *and* `Rechswert`/`Hochwert`, and the
latter are the former rounded to 3 decimals. This design uses `East`/`North` for
Georadar as instructed, and `Rechtswert`/`Hochwert` for Magnetic.

**2. How the stored value becomes text.** `numeric::text` prints exactly the column's
declared scale, including trailing zeros. So "as stored" means:

- Magnetic: `11-24-2736-443656.190-5935538.441`, 3 decimals.
- Georadar: `11-24-2736-443860.056540399960000-5935267.570306600000000`, 15 decimals, 57
  characters, within `varchar(100)`.

That output depends on the column's type. If a QGIS re-import changes
`numeric(23,15)` to another scale, every Georadar `target_id`, and so every id, would
change. **The configuration therefore pins the number of decimals per source**
(`id_decimals: 3` for Magnetic, `15` for Georadar), and the model renders
`round(value, id_decimals)::text`. Today that is byte-for-byte what is stored. After a
type change it still is. Note that the 15-decimal values carry floating-point noise
from the import (`…056540399960000`): they are what was stored, not surveyed precision.

**3. Does it reproduce the existing `target_id`s?**

| Source | Rows | Distinct `target_id` | Reproduce an existing one |
|---|---:|---:|---:|
| `Magnetic` (3 decimals) | 741 | 740 | **740 of 740**, all identical: same id, same row, feedback stays linked |
| `Georadar` from `East`/`North` (15 decimals) | 1,476 | 1,475 | **0**. The 45 existing radar targets reappear 0.0003–0.0007 m away under new ids |
| *for comparison:* `Georadar` from `Rechswert`/`Hochwert` | 1,476 | 1,475 | 45 of 45 |

The 45 radar targets carry no feedback and are all `pending`, so re-keying them loses no
field data. They do get new ids and new VM numbers (see [D9](#decisions)).

**4. Category.** `Magnetic` has no `Target Pic` column and no null category (741 ×
`Kat-1`), so the fallback applies to **0** rows there. In `Georadar`, **988** rows take
their category from `Target Pic`: `Kat. 1` → `Kat-1` ×31, `Kat. 2` → `Kat-2` ×924,
`Kat. 3` → `Kat-3` ×33. **No row** has a null category with an empty or non-numeric
`Target Pic`. The 488 `Rebar_00n` rows all have a category, so the rule never reads
`Rebar_002` as a number. If one of them ever lost its category, the rule would make it
`Kat-2`. Check that is what you would want.

**5. The migration as specified cannot pass its own check.** Of the 62 Wilhelmshaven
feedback rows:

- **10** find their new anomaly by identical `target_id`, including `2736-1000`, the one
  Wilhelmshaven row known to be a real field submission.
- **52 find nothing.** 34 are on `Nord Restflaeche`, a layer the new tables do not have.
  18 are the DB-only `Sued 1` rows. The nearest new point to any of them is **0.50 m**
  away (median 8.8 m, max 26.8 m), usually a *georadar* pick in another layer. That is a
  different target, not a moved one, so no tolerance was applied and none is proposed.
  These 52 are listed as unmatched. All 52 come from the 2026-07-15 bulk insert of
  unknown provenance, and per the standing rule none is treated as disposable.

And because every foreign key into `public.anomalies` is **`ON DELETE CASCADE`**,
deleting those 52 anomalies would not leave orphaned feedback. **It would silently
delete the 52 feedback rows**, and a "zero orphans" check would still pass. The
migration's gate therefore checks that the **feedback row count is unchanged (68)**,
not only that there are no orphans. With the 52 unmatched, that gate fails and the
transaction rolls back. You need to decide what happens to them ([D8](#decisions))
before the migration can run.

**6. D7, the Sued 2 defect.** `Magnetic` contains **no `Sued 2` rows at all** (only `Nord`
479 and `Sued 1` 262; eastings 442,966–443,842), so the defect does not exist there and
nothing needs fixing. The 429 `Sued 2` targets are among the rows that disappear.

---

## Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Wilhelmshaven source | **Decided:** `Magnetic` + `Georadar`. `magnetic_data` / `radar_data` are not used |
| D2 | uuid5 | **Decided:** a Python step in the runner, using `uuid.uuid5(uuid.NAMESPACE_DNS, target_id)`, the call that produced the existing ids |
| D3 | Changes to existing rows | **Decided:** staged for approval; new targets go in automatically |
| D4 | Where `anomalie_1` lives | **Decided:** in each project schema |
| D5 | Scheduler | **Decided:** the small runner container |
| D6 | DB-only rows | **Decided:** reported every run; a warning only when the set changes |
| D7 | Sued 2 defect | **Resolved:** not present in `Magnetic` (it has no Sued 2 rows) |
| **D8** | **The 52 unmatched feedback rows** | **Open, blocks the migration.** Options: **(a)** keep the anomalies that carry them (52 rows, or all 369 `Restflaeche` + DB-only `Sued 1` rows) and delete only old rows without feedback; the kept ones become DB-only rows, reported every run. **(b)** Add the missing targets to the source tables first. `Restflaeche` exists in `magnetic_data` at 3 decimals, so imported into `Magnetic` it would match by `target_id` exactly, keeping ids, VM numbers and feedback. The 18 exist in no table except `public.anomalies`, so they would have to be exported from there. **(c)** Accept losing them. Not recommended, and it contradicts the standing rule. |
| **D9** | **VM numbers for Wilhelmshaven** | **Open.** "Same logic as Köln" is `ROW_NUMBER() OVER (ORDER BY random())`, which renumbers everything. That conflicts with requirement 3 ("existing rows keep their vm_nr forever"): the 740 kept magnetic targets hold `2736-46…2736-1136` today, and crews use those numbers. Recommendation: kept rows keep their number; new rows get `max + 1…` from the registry, never reusing a retired number, even `2736-1…45` from the re-keyed radar targets. |
| **D10** | **Status of kept rows** | **Open.** "status: 'pending'" read literally would reset the 10 kept targets with feedback (and `2736-1040`, investigated with no feedback, also kept) to `pending`. Recommendation: `pending` for new rows only; kept rows keep their status (requirement 4). |
| **D11** | **Duplicate positions** | **Open.** Georadar has one position twice, in `Array 1` and `Array 2` (same depth and category), and Magnetic has `Nummer` 180/181 twice in `Nord` (identical). One target each. Recommendation: identical rows collapse; otherwise the first source in config order wins and the layer is taken from it (`Array 1`); both are listed in the run report. |

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

With the decided configuration (Magnetic `Rechtswert`/`Hochwert` at 3 decimals,
Georadar `East`/`North` at 15, both as stored):

| | Rows |
|---|---:|
| New `anomalie_1` (distinct `target_id`) | **2,215**: 740 magnetic + 1,475 georadar |
| …identical to an existing target (id, feedback and history kept) | **740**, all magnetic, VM `2736-46…2736-1136` |
| …new targets | **1,475**, all georadar. 45 of them are the existing radar targets re-keyed (see below) |
| Existing targets with no identical counterpart | **843** |

The 843, by layer:

| Layer | Old rows | `investigated` | With feedback | Nearest new point (same instrument), worst case |
|---|---:|---:|---:|---:|
| Georadar, 6 layers | 45 | 0 | 0 | **0.0007 m**: the same points, re-keyed by the 15-decimal `target_id` |
| Stoerkoerper Magnetik Nord Restflaeche | 351 | 34 | **34** | 46.4 m. The layer is not in the new tables |
| Stoerkoerper Magnetik Sued 1 (DB-only, `2736-1566…1583`) | 18 | 18 | **18** | 30.4 m |
| Stoerkoerper Magnetik Sued 2 | 429 | 1 (`2736-1186`, no feedback) | 0 | 92.4 m. The layer is not in the new tables |
| **Total** | **843** | **53** | **52** | |

No value differences on the 740 kept rows: instrument, layer, depth and category
(`Kat-1`) are the same in source and live.

Duplicates the pipeline must handle deterministically ([D11](#decisions)):

- `Nummer` 180 and 181 in `Magnetic` (`Nord`) are the same point with identical values.
  Live holds it once, as `2736-225`.
- One Georadar position is in both `Array 1` and `Array 2`, with the same depth and
  category.

*Revision 1 compared the old CSV mirrors (`magnetic_data` + `radar_data`), which would
have reproduced 1,565 of the 1,583 rows. That option is retired by decision D1.*

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
        id_decimals: 15          # numeric(23,15), as stored: 443860.056540399960000
        columns:
          easting: East
          northing: North
          depth: { column: "Tiefe [m]" }
          category: { column: category, fallback: { column: "Target Pic", rule: trailing_number } }
          layer: layer
```

- `coord_round` (optional) rounds the stored coordinates before anything else. Only Köln
  sets it. Without it, coordinates are used exactly as stored.
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
verified against Python's `.3f`. Wilhelmshaven: no rounding, 3 decimals for Magnetic,
15 for Georadar (see [Before building](#before-building-what-the-numbers-say)).

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
never deleting. The script needs `DELETE` on `public.anomalies` and `UPDATE` on
`public.feedback`, which `etl_pipeline` must never have, so it runs once as an admin
role and is then retired.

### Preconditions

1. Every field device has synced (you confirm). A device that syncs afterwards with
   feedback for a deleted anomaly would have that feedback skipped (`/api/sync` skips
   feedback whose anomaly is missing).
2. A `pg_dump -Fc` backup, **restored into a scratch database and compared** (row count
   and md5 per table) before anything runs.
3. D8–D11 decided.
4. The pipeline has built `p_11_24_2736_…anomalie_1` (2,215 rows), and it is the input.

### Matching, old → new

| Tier | Rule | Anomalies matched | Feedback rows matched |
|---|---|---:|---:|
| 1 | identical `target_id` (same id, nothing to re-point) | 740 | **10** |
| 2 | same instrument, distance ≤ **0.001 m** | 45 (the re-keyed radar targets, 0.0003–0.0007 m) | **0** (they have none) |
| none | | 798 | **52**, listed in the migration report by feedback id, VM number and layer |

The 1 mm tolerance is set by the data. The re-keyed radar points sit at ≤ 0.0007 m
(rounding of the 15-decimal values), and the next-closest candidate for any leftover
target is 0.50 m away, a different target. Any tolerance between 1 mm and 0.5 m
gives the same result. Larger ones start linking unrelated targets, often across
instruments. The 45 tier-2 targets are the same physical targets, so the recommendation
under D9 is that they keep their VM numbers (`2736-1…45`) on their new ids.

### Steps, in one transaction

```
LOCK public.anomalies, public.feedback   -- no sync can interleave
1. build the old→new map (tiers above) into a temp table
2. update kept rows (tier 1) from anomalie_1: category, layer, evaluated_depth only
   (0 differences today); status untouched (D10)
3. insert the new rows (status 'pending', VM numbers per D9)
4. re-point feedback whose anomaly changed: anomaly_id AND target_id (0 rows today)
   and set those new anomalies to 'investigated'
5. delete old 11-24-2736 rows with no counterpart, except those kept under D8
6. gates, else ROLLBACK:
   - feedback row count = 68 (a CASCADE delete leaves no orphans, so orphans alone prove nothing)
   - 0 orphaned feedback; every feedback.project_id = its anomaly's project_id
   - every feedback.target_id = its anomaly's target_id
   - 11-26-5151 rows byte-identical to before (md5 over the project's rows)
   - Wilhelmshaven row count and investigated count = the expected figures below
   - every id = uuid5(target_id); vm_nr unique
COMMIT
7. record every VM number ever issued for 11-24-2736 (2736-1…1583 and the new ones)
   in etl.vm_registry, so a retired number is never reissued
```

### Expected figures, by D8 option

| | (a) keep only the 52 with feedback | (a′) keep all `Restflaeche` + DB-only `Sued 1` (369) | (c) delete all 843 |
|---|---:|---:|---:|
| Kept (identical) | 740 | 740 | 740 |
| Inserted | 1,475 | 1,475 | 1,475 |
| Kept without a source (DB-only afterwards) | 52 | 369 | 0 |
| Deleted | 791 | 474 | 798 + 45 re-keyed |
| **11-24-2736 rows after** | **2,267** | **2,584** | 2,215 |
| **Feedback rows after** | **68** | **68** | **16**, gate fails |
| `investigated` after | 63 (loses `2736-1186`, Sued 2, no feedback) | 63 | 11 |

Option (b), importing the missing targets into the source tables first, changes the
inputs, so its figures are computed once the import exists.

Figures are from the live database on 2026-09-23. They are recomputed on the copy, and
every difference is reported, before you approve the live run.

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
Dagster, which is lighter) later is a matter of wrapping `run.py` in a task.
**Decided (D5): the runner container.**

---

## Phase 2 plan

Not started until this is approved, and the migration not until D8–D11 are decided.

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
4. The migration on the copy: the matching report (tiers, the 52 listed), the expected
   figures against the actual ones, 68/68 feedback resolving, a forced gate failure
   showing the rollback leaves the copy untouched.
5. Old scripts stay in place. The live run is a separate step you approve, after the
   devices have synced.
