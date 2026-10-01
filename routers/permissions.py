"""Requests for a surface a user lacks, and the admin's decision on them."""
import datetime
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
from database import get_db
from security import SURFACE_FLAG, current_user, require_admin

router = APIRouter()


class PermissionRequestCreate(BaseModel):
    surface: str                      # 'field' or 'dashboard'
    message: Optional[str] = None

class PermissionDecision(BaseModel):
    approve: bool


# Permission requests
@router.post("/api/permissions/request")
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


@router.get("/api/permissions/requests")
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


@router.post("/api/permissions/requests/{request_id}/decide")
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
