"""The ETL pipeline from the web app: health, status, approvals, run now, history.
Reads and decides through the separate etl_approver login, never the app's own."""
import asyncio
import datetime
import logging
import os
import subprocess
import threading
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

import models
from config import settings
from security import require_admin

router = APIRouter()


# --- ETL Approver API ---
class ChangeDecisionRequest(BaseModel):
    change_ids: List[int]
    decision: str  # 'approve' or 'reject'

class CorrectionDecisionRequest(BaseModel):
    pair_id: int
    decision: str  # 'approve' or 'reject'


def get_etl_approver_conn():
    from urllib.parse import urlparse
    import psycopg
    db_url = os.environ.get("DATABASE_URL", "")
    host = os.environ.get("ETL_DB_HOST")
    port = int(os.environ.get("ETL_DB_PORT", "5432"))
    dbname = os.environ.get("ETL_DB_NAME")
    if db_url and not host:
        parsed = urlparse(db_url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 5432
        dbname = parsed.path.lstrip("/") or "nolte_geoservices"
    user = os.environ.get("ETL_APPROVER_USER") or settings.etl_approver_user
    password = os.environ.get("ETL_APPROVER_PASSWORD") or settings.etl_approver_password
    return psycopg.connect(
        host=host or "127.0.0.1",
        port=port,
        dbname=dbname or "nolte_geoservices",
        user=user,
        password=password,
        application_name="nolte_etl_api_approver"
    )


def _etl_health() -> dict:
    """The pipeline's health, from etl.runs. A skipped run is a live pipeline that found
    nothing new, so it counts toward freshness like an ok run.

      unknown    no run has ever finished
      unhealthy  approval database unreachable, the latest finished run failed, or no
                 run has ever succeeded
      degraded   the last ok/skipped run is older than ETL_MAX_STALENESS_HOURS
      healthy    otherwise
    """
    import time
    now = datetime.datetime.now(datetime.timezone.utc)
    max_staleness_hours = float(os.environ.get("ETL_MAX_STALENESS_HOURS", "24"))
    try:
        with get_etl_approver_conn() as conn:
            t_ping = time.perf_counter()
            conn.execute("SELECT 1")
            latency_ms = round((time.perf_counter() - t_ping) * 1000, 2)

            last_run = conn.execute(
                "SELECT run_id, status, started_at, finished_at FROM etl.runs "
                "WHERE status <> 'running' ORDER BY run_id DESC LIMIT 1"
            ).fetchone()
            last_alive = conn.execute(
                "SELECT run_id, status, finished_at FROM etl.runs "
                "WHERE status IN ('ok', 'skipped') ORDER BY run_id DESC LIMIT 1"
            ).fetchone()
            staged_cnt = conn.execute("SELECT count(*) FROM etl.change_log WHERE status = 'staged'").fetchone()[0]
            corr_cnt = conn.execute("SELECT count(*) FROM etl.correction_candidates WHERE status IN ('pending', 'conflict')").fetchone()[0]
            targets_cnt = conn.execute("SELECT count(*) FROM public.anomalies").fetchone()[0]
            history_cnt = conn.execute("SELECT count(*) FROM public.anomaly_history").fetchone()[0]
    except Exception:
        logging.getLogger("server").exception("ETL health check could not reach the database")
        return {"status": "unhealthy", "timestamp": now.isoformat(), "error": "approval database unreachable"}

    seconds_since_last_alive = None
    is_stale = False
    if last_alive and last_alive[2]:
        finished_at = last_alive[2]
        if finished_at.tzinfo is None:
            finished_at = finished_at.replace(tzinfo=datetime.timezone.utc)
        seconds_since_last_alive = round((now - finished_at).total_seconds())
        is_stale = seconds_since_last_alive > max_staleness_hours * 3600

    if last_run is None:
        overall_status = "unknown"
    elif last_run[1] == "failed" or last_alive is None:
        overall_status = "unhealthy"
    elif is_stale:
        overall_status = "degraded"
    else:
        overall_status = "healthy"

    return {
        "status": overall_status,
        "timestamp": now.isoformat(),
        "database_latency_ms": latency_ms,
        "staleness": {
            "is_stale": is_stale,
            "max_staleness_hours": max_staleness_hours,
            "seconds_since_last_success": seconds_since_last_alive,
            "last_success_at": last_alive[2].isoformat() if last_alive and last_alive[2] else None,
            "last_success_status": last_alive[1] if last_alive else None,
        },
        "last_run": {
            "run_id": last_run[0] if last_run else None,
            "status": last_run[1] if last_run else None,
            "finished_at": last_run[3].isoformat() if last_run and last_run[3] else None
        },
        "pending_approvals": {
            "staged_changes": staged_cnt,
            "correction_pairs": corr_cnt,
            "total": staged_cnt + corr_cnt
        },
        "data_counts": {
            "anomalies": targets_cnt,
            "history_records": history_cnt
        }
    }


# The public probe reuses one result for this long, so polling it - by a monitor or by
# anyone - costs at most one approver connection per window.
_ETL_HEALTH_CACHE_SECONDS = 30
_etl_health_cache: dict = {"at": 0.0, "status": None}
_etl_health_lock = threading.Lock()


@router.get("/api/etl/health")
def get_etl_pipeline_health(response: Response):
    """Public liveness probe for monitors: the status word only, 503 when unhealthy.
    Counts, timings and errors are admin-only, at /api/etl/health/details."""
    import time
    with _etl_health_lock:
        if _etl_health_cache["status"] is None or time.monotonic() - _etl_health_cache["at"] > _ETL_HEALTH_CACHE_SECONDS:
            _etl_health_cache["status"] = _etl_health()["status"]
            _etl_health_cache["at"] = time.monotonic()
        status = _etl_health_cache["status"]
    if status == "unhealthy":
        response.status_code = 503
    return {"status": status}


@router.get("/api/etl/health/details")
def get_etl_pipeline_health_details(admin: models.User = Depends(require_admin)):
    """Operational health & staleness details for the ETL panel."""
    return _etl_health()


@router.get("/api/etl/status")
def get_etl_pipeline_status(admin: models.User = Depends(require_admin)):
    try:
        with get_etl_approver_conn() as conn:
            runs = [
                {
                    "run_id": r[0], "started_at": r[1].isoformat() if r[1] else None,
                    "finished_at": r[2].isoformat() if r[2] else None, "status": r[3],
                    "forced": r[4], "summary": r[5]
                }
                for r in conn.execute(
                    "select run_id, started_at, finished_at, status, forced, summary "
                    "from etl.runs order by run_id desc limit 25"
                ).fetchall()
            ]
            staged_changes = [
                {
                    "change_id": r[0], "run_id": r[1], "project_id": r[2], "anomaly_id": r[3],
                    "vm_nr": r[4], "column_name": r[5], "old_value": r[6], "new_value": r[7],
                    "staged_at": r[8].isoformat() if r[8] else None
                }
                for r in conn.execute(
                    "select change_id, run_id, project_id, anomaly_id, vm_nr, column_name, "
                    "old_value, new_value, staged_at from etl.change_log where status = 'staged' "
                    "order by change_id"
                ).fetchall()
            ]
            correction_pairs = [
                {
                    "pair_id": r[0], "run_id": r[1], "project_id": r[2], "new_target_id": r[3],
                    "new_easting": r[4], "new_northing": r[5], "old_anomaly_id": r[6],
                    "old_vm_nr": r[7], "old_easting": r[8], "old_northing": r[9],
                    "distance_m": r[10], "matched_by": r[11], "status": r[12]
                }
                for r in conn.execute(
                    "select pair_id, run_id, project_id, new_target_id, new_easting, new_northing, "
                    "old_anomaly_id, old_vm_nr, old_easting, old_northing, distance_m, matched_by, status "
                    "from etl.correction_candidates where status in ('pending', 'conflict') order by pair_id"
                ).fetchall()
            ]
            # Query configured and existing projects
            proj_dict = {}
            for r in conn.execute(
                "select project_id, coalesce(project_name, project_id) from public.projects order by project_id"
            ).fetchall():
                proj_dict[r[0]] = r[1]

            proj_dict.update(_etl_configured_projects())

            projects_list = [
                {"project_id": pid, "project_name": pname}
                for pid, pname in sorted(proj_dict.items())
            ]

            return {
                "runs": runs,
                "staged_changes": staged_changes,
                "correction_pairs": correction_pairs,
                "projects": projects_list
            }
    except Exception:
        logging.getLogger("server").exception("Failed to fetch ETL status")
        raise HTTPException(status_code=500, detail="Failed to fetch ETL status.")


def _etl_decision_error(exc: Exception, what: str) -> HTTPException:
    """etl_admin refuses with RAISE EXCEPTION (not staged, already decided, ...): that is
    the approver's business, so say why. Anything else is logged, not echoed."""
    import psycopg
    if isinstance(exc, psycopg.errors.RaiseException):
        return HTTPException(status_code=409, detail=f"{what}: {exc.diag.message_primary}. Nothing was recorded.")
    if isinstance(exc, psycopg.errors.UniqueViolation):  # etl_approval.decisions: unique (kind, ref_id)
        return HTTPException(status_code=409, detail=f"{what}: it has already been decided. Nothing was recorded.")
    logging.getLogger("server").exception("ETL decision failed")
    return HTTPException(status_code=500, detail=f"{what}: unexpected database error. Nothing was recorded.")


def _set_etl_actor(conn, admin: models.User) -> None:
    """The approver login is shared by every admin; etl_admin.decide_* append this
    transaction-local name to decided_by so each decision names the person."""
    conn.execute("select set_config('etl.actor', %s, true)", (admin.username,))


@router.post("/api/etl/approvals/change")
def decide_etl_change(req: ChangeDecisionRequest, admin: models.User = Depends(require_admin)):
    if req.decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="Decision must be 'approve' or 'reject'")
    change_ids = list(dict.fromkeys(req.change_ids))  # a repeated id would hit the unique decision
    if not change_ids:
        raise HTTPException(status_code=400, detail="change_ids list cannot be empty")
    results = []
    current = None
    try:
        # One transaction: every change in the batch is decided, or none is.
        with get_etl_approver_conn() as conn, conn.transaction():
            _set_etl_actor(conn, admin)
            for cid in change_ids:
                current = cid
                row = conn.execute("select etl_admin.decide_change(%s, %s)", (cid, req.decision)).fetchone()
                results.append({"change_id": cid, "decision_id": row[0]})
    except Exception as exc:
        what = f"Change {current} could not be decided" if current is not None else "Could not reach the approval database"
        raise _etl_decision_error(exc, what)
    return {"success": True, "decisions": results}


@router.post("/api/etl/approvals/correction")
def decide_etl_correction(req: CorrectionDecisionRequest, admin: models.User = Depends(require_admin)):
    if req.decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="Decision must be 'approve' or 'reject'")
    try:
        with get_etl_approver_conn() as conn, conn.transaction():
            _set_etl_actor(conn, admin)
            row = conn.execute("select etl_admin.decide_correction(%s, %s)", (req.pair_id, req.decision)).fetchone()
    except Exception as exc:
        raise _etl_decision_error(exc, f"Pair {req.pair_id} could not be decided")
    return {"success": True, "pair_id": req.pair_id, "decision_id": row[0]}


_REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ETL_CONFIG_PATH = os.path.join(_REPO_DIR, "etl", "config", "projects.yml")
_COMPOSE_FILE = os.path.join(_REPO_DIR, "docker-compose.yml")
_ETL_RUN_TIMEOUT_SECONDS = 180


def _etl_configured_projects() -> dict:
    """project_id -> project_name from etl/config/projects.yml - the file the ETL
    containers mount, so this is exactly what the runner will see. {} if unreadable."""
    try:
        import yaml
        with open(_ETL_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
    except Exception:
        logging.getLogger("server").exception("Could not read %s", _ETL_CONFIG_PATH)
        return {}
    return {p["project_id"]: p.get("project_name", p["project_id"])
            for p in cfg.get("projects", []) if p.get("project_id")}


class EtlRunRequest(BaseModel):
    project_id: Optional[str] = None
    # Off by default: a forced run skips the "nothing changed since the last run" check.
    force: bool = False


@router.post("/api/etl/run")
async def trigger_etl_run(req: EtlRunRequest, admin: models.User = Depends(require_admin)):
    """Run the pipeline once now (optionally for one project), as a one-off ETL container.

    outcome is 'ok', 'skipped' (nothing changed since the last run) or 'failed'. Another
    run holding the pipeline's lock is 409 - nothing was done. A run still going when the
    timeout ends is 504; it is not stopped, and shows up in the runs list when it ends."""
    if req.project_id is not None and req.project_id not in _etl_configured_projects():
        raise HTTPException(status_code=400, detail=f"Unknown project '{req.project_id}'")

    # Explicit compose file and project directory: the server's working directory is
    # whatever it was started from. --no-deps: the database is already up; a run must
    # never start or recreate it.
    cmd = ["docker", "compose", "-f", _COMPOSE_FILE, "--project-directory", _REPO_DIR,
           "--profile", "etl", "run", "--rm", "--no-deps", "etl", "run"]
    if req.force:
        cmd.append("--force")
    if req.project_id:
        cmd.extend(["--project", req.project_id])

    try:
        res = await asyncio.to_thread(
            subprocess.run, cmd, capture_output=True, text=True,
            timeout=_ETL_RUN_TIMEOUT_SECONDS, cwd=_REPO_DIR
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail=f"The ETL run did not finish within {_ETL_RUN_TIMEOUT_SECONDS} seconds. "
                   "It may still be running; check the runs list before starting another.")
    except Exception:
        logging.getLogger("server").exception("Could not start the ETL run")
        raise HTTPException(status_code=500, detail="Could not start the ETL run (is Docker running?)")

    if "another run holds the lock" in res.stdout:
        raise HTTPException(status_code=409, detail="Another ETL run is in progress; nothing was done.")

    if res.returncode != 0:
        outcome = "failed"
    elif "no change since the last successful run: skipped" in res.stdout:
        outcome = "skipped"
    else:
        outcome = "ok"
    return {
        "success": res.returncode == 0,
        "outcome": outcome,
        "returncode": res.returncode,
        "stdout": res.stdout,
        "stderr": res.stderr,
        "project_id": req.project_id,
        "force": req.force
    }


@router.get("/api/etl/history")
def get_anomaly_history(
    target_id: Optional[str] = None,
    vm_nr: Optional[str] = None,
    project_id: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    admin: models.User = Depends(require_admin)
):
    try:
        with get_etl_approver_conn() as conn:
            where_clauses = []
            params = []
            if target_id:
                where_clauses.append("h.target_id = %s")
                params.append(target_id)
            if vm_nr:
                where_clauses.append("h.vm_nr = %s")
                params.append(vm_nr)
            if project_id:
                where_clauses.append("h.project_id = %s")
                params.append(project_id)
            where_sql = ("where " + " and ".join(where_clauses)) if where_clauses else ""
            params.append(limit)
            q = f"""
                select h.history_id, h.anomaly_id, h.project_id, h.target_id, h.vm_nr,
                       h.instrument, h.category, h.layer, h.evaluated_depth,
                       h.easting, h.northing, h.latitude, h.longitude, h.status,
                       h.valid_from, h.valid_to, h.is_current, h.change_reason,
                       h.decision_id, h.changed_by
                  from public.anomaly_history h
                 {where_sql}
                 order by h.history_id desc
                 limit %s
            """
            rows = conn.execute(q, tuple(params)).fetchall()
            return [
                {
                    "history_id": r[0], "anomaly_id": r[1], "project_id": r[2], "target_id": r[3],
                    "vm_nr": r[4], "instrument": r[5], "category": r[6], "layer": r[7],
                    "evaluated_depth": r[8], "easting": r[9], "northing": r[10],
                    "latitude": r[11], "longitude": r[12], "status": r[13],
                    "valid_from": r[14].isoformat() if r[14] else None,
                    "valid_to": r[15].isoformat() if r[15] else None,
                    "is_current": r[16], "change_reason": r[17],
                    "decision_id": r[18], "changed_by": r[19]
                }
                for r in rows
            ]
    except Exception:
        logging.getLogger("server").exception("Failed to fetch anomaly history")
        raise HTTPException(status_code=500, detail="Failed to fetch anomaly history.")
