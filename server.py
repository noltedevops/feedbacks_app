from fastapi import FastAPI, Depends, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.orm import Session
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from typing import List, Optional
from contextlib import asynccontextmanager
from pydantic import BaseModel
import asyncio
import datetime
import hashlib
import hmac
import os
import json
import secrets
import subprocess
import uuid

from database import init_db, get_db
import models
import report
import assistant
from config import settings

init_db()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown, replacing the deprecated @app.on_event hooks.

    Everything before the yield runs once before the first request; anything
    after it would run on shutdown, of which this app has none.

    seed_default_users is defined further down the module: the name is looked up
    when this runs, not when it is declared, so the ordering is fine.
    """
    from database import SessionLocal
    db = SessionLocal()
    try:
        seed_default_users(db)
    finally:
        db.close()
    yield


app = FastAPI(
    title="Nolte Geoservices UXO Target Sync Platform",
    lifespan=lifespan,
)

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

class PointUpdate(BaseModel):
    id: str
    easting: float
    northing: float
    latitude: float
    longitude: float

class SyncPayload(BaseModel):
    feedback: List[FeedbackCreate]
    point_updates: Optional[List[PointUpdate]] = None

MIN_PASSWORD_LENGTH = 8


def password_acceptable(password: str) -> bool:
    """The one password rule, for register and change-password alike: at least
    MIN_PASSWORD_LENGTH characters, and not whitespace alone - eight spaces pass a
    bare length check."""
    return len(password) >= MIN_PASSWORD_LENGTH and bool(password.strip())


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

# Authentication API Endpoints
@app.post("/api/auth/register")
def register_user(payload: UserRegister, db: Session = Depends(get_db)):
    # Checked here, not only in the form: the dialog's `required` is the browser's
    # courtesy, and anything can POST to this endpoint. An empty password used to be
    # stored as-is, and the client substituted the literal "password" for it.
    full_name = payload.full_name.strip()
    username = payload.username.strip()
    if not full_name or not username:
        raise HTTPException(status_code=400, detail="Full name and username are required.")
    if not password_acceptable(payload.password):
        raise HTTPException(
            status_code=400,
            detail=f"The password needs at least {MIN_PASSWORD_LENGTH} characters.",
        )

    existing = db.query(models.User).filter(models.User.username == username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already exists")

    new_user = models.User(
        id=str(uuid.uuid4()),
        full_name=full_name,
        username=username,
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
    if not password_acceptable(payload.new_password):
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


@app.get("/api/etl/health")
def get_etl_pipeline_health():
    """Operational health & staleness monitoring endpoint for the ETL pipeline."""
    import time
    t_start = time.perf_counter()
    try:
        with get_etl_approver_conn() as conn:
            # Measure DB ping latency
            conn.execute("SELECT 1")
            latency_ms = round((time.perf_counter() - t_start) * 1000, 2)

            # Last run details
            last_run = conn.execute(
                "SELECT run_id, status, started_at, finished_at FROM etl.runs ORDER BY run_id DESC LIMIT 1"
            ).fetchone()

            # Last successful run
            last_success = conn.execute(
                "SELECT run_id, finished_at FROM etl.runs WHERE status = 'ok' ORDER BY run_id DESC LIMIT 1"
            ).fetchone()

            # Pending counts
            staged_cnt = conn.execute("SELECT count(*) FROM etl.change_log WHERE status = 'staged'").fetchone()[0]
            corr_cnt = conn.execute("SELECT count(*) FROM etl.correction_candidates WHERE status IN ('pending', 'conflict')").fetchone()[0]
            targets_cnt = conn.execute("SELECT count(*) FROM public.anomalies").fetchone()[0]
            history_cnt = conn.execute("SELECT count(*) FROM public.anomaly_history").fetchone()[0]

            now = datetime.datetime.now(datetime.timezone.utc)
            max_staleness_hours = float(os.environ.get("ETL_MAX_STALENESS_HOURS", "24"))

            seconds_since_last_success = None
            is_stale = False
            if last_success and last_success[1]:
                finished_at = last_success[1]
                if finished_at.tzinfo is None:
                    finished_at = finished_at.replace(tzinfo=datetime.timezone.utc)
                seconds_since_last_success = round((now - finished_at).total_seconds())
                is_stale = seconds_since_last_success > (max_staleness_hours * 3600)

            # Health classification
            last_status = last_run[1] if last_run else "none"
            if last_status == "failed":
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
                    "seconds_since_last_success": seconds_since_last_success,
                    "last_success_at": last_success[1].isoformat() if last_success and last_success[1] else None
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
    except Exception as exc:
        return {
            "status": "unhealthy",
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "error": str(exc)
        }


@app.get("/api/etl/status")
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

            cfg_path = os.path.join(os.path.dirname(__file__), "etl", "config", "projects.yml")
            if os.path.exists(cfg_path):
                try:
                    import yaml
                    with open(cfg_path, "r", encoding="utf-8") as f:
                        cfg = yaml.safe_load(f) or {}
                    for p in cfg.get("projects", []):
                        if p.get("project_id"):
                            proj_dict[p["project_id"]] = p.get("project_name", p["project_id"])
                except Exception:
                    pass

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
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch ETL status: {exc}")


@app.post("/api/etl/approvals/change")
def decide_etl_change(req: ChangeDecisionRequest, admin: models.User = Depends(require_admin)):
    if req.decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="Decision must be 'approve' or 'reject'")
    if not req.change_ids:
        raise HTTPException(status_code=400, detail="change_ids list cannot be empty")
    results = []
    try:
        with get_etl_approver_conn() as conn:
            for cid in req.change_ids:
                row = conn.execute("select etl_admin.decide_change(%s, %s)", (cid, req.decision)).fetchone()
                conn.commit()
                results.append({"change_id": cid, "decision_id": row[0]})
        return {"success": True, "decisions": results}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Approval execution failed: {exc}")


@app.post("/api/etl/approvals/correction")
def decide_etl_correction(req: CorrectionDecisionRequest, admin: models.User = Depends(require_admin)):
    if req.decision not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="Decision must be 'approve' or 'reject'")
    try:
        with get_etl_approver_conn() as conn:
            row = conn.execute("select etl_admin.decide_correction(%s, %s)", (req.pair_id, req.decision)).fetchone()
            conn.commit()
            return {"success": True, "pair_id": req.pair_id, "decision_id": row[0]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Correction decision failed: {exc}")


class EtlRunRequest(BaseModel):
    project_id: Optional[str] = None
    force: bool = True


@app.post("/api/etl/run")
async def trigger_etl_run(req: EtlRunRequest, admin: models.User = Depends(require_admin)):
    """Trigger an immediate ETL run (optionally scoped to a project_id) via Docker compose."""
    cmd = ["docker", "compose", "--profile", "etl", "run", "--rm", "etl", "run"]
    if req.force:
        cmd.append("--force")
    if req.project_id:
        cmd.extend(["--project", req.project_id])

    try:
        res = await asyncio.to_thread(
            subprocess.run, cmd, capture_output=True, text=True, timeout=180
        )
        return {
            "success": res.returncode == 0,
            "returncode": res.returncode,
            "stdout": res.stdout,
            "stderr": res.stderr,
            "project_id": req.project_id,
            "force": req.force
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="ETL run timed out after 180 seconds")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to execute ETL run: {exc}")


@app.get("/api/etl/history")
def get_anomaly_history(
    target_id: Optional[str] = None,
    vm_nr: Optional[str] = None,
    project_id: Optional[str] = None,
    limit: int = 50,
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
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to fetch anomaly history: {exc}")


# The landing page's assistant. Registered before the static mount below, which
# answers every path that reaches it.
app.include_router(assistant.router)

if os.path.exists("./static"):
    app.mount("/", StaticFiles(directory="./static", html=True), name="static")
else:
    @app.get("/")
    def read_root():
        return {"message": "Nolte Geoservices platform server running."}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
