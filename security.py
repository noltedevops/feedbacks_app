"""Who the caller is and what they may open: passwords, session tokens, and the
FastAPI dependencies that gate every endpoint by login, surface or admin."""
import datetime
import hashlib
import hmac
import secrets
from typing import Optional

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

import models
from config import settings
from database import get_db


MIN_PASSWORD_LENGTH = 8


def password_acceptable(password: str) -> bool:
    """The one password rule, for register and change-password alike: at least
    MIN_PASSWORD_LENGTH characters, and not whitespace alone - eight spaces pass a
    bare length check."""
    return len(password) >= MIN_PASSWORD_LENGTH and bool(password.strip())


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
