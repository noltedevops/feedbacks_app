from fastapi import FastAPI, Depends, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from typing import List, Optional
from pydantic import BaseModel
import datetime
import hashlib
import hmac
import os
import json
import secrets
import uuid

from database import init_db, get_db, utm32n_to_latlon
import models
import report
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

class UserRegister(BaseModel):
    full_name: str
    username: str
    email: Optional[str] = None
    password: str

class UserLogin(BaseModel):
    username: str
    password: str

class PermissionRequestCreate(BaseModel):
    surface: str                      # 'field' or 'dashboard'
    message: Optional[str] = None

class PermissionDecision(BaseModel):
    approve: bool

class UserAccessUpdate(BaseModel):
    can_field: Optional[bool] = None
    can_dashboard: Optional[bool] = None
    is_admin: Optional[bool] = None

class PasswordChange(BaseModel):
    current_password: str
    new_password: str


# Passwords: PBKDF2-HMAC-SHA256 via hashlib, so there is no dependency to install
# on the field laptops. Encoded as pbkdf2_sha256$<iterations>$<salt>$<hash> and
# stored in users.password_hash, which is String(255) - an encoded value is ~110.
PBKDF2_ITERATIONS = 240_000
_HASH_PREFIX = "pbkdf2_sha256"


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ITERATIONS
    )
    return f"{_HASH_PREFIX}${PBKDF2_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Check a password against a stored value.

    Rows written before hashing was introduced hold the password in the clear;
    those are compared directly so existing accounts keep working, and the caller
    is expected to re-hash them (see needs_rehash).
    """
    if not stored:
        return False
    if not stored.startswith(f"{_HASH_PREFIX}$"):
        return hmac.compare_digest(password, stored)
    try:
        _, iterations, salt, expected = stored.split("$", 3)
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt.encode("utf-8"), int(iterations)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), expected)


def _auth_secret() -> str:
    """Key that signs session tokens.

    Falls back to a per-process random key so local runs need no configuration;
    the cost is that restarting the server invalidates outstanding tokens, hence
    the warning. Set AUTH_SECRET in .env on anything shared.
    """
    global _RUNTIME_SECRET
    if settings.auth_secret:
        return settings.auth_secret
    if _RUNTIME_SECRET is None:
        _RUNTIME_SECRET = secrets.token_hex(32)
        print("AUTH_SECRET is not set - using a random key; sessions end on restart.")
    return _RUNTIME_SECRET


_RUNTIME_SECRET = None
TOKEN_TTL = datetime.timedelta(days=30)


def issue_token(user: "models.User") -> str:
    """Stateless token: <user_id>.<expiry>.<signature>.

    Stateless so a field device that has been offline for days keeps its session
    without the server holding state, and so nothing new has to sync.
    """
    expires = int((datetime.datetime.utcnow() + TOKEN_TTL).timestamp())
    payload = f"{user.id}.{expires}"
    signature = hmac.new(
        _auth_secret().encode("utf-8"), payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"{payload}.{signature}"


def read_token(token: str) -> Optional[str]:
    """Return the user id in a valid, unexpired token, else None."""
    if not token:
        return None
    try:
        user_id, expires, signature = token.rsplit(".", 2)
    except ValueError:
        return None
    expected = hmac.new(
        _auth_secret().encode("utf-8"), f"{user_id}.{expires}".encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        if int(expires) < datetime.datetime.utcnow().timestamp():
            return None
    except ValueError:
        return None
    return user_id


def needs_rehash(stored: str) -> bool:
    """True for legacy plaintext rows and for hashes below the current cost."""
    if not stored or not stored.startswith(f"{_HASH_PREFIX}$"):
        return True
    try:
        return int(stored.split("$", 2)[1]) < PBKDF2_ITERATIONS
    except (ValueError, IndexError):
        return True


SURFACE_FLAG = {"field": "can_field", "dashboard": "can_dashboard"}
SURFACE_LABEL = {"field": "Field App", "dashboard": "Dashboard"}


def current_user(request: Request, db: Session = Depends(get_db)) -> models.User:
    """Resolve the caller from the bearer token, or 401."""
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    user_id = read_token(token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Anmeldung erforderlich.")
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=401, detail="Anmeldung erforderlich.")
    return user


def _block_until_password_changed(user: models.User):
    """A temporary password opens nothing but the change-password screen."""
    if user.must_change_password:
        raise HTTPException(
            status_code=403,
            detail={
                "must_change_password": True,
                "message": "Bitte vergeben Sie zuerst ein eigenes Passwort.",
            },
        )


def require_admin(user: models.User = Depends(current_user)) -> models.User:
    _block_until_password_changed(user)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Nur für Administratoren.")
    return user


def require_surface(surface: str):
    """Dependency factory gating an endpoint behind one of the app surfaces.

    The 403 body carries the surface so the client knows which permission to
    offer to request, rather than showing a bare error.
    """
    def dependency(user: models.User = Depends(current_user)) -> models.User:
        _block_until_password_changed(user)
        if not getattr(user, SURFACE_FLAG[surface], False):
            raise HTTPException(
                status_code=403,
                detail={
                    "surface": surface,
                    "message": f"Kein Zugriff auf {SURFACE_LABEL[surface]}. "
                               f"Bitte Berechtigung beim Administrator anfragen.",
                },
            )
        return user
    return dependency


def require_any_surface(*surfaces: str):
    """Gate an endpoint behind holding at least one of several surfaces.

    For things both apps legitimately offer, such as the CSV export that the
    field app exposes to crews and the dashboard exposes alongside the PDF.
    Requiring 'dashboard' there locked collectors out of a button their own
    screen shows them.
    """
    def dependency(user: models.User = Depends(current_user)) -> models.User:
        _block_until_password_changed(user)
        if any(getattr(user, SURFACE_FLAG[s], False) for s in surfaces):
            return user
        # Name the first surface as the one to request: it is the caller's own
        # app, so it is the permission that will actually help them.
        wanted = surfaces[0]
        raise HTTPException(
            status_code=403,
            detail={
                "surface": wanted,
                "message": f"Kein Zugriff auf {SURFACE_LABEL[wanted]}. "
                           f"Bitte Berechtigung beim Administrator anfragen.",
            },
        )
    return dependency


def user_payload(user: models.User, token: Optional[str] = None) -> dict:
    payload = {
        "status": "success",
        "id": user.id,
        "username": user.username,
        "full_name": user.full_name,
        "email": user.email,
        "role": user.role,
        "can_field": bool(user.can_field),
        "can_dashboard": bool(user.can_dashboard),
        "is_admin": bool(user.is_admin),
        "must_change_password": bool(user.must_change_password),
    }
    if token:
        payload["token"] = token
    return payload


def seed_default_users(db: Session):
    # Only ever used to fill an empty table. The password comes from the
    # environment so it is not a literal in a file that gets pushed; without it
    # each seeded account gets its own random one, which has to be reset rather
    # than guessed.
    try:
        if db.query(models.User).count() == 0:
            # settings, not os.getenv: the value lives in .env, which only
            # pydantic reads - os.environ never sees it.
            seed_password = settings.seed_password
            if not seed_password:
                print("SEED_PASSWORD not set - seeding accounts with random passwords.")

            def seed_hash():
                return hash_password(seed_password or secrets.token_urlsafe(24))

            default_users = [
                models.User(
                    id="usr-collector-001",
                    full_name="Eric Musonera",
                    username="collector",
                    email="eric.musonera@nolte-geoservices.de",
                    password_hash=seed_hash(),
                    role="collector",
                    can_field=True, can_dashboard=False, is_admin=False
                ),
                models.User(
                    id="usr-dashboard-001",
                    full_name="Operations Analyst",
                    username="dashboard",
                    email="analytics@nolte-geoservices.de",
                    password_hash=seed_hash(),
                    role="dashboard",
                    can_field=False, can_dashboard=True, is_admin=False
                ),
                models.User(
                    id="usr-eric-001",
                    full_name="Eric Musonera",
                    username="eric.musonera",
                    email="eric.musonera@nolte-geoservices.de",
                    password_hash=seed_hash(),
                    role="collector",
                    # Someone has to be able to approve the first request.
                    can_field=True, can_dashboard=True, is_admin=True
                )
            ]
            db.add_all(default_users)
            db.commit()
    except Exception as e:
        print("Error seeding default users:", e)

@app.on_event("startup")
def startup_event():
    from database import SessionLocal
    db = SessionLocal()
    try:
        seed_default_users(db)
    finally:
        db.close()

# Authentication API Endpoints
@app.post("/api/auth/register")
def register_user(payload: UserRegister, db: Session = Depends(get_db)):
    existing = db.query(models.User).filter(models.User.username == payload.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")
    
    new_user = models.User(
        id=str(uuid.uuid4()),
        full_name=payload.full_name,
        username=payload.username,
        email=payload.email,
        password_hash=hash_password(payload.password),
        role="collector" # Role assigned on database level
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    # New accounts start with the field app only; the dashboard is requested.
    return user_payload(new_user, issue_token(new_user))

@app.post("/api/auth/login")
def login_user(payload: UserLogin, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.username == payload.username).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    # Upgrade legacy plaintext rows on the first successful login, so accounts
    # migrate as people sign in rather than needing a bulk rewrite.
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(payload.password)
        db.commit()

    return user_payload(user, issue_token(user))


MIN_PASSWORD_LENGTH = 8


@app.post("/api/auth/change-password")
def change_own_password(
    payload: PasswordChange,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Set your own password. Deliberately not behind require_surface: someone
    holding a temporary password has no surfaces yet, and this is their way out."""
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="Aktuelles Passwort ist falsch.")
    if len(payload.new_password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Das neue Passwort braucht mindestens {MIN_PASSWORD_LENGTH} Zeichen.",
        )
    if payload.new_password == payload.current_password:
        raise HTTPException(status_code=400, detail="Bitte ein anderes Passwort wählen.")

    user.password_hash = hash_password(payload.new_password)
    user.must_change_password = False
    db.commit()
    db.refresh(user)
    # A fresh token, so the change is a clean break from the temporary one.
    return user_payload(user, issue_token(user))


@app.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_password(
    user_id: str,
    admin: models.User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """Issue a temporary password and return it once.

    The admin reads it off the screen and passes it on; it is never stored in the
    clear and cannot be retrieved again. The user is forced to replace it before
    anything else opens.
    """
    target = db.query(models.User).filter(models.User.id == user_id).first()
    if target is None:
        raise HTTPException(status_code=404, detail="Benutzer nicht gefunden.")

    temporary = secrets.token_urlsafe(9)
    target.password_hash = hash_password(temporary)
    target.must_change_password = True
    db.commit()
    return {
        "status": "success",
        "username": target.username,
        # Shown once. There is no endpoint that can return it again.
        "temporary_password": temporary,
    }


@app.get("/api/auth/me")
def read_me(user: models.User = Depends(current_user)):
    """Re-read the caller's own access, so a client that has been offline picks
    up permissions granted while it was away."""
    return user_payload(user)


# Permission requests
@app.post("/api/permissions/request")
def request_permission(
    payload: PermissionRequestCreate,
    user: models.User = Depends(current_user),
    db: Session = Depends(get_db),
):
    if payload.surface not in SURFACE_FLAG:
        raise HTTPException(status_code=400, detail="Unbekannter Bereich.")
    if getattr(user, SURFACE_FLAG[payload.surface], False):
        return {"status": "already_granted", "surface": payload.surface}

    # One open request per surface, so repeated clicks do not spam the admin.
    pending = (
        db.query(models.PermissionRequest)
        .filter(
            models.PermissionRequest.user_id == user.id,
            models.PermissionRequest.surface == payload.surface,
            models.PermissionRequest.status == "pending",
        )
        .first()
    )
    if pending:
        return {"status": "pending", "surface": payload.surface, "request_id": pending.id}

    entry = models.PermissionRequest(
        id=str(uuid.uuid4()),
        user_id=user.id,
        surface=payload.surface,
        message=(payload.message or "")[:500] or None,
    )
    db.add(entry)
    db.commit()
    return {"status": "pending", "surface": payload.surface, "request_id": entry.id}


@app.get("/api/permissions/requests")
def list_permission_requests(
    status: str = Query("pending"),
    admin: models.User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    query = db.query(models.PermissionRequest, models.User).join(
        models.User, models.PermissionRequest.user_id == models.User.id
    )
    if status != "all":
        query = query.filter(models.PermissionRequest.status == status)
    rows = query.order_by(models.PermissionRequest.created_at.desc()).limit(200).all()
    return [
        {
            "id": req.id,
            "surface": req.surface,
            "status": req.status,
            "message": req.message,
            "created_at": req.created_at.isoformat() if req.created_at else None,
            "user": {"id": u.id, "username": u.username, "full_name": u.full_name},
        }
        for req, u in rows
    ]


@app.post("/api/permissions/requests/{request_id}/decide")
def decide_permission_request(
    request_id: str,
    payload: PermissionDecision,
    admin: models.User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    entry = (
        db.query(models.PermissionRequest)
        .filter(models.PermissionRequest.id == request_id)
        .first()
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Anfrage nicht gefunden.")
    if entry.status != "pending":
        raise HTTPException(status_code=409, detail="Anfrage wurde bereits entschieden.")

    entry.status = "approved" if payload.approve else "denied"
    entry.decided_at = datetime.datetime.utcnow()
    entry.decided_by = admin.id
    if payload.approve:
        target = db.query(models.User).filter(models.User.id == entry.user_id).first()
        if target is None:
            raise HTTPException(status_code=404, detail="Benutzer nicht gefunden.")
        setattr(target, SURFACE_FLAG[entry.surface], True)
    db.commit()
    return {"status": entry.status, "request_id": entry.id}


# User administration
@app.get("/api/admin/users")
def list_users(admin: models.User = Depends(require_admin), db: Session = Depends(get_db)):
    users = db.query(models.User).order_by(models.User.username).all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "full_name": u.full_name,
            "email": u.email,
            "role": u.role,
            "can_field": bool(u.can_field),
            "can_dashboard": bool(u.can_dashboard),
            "is_admin": bool(u.is_admin),
            "must_change_password": bool(u.must_change_password),
        }
        for u in users
    ]


@app.patch("/api/admin/users/{user_id}/access")
def update_user_access(
    user_id: str,
    payload: UserAccessUpdate,
    admin: models.User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    target = db.query(models.User).filter(models.User.id == user_id).first()
    if target is None:
        raise HTTPException(status_code=404, detail="Benutzer nicht gefunden.")

    if payload.can_field is not None:
        target.can_field = payload.can_field
    if payload.can_dashboard is not None:
        target.can_dashboard = payload.can_dashboard
    if payload.is_admin is not None:
        # Refuse to remove the last admin, otherwise nobody can grant anything.
        if target.is_admin and not payload.is_admin:
            remaining = (
                db.query(models.User)
                .filter(models.User.is_admin.is_(True), models.User.id != target.id)
                .count()
            )
            if remaining == 0:
                raise HTTPException(
                    status_code=409, detail="Der letzte Administrator kann nicht entfernt werden."
                )
        target.is_admin = payload.is_admin

    db.commit()
    db.refresh(target)
    return user_payload(target)


# API Endpoints
@app.get("/api/points")
def get_points(
    db: Session = Depends(get_db),
    user: models.User = Depends(current_user),   # both surfaces read the points
):
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
            "feedback": feedback_data
        })
    return result

@app.post("/api/points/import")
def import_points(
    points_list: List[PointCreate],
    db: Session = Depends(get_db),
    admin: models.User = Depends(require_admin),
):
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
            id=str(uuid.uuid5(uuid.NAMESPACE_DNS, target_id_val)),
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


@app.post("/api/sync")
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


@app.get("/api/projects")
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


def _report_rows(db, project_id, start, end):
    start_dt = report.parse_date(start)
    end_dt = report.parse_date(end, end_of_day=True)
    if start and start_dt is None:
        raise HTTPException(status_code=400, detail=f"Invalid start date: {start}")
    if end and end_dt is None:
        raise HTTPException(status_code=400, detail=f"Invalid end date: {end}")
    return report.fetch_rows(db, project_id, start_dt, end_dt), start_dt, end_dt


def _stamp(project_id, start, end):
    return "-".join(filter(None, [project_id or "alle", start or None, end or None]))


@app.get("/api/reports/feedback.pdf")
def report_feedback_pdf(
    request: Request,
    project_id: Optional[str] = Query(None),
    start: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive"),
    db: Session = Depends(get_db),
    user: models.User = Depends(require_surface("dashboard")),
):
    rows, start_dt, end_dt = _report_rows(db, project_id, start, end)
    # The Bild links point back at whichever origin the report was requested from,
    # so a PDF pulled over the LAN keeps working on that machine.
    gallery_base = str(request.base_url).rstrip("/")
    pdf = report.build_pdf(db, rows, project_id, start_dt, end_dt, gallery_base=gallery_base)
    filename = f"oeffnungsmassnahmen-{_stamp(project_id, start, end)}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/reports/feedback.csv")
def report_feedback_csv(
    project_id: Optional[str] = Query(None),
    start: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive"),
    db: Session = Depends(get_db),
    # Both apps offer the CSV export; the PDF report stays dashboard-only.
    user: models.User = Depends(require_any_surface("field", "dashboard")),
):
    rows, _, _ = _report_rows(db, project_id, start, end)
    filename = f"feedback-{_stamp(project_id, start, end)}.csv"
    return Response(
        # BOM so Excel opens the German umlauts correctly
        content=("﻿" + report.rows_to_csv(rows)).encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/reports/bilder/{feedback_id}", response_class=HTMLResponse)
def report_photo_gallery(feedback_id: str, db: Session = Depends(get_db)):
    """Target of the Bild links in the PDF: one standalone page per VM point with
    every photo of that point and a download link each."""
    row = (
        db.query(models.Feedback, models.Anomaly)
        .join(models.Anomaly, models.Feedback.anomaly_id == models.Anomaly.id)
        .filter(models.Feedback.id == feedback_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Kein Datensatz zu dieser Bild-ID.")
    fb, an = row
    return HTMLResponse(
        content=report.photo_gallery_html(fb, an),
        # Base64 photos are immutable once written, but never let a proxy hold them.
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/stats")
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

@app.post("/api/seed")
def seed_mock_data(
    db: Session = Depends(get_db),
    admin: models.User = Depends(require_admin),
):
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
            id=str(uuid.uuid5(uuid.NAMESPACE_DNS, target_id_val)),
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
    uuid_1 = str(uuid.uuid5(uuid.NAMESPACE_DNS, "11-24-2736-442972.981-5937097.795"))
    uuid_4 = str(uuid.uuid5(uuid.NAMESPACE_DNS, "11-24-2736-442974.440-5937090.100"))
    uuid_8 = str(uuid.uuid5(uuid.NAMESPACE_DNS, "11-24-2736-442982.135-5937060.746"))
    uuid_28 = str(uuid.uuid5(uuid.NAMESPACE_DNS, "11-24-2736-443470.349-5935866.705"))

    # Target 1 (VM 2736-1) - Investigated: Clear
    anomaly_1 = db.query(models.Anomaly).filter(models.Anomaly.id == uuid_1).first()
    if anomaly_1:
        anomaly_1.status = "investigated"
    db.add(models.Feedback(
        id="fb-uuid-161",
        anomaly_id=uuid_1,
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
    anomaly_4 = db.query(models.Anomaly).filter(models.Anomaly.id == uuid_4).first()
    if anomaly_4:
        anomaly_4.status = "investigated"
    db.add(models.Feedback(
        id="fb-uuid-1519",
        anomaly_id=uuid_4,
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
    anomaly_8 = db.query(models.Anomaly).filter(models.Anomaly.id == uuid_8).first()
    if anomaly_8:
        anomaly_8.status = "investigated"
    db.add(models.Feedback(
        id="fb-uuid-473",
        anomaly_id=uuid_8,
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
    anomaly_28 = db.query(models.Anomaly).filter(models.Anomaly.id == uuid_28).first()
    if anomaly_28:
        anomaly_28.status = "investigated"
    db.add(models.Feedback(
        id="fb-uuid-1178",
        anomaly_id=uuid_28,
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
