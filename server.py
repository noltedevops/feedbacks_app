from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from typing import List, Optional
from pydantic import BaseModel
import datetime
import os
import json

from database import init_db, get_db, utm32n_to_latlon
import models
from config import settings

init_db()

app = FastAPI(title="Nolte Geoservices UXO Target Sync Platform")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Schemas
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

class PointCreate(BaseModel):
    vm_nr: str
    easting: float
    northing: float
    evaluated_depth: Optional[float] = None
    opening_length: Optional[float] = None
    opening_width: Optional[float] = None
    opening_depth: Optional[float] = None
    opening_volume: Optional[float] = None
    find_description: Optional[str] = None
    image_id: Optional[int] = None
    remarks: Optional[str] = None

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
@app.get("/api/points")
def get_points(db: Session = Depends(get_db)):
    anomalies = db.query(models.Anomaly).all()
    result = []
    for p in anomalies:
        latest_feedback = (
            db.query(models.Feedback)
            .filter(models.Feedback.anomaly_id == p.id)
            .order_by(models.Feedback.visit_date.desc())
            .first()
        )
        
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
                "m_cube": latest_feedback.m_cube
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
            "feedback": feedback_data
        })
    return result

@app.post("/api/points/import")
def import_points(points_list: List[PointCreate], db: Session = Depends(get_db)):
    imported_count = 0
    # Ensure project exists
    project = db.query(models.Project).filter(models.Project.project_id == '11-24-2736').first()
    if not project:
        project = models.Project(
            project_id='11-24-2736',
            project_name='Wilhemshaven Rüstersieler Seedeich'
        )
        db.add(project)
        db.commit()

    existing_count = db.query(models.Anomaly).filter(models.Anomaly.project_id == '11-24-2736').count()
    for p_data in points_list:
        # Convert UTM 32N coordinates to Lat/Lng
        lat, lon = utm32n_to_latlon(p_data.easting, p_data.northing)
        
        seq_nr = existing_count + 1
        vm_nr_val = f"2736-{seq_nr}"
        target_id_val = f"11-24-2736-{p_data.easting:.3f}-{p_data.northing:.3f}"
        
        db_anomaly = models.Anomaly(
            id=f"pt-uuid-vm-{vm_nr_val}",
            project_id='11-24-2736',
            instrument='georadar',
            easting=p_data.easting,
            northing=p_data.northing,
            latitude=lat,
            longitude=lon,
            evaluated_depth=p_data.evaluated_depth,
            vm_nr=vm_nr_val,
            target_id=target_id_val,
            category='Kat-1',
            layer='Stoerkoerper Georadar',
            status='pending'
        )
        db.add(db_anomaly)
        existing_count += 1
        imported_count += 1
    db.commit()
    return {"status": "success", "imported": imported_count}

@app.post("/api/sync")
def sync_data(payload: SyncPayload, db: Session = Depends(get_db)):
    synced_feedback_count = 0
    for fb in payload.feedback:
        # Verify target anomaly exists in anomalies table to prevent foreign key violation
        anomaly = db.query(models.Anomaly).filter(models.Anomaly.id == fb.point_id).first()
        if not anomaly:
            import logging
            logger = logging.getLogger("server")
            logger.warning(f"Skipping sync of feedback log {fb.id} because parent anomaly {fb.point_id} does not exist.")
            continue

        existing_fb = db.query(models.Feedback).filter(models.Feedback.id == fb.id).first()
        logged_at_dt = fb.logged_at or datetime.datetime.utcnow()
        
        # Serialize photos list to JSON string
        photos_json = json.dumps(fb.photos) if fb.photos else "[]"
        
        # Update anomaly status to 'investigated' in anomalies table
        anomaly.status = 'investigated'
        
        if existing_fb:
            if fb.logged_at and (not existing_fb.visit_date or fb.logged_at > existing_fb.visit_date):
                existing_fb.visited = fb.visited
                existing_fb.tief = fb.actual_depth
                existing_fb.photos = photos_json
                existing_fb.notes = fb.notes
                existing_fb.investigator = fb.investigator
                existing_fb.investigator_username = fb.investigator_username
                existing_fb.visit_date = logged_at_dt
                
                # New fields
                existing_fb.target_id = fb.target_id
                existing_fb.sohle_status = fb.sohle_status
                existing_fb.bilder_n = fb.bilder_n
                existing_fb.other = fb.other
                existing_fb.fundstueck = fb.fundstueck
                existing_fb.laenge = fb.laenge
                existing_fb.breite = fb.breite
                existing_fb.m_cube = fb.m_cube
                
                synced_feedback_count += 1
        else:
            new_fb = models.Feedback(
                id=fb.id,
                anomaly_id=fb.point_id,
                visited=fb.visited,
                tief=fb.actual_depth,
                photos=photos_json,
                notes=fb.notes,
                investigator=fb.investigator,
                investigator_username=fb.investigator_username,
                visit_date=logged_at_dt,
                
                # New fields
                target_id=fb.target_id,
                sohle_status=fb.sohle_status,
                bilder_n=fb.bilder_n,
                other=fb.other,
                fundstueck=fb.fundstueck,
                laenge=fb.laenge,
                breite=fb.breite,
                m_cube=fb.m_cube
            )
            db.add(new_fb)
            synced_feedback_count += 1
            
    # Update coordinates of anomalies if present
    synced_points_count = 0
    if payload.point_updates:
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
            detail=f"Database synchronization failed. This usually happens if the backend database has not been seeded with targets yet. Please seed the database and try again. Error: {str(e)}"
        )
        
    return {
        "status": "success",
        "synced_feedback": synced_feedback_count,
        "synced_points": synced_points_count,
        "points": get_points(db)
    }


@app.get("/api/stats")
def get_stats(db: Session = Depends(get_db)):
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

@app.post("/api/seed")
def seed_mock_data(db: Session = Depends(get_db)):
    # Clear existing tables in dependency order
    db.query(models.Feedback).delete()
    db.query(models.Anomaly).delete()
    db.query(models.Project).delete()
    db.commit()
    
    # Seed the Project
    project = models.Project(
        project_id='11-24-2736',
        project_name='Wilhemshaven Rüstersieler Seedeich'
    )
    db.add(project)
    db.commit()
    
    # Transcribed Excel Data: 29 Targets in Wilhelmshaven Rüstersieler Seedeich (UTM Zone 32N)
    excel_rows = [
        {"vm": 161, "x": 442972.981, "y": 5937097.795, "depth": 1.20, "l": 1.20, "w": 1.00, "d": 0.90, "v": 1.08, "find": "Eisenstange / Eisenstab", "sohle": "Frei", "rem": "tiefer nicht möglich, Kunststoffleitung"},
        {"vm": 1518, "x": 442973.039, "y": 5937094.115, "depth": 1.10, "l": 1.20, "w": 1.00, "d": 0.70, "v": 0.84, "find": "ohne Fund", "sohle": "Nicht Frei", "rem": "tiefer nicht möglich, Kunststoffleitung"},
        {"vm": 1515, "x": 442976.024, "y": 5937092.930, "depth": 1.00, "l": 1.00, "w": 1.00, "d": 0.60, "v": 0.60, "find": "ohne Fund", "sohle": "Frei", "rem": "---"},
        {"vm": 1519, "x": 442974.440, "y": 5937090.100, "depth": 0.50, "l": 1.00, "w": 1.00, "d": 0.50, "v": 0.50, "find": "Eisenteil", "sohle": "Frei", "rem": "---"},
        {"vm": 1202, "x": 442964.733, "y": 5937089.216, "depth": 0.70, "l": 1.00, "w": 1.00, "d": 0.80, "v": 0.80, "find": "Eisenstange / Eisenstab", "sohle": "Frei", "rem": "---"},
        {"vm": 474, "x": 442970.026, "y": 5937076.386, "depth": 1.20, "l": 1.00, "w": 1.00, "d": 1.20, "v": 1.20, "find": "Eisendraht", "sohle": "Frei", "rem": "---"},
        {"vm": 1521, "x": 442980.747, "y": 5937070.030, "depth": 0.40, "l": 1.00, "w": 1.00, "d": 0.50, "v": 0.50, "find": "ohne Fund", "sohle": "Frei", "rem": "---"},
        {"vm": 473, "x": 442982.135, "y": 5937060.746, "depth": 1.00, "l": 1.00, "w": 1.00, "d": 0.30, "v": 0.30, "find": "Eisenstab", "sohle": "Frei", "rem": "tiefer nicht möglich, Kunststoffleitung"},
        {"vm": 1418, "x": 442986.683, "y": 5937052.314, "depth": 0.30, "l": 1.00, "w": 1.00, "d": 0.40, "v": 0.40, "find": "Eisenteil", "sohle": "Frei", "rem": "---"},
        {"vm": 468, "x": 442978.570, "y": 5937046.843, "depth": 1.20, "l": 1.00, "w": 1.00, "d": 1.20, "v": 1.20, "find": "Eisenteil", "sohle": "Frei", "rem": "---"},
        {"vm": 1219, "x": 442975.528, "y": 5937051.648, "depth": 1.00, "l": 1.00, "w": 1.00, "d": 1.00, "v": 1.00, "find": "Eisendraht", "sohle": "Frei", "rem": "---"},
        {"vm": 170, "x": 442991.185, "y": 5937031.697, "depth": 0.90, "l": 1.00, "w": 1.00, "d": 0.40, "v": 0.40, "find": "Eisendraht", "sohle": "Frei", "rem": "tiefer nicht möglich, Kunststoffleitung"},
        {"vm": 1442, "x": 443271.969, "y": 5936200.739, "depth": 0.70, "l": 1.00, "w": 1.00, "d": 0.60, "v": 0.60, "find": "Eisendraht", "sohle": "Frei", "rem": "---"},
        {"vm": 59, "x": 443270.955, "y": 5936191.152, "depth": 0.90, "l": 1.00, "w": 1.00, "d": 0.90, "v": 0.90, "find": "Eisenseil", "sohle": "Frei", "rem": "---"},
        {"vm": 1336, "x": 443277.268, "y": 5936184.080, "depth": 0.70, "l": 1.00, "w": 1.00, "d": 0.80, "v": 0.80, "find": "Eisennägel", "sohle": "Frei", "rem": "---"},
        {"vm": 1463, "x": 443298.022, "y": 5936147.441, "depth": 0.40, "l": 1.00, "w": 1.00, "d": 0.50, "v": 0.50, "find": "Eisenstange / Eisenstab", "sohle": "Frei", "rem": "---"},
        {"vm": 1410, "x": 443330.226, "y": 5936094.470, "depth": 0.70, "l": 1.00, "w": 1.00, "d": 0.70, "v": 0.70, "find": "Eisenstange / Eisenstab", "sohle": "Frei", "rem": "---"},
        {"vm": 1401, "x": 443334.440, "y": 5936091.621, "depth": 0.40, "l": 1.00, "w": 1.00, "d": 0.50, "v": 0.50, "find": "ohne Fund", "sohle": "Frei", "rem": "---"},
        {"vm": 1383, "x": 443360.214, "y": 5936048.474, "depth": 0.50, "l": 1.00, "w": 1.00, "d": 0.60, "v": 0.60, "find": "Eisenstange / Eisenstab", "sohle": "Frei", "rem": "---"},
        {"vm": 1341, "x": 443380.399, "y": 5936014.391, "depth": 0.90, "l": 1.00, "w": 1.00, "d": 0.90, "v": 0.90, "find": "ohne Fund", "sohle": "Frei", "rem": "---"},
        {"vm": 1365, "x": 443383.341, "y": 5936009.608, "depth": 0.20, "l": 1.00, "w": 0.50, "d": 0.30, "v": 0.15, "find": "ohne Fund", "sohle": "Frei", "rem": "---"},
        {"vm": 1433, "x": 443389.749, "y": 5936002.133, "depth": 0.30, "l": 1.00, "w": 0.50, "d": 0.40, "v": 0.20, "find": "ohne Fund", "sohle": "Frei", "rem": "---"},
        {"vm": 1397, "x": 443393.472, "y": 5935990.790, "depth": 0.10, "l": 0.50, "w": 0.50, "d": 0.20, "v": 0.05, "find": "ohne Fund", "sohle": "Frei", "rem": "---"},
        {"vm": 1430, "x": 443400.633, "y": 5935988.556, "depth": 0.30, "l": 1.00, "w": 1.00, "d": 0.80, "v": 0.32, "find": "Eisenteil", "sohle": "Frei", "rem": "---"},
        {"vm": 1387, "x": 443401.341, "y": 5935980.900, "depth": 0.40, "l": 1.00, "w": 0.70, "d": 0.50, "v": 0.35, "find": "Eisenteil", "sohle": "Frei", "rem": "---"},
        {"vm": 1409, "x": 443405.389, "y": 5935980.851, "depth": 0.70, "l": 1.00, "w": 1.00, "d": 0.60, "v": 0.60, "find": "Eisenstange / Eisenstab", "sohle": "Frei", "rem": "---"},
        {"vm": 1419, "x": 443425.437, "y": 5935943.771, "depth": 0.20, "l": 1.00, "w": 0.50, "d": 0.40, "v": 0.20, "find": "ohne Fund", "sohle": "Frei", "rem": "---"},
        {"vm": 1178, "x": 443470.349, "y": 5935866.705, "depth": 1.00, "l": 1.00, "w": 1.00, "d": 0.70, "v": 0.70, "find": "Eisenseil", "sohle": "Nicht Frei", "rem": "hochgelegt und abgesperrt, länge ub."},
        {"vm": 28, "x": 443470.763, "y": 5935866.260, "depth": 1.20, "l": 1.00, "w": 1.00, "d": 0.70, "v": 0.70, "find": "Eisenseil", "sohle": "Nicht Frei", "rem": "hochgelegt und abgesperrt, länge ub."}
    ]
    
    db_anomalies = []
    for i, r in enumerate(excel_rows):
        lat, lon = utm32n_to_latlon(r["x"], r["y"])
        vm_nr_val = f"2736-{i+1}"
        target_id_val = f"11-24-2736-{r['x']:.3f}-{r['y']:.3f}"
        
        p = models.Anomaly(
            id=f"pt-uuid-vm-{vm_nr_val}",
            project_id='11-24-2736',
            instrument='georadar',
            easting=r["x"],
            northing=r["y"],
            latitude=lat,
            longitude=lon,
            evaluated_depth=r["depth"],
            vm_nr=vm_nr_val,
            target_id=target_id_val,
            category='Kat-1',
            layer="Stoerkoerper Georadar",
            status='pending'
        )
        db_anomalies.append(p)
        db.add(p)
        
    db.commit()
    
    # Pre-populate 4 investigated targets to show Green markers and display mock data
    # Target 1 (VM 2736-1) - Investigated: Clear
    anomaly_1 = db.query(models.Anomaly).filter(models.Anomaly.id == "pt-uuid-vm-2736-1").first()
    if anomaly_1:
        anomaly_1.status = "investigated"
    db.add(models.Feedback(
        id="fb-uuid-161",
        anomaly_id="pt-uuid-vm-2736-1",
        visited=True,
        tief=1.20,
        photos=json.dumps([]),
        notes="Excavated. Confirmed Eisenstange at 1.20m depth as described. Cleared and backfilled.",
        investigator="Eric Musonera",
        investigator_username="eric.musonera",
        visit_date=datetime.datetime.utcnow() - datetime.timedelta(hours=6),
        target_id="11-24-2736-442972.981-5937097.795",
        sohle_status="Frei",
        bilder_n=0,
        fundstueck="Eisenstange / Eisenstab",
        laenge=1.20,
        breite=1.00,
        m_cube=1.08,
        other=None
    ))
    
    # Target 4 (VM 2736-4) - Investigated: Scrap Metal
    anomaly_4 = db.query(models.Anomaly).filter(models.Anomaly.id == "pt-uuid-vm-2736-4").first()
    if anomaly_4:
        anomaly_4.status = "investigated"
    db.add(models.Feedback(
        id="fb-uuid-1519",
        anomaly_id="pt-uuid-vm-2736-4",
        visited=True,
        tief=0.55,
        photos=json.dumps([]),
        notes="Dug and found rusted iron scrap bracket. Fits calculated depth of 0.50m. Logged.",
        investigator="Field Collector A",
        investigator_username="collector_a",
        visit_date=datetime.datetime.utcnow() - datetime.timedelta(hours=4),
        target_id="11-24-2736-442974.440-5937090.100",
        sohle_status="Frei",
        bilder_n=0,
        fundstueck="Eisenteil",
        laenge=1.00,
        breite=1.00,
        m_cube=0.50,
        other=None
    ))
    
    # Target 8 (VM 2736-8) - Investigated: False Alarm
    anomaly_8 = db.query(models.Anomaly).filter(models.Anomaly.id == "pt-uuid-vm-2736-8").first()
    if anomaly_8:
        anomaly_8.status = "investigated"
    db.add(models.Feedback(
        id="fb-uuid-473",
        anomaly_id="pt-uuid-vm-2736-8",
        visited=True,
        tief=0.35,
        notes="Excavation aborted due to intersection with active utility (Kunststoffleitung). Signal caused by surrounding mineralization.",
        investigator="Eric Musonera",
        investigator_username="eric.musonera",
        visit_date=datetime.datetime.utcnow() - datetime.timedelta(hours=2),
        target_id="11-24-2736-442982.135-5937060.746",
        sohle_status="Frei",
        bilder_n=0,
        fundstueck="ohne Fund",
        laenge=1.00,
        breite=1.00,
        m_cube=0.30,
        other=None
    ))
    
    # Target 28 (VM 2736-28) - Investigated: UXO / Mine
    anomaly_28 = db.query(models.Anomaly).filter(models.Anomaly.id == "pt-uuid-vm-2736-28").first()
    if anomaly_28:
        anomaly_28.status = "investigated"
    db.add(models.Feedback(
        id="fb-uuid-1178",
        anomaly_id="pt-uuid-vm-2736-28",
        visited=True,
        tief=1.05,
        notes="PMN-2 landmine variant detected in close proximity to Seedeich boundary. Area secured and flagged for demolition.",
        investigator="Field Collector B",
        investigator_username="collector_b",
        visit_date=datetime.datetime.utcnow() - datetime.timedelta(hours=1),
        target_id="11-24-2736-443470.349-5935866.705",
        sohle_status="Nicht Frei",
        bilder_n=0,
        fundstueck="Eisenseil",
        laenge=1.00,
        breite=1.00,
        m_cube=0.70,
        other=None
    ))
    
    db.commit()
    return {"status": "success", "seeded_points": len(db_anomalies), "seeded_feedback": 4}

if os.path.exists("./static"):
    app.mount("/", StaticFiles(directory="./static", html=True), name="static")
else:
    @app.get("/")
    def read_root():
        return {"message": "Nolte Geoservices platform server running."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
