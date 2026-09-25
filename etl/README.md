# ETL pipeline

Keeps `public.anomalies` in step with the project schemas. Design and the reasons behind
every rule: [docs/ETL_DESIGN.md](../docs/ETL_DESIGN.md).

```
project schemas ──dbt──► etl.stg_candidates ─► etl.int_candidates ──runner merge──► public.anomalies
 (config/projects.yml)        (views, tables in the etl schema)        (one transaction,   + <schema>.anomalie_1
                                                                         gated)
```

- **Configuration only.** `config/projects.yml` names each project's schema, source tables,
  column mapping, SRID and VM prefix. Nothing project-specific is in the code.
- **Never deletes or rebuilds.** New targets are inserted as `pending` with the next VM
  number never issued before. The `etl_pipeline` role has no `UPDATE`, `DELETE` or
  `TRUNCATE` on `public.anomalies` at all.
- **Changes to existing rows need an approver.** They are staged; a separate login,
  `etl_approver`, decides; the next run carries out exactly what was approved, through
  functions the database only lets it call for an approved decision.
- **Idempotent.** A run with no source, config or decision change since the last
  successful run is skipped. A forced run with nothing to do writes nothing.

## One-time setup (admin, as `postgres`)

```sh
# 1. a password for the pipeline's own login, in .env (gitignored)
#    ETL_DB_USER=etl_pipeline
#    ETL_DB_PASSWORD=<random>
#    ETL_APPROVER_USER=etl_approver
#    ETL_APPROVER_PASSWORD=<another random>
# 2. build, then generate the grants from the config and apply them
docker compose --profile etl build etl
docker compose --profile etl run --rm --no-deps etl setup-sql > setup.sql
docker exec -i -e PGPASSWORD=... feedback_postgres_db psql -U postgres -d nolte_geoservices \
    -v ON_ERROR_STOP=1 -v etl_password="$ETL_DB_PASSWORD" \
    -v approver_password="$ETL_APPROVER_PASSWORD" < setup.sql
```

`setup-sql` creates both roles, the `etl` schema the pipeline owns, the approval schema
and functions, the grants per project schema, and read access to `spatial_ref_sys`
(PUBLIC's is revoked in this database). It also transfers each existing `anomalie_1` to
the pipeline. Safe to re-run; re-run it after adding a project.

## Running

```sh
docker compose --profile etl run --rm etl run            # one run
docker compose --profile etl run --rm etl run --force    # ignore the "nothing changed" check
docker compose --profile etl run --rm etl-approve        # what is waiting for a decision
```

Scheduling: `docker compose --profile etl up -d etl` starts the `loop` command. It does
nothing until `ETL_INTERVAL_SECONDS` is set above 0 in `.env`.

## Decisions

A run stages; the approver decides; the next run carries out exactly that. Decisions are
taken with the `etl-approve` service, which holds only the approver's login:
`docker compose --profile etl run --rm etl-approve approve-change 12 13`.

| Situation | What the run does | Decide with |
|---|---|---|
| A source value differs from an existing target (category, layer, depth, instrument) | stages it in `etl.change_log` | `approve-change ID...` / `approve-change --run RUN_ID` / `reject-change ID...` |
| A new source position lies within `correction_radius_m`, or has the same source key, as a target that just lost its source | pairs them in `etl.correction_candidates` and holds the new one back | `approve-correction PAIR_ID` (the existing target keeps its id, VM number, status and feedback and takes the new coordinates) / `reject-correction PAIR_ID` (inserted as a new target) |
| Pair where the old target was also moved in the field | status `conflict`: never resolved automatically | as above, after checking with the crew |
| A target no source produces any more | listed every run; a WARNING when that set changes | nothing is ever deleted |
| A source row with no category and no usable fallback | left out and listed | fix the source |

## Tests

- `dbt test` runs at the end of every run: keys, relationships, the uuid5 identity rule,
  every feedback row resolving, each `anomalie_1` agreeing with `public.anomalies`, and
  the app's indexes (including the GIST index) present.
- `tests/acceptance.py <copy_db>` runs the full acceptance suite against a **copy** of
  the database (it refuses the live name). See the design doc for the last result.

## Pre-existing tools

`ingest_anomalies.py`, `sql/` and the CSVs were removed on 2026-09-25, after the
pipeline replaced them on live (last present in `cd69945`).
