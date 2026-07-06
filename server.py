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

class PointCreate(BaseModel):
    vm_nr: int
    easting: float
    northing: float
    calculated_depth: Optional[float] = None
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
    points = db.query(models.Point).all()
    result = []
    for p in points:
        latest_feedback = (
            db.query(models.FeedbackLog)
            .filter(models.FeedbackLog.point_id == p.id)
            .order_by(models.FeedbackLog.logged_at.desc())
            .first()
        )
        
        feedback_data = None
        if latest_feedback:
            # Parse photos JSON list
            photos_list = []
            if latest_feedback.photos:
                try:
                    photos_list = json.loads(latest_feedback.photos)
                except Exception:
                    pass
                    
            feedback_data = {
                "id": latest_feedback.id,
                "visited": latest_feedback.visited,
                "status": latest_feedback.status,
                "actual_depth": latest_feedback.actual_depth,
                "photos": photos_list,
                "notes": latest_feedback.notes,
                "investigator": latest_feedback.investigator,
                "investigator_username": latest_feedback.investigator_username,
                "logged_at": latest_feedback.logged_at.isoformat() if latest_feedback.logged_at else None
            }
            
        result.append({
            "id": p.id,
            "vm_nr": p.vm_nr,
            "easting": p.easting,
            "northing": p.northing,
            "latitude": p.latitude,
            "longitude": p.longitude,
            "calculated_depth": p.calculated_depth,
            "opening_length": p.opening_length,
            "opening_width": p.opening_width,
            "opening_depth": p.opening_depth,
            "opening_volume": p.opening_volume,
            "find_description": p.find_description,
            "image_id": p.image_id,
            "remarks": p.remarks,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "feedback": feedback_data
        })
    return result

@app.post("/api/points/import")
def import_points(points_list: List[PointCreate], db: Session = Depends(get_db)):
    imported_count = 0
    for p_data in points_list:
        # Convert UTM 32N coordinates to Lat/Lng
        lat, lon = utm32n_to_latlon(p_data.easting, p_data.northing)
        
        db_point = models.Point(
            vm_nr=p_data.vm_nr,
            easting=p_data.easting,
            northing=p_data.northing,
            latitude=lat,
            longitude=lon,
            calculated_depth=p_data.calculated_depth,
            opening_length=p_data.opening_length,
            opening_width=p_data.opening_width,
            opening_depth=p_data.opening_depth,
            opening_volume=p_data.opening_volume,
            find_description=p_data.find_description,
            image_id=p_data.image_id,
            remarks=p_data.remarks
        )
        db.add(db_point)
        imported_count += 1
    db.commit()
    return {"status": "success", "imported": imported_count}

@app.post("/api/sync")
def sync_data(payload: SyncPayload, db: Session = Depends(get_db)):
    synced_feedback_count = 0
    for fb in payload.feedback:
        existing_fb = db.query(models.FeedbackLog).filter(models.FeedbackLog.id == fb.id).first()
        logged_at_dt = fb.logged_at or datetime.datetime.utcnow()
        
        # Serialize photos list to JSON string
        photos_json = json.dumps(fb.photos) if fb.photos else "[]"
        
        if existing_fb:
            if fb.logged_at and (not existing_fb.logged_at or fb.logged_at > existing_fb.logged_at):
                existing_fb.status = fb.status
                existing_fb.visited = fb.visited
                existing_fb.actual_depth = fb.actual_depth
                existing_fb.photos = photos_json
                existing_fb.notes = fb.notes
                existing_fb.investigator = fb.investigator
                existing_fb.investigator_username = fb.investigator_username
                existing_fb.logged_at = logged_at_dt
                synced_feedback_count += 1
        else:
            new_fb = models.FeedbackLog(
                id=fb.id,
                point_id=fb.point_id,
                visited=fb.visited,
                status=fb.status,
                actual_depth=fb.actual_depth,
                photos=photos_json,
                notes=fb.notes,
                investigator=fb.investigator,
                investigator_username=fb.investigator_username,
                logged_at=logged_at_dt
            )
            db.add(new_fb)
            synced_feedback_count += 1
            
    # Update coordinates of points if present
    synced_points_count = 0
    if payload.point_updates:
        for pu in payload.point_updates:
            db_point = db.query(models.Point).filter(models.Point.id == pu.id).first()
            if db_point:
                db_point.easting = pu.easting
                db_point.northing = pu.northing
                db_point.latitude = pu.latitude
                db_point.longitude = pu.longitude
                synced_points_count += 1
            
    db.commit()
    return {
        "status": "success",
        "synced_feedback": synced_feedback_count,
        "synced_points": synced_points_count,
        "points": get_points(db)
    }

@app.get("/api/stats")
def get_stats(db: Session = Depends(get_db)):
    total_points = db.query(models.Point).count()
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
    # Clear existing tables
    db.query(models.FeedbackLog).delete()
    db.query(models.Point).delete()
    db.commit()
    
    # Transcribed Excel Data: 29 Targets in Wilhelmshaven Rüstersieler Seedeich (UTM Zone 32N)
    excel_rows = [
        {"vm": 161, "x": 442972.981, "y": 5937097.795, "depth": 1.20, "l": 1.20, "w": 1.00, "d": 0.90, "v": 1.08, "find": "Eisenstange / Sohle frei", "img": 1, "rem": "tiefer nicht möglich, Kunststoffleitung"},
        {"vm": 1518, "x": 442973.039, "y": 5937094.115, "depth": 1.10, "l": 1.20, "w": 1.00, "d": 0.70, "v": 0.84, "find": "ohne Fund / Sohle nicht frei", "img": 2, "rem": "tiefer nicht möglich, Kunststoffleitung"},
        {"vm": 1515, "x": 442976.024, "y": 5937092.930, "depth": 1.00, "l": 1.00, "w": 1.00, "d": 0.60, "v": 0.60, "find": "ohne Fund / Sohle frei", "img": 3, "rem": "---"},
        {"vm": 1519, "x": 442974.440, "y": 5937090.100, "depth": 0.50, "l": 1.00, "w": 1.00, "d": 0.50, "v": 0.50, "find": "Eisenteil / Sohle frei", "img": 4, "rem": "---"},
        {"vm": 1202, "x": 442964.733, "y": 5937089.216, "depth": 0.70, "l": 1.00, "w": 1.00, "d": 0.80, "v": 0.80, "find": "Eisenstange / Sohle frei", "img": 5, "rem": "---"},
        {"vm": 474, "x": 442970.026, "y": 5937076.386, "depth": 1.20, "l": 1.00, "w": 1.00, "d": 1.20, "v": 1.20, "find": "Eisendraht / Sohle frei", "img": 6, "rem": "---"},
        {"vm": 1521, "x": 442980.747, "y": 5937070.030, "depth": 0.40, "l": 1.00, "w": 1.00, "d": 0.50, "v": 0.50, "find": "ohne Fund / Sohle frei", "img": 7, "rem": "---"},
        {"vm": 473, "x": 442982.135, "y": 5937060.746, "depth": 1.00, "l": 1.00, "w": 1.00, "d": 0.30, "v": 0.30, "find": "Eisenstab / Sohle frei", "img": 8, "rem": "tiefer nicht möglich, Kunststoffleitung"},
        {"vm": 1418, "x": 442986.683, "y": 5937052.314, "depth": 0.30, "l": 1.00, "w": 1.00, "d": 0.40, "v": 0.40, "find": "Eisenteil / Sohle frei", "img": 9, "rem": "---"},
        {"vm": 468, "x": 442978.570, "y": 5937046.843, "depth": 1.20, "l": 1.00, "w": 1.00, "d": 1.20, "v": 1.20, "find": "Eisenteil / Sohle frei", "img": 10, "rem": "---"},
        {"vm": 1219, "x": 442975.528, "y": 5937051.648, "depth": 1.00, "l": 1.00, "w": 1.00, "d": 1.00, "v": 1.00, "find": "Eisendraht & Teile / Sohle frei", "img": 11, "rem": "---"},
        {"vm": 170, "x": 442991.185, "y": 5937031.697, "depth": 0.90, "l": 1.00, "w": 1.00, "d": 0.40, "v": 0.40, "find": "Eisendraht / Sohle frei", "img": 12, "rem": "tiefer nicht möglich, Kunststoffleitung"},
        {"vm": 1442, "x": 443271.969, "y": 5936200.739, "depth": 0.70, "l": 1.00, "w": 1.00, "d": 0.60, "v": 0.60, "find": "Eisendraht / Sohle frei", "img": 13, "rem": "---"},
        {"vm": 59, "x": 443270.955, "y": 5936191.152, "depth": 0.90, "l": 1.00, "w": 1.00, "d": 0.90, "v": 0.90, "find": "Eisenseil / Sohle frei", "img": 14, "rem": "---"},
        {"vm": 1336, "x": 443277.268, "y": 5936184.080, "depth": 0.70, "l": 1.00, "w": 1.00, "d": 0.80, "v": 0.80, "find": "Eisennägel / Sohle Frei", "img": 15, "rem": "---"},
        {"vm": 1463, "x": 443298.022, "y": 5936147.441, "depth": 0.40, "l": 1.00, "w": 1.00, "d": 0.50, "v": 0.50, "find": "Eisenstab / Sohle frei", "img": 16, "rem": "---"},
        {"vm": 1410, "x": 443330.226, "y": 5936094.470, "depth": 0.70, "l": 1.00, "w": 1.00, "d": 0.70, "v": 0.70, "find": "Eisenstab / Sohle frei", "img": 17, "rem": "---"},
        {"vm": 1401, "x": 443334.440, "y": 5936091.621, "depth": 0.40, "l": 1.00, "w": 1.00, "d": 0.50, "v": 0.50, "find": "ohne Fund / Sohle frei", "img": 18, "rem": "---"},
        {"vm": 1383, "x": 443360.214, "y": 5936048.474, "depth": 0.50, "l": 1.00, "w": 1.00, "d": 0.60, "v": 0.60, "find": "Eisenstab / Sohle frei", "img": 19, "rem": "---"},
        {"vm": 1341, "x": 443380.399, "y": 5936014.391, "depth": 0.90, "l": 1.00, "w": 1.00, "d": 0.90, "v": 0.90, "find": "ohne Fund / Sohle frei", "img": 20, "rem": "---"},
        {"vm": 1365, "x": 443383.341, "y": 5936009.608, "depth": 0.20, "l": 1.00, "w": 0.50, "d": 0.30, "v": 0.15, "find": "ohne Fund / Sohle frei", "img": 21, "rem": "---"},
        {"vm": 1433, "x": 443389.749, "y": 5936002.133, "depth": 0.30, "l": 1.00, "w": 0.50, "d": 0.40, "v": 0.20, "find": "ohne Fund / Sohle frei", "img": 22, "rem": "---"},
        {"vm": 1397, "x": 443393.472, "y": 5935990.790, "depth": 0.10, "l": 0.50, "w": 0.50, "d": 0.20, "v": 0.05, "find": "ohne Fund / Sohle frei", "img": 23, "rem": "---"},
        {"vm": 1430, "x": 443400.633, "y": 5935988.556, "depth": 0.30, "l": 1.00, "w": 1.00, "d": 0.80, "v": 0.32, "find": "Eisenteil / Sohle frei", "img": 24, "rem": "---"},
        {"vm": 1387, "x": 443401.341, "y": 5935980.900, "depth": 0.40, "l": 1.00, "w": 0.70, "d": 0.50, "v": 0.35, "find": "Eisenteil / Sohle frei", "img": 25, "rem": "---"},
        {"vm": 1409, "x": 443405.389, "y": 5935980.851, "depth": 0.70, "l": 1.00, "w": 1.00, "d": 0.60, "v": 0.60, "find": "Eisenstab / Sohle frei", "img": 26, "rem": "---"},
        {"vm": 1419, "x": 443425.437, "y": 5935943.771, "depth": 0.20, "l": 1.00, "w": 0.50, "d": 0.40, "v": 0.20, "find": "ohne Fund / Sohle frei", "img": 27, "rem": "---"},
        {"vm": 1178, "x": 443470.349, "y": 5935866.705, "depth": 1.00, "l": 1.00, "w": 1.00, "d": 0.70, "v": 0.70, "find": "Eisenseil / Sohle nicht frei", "img": 28, "rem": "hochgelegt und abgesperrt, länge ub."},
        {"vm": 28, "x": 443470.763, "y": 5935866.260, "depth": 1.20, "l": 1.00, "w": 1.00, "d": 0.70, "v": 0.70, "find": "Eisenseil / Sohle nicht frei", "img": 29, "rem": "hochgelegt und abgesperrt, länge ub."}
    ]
    
    db_points = []
    for r in excel_rows:
        lat, lon = utm32n_to_latlon(r["x"], r["y"])
        p = models.Point(
            id=f"pt-uuid-vm-{r['vm']}",
            vm_nr=r["vm"],
            easting=r["x"],
            northing=r["y"],
            latitude=lat,
            longitude=lon,
            calculated_depth=r["depth"],
            opening_length=r["l"],
            opening_width=r["w"],
            opening_depth=r["d"],
            opening_volume=r["v"],
            find_description=r["find"],
            image_id=r["img"],
            remarks=r["rem"]
        )
        db_points.append(p)
        db.add(p)
        
    db.commit()
    
    # Pre-populate 4 investigated targets to show Green markers and display mock data
    # Target 1 (VM 161) - Investigated: Clear
    db.add(models.FeedbackLog(
        id="fb-uuid-161",
        point_id="pt-uuid-vm-161",
        visited=True,
        status="clear",
        actual_depth=1.20,
        photos=json.dumps([]),
        notes="Excavated. Confirmed Eisenstange at 1.20m depth as described. Cleared and backfilled.",
        investigator="Eric Musonera",
        investigator_username="eric.musonera",
        logged_at=datetime.datetime.utcnow() - datetime.timedelta(hours=6)
    ))
    
    # Target 4 (VM 1519) - Investigated: Scrap Metal
    db.add(models.FeedbackLog(
        id="fb-uuid-1519",
        point_id="pt-uuid-vm-1519",
        visited=True,
        status="scrap",
        actual_depth=0.55,
        photos=json.dumps([]),
        notes="Dug and found rusted iron scrap bracket. Fits calculated depth of 0.50m. Logged.",
        investigator="Field Collector A",
        investigator_username="collector_a",
        logged_at=datetime.datetime.utcnow() - datetime.timedelta(hours=4)
    ))
    
    # Target 8 (VM 473) - Investigated: False Alarm
    db.add(models.FeedbackLog(
        id="fb-uuid-473",
        point_id="pt-uuid-vm-473",
        visited=True,
        status="false_alarm",
        actual_depth=0.35,
        notes="Excavation aborted due to intersection with active utility (Kunststoffleitung). Signal caused by surrounding mineralization.",
        investigator="Eric Musonera",
        investigator_username="eric.musonera",
        logged_at=datetime.datetime.utcnow() - datetime.timedelta(hours=2)
    ))
    
    # Target 28 (VM 1178) - Investigated: UXO / Mine
    db.add(models.FeedbackLog(
        id="fb-uuid-1178",
        point_id="pt-uuid-vm-1178",
        visited=True,
        status="uxo",
        actual_depth=1.05,
        notes="PMN-2 landmine variant detected in close proximity to Seedeich boundary. Area secured and flagged for demolition.",
        investigator="Field Collector B",
        investigator_username="collector_b",
        logged_at=datetime.datetime.utcnow() - datetime.timedelta(hours=1)
    ))
    
    db.commit()
    return {"status": "success", "seeded_points": len(db_points), "seeded_feedback": 4}

if os.path.exists("./static"):
    app.mount("/", StaticFiles(directory="./static", html=True), name="static")
else:
    @app.get("/")
    def read_root():
        return {"message": "Nolte Geoservices platform server running."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
