"""The targets and their feedback: read them, sync the field app's records and moves,
the project list, and the dashboard's summary figures."""
import datetime
import json
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session, aliased

import models
from database import get_db
from security import current_user, require_surface

router = APIRouter()


class TeamsTools(BaseModel):
    need_update: bool = True
    truppfuehrer: Optional[str] = None      # auto-filled from the logged-in user
    maschinenfuehrer: Optional[str] = None
    bez_suchfeld: Optional[str] = None
    messgeraet: Optional[str] = None
    sondierer: Optional[str] = None

class FeedbackCreate(BaseModel):
    id: str
    point_id: str
    visited: bool
    status: str # 'clear', 'scrap', 'uxo', 'false_alarm'
    actual_depth: Optional[float] = None
    photos: Optional[List[str]] = None # List of base64 strings
    notes: Optional[str] = None
    investigator: Optional[str] = None
    investigator_username: Optional[str] = None
    logged_at: Optional[datetime.datetime] = None
    
    # New fields
    target_id: Optional[str] = None
    sohle_status: Optional[str] = None
    bilder_n: Optional[int] = 0
    other: Optional[str] = None
    fundstueck: Optional[str] = None
    laenge: Optional[float] = None
    breite: Optional[float] = None
    m_cube: Optional[float] = None
    teams_tools: Optional[TeamsTools] = None

class PointUpdate(BaseModel):
    id: str
    easting: float
    northing: float
    latitude: float
    longitude: float

class SyncPayload(BaseModel):
    feedback: List[FeedbackCreate]
    point_updates: Optional[List[PointUpdate]] = None


# API Endpoints
def _latest_feedback_by_anomaly(db: Session) -> dict:
    """anomaly_id -> its most recent feedback row, in one query.

    The same pick as asking per anomaly for ORDER BY visit_date DESC LIMIT 1 - which this
    replaced, at one query per target (2,659 for 2,658 targets on 2026-10-01) - including
    the database's own NULL ordering (PostgreSQL puts NULLs first on DESC). Ties are broken
    by id so the pick no longer depends on row order.
    """
    rank = func.row_number().over(
        partition_by=models.Feedback.anomaly_id,
        order_by=(models.Feedback.visit_date.desc(), models.Feedback.id),
    ).label("rank")
    ranked = db.query(models.Feedback, rank).subquery()
    latest = aliased(models.Feedback, ranked)
    return {fb.anomaly_id: fb for fb in db.query(latest).filter(ranked.c.rank == 1)}


@router.get("/api/points")
def get_points(
    db: Session = Depends(get_db),
    user: models.User = Depends(current_user),   # both surfaces read the points
):
    anomalies = db.query(models.Anomaly).all()
    latest_by_anomaly = _latest_feedback_by_anomaly(db)
    result = []
    for p in anomalies:
        latest_feedback = latest_by_anomaly.get(p.id)
        
        feedback_data = None
        local_status = 'unvisited'
        if latest_feedback:
            # Parse photos JSON list
            photos_list = []
            if latest_feedback.photos:
                try:
                    photos_list = json.loads(latest_feedback.photos)
                except Exception:
                    pass
            
            # Resolve status based on findings
            notes_str = (latest_feedback.notes or "") + (latest_feedback.other or "")
            fund = latest_feedback.fundstueck
            sohle = latest_feedback.sohle_status
            
            if fund == 'ohne Fund':
                local_status = 'false_alarm'
            elif any(w in notes_str.lower() for w in ['uxo', 'mine', 'bomb', 'munition', 'pmn']):
                local_status = 'uxo'
            elif sohle == 'Nicht Frei':
                local_status = 'scrap'
            else:
                local_status = 'clear'
                
            feedback_data = {
                "id": latest_feedback.id,
                "visited": latest_feedback.visited,
                "status": local_status,
                "actual_depth": latest_feedback.tief,
                "photos": photos_list,
                "notes": latest_feedback.notes,
                "investigator": latest_feedback.investigator,
                "investigator_username": latest_feedback.investigator_username,
                "logged_at": latest_feedback.visit_date.isoformat() if latest_feedback.visit_date else None,
                
                # New fields
                "target_id": latest_feedback.target_id,
                "sohle_status": latest_feedback.sohle_status,
                "bilder_n": latest_feedback.bilder_n,
                "other": latest_feedback.other,
                "fundstueck": latest_feedback.fundstueck,
                "laenge": latest_feedback.laenge,
                "breite": latest_feedback.breite,
                "m_cube": latest_feedback.m_cube,
                "teams_tools": latest_feedback.teams_tools
            }
            
        result.append({
            "id": p.id,
            "project_id": p.project_id,
            "target_id": p.target_id,
            "vm_nr": p.vm_nr,
            "easting": p.easting,
            "northing": p.northing,
            "latitude": p.latitude,
            "longitude": p.longitude,
            "evaluated_depth": p.evaluated_depth,
            "opening_length": latest_feedback.laenge if latest_feedback else None,
            "opening_width": latest_feedback.breite if latest_feedback else None,
            "opening_depth": latest_feedback.tief if latest_feedback else None,
            "opening_volume": latest_feedback.m_cube if latest_feedback else None,
            "find_description": latest_feedback.fundstueck if latest_feedback else None,
            "image_id": None,
            "remarks": latest_feedback.notes if latest_feedback else None,
            "created_at": None,
            "instrument": p.instrument,
            "layer": p.layer,
            # Survey classification from the picks (Kat-2, Kat-3 ...), or the Kat-1
            # every CSV/import path writes as a default. Not the Fundstück: that is
            # what was found on excavation and lives on the feedback record.
            "category": p.category,
            "feedback": feedback_data
        })
    return result

def _upsert_feedback(db: Session, values: dict, update_teams_tools: bool):
    """Insert a feedback row, or refresh it when the field app re-sends the same id.

    The queue in IndexedDB keeps a record until the server confirms it, and two sync
    cycles can overlap, so the plain INSERT this used to do raced itself into
    `duplicate key value violates unique constraint "feedback_pkey"` and 400'd the
    entire batch. ON CONFLICT DO UPDATE makes each row idempotent: a re-send of an
    unchanged record is a no-op, an edited record overwrites the stored one, and one
    already-present id can no longer fail its batch mates.

    DO UPDATE rather than DO NOTHING because a crew can reopen a target and correct
    its measurements - those corrections have to reach the server. The WHERE guard
    keeps that safe in the other direction: a stale copy that has been sitting in an
    offline queue can never clobber a newer visit already stored.
    """
    table = models.Feedback.__table__
    insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
    updatable = {k: v for k, v in values.items() if k != "id"}
    if not update_teams_tools:
        # No crew/kit block on this payload - keep whatever is already stored.
        updatable.pop("teams_tools", None)
    stmt = insert(table).values(**values).on_conflict_do_update(
        index_elements=[table.c.id],
        set_=updatable,
        where=(table.c.visit_date.is_(None)) | (table.c.visit_date <= values["visit_date"]),
    )
    db.execute(stmt)


@router.post("/api/sync")
def sync_data(
    payload: SyncPayload,
    db: Session = Depends(get_db),
    user: models.User = Depends(require_surface("field")),
):
    synced_feedback_count = 0
    for fb in payload.feedback:
        # Verify target anomaly exists in anomalies table to prevent foreign key violation
        anomaly = db.query(models.Anomaly).filter(models.Anomaly.id == fb.point_id).first()
        if not anomaly:
            import logging
            logger = logging.getLogger("server")
            logger.warning(f"Skipping sync of feedback log {fb.id} because parent anomaly {fb.point_id} does not exist.")
            continue

        logged_at_dt = fb.logged_at or datetime.datetime.utcnow()
        # The field app sends ISO-8601 with a trailing 'Z', so pydantic yields an aware datetime,
        # while visit_date is TIMESTAMP WITHOUT TIME ZONE and reads back naive. Normalise to naive
        # UTC so comparisons below don't raise and inserts aren't silently shifted by the session tz.
        if logged_at_dt.tzinfo is not None:
            logged_at_dt = logged_at_dt.astimezone(datetime.timezone.utc).replace(tzinfo=None)
        
        # Serialize photos list to JSON string
        photos_json = json.dumps(fb.photos) if fb.photos else "[]"

        # Stored as JSON so the whole teams & tools block travels as one column
        teams_tools_val = fb.teams_tools.model_dump() if fb.teams_tools else None
        
        # Update anomaly status to 'investigated' in anomalies table
        anomaly.status = 'investigated'
        
        _upsert_feedback(
            db,
            {
                "id": fb.id,
                "anomaly_id": fb.point_id,
                # Taken from the parent anomaly, not from the payload. The client never
                # sends a project - the form only displays the one it read off the point -
                # and taking it from the anomaly that was just resolved above means the
                # stored project cannot disagree with the target the record belongs to.
                "project_id": anomaly.project_id,
                "visited": fb.visited,
                "tief": fb.actual_depth,
                "photos": photos_json,
                "notes": fb.notes,
                "investigator": fb.investigator,
                "investigator_username": fb.investigator_username,
                "visit_date": logged_at_dt,

                # New fields
                "target_id": fb.target_id,
                "sohle_status": fb.sohle_status,
                "bilder_n": fb.bilder_n,
                "other": fb.other,
                "fundstueck": fb.fundstueck,
                "laenge": fb.laenge,
                "breite": fb.breite,
                "m_cube": fb.m_cube,
                "teams_tools": teams_tools_val,
            },
            update_teams_tools=teams_tools_val is not None,
        )
        synced_feedback_count += 1

    # Update coordinates of anomalies if present
    synced_points_count = 0
    if payload.point_updates:
        if db.bind and db.bind.dialect.name == "postgresql":
            db.execute(text("SELECT set_config('etl.change_reason', 'field_sync', true)"))
        for pu in payload.point_updates:
            db_anomaly = db.query(models.Anomaly).filter(models.Anomaly.id == pu.id).first()
            if db_anomaly:
                db_anomaly.easting = pu.easting
                db_anomaly.northing = pu.northing
                db_anomaly.latitude = pu.latitude
                db_anomaly.longitude = pu.longitude
                synced_points_count += 1
            
    try:
        db.commit()
    except Exception as e:
        db.rollback()
        import logging
        logger = logging.getLogger("server")
        logger.error(f"Sync commit failed: {e}")
        raise HTTPException(
            status_code=400,
            detail=f"Database synchronization failed. This usually means the records refer to targets this database does not hold. Targets are loaded by the ETL pipeline (etl/), not by the app: check that it has run against this database, then sync again. Error: {str(e)}"
        )
        
    return {
        "status": "success",
        "synced_feedback": synced_feedback_count,
        "synced_points": synced_points_count,
        "points": get_points(db)
    }


@router.get("/api/projects")
def list_projects(
    db: Session = Depends(get_db),
    user: models.User = Depends(current_user),   # used by both surfaces
):
    """Projects that actually carry anomalies, for the report filter dropdown."""
    rows = (
        db.query(models.Anomaly.project_id, models.Project.project_name)
        .join(models.Project, models.Project.project_id == models.Anomaly.project_id)
        .distinct()
        .all()
    )
    return [{"project_id": pid, "project_name": name} for pid, name in rows]


@router.get("/api/stats")
def get_stats(
    db: Session = Depends(get_db),
    user: models.User = Depends(require_surface("dashboard")),
):
    total_points = db.query(models.Anomaly).count()
    all_points = get_points(db)
    
    visited_count = 0
    unvisited_count = 0
    status_counts = {
        "clear": 0,
        "scrap": 0,
        "uxo": 0,
        "false_alarm": 0,
        "unvisited": 0
    }
    
    for p in all_points:
        if p["feedback"] and p["feedback"]["visited"]:
            visited_count += 1
            status = p["feedback"]["status"]
            if status in status_counts:
                status_counts[status] += 1
        else:
            unvisited_count += 1
            status_counts["unvisited"] += 1
            
    progress_percentage = (visited_count / total_points * 100) if total_points > 0 else 0
    
    return {
        "total_points": total_points,
        "visited_points": visited_count,
        "unvisited_points": unvisited_count,
        "progress_percentage": round(progress_percentage, 1),
        "status_distribution": status_counts
    }
