"""User administration: list users, grant or remove access, issue temporary passwords."""
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from database import get_db
from security import hash_password, require_admin, user_payload

router = APIRouter()


class UserAccessUpdate(BaseModel):
    can_field: Optional[bool] = None
    can_dashboard: Optional[bool] = None
    is_admin: Optional[bool] = None


@router.post("/api/admin/users/{user_id}/reset-password")
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


# User administration
@router.get("/api/admin/users")
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


@router.patch("/api/admin/users/{user_id}/access")
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
