"""Exports: the PDF report, the CSV, and the photo gallery page the PDF links to."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, Response
from sqlalchemy.orm import Session

import models
import report
from database import get_db
from security import require_any_surface, require_surface

router = APIRouter()


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


@router.get("/api/reports/feedback.pdf")
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


@router.get("/api/reports/feedback.csv")
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


@router.get("/api/reports/bilder/{feedback_id}", response_class=HTMLResponse)
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
