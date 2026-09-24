"""ETL runner: project schemas -> <schema>.anomalie_1 -> public.anomalies.

Design: docs/ETL_DESIGN.md. The rules this file enforces:

* public.anomalies is merged, never rebuilt: new targets are INSERTed as 'pending';
  changes to existing rows are STAGED in etl.change_log and applied only once approved;
  nothing is ever deleted (the etl_pipeline role has no DELETE or TRUNCATE on it).
* ids are uuid5(NAMESPACE_DNS, target_id), computed here with Python's uuid module,
  the call that produced every existing id.
* VM numbers: existing targets keep theirs; new ones continue from the highest number
  ever issued for the project (etl.vm_registry), so none is ever reused.
* A run that finds no source change since the last successful run does nothing.
* The merge is one top-level transaction with gates; any failed gate rolls it all back.

Commands:
  run [--force]                 one pipeline run
  loop                          run every ETL_INTERVAL_SECONDS (the container's command)
  status                        pending approvals, DB-only rows, last runs
  approve-change ID... | --run RUN_ID     approve staged value changes
  reject-change ID...
  approve-correction PAIR_ID    accept a coordinate-correction pair
  reject-correction PAIR_ID     treat it as a new target instead
  setup-sql                     print the one-time admin SQL (run it as postgres)

Connection: ETL_DB_HOST, ETL_DB_PORT, ETL_DB_NAME, ETL_DB_USER, ETL_DB_PASSWORD.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

import psycopg
import yaml
from psycopg import sql

HERE = Path(__file__).resolve().parent
ETL_DIR = HERE.parent
CONFIG_PATH = Path(os.environ.get("ETL_CONFIG", ETL_DIR / "config" / "projects.yml"))
DBT_DIR = ETL_DIR / "dbt"
LOCK_KEY = "nolte_etl_pipeline"

# anomalie_1: the shape of the original Köln table, kept for every project.
ANOMALIE_1_COLUMNS = [
    ("id", "varchar(36)"), ("project_id", "varchar(50)"), ("instrument", "varchar(50)"),
    ("easting", "double precision"), ("northing", "double precision"),
    ("latitude", "double precision"), ("longitude", "double precision"),
    ("vm_nr", "varchar(50)"), ("category", "varchar(50)"), ("layer", "varchar(255)"),
    ("status", "varchar(50)"), ("target_id", "varchar(100)"), ("evaluated_depth", "double precision"),
]
# The only columns of existing rows the pipeline may change, and only after approval.
STAGED_COLUMNS = [("category", "varchar"), ("layer", "varchar"),
                  ("evaluated_depth", "double precision"), ("instrument", "varchar")]

BOOTSTRAP_SQL = """
create table if not exists etl.runs (
    run_id       bigserial primary key,
    started_at   timestamptz not null default now(),
    finished_at  timestamptz,
    status       text not null default 'running',   -- running | ok | skipped | failed
    forced       boolean not null default false,
    fingerprint  jsonb,
    summary      jsonb
);
create table if not exists etl.id_registry (
    target_id  varchar(100) primary key,
    id         varchar(36) not null unique
);
create table if not exists etl.vm_registry (
    project_id  varchar(50) not null,
    vm_number   integer not null,
    vm_nr       varchar(50) not null unique,
    target_id   varchar(100),
    origin      text not null,                       -- seed:<table> | pipeline
    issued_run  bigint,
    primary key (project_id, vm_number)
);
create table if not exists etl.change_log (
    change_id    bigserial primary key,
    run_id       bigint not null,
    project_id   varchar(50) not null,
    anomaly_id   varchar(36) not null,
    vm_nr        varchar(50),
    column_name  text not null,
    old_value    text,
    new_value    text,
    status       text not null default 'staged',     -- staged | approved | applied | rejected | superseded | stale
    staged_at    timestamptz not null default now(),
    decided_at   timestamptz,
    decided_by   text,
    applied_run  bigint
);
create unique index if not exists change_log_open
    on etl.change_log (anomaly_id, column_name) where status in ('staged', 'approved');
create table if not exists etl.anomaly_state (
    anomaly_id        varchar(36) primary key,
    project_id        varchar(50) not null,
    source_table      text,
    source_key        text,
    last_db_easting   double precision,
    last_db_northing  double precision,
    first_seen_run    bigint,
    last_seen_run     bigint
);
create table if not exists etl.correction_candidates (
    pair_id          bigserial primary key,
    run_id           bigint not null,
    project_id       varchar(50) not null,
    source_table     text,
    source_key       text,
    new_target_id    varchar(100) not null,
    new_easting      double precision not null,
    new_northing     double precision not null,
    old_anomaly_id   varchar(36) not null,
    old_vm_nr        varchar(50),
    old_easting      double precision,
    old_northing     double precision,
    distance_m       double precision,
    matched_by       text not null,                  -- source_key | distance
    old_has_feedback boolean,
    old_status       varchar(50),
    status           text not null default 'pending', -- pending | conflict | accepted | applied | rejected
    decided_at       timestamptz,
    decided_by       text,
    applied_run      bigint
);
create unique index if not exists correction_open
    on etl.correction_candidates (new_target_id) where status in ('pending', 'conflict', 'accepted');
create table if not exists etl.db_only_state (
    project_id  varchar(50) primary key,
    anomaly_ids text[] not null,
    run_id      bigint not null
);
"""


# ----------------------------------------------------------------------------- helpers
def load_config() -> dict:
    cfg = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    ids = [p["project_id"] for p in cfg["projects"]]
    if len(ids) != len(set(ids)):
        raise SystemExit("config: duplicate project_id")
    for p in cfg["projects"]:
        for key in ("project_id", "project_name", "schema", "srid", "vm_prefix", "sources"):
            if key not in p:
                raise SystemExit(f"config: project {p.get('project_id')} lacks {key}")
        for s in p["sources"]:
            for key in ("table", "instrument", "id_decimals", "columns"):
                if key not in s:
                    raise SystemExit(f"config: {p['project_id']}/{s.get('table')} lacks {key}")
    return cfg


def connect(approver: bool = False) -> psycopg.Connection:
    """The pipeline connects as etl_pipeline; decisions are taken as etl_approver, a
    separate login the pipeline process is never given."""
    env = os.environ
    user_var, pw_var = ("ETL_APPROVER_USER", "ETL_APPROVER_PASSWORD") if approver else ("ETL_DB_USER", "ETL_DB_PASSWORD")
    missing = [k for k in ("ETL_DB_HOST", "ETL_DB_NAME", user_var, pw_var) if not env.get(k)]
    if missing:
        raise SystemExit(f"missing environment: {', '.join(missing)}")
    return psycopg.connect(host=env["ETL_DB_HOST"], port=int(env.get("ETL_DB_PORT", "5432")),
                           dbname=env["ETL_DB_NAME"], user=env[user_var], password=env[pw_var],
                           application_name="nolte_etl_approver" if approver else "nolte_etl")


def ident(*parts: str) -> sql.Identifier:
    return sql.Identifier(*parts)


def referenced_columns(source: dict) -> set[str]:
    cols: set[str] = set()
    def add(spec):
        if spec is None:
            return
        if isinstance(spec, str):
            cols.add(spec)
        elif "column" in spec:
            cols.add(spec["column"])
            if "fallback" in spec:
                cols.add(spec["fallback"]["column"])
    for spec in source["columns"].values():
        add(spec)
    for c in (source.get("id_columns") or {}).values():
        cols.add(c)
    if source.get("key"):
        cols.add(source["key"])
    return cols


def validate_sources(conn, cfg) -> list[str]:
    """Every configured table and column must exist; returns tables nobody configured.
    Reads pg_catalog: PUBLIC's access to information_schema is revoked on live."""
    problems, unconfigured = [], []
    for p in cfg["projects"]:
        tables = {r[0] for r in conn.execute(
            "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace "
            "where n.nspname = %s and c.relkind in ('r', 'p', 'v', 'm', 'f')", (p["schema"],))}
        configured = {s["table"] for s in p["sources"]} | {"anomalie_1"}
        unconfigured += [f"{p['schema']}.{t}" for t in sorted(tables - configured)]
        for s in p["sources"]:
            if s["table"] not in tables:
                problems.append(f"{p['schema']}.{s['table']}: table not found")
                continue
            have = {r[0] for r in conn.execute(
                "select a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid "
                "join pg_namespace n on n.oid = c.relnamespace "
                "where n.nspname = %s and c.relname = %s and a.attnum > 0 and not a.attisdropped",
                (p["schema"], s["table"]))}
            for c in sorted(referenced_columns(s) - have):
                problems.append(f"{p['schema']}.{s['table']}: column {c!r} not found")
    if problems:
        raise SystemExit("config does not match the database:\n  " + "\n  ".join(problems))
    return unconfigured


def fingerprint(conn, cfg) -> dict:
    """What a run depends on. Unchanged since the last successful run = nothing to do."""
    fp = {"config": hashlib.sha256(CONFIG_PATH.read_bytes()).hexdigest(), "sources": {}, "public": {}}
    for p in cfg["projects"]:
        for s in p["sources"]:
            q = sql.SQL("select count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t::text), '')) "
                        "from {} t").format(ident(p["schema"], s["table"]))
            fp["sources"][f"{p['schema']}.{s['table']}"] = conn.execute(q).fetchone()[0]
        fp["public"][p["project_id"]] = conn.execute(
            "select count(*)::text || ':' || md5(coalesce(string_agg(id || '/' || coalesce(vm_nr, '') || '/' || target_id, '|' order by id), '')) "
            "from public.anomalies where project_id = %s", (p["project_id"],)).fetchone()[0]
    # decisions the approver has taken that no run has processed yet
    fp["decisions"] = conn.execute("select count(*) from etl_approval.decisions where outcome is null").fetchone()[0]
    return fp


def dbt(*args: str, cfg: dict) -> None:
    cmd = ["dbt", *args, "--project-dir", str(DBT_DIR), "--profiles-dir", str(DBT_DIR),
           "--vars", json.dumps({"etl": cfg}), "--no-use-colors"]
    print("  $", " ".join(cmd[:3]), "...", flush=True)
    res = subprocess.run(cmd, cwd=DBT_DIR, capture_output=True, text=True)
    out = res.stdout + res.stderr
    tail = [l for l in out.splitlines() if any(k in l for k in ("PASS", "WARN", "ERROR", "FAIL", "Done.", "Completed", "error"))]
    print("    " + "\n    ".join(tail[-40:]), flush=True)
    if res.returncode != 0:
        raise RuntimeError(f"dbt {args[0]} failed (exit {res.returncode})\n{out[-4000:]}")


# ----------------------------------------------------------------------------- the run
def run(force: bool = False) -> int:
    cfg = load_config()
    conn = connect()
    if not conn.execute("select pg_try_advisory_lock(hashtext(%s))", (LOCK_KEY,)).fetchone()[0]:
        print("another run holds the lock; nothing done")
        return 0
    conn.execute(BOOTSTRAP_SQL)
    conn.commit()

    unconfigured = validate_sources(conn, cfg)
    fp = fingerprint(conn, cfg)
    last = conn.execute("select fingerprint from etl.runs where status = 'ok' order by run_id desc limit 1").fetchone()
    run_id = conn.execute("insert into etl.runs (forced, fingerprint) values (%s, %s) returning run_id",
                          (force, json.dumps(fp))).fetchone()[0]
    conn.commit()
    print(f"run {run_id} ({'forced' if force else 'scheduled'})")

    if last and last[0] == fp and not force:
        conn.execute("update etl.runs set status = 'skipped', finished_at = now(), summary = %s where run_id = %s",
                     (json.dumps({"reason": "no source, config or decision change since the last successful run"}), run_id))
        conn.commit()
        print("  no change since the last successful run: skipped")
        return 0

    try:
        dbt("run", "--select", "stg_candidates", "excluded_rows", "dup_report", cfg=cfg)
        register_ids(conn)
        dbt("run", "--select", "int_candidates", cfg=cfg)
        summary = merge(conn, cfg, run_id)
        summary["unconfigured_tables"] = unconfigured
        summary["excluded_rows"] = [dict(zip(("project_id", "source_table", "source_key", "layer"), r)) for r in
                                    conn.execute("select project_id, source_table, source_key, layer from etl.excluded_rows order by 1, 2, 3")]
        summary["duplicates"] = [dict(zip(("project_id", "target_id", "rows"), r)) for r in
                                 conn.execute("select project_id, target_id, rows from etl.dup_report order by 1, 2")]
        conn.commit()
        dbt("test", cfg=cfg)
        # The fingerprint is re-taken after the merge: the merge itself changes public.
        conn.execute("update etl.runs set status = 'ok', finished_at = now(), fingerprint = %s, summary = %s where run_id = %s",
                     (json.dumps(fingerprint(conn, cfg)), json.dumps(summary, default=str), run_id))
        conn.commit()
        report(summary)
        return 0
    except Exception as exc:  # noqa: BLE001 - every failure is recorded and re-raised
        conn.rollback()
        conn.execute("update etl.runs set status = 'failed', finished_at = now(), summary = %s where run_id = %s",
                     (json.dumps({"error": str(exc)[:4000]}), run_id))
        conn.commit()
        print(f"RUN {run_id} FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


def register_ids(conn) -> None:
    """uuid5 for every target_id the pipeline or the app knows. Append-only."""
    missing = [r[0] for r in conn.execute(
        "select target_id from etl.stg_candidates union select target_id from public.anomalies "
        "except select target_id from etl.id_registry")]
    with conn.cursor() as cur:
        cur.executemany("insert into etl.id_registry (target_id, id) values (%s, %s)",
                        [(t, str(uuid.uuid5(uuid.NAMESPACE_DNS, t))) for t in missing if t])
    conn.commit()
    print(f"  id registry: +{len(missing)}")


def merge(conn, cfg, run_id: int) -> dict:
    s: dict = {"run_id": run_id, "projects": {}}
    conn.commit()  # the merge must be a top-level transaction, never a savepoint
    assert conn.info.transaction_status == psycopg.pq.TransactionStatus.IDLE
    radius = float(cfg.get("correction_radius_m", 1.0))
    with conn.transaction():
        # No table lock: blocking other writers needs table-wide UPDATE/DELETE/TRUNCATE,
        # which this role deliberately lacks. Nothing requires it. Runs cannot overlap (the
        # advisory lock). The app only writes status and field-moved coordinates, which the
        # merge never touches. And every gate below holds under concurrent app writes:
        # it compares rows that existed at the start (ids, VM numbers, feedback) and
        # counts that may only grow.
        conn.execute("create temp table base_ids on commit drop as select id, vm_nr, project_id from public.anomalies")
        conn.execute("create temp table base_feedback on commit drop as select id from public.feedback")
        base = conn.execute("select (select count(*) from base_feedback), "
                            "(select md5(string_agg(id || ':' || vm_nr, '|' order by id)) from public.anomalies)").fetchone()
        base_proj = {r[0]: (r[1], r[2]) for r in conn.execute(
            "select project_id, count(*), count(*) filter (where status = 'investigated') from public.anomalies group by 1")}

        # 1. projects the FK needs
        for p in cfg["projects"]:
            conn.execute("insert into public.projects (project_id, project_name, created_at, updated_at) "
                         "values (%s, %s, now(), now()) on conflict (project_id) do nothing",
                         (p["project_id"], p["project_name"]))

        # 2. every VM number ever issued: public, plus any archive table that holds some
        seed_vm_registry(conn, cfg)

        # 3. the approver's decisions since the last run. Only etl_admin functions can
        #    carry them out, and only as the approver took them (etl_pipeline has no
        #    UPDATE on public.anomalies at all).
        s["corrections_applied"] = apply_decided_corrections(conn, run_id)
        s["changes_applied"] = apply_decided_changes(conn, run_id)
        if s["corrections_applied"]:
            # an applied correction maps the corrected source row onto the existing target
            conn.execute("""update etl.int_candidates c set id = d.anomaly_id, target_id = p.target_id, via_alias = true
                              from etl_approval.decisions d join public.anomalies p on p.id = d.anomaly_id
                             where d.kind = 'correction' and d.decision = 'approve' and d.outcome = 'applied'
                               and d.new_target_id = c.source_target_id and c.id is distinct from d.anomaly_id""")

        for p in cfg["projects"]:
            pid = p["project_id"]
            ps: dict = {}
            conn.execute("create temp table cand on commit drop as select * from etl.int_candidates where project_id = %s", (pid,))
            conn.execute("create temp table db_only on commit drop as "
                         "select a.* from public.anomalies a where a.project_id = %s "
                         "and not exists (select 1 from cand c where c.id = a.id)", (pid,))
            # 4. new candidates, and the ones held back by a correction pair
            conn.execute("""create temp table fresh on commit drop as
                select c.* from cand c
                 where not exists (select 1 from public.anomalies a where a.id = c.id)""")
            ps["correction_pairs_new"] = pair_corrections(conn, run_id, pid, radius)
            conn.execute("""delete from fresh f using etl.correction_candidates k
                             where k.new_target_id = f.source_target_id and k.status in ('pending', 'conflict', 'accepted')""")
            # 5. insert new targets: pending, next VM numbers, geometry by the app's trigger
            ps["inserted"] = insert_new(conn, run_id, p)
            # 6. stage value changes on existing rows
            ps["changes_staged"] = stage_changes(conn, run_id, pid)
            # 7. what the pipeline saw of each target, for pairing and field-move detection
            conn.execute("""insert into etl.anomaly_state as st (anomaly_id, project_id, source_table, source_key,
                                   last_db_easting, last_db_northing, first_seen_run, last_seen_run)
                            select a.id, a.project_id, c.source_table, c.source_key, a.easting, a.northing, %(r)s, %(r)s
                              from cand c join public.anomalies a on a.id = c.id
                            on conflict (anomaly_id) do update set
                                source_table = excluded.source_table, source_key = excluded.source_key,
                                last_db_easting = excluded.last_db_easting, last_db_northing = excluded.last_db_northing,
                                last_seen_run = excluded.last_seen_run
                            where (st.source_table, st.source_key, st.last_db_easting, st.last_db_northing)
                                  is distinct from (excluded.source_table, excluded.source_key,
                                                    excluded.last_db_easting, excluded.last_db_northing)""",
                         {"r": run_id})
            # 8. DB-only rows: reported every run, a warning when the set changes
            ps.update(db_only_report(conn, run_id, pid))
            # 9. the project's anomalie_1 = what its sources produce, as it stands in public
            ps["anomalie_1"] = sync_anomalie_1(conn, p)
            ps["open_pairs"] = conn.execute("select count(*) from etl.correction_candidates where project_id = %s "
                                            "and status in ('pending', 'conflict')", (pid,)).fetchone()[0]
            ps["staged_open"] = conn.execute("select count(*) from etl.change_log where project_id = %s "
                                             "and status = 'staged'", (pid,)).fetchone()[0]
            for t in ("cand", "db_only", "fresh"):
                conn.execute(sql.SQL("drop table {}").format(ident(t)))
            s["projects"][pid] = ps

        # Test hook, acceptance suite only: hold the transaction open so the suite can
        # write feedback the way a syncing device would, mid-run. Unset in production.
        pause = float(os.environ.get("ETL_TEST_PAUSE_BEFORE_GATES") or 0)
        if pause > 0:
            print(f"  TEST HOOK: paused {pause:.0f}s before the gates", flush=True)
            time.sleep(pause)

        # 10. gates
        g = {
            "feedback": conn.execute("select count(*) from public.feedback").fetchone()[0],
            "feedback_lost": conn.execute("select count(*) from base_feedback b where not exists "
                                          "(select 1 from public.feedback f where f.id = b.id)").fetchone()[0],
            "orphaned_feedback": conn.execute("select count(*) from public.feedback f left join public.anomalies a "
                                              "on a.id = f.anomaly_id where a.id is null").fetchone()[0],
            "existing_id_vm_md5": conn.execute("select md5(string_agg(a.id || ':' || a.vm_nr, '|' order by a.id)) "
                                               "from public.anomalies a join base_ids b on b.id = a.id").fetchone()[0],
            "vm_duplicates": conn.execute("select count(*) from (select vm_nr from public.anomalies group by 1 "
                                          "having count(*) > 1) x").fetchone()[0],
            "id_rule_mismatches": conn.execute("select count(*) from public.anomalies a left join etl.id_registry r "
                                               "on r.target_id = a.target_id where r.id is distinct from a.id").fetchone()[0],
            "anomalie_1_id_mismatches": sum(conn.execute(sql.SQL(
                "select count(*) from {} x left join public.anomalies a on a.target_id = x.target_id "
                "where x.id is null or (a.id is not null and a.id is distinct from x.id)").format(
                    ident(p["schema"], "anomalie_1"))).fetchone()[0] for p in cfg["projects"]),
        }
        now_proj = {r[0]: (r[1], r[2]) for r in conn.execute(
            "select project_id, count(*), count(*) filter (where status = 'investigated') from public.anomalies group by 1")}
        failed = []
        if g["feedback_lost"] or g["feedback"] < base[0]:
            failed.append(f"feedback lost: {g['feedback_lost']} rows gone ({base[0]} -> {g['feedback']})")
        if g["orphaned_feedback"]:
            failed.append(f"{g['orphaned_feedback']} orphaned feedback rows")
        if g["existing_id_vm_md5"] != base[1]:
            failed.append("an existing target's id or VM number changed")
        if g["vm_duplicates"]:
            failed.append(f"{g['vm_duplicates']} duplicate VM numbers")
        if g["id_rule_mismatches"]:
            failed.append(f"{g['id_rule_mismatches']} ids are not uuid5(target_id)")
        if g["anomalie_1_id_mismatches"]:
            failed.append(f"{g['anomalie_1_id_mismatches']} anomalie_1 ids differ from public.anomalies")
        for pid, (n, inv) in base_proj.items():
            n2, inv2 = now_proj.get(pid, (0, 0))
            if n2 < n:
                failed.append(f"{pid}: rows {n} -> {n2}")
            if inv2 < inv:
                failed.append(f"{pid}: investigated {inv} -> {inv2}")
        s["gates"] = g
        if failed:
            raise RuntimeError("GATES FAILED, rolled back: " + "; ".join(failed))
    return s


def seed_vm_registry(conn, cfg) -> None:
    prefixes = {p["project_id"]: p["vm_prefix"] for p in cfg["projects"]}
    tables = [("public", "anomalies")] + [tuple(r) for r in conn.execute(
        """select n.nspname, c.relname from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             join pg_attribute a on a.attrelid = c.oid
            where n.nspname = 'archive' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
              and a.attname in ('project_id', 'vm_nr', 'target_id')
            group by 1, 2 having count(*) = 3""")]
    for schema, table in tables:
        conn.execute(sql.SQL("""insert into etl.vm_registry (project_id, vm_number, vm_nr, target_id, origin)
                                 select distinct on (t.vm_nr) t.project_id, split_part(t.vm_nr, '-', 2)::int, t.vm_nr,
                                        t.target_id, %s
                                   from {} t
                                  where t.vm_nr ~ '^[0-9]+-[0-9]+$' and t.project_id = any(%s)
                                    and split_part(t.vm_nr, '-', 1) = (%s::jsonb ->> t.project_id)
                                 on conflict do nothing""").format(ident(schema, table)),
                     (f"seed:{schema}.{table}", list(prefixes), json.dumps(prefixes)))


def apply_decided_corrections(conn, run_id) -> int:
    """Carry out the approver's correction decisions. apply_correction moves the target
    to the coordinates the approver saw; the pipeline cannot move anything itself."""
    n = 0
    for did, pair_id, decision in conn.execute(
            "select decision_id, ref_id, decision from etl_approval.decisions "
            "where kind = 'correction' and outcome is null order by decision_id").fetchall():
        if decision == "approve":
            conn.execute("select etl_admin.apply_correction(%s)", (did,))
            status, n = "applied", n + 1
        else:
            conn.execute("select etl_admin.close_decision(%s, 'closed')", (did,))
            status = "rejected"
        conn.execute("update etl.correction_candidates set status = %s, applied_run = %s where pair_id = %s",
                     (status, run_id, pair_id))
    return n


def apply_decided_changes(conn, run_id) -> int:
    """Carry out the approver's change decisions. apply_change writes exactly the value
    the approver approved, and only while the live value is still the one it was staged
    against (else 'stale'). A change the source no longer asks for is closed unapplied."""
    n = 0
    for did, change_id, decision, anomaly_id, col, new in conn.execute(
            "select decision_id, ref_id, decision, anomaly_id, column_name, new_value from etl_approval.decisions "
            "where kind = 'change' and outcome is null order by decision_id").fetchall():
        if decision != "approve":
            conn.execute("select etl_admin.close_decision(%s, 'closed')", (did,))
            outcome = "rejected"
        else:
            src = conn.execute(sql.SQL("select {}::text from etl.int_candidates where id = %s").format(ident(col)),
                               (anomaly_id,)).fetchone()
            if src is None or src[0] != new:
                conn.execute("select etl_admin.close_decision(%s, 'superseded')", (did,))
                outcome = "superseded"
            else:
                outcome = conn.execute("select etl_admin.apply_change(%s)", (did,)).fetchone()[0]
                n += outcome == "applied"
        conn.execute("update etl.change_log set status = %s, applied_run = %s where change_id = %s",
                     (outcome, run_id, change_id))
    return n


def pair_corrections(conn, run_id, pid, radius) -> int:
    """A new candidate that matches a target which lost its source (same source key, or
    within the radius, same instrument) is a probable coordinate correction: pair it and
    hold it back for approval instead of inserting a second target."""
    return conn.execute("""
        insert into etl.correction_candidates (run_id, project_id, source_table, source_key, new_target_id,
               new_easting, new_northing, old_anomaly_id, old_vm_nr, old_easting, old_northing, distance_m,
               matched_by, old_has_feedback, old_status, status)
        select %(r)s, f.project_id, f.source_table, f.source_key, f.source_target_id, f.easting, f.northing,
               o.id, o.vm_nr, o.easting, o.northing, o.dist, o.matched_by,
               exists (select 1 from public.feedback fb where fb.anomaly_id = o.id), o.status,
               case when o.moved then 'conflict' else 'pending' end
          from fresh f
          cross join lateral (
              select d.id, d.vm_nr, d.easting, d.northing, d.status,
                     sqrt((d.easting - f.easting) ^ 2 + (d.northing - f.northing) ^ 2) as dist,
                     case when f.source_key is not null and st.source_table = f.source_table
                               and st.source_key = f.source_key then 'source_key' else 'distance' end as matched_by,
                     (d.easting, d.northing) is distinct from (st.last_db_easting, st.last_db_northing) as moved
                from db_only d
                join etl.anomaly_state st on st.anomaly_id = d.id           -- once produced by a source
               where d.instrument = f.instrument
                 and ((f.source_key is not null and st.source_table = f.source_table and st.source_key = f.source_key)
                      or sqrt((d.easting - f.easting) ^ 2 + (d.northing - f.northing) ^ 2) <= %(rad)s)
                 and not exists (select 1 from etl.correction_candidates k
                                  where k.old_anomaly_id = d.id and k.status in ('pending', 'conflict', 'accepted'))
               order by (f.source_key is not null and st.source_table = f.source_table and st.source_key = f.source_key) desc,
                        sqrt((d.easting - f.easting) ^ 2 + (d.northing - f.northing) ^ 2)
               limit 1) o
         where not exists (select 1 from etl.correction_candidates k
                            where k.new_target_id = f.source_target_id and k.status <> 'applied')
        """, {"r": run_id, "rad": radius}).rowcount


def insert_new(conn, run_id, p) -> int:
    pid, prefix = p["project_id"], p["vm_prefix"]
    start = conn.execute("select greatest(coalesce((select max(vm_number) from etl.vm_registry where project_id = %s), 0), "
                         "coalesce((select max(split_part(vm_nr, '-', 2)::int) from public.anomalies "
                         "where project_id = %s and vm_nr ~ '^[0-9]+-[0-9]+$'), 0))", (pid, pid)).fetchone()[0]
    conn.execute("""create temp table numbered on commit drop as
                    select f.*, %s + row_number() over (order by f.target_id collate "C") as vm_number from fresh f""", (start,))
    conn.execute("""insert into etl.vm_registry (project_id, vm_number, vm_nr, target_id, origin, issued_run)
                    select project_id, vm_number, %s || '-' || vm_number, target_id, 'pipeline', %s from numbered""",
                 (prefix, run_id))
    n = conn.execute("""insert into public.anomalies (id, project_id, instrument, easting, northing, vm_nr,
                               category, layer, status, target_id, evaluated_depth)
                        select id, project_id, instrument, easting, northing, %s || '-' || vm_number,
                               category, layer, 'pending', target_id, evaluated_depth
                          from numbered""", (prefix,)).rowcount
    conn.execute("drop table numbered")
    return n


def stage_changes(conn, run_id, pid) -> int:
    n = 0
    for col, _ in STAGED_COLUMNS:
        c = ident(col)
        # a staged/approved change the source no longer asks for is superseded
        conn.execute(sql.SQL("""update etl.change_log l set status = 'superseded', decided_at = now()
                                  from cand k join public.anomalies a on a.id = k.id
                                 where l.status in ('staged', 'approved') and l.column_name = %s and l.anomaly_id = a.id
                                   and k.{c}::text is distinct from l.new_value""").format(c=c), (col,))
        n += conn.execute(sql.SQL("""insert into etl.change_log (run_id, project_id, anomaly_id, vm_nr, column_name, old_value, new_value)
                                     select %s, a.project_id, a.id, a.vm_nr, %s, a.{c}::text, k.{c}::text
                                       from cand k join public.anomalies a on a.id = k.id
                                      where a.{c} is distinct from k.{c}
                                        and not exists (select 1 from etl.change_log l where l.anomaly_id = a.id
                                                        and l.column_name = %s and l.status in ('staged', 'approved'))""").format(c=c),
                          (run_id, col, col)).rowcount
    return n


def db_only_report(conn, run_id, pid) -> dict:
    ids = [r[0] for r in conn.execute("select id from db_only order by id")]
    vms = [r[0] for r in conn.execute("select vm_nr from db_only order by vm_nr")]
    prev = conn.execute("select anomaly_ids from etl.db_only_state where project_id = %s", (pid,)).fetchone()
    out = {"db_only": len(ids), "db_only_vm": vms[:50]}
    if prev is None or list(prev[0]) != ids:
        added = sorted(set(ids) - set(prev[0] if prev else []))
        removed = sorted(set(prev[0] if prev else []) - set(ids))
        if prev is not None:
            out["WARNING_db_only_changed"] = {"added": added, "removed": removed}
        conn.execute("insert into etl.db_only_state (project_id, anomaly_ids, run_id) values (%s, %s, %s) "
                     "on conflict (project_id) do update set anomaly_ids = excluded.anomaly_ids, run_id = excluded.run_id",
                     (pid, ids, run_id))
    return out


def sync_anomalie_1(conn, p) -> dict:
    """Bring <schema>.anomalie_1 to exactly the rows the sources produce, as they stand in
    public (id, VM number, target_id from there). Rows already right are not touched."""
    t = ident(p["schema"], "anomalie_1")
    cols = [c for c, _ in ANOMALIE_1_COLUMNS]
    conn.execute(sql.SQL("create table if not exists {} ({})").format(
        t, sql.SQL(", ").join(sql.SQL("{} {}").format(ident(c), sql.SQL(ty)) for c, ty in ANOMALIE_1_COLUMNS)))
    conn.execute(sql.SQL("""create temp table desired on commit drop as
        select c.id::varchar(36) as id, c.project_id::varchar(50) as project_id, c.instrument::varchar(50) as instrument,
               c.easting, c.northing, c.latitude, c.longitude, a.vm_nr::varchar(50) as vm_nr,
               c.category::varchar(50) as category, c.layer::varchar(255) as layer, 'pending'::varchar(50) as status,
               a.target_id::varchar(100) as target_id, c.evaluated_depth
          from cand c join public.anomalies a on a.id = c.id"""))
    same = sql.SQL(" and ").join(sql.SQL("d.{c} is not distinct from x.{c}").format(c=ident(c)) for c in cols)
    removed = conn.execute(sql.SQL("delete from {} x where not exists (select 1 from desired d where {})").format(t, same)).rowcount
    added = conn.execute(sql.SQL("insert into {} ({}) select {} from desired d where not exists (select 1 from {} x where {})").format(
        t, sql.SQL(", ").join(map(ident, cols)), sql.SQL(", ").join(sql.SQL("d.{}").format(ident(c)) for c in cols), t, same)).rowcount
    conn.execute("drop table desired")
    return {"rows_rewritten": removed, "rows_written": added}


def report(s: dict) -> None:
    print(f"run {s['run_id']} ok. gates: {s['gates']}")
    print(f"  corrections applied {s['corrections_applied']}, approved changes applied {s['changes_applied']}")
    for pid, ps in s["projects"].items():
        warn = ps.get("WARNING_db_only_changed")
        print(f"  {pid}: inserted {ps['inserted']}, staged {ps['changes_staged']} (open {ps['staged_open']}), "
              f"correction pairs +{ps['correction_pairs_new']} (open {ps['open_pairs']}), "
              f"DB-only {ps['db_only']}, anomalie_1 -{ps['anomalie_1']['rows_rewritten']}/+{ps['anomalie_1']['rows_written']}")
        if warn:
            print(f"  WARNING {pid}: the set of DB-only rows changed: +{len(warn['added'])} -{len(warn['removed'])}")
    for k in ("excluded_rows", "duplicates", "unconfigured_tables"):
        if s.get(k):
            print(f"  {k}: {s[k]}")


# ----------------------------------------------------------------------------- decisions
def decide_changes(ids: list[int], run: int | None, decision: str) -> None:
    """As etl_approver: record decisions through etl_admin.decide_change, which snapshots
    exactly what is approved. The pipeline's own login cannot call it."""
    conn = connect(approver=True)
    if run is not None:
        ids = [r[0] for r in conn.execute(
            "select change_id from etl.change_log where status = 'staged' and run_id = %s order by change_id", (run,))]
    done = []
    for cid in ids:
        conn.execute("select etl_admin.decide_change(%s, %s)", (cid, decision))
        done.append(cid)
    conn.commit()
    print(f"{len(done)} change(s) {decision}d: {done}. The next run carries them out.")


def decide_correction(pair_id: int, decision: str) -> None:
    conn = connect(approver=True)
    conn.execute("select etl_admin.decide_correction(%s, %s)", (pair_id, decision))
    conn.commit()
    print(f"pair {pair_id}: {decision}d. The next run carries it out.")


def status(approver: bool = False) -> None:
    conn = connect(approver=approver)
    for title, q in (
        ("staged changes awaiting a decision",
         "select l.change_id, l.project_id, l.vm_nr, l.column_name, l.old_value, l.new_value, l.run_id "
         "from etl.change_log l where l.status = 'staged' and not exists (select 1 from etl_approval.decisions d "
         "where d.kind = 'change' and d.ref_id = l.change_id) order by l.change_id"),
        ("correction pairs awaiting a decision",
         "select k.pair_id, k.project_id, k.old_vm_nr, k.source_table, k.source_key, round(k.distance_m::numeric, 3), "
         "k.matched_by, k.old_has_feedback, k.old_status, k.status from etl.correction_candidates k "
         "where k.status in ('pending', 'conflict') and not exists (select 1 from etl_approval.decisions d "
         "where d.kind = 'correction' and d.ref_id = k.pair_id) order by k.pair_id"),
        ("decisions not yet carried out",
         "select decision_id, kind, ref_id, decision, decided_by, decided_at from etl_approval.decisions "
         "where outcome is null order by decision_id"),
        ("DB-only rows", "select project_id, cardinality(anomaly_ids) from etl.db_only_state order by 1"),
        ("last runs", "select run_id, status, forced, started_at, finished_at from etl.runs order by run_id desc limit 10"),
    ):
        rows = conn.execute(q).fetchall()
        print(f"{title}: {len(rows)}")
        for r in rows:
            print("   ", " | ".join("" if v is None else str(v) for v in r))


# ----------------------------------------------------------------------------- admin
APPROVAL_SQL = r"""
-- ---------------------------------------------------------------- approvals
-- Decisions live where etl_pipeline can read but never write. Only these postgres-owned
-- functions act on them: etl_approver decides (the content is snapshotted at that
-- moment); etl_pipeline carries out exactly what was decided, or closes it unapplied.
create schema if not exists etl_approval authorization postgres;
revoke all on schema etl_approval from public;
grant usage on schema etl_approval to etl_pipeline, etl_approver;
create table if not exists etl_approval.decisions (
    decision_id  bigserial primary key,
    kind         text not null check (kind in ('change', 'correction')),
    ref_id       bigint not null,
    decision     text not null check (decision in ('approve', 'reject')),
    anomaly_id   varchar(36) not null,
    column_name  text,
    old_value    text,
    new_value    text,
    new_target_id varchar(100),
    new_easting  double precision,
    new_northing double precision,
    decided_by   text not null,
    decided_at   timestamptz not null default now(),
    outcome      text,          -- applied | stale | superseded | closed
    outcome_at   timestamptz,
    unique (kind, ref_id)
);
revoke all on etl_approval.decisions from public;
grant select on etl_approval.decisions to etl_pipeline, etl_approver;

create schema if not exists etl_admin authorization postgres;
revoke all on schema etl_admin from public;
grant usage on schema etl_admin to etl_pipeline, etl_approver;

create or replace function etl_admin.decide_change(p_change_id bigint, p_decision text) returns bigint
language plpgsql security definer set search_path = pg_catalog, public as $fn$
declare r record; d bigint;
begin
  if p_decision not in ('approve', 'reject') then raise exception 'decision must be approve or reject'; end if;
  select * into r from etl.change_log where change_id = p_change_id and status = 'staged';
  if not found then raise exception 'change % is not staged', p_change_id; end if;
  if r.column_name not in ('category', 'layer', 'evaluated_depth', 'instrument') then
    raise exception 'column % cannot be changed by the pipeline', r.column_name; end if;
  insert into etl_approval.decisions (kind, ref_id, decision, anomaly_id, column_name, old_value, new_value, decided_by)
  values ('change', p_change_id, p_decision, r.anomaly_id, r.column_name, r.old_value, r.new_value, session_user)
  returning decision_id into d;
  return d;
end $fn$;

create or replace function etl_admin.decide_correction(p_pair_id bigint, p_decision text) returns bigint
language plpgsql security definer set search_path = pg_catalog, public as $fn$
declare r record; d bigint;
begin
  if p_decision not in ('approve', 'reject') then raise exception 'decision must be approve or reject'; end if;
  select * into r from etl.correction_candidates where pair_id = p_pair_id and status in ('pending', 'conflict');
  if not found then raise exception 'pair % is not open', p_pair_id; end if;
  insert into etl_approval.decisions (kind, ref_id, decision, anomaly_id, new_target_id, new_easting, new_northing, decided_by)
  values ('correction', p_pair_id, p_decision, r.old_anomaly_id, r.new_target_id, r.new_easting, r.new_northing, session_user)
  returning decision_id into d;
  return d;
end $fn$;

create or replace function etl_admin.apply_change(p_decision_id bigint) returns text
language plpgsql security definer set search_path = pg_catalog, public as $fn$
declare d record; cur text;
begin
  select * into d from etl_approval.decisions
   where decision_id = p_decision_id and kind = 'change' and decision = 'approve' and outcome is null for update;
  if not found then raise exception 'decision % is not an approved, open change', p_decision_id; end if;
  if d.column_name not in ('category', 'layer', 'evaluated_depth', 'instrument') then
    raise exception 'column % cannot be changed by the pipeline', d.column_name; end if;
  execute format('select %I::text from public.anomalies where id = $1', d.column_name) into cur using d.anomaly_id;
  if cur is distinct from d.old_value then
    update etl_approval.decisions set outcome = 'stale', outcome_at = now() where decision_id = p_decision_id;
    return 'stale';
  end if;
  execute format('update public.anomalies set %I = $1::%s where id = $2', d.column_name,
                 case when d.column_name = 'evaluated_depth' then 'double precision' else 'varchar' end)
    using d.new_value, d.anomaly_id;
  update etl_approval.decisions set outcome = 'applied', outcome_at = now() where decision_id = p_decision_id;
  return 'applied';
end $fn$;

drop function if exists etl_admin.apply_correction(bigint);
create function etl_admin.apply_correction(p_decision_id bigint) returns text
language plpgsql security definer set search_path = pg_catalog, public as $fn$
declare d record;
begin
  select * into d from etl_approval.decisions
   where decision_id = p_decision_id and kind = 'correction' and decision = 'approve' and outcome is null for update;
  if not found then raise exception 'decision % is not an approved, open correction', p_decision_id; end if;
  update public.anomalies set easting = d.new_easting, northing = d.new_northing where id = d.anomaly_id;
  if not found then raise exception 'anomaly % not found', d.anomaly_id; end if;
  update etl_approval.decisions set outcome = 'applied', outcome_at = now() where decision_id = p_decision_id;
  return 'applied';
end $fn$;

-- close a decision without applying it: can only ever prevent a write, never cause one
create or replace function etl_admin.close_decision(p_decision_id bigint, p_outcome text) returns void
language plpgsql security definer set search_path = pg_catalog, public as $fn$
begin
  if p_outcome not in ('superseded', 'closed') then raise exception 'outcome must be superseded or closed'; end if;
  update etl_approval.decisions set outcome = p_outcome, outcome_at = now()
   where decision_id = p_decision_id and outcome is null;
  if not found then raise exception 'decision % is not open', p_decision_id; end if;
end $fn$;

revoke all on all functions in schema etl_admin from public;
grant execute on function etl_admin.decide_change(bigint, text), etl_admin.decide_correction(bigint, text) to etl_approver;
grant execute on function etl_admin.apply_change(bigint), etl_admin.apply_correction(bigint),
                          etl_admin.close_decision(bigint, text) to etl_pipeline;

-- what the approver reads to decide: the pipeline's staged changes and pairs, and the targets
grant usage on schema etl to etl_approver;
alter default privileges for role etl_pipeline in schema etl grant select on tables to etl_approver;
grant select on all tables in schema etl to etl_approver;
grant usage on schema public to etl_approver;
grant select on public.anomalies to etl_approver;
"""


def setup_sql() -> str:
    """One-time SQL for an admin (postgres): roles, schemas, grants, ownership, approval
    functions. Generated from the config so a new project gets its grants from here."""
    cfg = load_config()
    lit = lambda v: "'" + str(v).replace("'", "''") + "'"
    q = lambda v: '"' + str(v).replace('"', '""') + '"'
    out = ["-- Generated by etl/runner/run.py setup-sql. Run as postgres (safe to re-run):",
           "--   psql -v ON_ERROR_STOP=1 -v etl_password=... -v approver_password=... -f setup.sql",
           "do $$ begin",
           "  if not exists (select 1 from pg_roles where rolname = 'etl_pipeline') then",
           "    create role etl_pipeline login nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;",
           "  if not exists (select 1 from pg_roles where rolname = 'etl_approver') then",
           "    create role etl_approver login nosuperuser nocreatedb nocreaterole noreplication nobypassrls; end if;",
           "end $$;",
           "alter role etl_pipeline with password :'etl_password';",
           "alter role etl_approver with password :'approver_password';",
           "select format('grant connect on database %I to etl_pipeline, etl_approver', current_database()) \\gexec",
           "-- the merge uses session-private temp tables; PUBLIC's TEMPORARY is revoked on live",
           "select format('grant temporary on database %I to etl_pipeline', current_database()) \\gexec",
           "create schema if not exists etl authorization etl_pipeline;",
           "grant usage on schema public to etl_pipeline;",
           "grant select on public.anomalies, public.projects, public.feedback to etl_pipeline;",
           "-- coordinate transforms, in the models and in the app's trigger on insert",
           "grant select on public.spatial_ref_sys to etl_pipeline;",
           "grant insert on public.anomalies, public.projects to etl_pipeline;",
           "-- no UPDATE at all: existing rows change only through the approval functions below",
           "revoke update on public.anomalies from etl_pipeline;",
           "revoke update (category, layer, evaluated_depth, instrument) on public.anomalies from etl_pipeline;",
           "-- deliberately absent: DELETE, TRUNCATE, UPDATE, any write on feedback",
           ""]
    for p in cfg["projects"]:
        s = q(p["schema"])
        out += [f"-- {p['project_id']}",
                f"grant usage, create on schema {s} to etl_pipeline;",
                f"grant select on all tables in schema {s} to etl_pipeline;",
                f"alter default privileges for role postgres in schema {s} grant select on tables to etl_pipeline;",
                f"do $$ begin if to_regclass({lit(p['schema'] + '.anomalie_1')}) is not null then",
                f"  execute 'alter table {s}.anomalie_1 owner to etl_pipeline'; end if; end $$;", ""]
    out += ["-- retired VM numbers held in archive tables",
            "do $$ begin if exists (select 1 from pg_namespace where nspname = 'archive') then",
            "  execute 'grant usage on schema archive to etl_pipeline';",
            "  execute 'grant select on all tables in schema archive to etl_pipeline'; end if; end $$;"]
    return "\n".join(out) + "\n" + APPROVAL_SQL


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("--force", action="store_true")
    sub.add_parser("loop"); sub.add_parser("setup-sql")
    st = sub.add_parser("status"); st.add_argument("--approver", action="store_true", help="connect as etl_approver")
    for name in ("approve-change", "reject-change"):
        c = sub.add_parser(name); c.add_argument("ids", nargs="*", type=int); c.add_argument("--run", type=int)
    for name in ("approve-correction", "reject-correction"):
        c = sub.add_parser(name); c.add_argument("pair_id", type=int)
    a = ap.parse_args()
    if a.cmd == "run":
        return run(force=a.force)
    if a.cmd == "loop":
        interval = int(os.environ.get("ETL_INTERVAL_SECONDS", "0"))
        if interval <= 0:
            print("ETL_INTERVAL_SECONDS is not set: scheduling is off. Nothing runs.")
            while True:
                time.sleep(3600)
        while True:
            run()
            time.sleep(interval)
    if a.cmd == "status":
        status(approver=a.approver); return 0
    if a.cmd == "setup-sql":
        sys.stdout.write(setup_sql()); return 0
    if a.cmd in ("approve-change", "reject-change"):
        decide_changes(a.ids, a.run, "approve" if a.cmd == "approve-change" else "reject"); return 0
    if a.cmd in ("approve-correction", "reject-correction"):
        decide_correction(a.pair_id, "approve" if a.cmd == "approve-correction" else "reject"); return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
