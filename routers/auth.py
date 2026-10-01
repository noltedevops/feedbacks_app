"""Register, log in, change your own password, read your own access."""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from database import get_db
from security import (MIN_PASSWORD_LENGTH, current_user, hash_password, issue_token, needs_rehash,
                      password_acceptable, user_payload, verify_password)

router = APIRouter()


class UserRegister(BaseModel):
    full_name: str
    username: str
    email: Optional[str] = None
    password: str

class UserLogin(BaseModel):
    username: str
    password: str


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


# Authentication API Endpoints
@router.post("/api/auth/register")
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

@router.post("/api/auth/login")
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


@router.post("/api/auth/change-password")
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


@router.get("/api/auth/me")
def read_me(user: models.User = Depends(current_user)):
    """Re-read the caller's own access, so a client that has been offline picks
    up permissions granted while it was away."""
    return user_payload(user)
