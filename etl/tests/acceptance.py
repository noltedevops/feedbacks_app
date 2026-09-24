"""Acceptance tests for the ETL pipeline, against a COPY of the database.

usage (repo root):  .venv/Scripts/python etl/tests/acceptance.py <copy_db_name>

Runs the real pipeline container (docker compose --profile etl) as etl_pipeline, and
uses the postgres login from DATABASE_URL only to snapshot and to edit source rows on
the copy. Refuses to run against the live database name.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import psycopg

LIVE_DB = "nolte_geoservices"
COPY = sys.argv[1] if len(sys.argv) > 1 else ""
if not COPY or COPY == LIVE_DB:
    raise SystemExit("give the name of a COPY database; the live database is refused")

REPO = Path(__file__).resolve().parents[2]
url = [l for l in (REPO / ".env").read_text().splitlines() if l.startswith("DATABASE_URL=")][0].split("=", 1)[1]
url = url.replace("@localhost", "@127.0.0.1").rsplit("/", 1)[0] + "/" + COPY
K = "p_11_26_5151_koeln_deutzerfeld"
W = "p_11_24_2736_wilhemshaven_r_stersieler_seedeich"
results: list[tuple[str, bool, object]] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    results.append((name, bool(ok), detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  -> {detail}" if not ok or detail != "" else ""), flush=True)


def db():
    c = psycopg.connect(url, autocommit=True)
    assert c.execute("select current_database()").fetchone()[0] == COPY
    return c


def q1(sql, *a):
    with db() as c:
        return c.execute(sql, *a).fetchone()


def qall(sql, *a):
    with db() as c:
        return c.execute(sql, *a).fetchall()


ENV = dict(l.split("=", 1) for l in (REPO / ".env").read_text().splitlines() if "=" in l and not l.startswith("#"))


def as_role(user: str, password: str, stmt: str) -> str:
    """Run one statement on the copy as the given login; returns the error text or 'ok'."""
    p = subprocess.run(["docker", "exec", "-e", f"PGPASSWORD={password}", "feedback_postgres_db", "psql", "-h", "127.0.0.1",
                        "-U", user, "-d", COPY, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", stmt], capture_output=True, text=True)
    err = (p.stderr or "").strip().splitlines()
    return "ok" if p.returncode == 0 else (err[0] if err else f"exit {p.returncode}")


def approve(*args: str) -> tuple[int, str]:
    return pipeline(*args, service="etl-approve")


def pipeline(*args: str, service: str = "etl", env: dict | None = None) -> tuple[int, str]:
    extra = sum((["-e", f"{k}={v}"] for k, v in (env or {}).items()), [])
    cmd = ["docker", "compose", "--profile", "etl", "run", "--rm", "--no-deps", "-e", f"ETL_DB_NAME={COPY}", *extra, service, *args]
    p = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
    out = p.stdout + p.stderr
    print("    | " + "\n    | ".join(l for l in out.splitlines() if l.strip() and not l.startswith(("Container", " Container")))[-3000:], flush=True)
    return p.returncode, out


def snap() -> dict:
    s = {}
    for name, sql in {
        "anomalies": "select md5(string_agg(a::text, '|' order by a.id)) || ' n=' || count(*) from public.anomalies a",
        "feedback": "select md5(string_agg(f::text, '|' order by f.id)) || ' n=' || count(*) from public.feedback f",
        "koeln_a1": f"select md5(string_agg(x::text, '|' order by x::text)) || ' n=' || count(*) from {K}.anomalie_1 x",
        "whv_a1": f"select md5(string_agg(x::text, '|' order by x::text)) || ' n=' || count(*) from {W}.anomalie_1 x",
        "sources": f"""select md5((select string_agg(t::text,'|' order by t::text) from {K}.picks t)
                               || (select string_agg(t::text,'|' order by t::text) from {W}."Magnetic" t)
                               || (select string_agg(t::text,'|' order by t::text) from {W}."Georadar" t))""",
        "indexes": "select string_agg(indexname || ':' || split_part(split_part(indexdef, 'USING ', 2), ' ', 1), ',' order by indexname) "
                   "from pg_indexes where schemaname = 'public' and tablename = 'anomalies'",
    }.items():
        s[name] = q1(sql)[0]
    return s


def last_run():
    return q1("select run_id, status, summary from etl.runs order by run_id desc limit 1")


print(f"== acceptance on {COPY}")
before = snap()
koeln_before = qall(f"select id, target_id, easting, northing, latitude, longitude, vm_nr, category, layer, status, evaluated_depth, instrument, project_id from {K}.anomalie_1")
print("  baseline:", json.dumps(before, indent=1))

# ---------------------------------------------------------------- 1. first run changes nothing
print("\n== 1. first run against the current state")
rc, _ = pipeline("run")
r1 = last_run()
check("first run succeeded (merge gates + dbt tests)", rc == 0 and r1[1] == "ok", r1[1])
if r1[1] != "ok":
    raise SystemExit("first run failed; stopping (every later test depends on it)")
after = snap()
for k in ("anomalies", "feedback", "whv_a1", "sources", "indexes"):
    check(f"first run: {k} unchanged", after[k] == before[k], (before[k], after[k]) if after[k] != before[k] else "")
koeln_after = qall(f"select id, target_id, easting, northing, latitude, longitude, vm_nr, category, layer, status, evaluated_depth, instrument, project_id from {K}.anomalie_1")
strip = lambda rows: sorted(tuple(r[2:]) for r in rows)
check("Köln anomalie_1: identical apart from id and target_id", strip(koeln_before) == strip(koeln_after),
      f"{len(koeln_before)} -> {len(koeln_after)} rows")
pub = {r[0]: r[1] for r in qall("select target_id, id from public.anomalies where project_id = '11-26-5151'")}
check("Köln anomalie_1: all 127 ids equal public.anomalies' ids", len(koeln_after) == 127 and all(pub.get(r[1]) == r[0] for r in koeln_after),
      sum(1 for r in koeln_after if pub.get(r[1]) != r[0]))
num = lambda t: tuple(float(x) for x in re.findall(r"-(\d+\.\d+)", t))
old_by_pos = {(r[2], r[3], r[6]): r[1] for r in koeln_before}
same_values = all(num(old_by_pos[(r[2], r[3], r[6])]) == num(r[1]) and re.search(r"\.\d{3}-\d+\.\d{3}$", r[1]) for r in koeln_after)
check("Köln anomalie_1: target_id only re-rendered (same values, 3 decimals)", same_values)
check("feedback = 16", q1("select count(*) from public.feedback")[0] == 16)

# ---------------------------------------------------------------- 2. second run changes nothing
print("\n== 2. second run (scheduled: skipped by the checksum gate) and a forced run")
s1 = snap()
rc, _ = pipeline("run")
check("second run is skipped: no source change", rc == 0 and last_run()[1] == "skipped", last_run()[1])
rc, _ = pipeline("run", "--force")
r = last_run()
ps = r[2]["projects"] if r[2] else {}
check("forced run succeeded", rc == 0 and r[1] == "ok", r[1])
check("forced run: nothing inserted, staged, paired or rewritten",
      all(v["inserted"] == 0 and v["changes_staged"] == 0 and v["correction_pairs_new"] == 0
          and v["anomalie_1"] == {"rows_rewritten": 0, "rows_written": 0} for v in ps.values()), ps)
check("second and forced run: every snapshot unchanged", snap() == s1)

# ---------------------------------------------------------------- 3. a new source row
print("\n== 3. add a test row to Magnetic")
s3 = snap()
with db() as c:
    c.execute(f"""insert into {W}."Magnetic" ("Nummer", "Rechtswert", "Hochwert", "Tiefe [m]", layer, category)
                  values (990001, 443500.123, 5936000.456, 1.3, 'Stoerkoerper Magnetik Nord', 'Kat-1')""")
max_vm = q1("select max(split_part(vm_nr, '-', 2)::int) from public.anomalies where project_id = '11-24-2736'")[0]
max_ever = q1("select greatest((select max(split_part(vm_nr,'-',2)::int) from public.anomalies where project_id='11-24-2736'), "
              "(select max(split_part(vm_nr,'-',2)::int) from archive.anomalies_11_24_2736_removed_20260923))")[0]
rc, _ = pipeline("run")
new = qall("select a.vm_nr, a.status, a.target_id, a.instrument, a.category, a.layer, a.evaluated_depth, a.geom is not null, a.latitude "
           "from public.anomalies a where a.target_id = '11-24-2736-443500.123-5936000.456'")
check("test row: run succeeded", rc == 0 and last_run()[1] == "ok", last_run()[1])
check("test row: exactly one target inserted", q1("select count(*) from public.anomalies")[0] == 2343 and len(new) == 1, new)
if new:
    check("test row: status pending", new[0][1] == "pending", new[0][1])
    check(f"test row: next unused VM number (highest ever issued {max_ever})", new[0][0] == f"2736-{max_ever + 1}", new[0][0])
    check("test row: geometry and lat/lon set by the app's trigger", new[0][7] and new[0][8] is not None)
check("test row: every other target unchanged",
      q1("select md5(string_agg(a::text, '|' order by a.id)) || ' n=' || count(*) from public.anomalies a "
         "where a.target_id <> '11-24-2736-443500.123-5936000.456'")[0] == s3["anomalies"])
check("test row: feedback unchanged", snap()["feedback"] == s3["feedback"])

# ---------------------------------------------------------------- 4. a category change is staged
print("\n== 4. change a category in a source table")
victim = q1(f"""select g."Rechswert", g."Hochwert", g.category, a.id, a.vm_nr, a.category from {W}."Georadar" g
                join public.anomalies a on a.target_id = '11-24-2736-' || round(g."Rechswert", 3) || '-' || round(g."Hochwert", 3)
                where g.category = 'Kat-2' order by a.vm_nr limit 1""")
s4 = snap()
with db() as c:
    c.execute(f"""update {W}."Georadar" set category = 'Kat-3' where "Rechswert" = %s and "Hochwert" = %s""", (victim[0], victim[1]))
rc, _ = pipeline("run")
staged = qall("select change_id, vm_nr, column_name, old_value, new_value, status from etl.change_log where anomaly_id = %s", (victim[3],))
check("category change: run succeeded", rc == 0 and last_run()[1] == "ok", last_run()[1])
check(f"category change on {victim[4]} is staged (Kat-2 -> Kat-3)",
      len(staged) == 1 and staged[0][2:] == ("category", "Kat-2", "Kat-3", "staged"), staged)
check("category change: NOT applied to public.anomalies", snap()["anomalies"] == s4["anomalies"])
others_sql = "select md5(string_agg(a::text, '|' order by a.id)) from public.anomalies a where a.id <> %s"
row_sql = ("select id, project_id, instrument, easting, northing, latitude, longitude, vm_nr, layer, status, "
           "target_id, evaluated_depth, geom::text from public.anomalies where id = %s")
others_before, row_before = q1(others_sql, (victim[3],))[0], q1(row_sql, (victim[3],))
PW, APW = ENV["ETL_DB_PASSWORD"], ENV["ETL_APPROVER_PASSWORD"]
cid = staged[0][0] if staged else -1
check("etl_pipeline cannot approve its own change",
      "permission denied" in as_role("etl_pipeline", PW, f"select etl_admin.decide_change({cid}, 'approve')"))
check("etl_pipeline cannot write a decision directly",
      "permission denied" in as_role("etl_pipeline", PW, "insert into etl_approval.decisions (kind, ref_id, decision, anomaly_id, decided_by) "
                                                          f"values ('change', {cid}, 'approve', '{victim[3]}', 'me')"))
check("etl_pipeline cannot update public.anomalies (not even category)",
      "permission denied" in as_role("etl_pipeline", PW, f"update public.anomalies set category = 'Kat-3' where id = '{victim[3]}'"))
check("etl_pipeline cannot carry out a change nobody approved",
      "not an approved, open change" in as_role("etl_pipeline", PW, "select etl_admin.apply_change(999999)"))
check("etl_approver cannot write public.anomalies either",
      "permission denied" in as_role("etl_approver", APW, f"update public.anomalies set category = 'Kat-3' where id = '{victim[3]}'"))
rc, _ = approve("approve-change", str(cid)) if staged else (1, "")
check("etl_approver approves through the approval function", rc == 0)
# the pipeline tampers with its own staged row after approval: the approved snapshot wins
as_role("etl_pipeline", PW, f"update etl.change_log set new_value = 'Kat-9' where change_id = {cid}")
rc, _ = pipeline("run")
check("after approval the next run applies it, with the approved value (Kat-3, not the tampered Kat-9)",
      q1("select category from public.anomalies where id = %s", (victim[3],))[0] == "Kat-3",
      q1("select category from public.anomalies where id = %s", (victim[3],))[0])
check("the applied change touched only that row's category",
      q1(others_sql, (victim[3],))[0] == others_before and q1(row_sql, (victim[3],)) == row_before)
check("the change is recorded as applied",
      q1("select status from etl.change_log where change_id = %s", (staged[0][0],))[0] == "applied" if staged else False)

# ---------------------------------------------------------------- 5. a corrected coordinate is paired
print("\n== 5. move the test row's coordinates slightly")
s5 = snap()
n5 = q1("select count(*) from public.anomalies")[0]
with db() as c:
    c.execute(f"""update {W}."Magnetic" set "Rechtswert" = 443500.173 where "Nummer" = 990001""")
rc, out = pipeline("run")
pairs = qall("select pair_id, old_vm_nr, matched_by, round(distance_m::numeric, 3), status, new_target_id from etl.correction_candidates")
check("move: run succeeded", rc == 0 and last_run()[1] == "ok", last_run()[1])
check("move: paired with the old target and held back",
      len(pairs) == 1 and pairs[0][2] == "source_key" and pairs[0][4] == "pending" and float(pairs[0][3]) == 0.05, pairs)
check("move: NOT inserted as a new target", q1("select count(*) from public.anomalies")[0] == n5
      and q1("select count(*) from public.anomalies where target_id = '11-24-2736-443500.173-5936000.456'")[0] == 0)
check("move: public.anomalies unchanged", snap()["anomalies"] == s5["anomalies"])
check("move: the run reports the DB-only set changed (the old target lost its source)", "WARNING" in out)
if pairs:
    check("etl_pipeline cannot approve its own correction pair",
          "permission denied" in as_role("etl_pipeline", PW, f"select etl_admin.decide_correction({pairs[0][0]}, 'approve')"))
    approve("approve-correction", str(pairs[0][0]))
    rc, _ = pipeline("run")
    row = q1("select vm_nr, target_id, easting, northing, status from public.anomalies where target_id = '11-24-2736-443500.123-5936000.456'")
    check("approved correction: same target keeps id, VM number and target_id, coordinates updated",
          rc == 0 and row and row[0] == pairs[0][1] and abs(row[2] - 443500.173) < 1e-9, row)
    check("approved correction: still no second target", q1("select count(*) from public.anomalies")[0] == n5)

# ---------------------------------------------------------------- 6. invariants
print("\n== 6. invariants")
check("feedback still 16, and unchanged", q1("select count(*) from public.feedback")[0] == 16 and snap()["feedback"] == before["feedback"])
check("spatial and query indexes intact", snap()["indexes"] == before["indexes"], snap()["indexes"])
runs = qall("select run_id, status from etl.runs order by run_id")
check("every pipeline run ended ok or skipped (dbt tests included)", all(s in ("ok", "skipped") for _, s in runs), runs)
rc, _ = pipeline("run", "--force")
check("final forced run: dbt tests all pass", rc == 0 and last_run()[1] == "ok", last_run()[1])


# ---------------------------------------------------------------- 7. a device syncs during a run
def run_with_pause(during) -> tuple[int, str]:
    """Start a run that holds its merge transaction open before the gates, do `during`
    (committed, from another session) while it waits, then let it finish."""
    cmd = ["docker", "compose", "--profile", "etl", "run", "--rm", "--no-deps", "-e", f"ETL_DB_NAME={COPY}",
           "-e", "ETL_TEST_PAUSE_BEFORE_GATES=20", "etl", "run"]
    p = subprocess.Popen(cmd, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out = []
    for line in p.stdout:
        out.append(line)
        if "TEST HOOK" in line:
            during()
            break
    rest, _ = p.communicate()
    out.append(rest)
    text = "".join(out)
    print("    | " + "\n    | ".join(l for l in text.splitlines() if "GATES" in l or "TEST HOOK" in l or " ok." in l or "FAILED" in l))
    return p.returncode, text


print("\n== 7. a device syncs new feedback while a run is in its merge transaction")
fb_cols = "id, anomaly_id, visited, visit_date, investigator, investigator_username, notes, project_id, target_id"
target = q1("select id, target_id from public.anomalies where project_id = '11-24-2736' and status = 'pending' "
            "and vm_nr = '2736-1590'")
n_fb = q1("select count(*) from public.feedback")[0]
with db() as c:   # give the run something to do: one more new source row
    c.execute(f"""insert into {W}."Magnetic" ("Nummer", "Rechtswert", "Hochwert", "Tiefe [m]", layer, category)
                  values (990002, 443510.001, 5936010.002, 0.8, 'Stoerkoerper Magnetik Nord', 'Kat-1')""")


def device_syncs():
    with db() as c:   # what /api/sync does: insert the feedback row, mark the target investigated
        c.execute(f"insert into public.feedback ({fb_cols}) values (gen_random_uuid()::text, %s, true, now(), "
                  "'Acceptance Test', 'acceptance', 'written during the run', '11-24-2736', %s)", (target[0], target[1]))
        c.execute("update public.anomalies set status = 'investigated' where id = %s", (target[0],))
    print("    (device sync committed while the run waited)")


rc, out = run_with_pause(device_syncs)
check("run with a concurrent sync: passes its gates and commits", rc == 0 and last_run()[1] == "ok", last_run()[1])
check("the new feedback row survives: feedback grew by one", q1("select count(*) from public.feedback")[0] == n_fb + 1)
check("the run's own work committed (its new target is in)",
      q1("select count(*) from public.anomalies where target_id = '11-24-2736-443510.001-5936010.002'")[0] == 1)
check("the synced target is investigated, as the device set it",
      q1("select status from public.anomalies where id = %s", (target[0],))[0] == "investigated")

print("\n== 7b. a feedback row that existed before the run disappears during it")
with db() as c:
    c.execute(f"""insert into {W}."Magnetic" ("Nummer", "Rechtswert", "Hochwert", "Tiefe [m]", layer, category)
                  values (990003, 443520.001, 5936020.002, 0.9, 'Stoerkoerper Magnetik Nord', 'Kat-1')""")
gone = q1(f"select {fb_cols} from public.feedback where investigator_username = 'acceptance'")


def feedback_lost():
    with db() as c:
        c.execute("delete from public.feedback where id = %s", (gone[0],))
    print("    (a pre-existing feedback row deleted while the run waited)")


n_an = q1("select count(*) from public.anomalies")[0]
rc, out = run_with_pause(feedback_lost)
check("the lost row fails the gate and the run rolls back", rc != 0 and last_run()[1] == "failed" and "feedback lost" in out,
      last_run()[2])
check("nothing from the rolled-back run remains (its new target is not in)",
      q1("select count(*) from public.anomalies")[0] == n_an
      and q1("select count(*) from public.anomalies where target_id = '11-24-2736-443520.001-5936020.002'")[0] == 0)
with db() as c:
    c.execute(f"insert into public.feedback ({fb_cols}) values (%s, %s, %s, %s, %s, %s, %s, %s, %s)", gone)
rc, _ = pipeline("run")
check("with the row back, the next run succeeds and inserts the target", rc == 0 and last_run()[1] == "ok"
      and q1("select count(*) from public.anomalies where target_id = '11-24-2736-443520.001-5936020.002'")[0] == 1)

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
(REPO / "scratch" / "etl-acceptance.json").write_text(json.dumps([{"check": n, "ok": o, "detail": str(d)} for n, o, d in results], indent=1))
sys.exit(1 if failed else 0)
