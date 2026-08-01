"""Feedback reporting: filtered CSV and a PDF laid out after reportTemplate.pdf.

reportTemplate.pdf is an Excel export with no AcroForm fields, so it cannot be
filled in; this module reproduces its layout instead - landscape A4, Nolte logo
and crew header, the Öffnungsmaßnahmen table, and the sign-off footer.
"""
import csv
import datetime
import io
import os

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Table, TableStyle

from sqlalchemy.orm import Session

import models

COMPANY_LINE = "Nolte Services GmbH, Hanns Martin Schleyer Straße 14, 48301 Nottuln"
# Deliberately not under static/: vite builds with emptyOutDir, so anything the
# frontend does not produce is wiped from that directory on every build.
LOGO_PATH = os.path.join(os.path.dirname(__file__), "assets", "report-logo.png")

COLUMNS = [
    ("VM-Nr.", 22),
    ("x", 30),
    ("y", 32),
    ("errechnete Tiefe", 24),
    ("Länge", 20),
    ("Breite", 20),
    ("Tiefe", 20),
    ("m³", 18),
    ("Fundstück / Sohle", 62),
    ("lfd. Nr.", 16),
    ("Bemerkung", 50),
]

CSV_HEADER = [
    "vm_nr", "target_id", "project_id", "easting", "northing", "evaluated_depth",
    "laenge", "breite", "tiefe", "m_cube", "fundstueck", "sohle_status", "bemerkung",
    "investigator", "visit_date", "bilder_n",
    "truppfuehrer", "maschinenfuehrer", "bez_suchfeld", "messgeraet", "sondierer",
]


def _de(value, unit="m", decimals=2):
    """German number formatting: 1.2 -> '1,20 m'. Empty values render as the
    template's own placeholder."""
    if value is None:
        return "---"
    text = f"{float(value):.{decimals}f}".replace(".", ",")
    return f"{text} {unit}".strip() if unit else text


def fetch_rows(db: Session, project_id=None, start=None, end=None):
    """Feedback joined to its anomaly, filtered by project and visit_date range."""
    q = (
        db.query(models.Feedback, models.Anomaly)
        .join(models.Anomaly, models.Feedback.anomaly_id == models.Anomaly.id)
    )
    if project_id:
        q = q.filter(models.Anomaly.project_id == project_id)
    if start:
        q = q.filter(models.Feedback.visit_date >= start)
    if end:
        q = q.filter(models.Feedback.visit_date <= end)
    return q.order_by(models.Feedback.visit_date.asc()).all()


def rows_to_csv(rows) -> str:
    buf = io.StringIO()
    # Excel on a German locale needs the separator hint to split on ';'
    buf.write("sep=;\r\n")
    writer = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    writer.writerow(CSV_HEADER)
    for fb, an in rows:
        tt = fb.teams_tools or {}
        writer.writerow([
            an.vm_nr, an.target_id, an.project_id, an.easting, an.northing,
            an.evaluated_depth, fb.laenge, fb.breite, fb.tief, fb.m_cube,
            fb.fundstueck, fb.sohle_status, fb.notes, fb.investigator,
            fb.visit_date.isoformat() if fb.visit_date else None, fb.bilder_n,
            tt.get("truppfuehrer"), tt.get("maschinenfuehrer"), tt.get("bez_suchfeld"),
            tt.get("messgeraet"), tt.get("sondierer"),
        ])
    return buf.getvalue()


def _header_values(rows, project_id):
    """The template header carries the crew and kit; take them from the most
    recent teams_tools in the filtered set."""
    for fb, _ in reversed(rows):
        if fb.teams_tools:
            tt = fb.teams_tools
            return {
                "project": project_id or "Alle Projekte",
                "truppfuehrer": tt.get("truppfuehrer") or "---",
                "maschinenfuehrer": tt.get("maschinenfuehrer") or "---",
                "bez_suchfeld": tt.get("bez_suchfeld") or "---",
                "messgeraet": tt.get("messgeraet") or "---",
                "sondierer": tt.get("sondierer") or "---",
            }
    return {
        "project": project_id or "Alle Projekte",
        "truppfuehrer": "---", "maschinenfuehrer": "---",
        "bez_suchfeld": "---", "messgeraet": "---", "sondierer": "---",
    }


def build_pdf(rows, project_id=None, start=None, end=None) -> bytes:
    page_w, page_h = landscape(A4)
    meta = _header_values(rows, project_id)

    period = "gesamter Zeitraum"
    if start or end:
        period = f"{start.strftime('%d.%m.%Y') if start else '...'} – {end.strftime('%d.%m.%Y') if end else '...'}"

    def draw_frame(canvas, doc):
        canvas.saveState()
        if os.path.exists(LOGO_PATH):
            canvas.drawImage(LOGO_PATH, 12 * mm, page_h - 24 * mm, width=38 * mm,
                             height=10 * mm, preserveAspectRatio=True, mask="auto")
        canvas.setFont("Helvetica-Bold", 12)
        canvas.drawString(56 * mm, page_h - 17 * mm, "Öffnungsmaßnahmen – Kampfmittelverdachtspunkte")
        canvas.setFont("Helvetica", 7.5)
        canvas.drawString(56 * mm, page_h - 21.5 * mm,
                          f"Projekt: {meta['project']}    Zeitraum: {period}    "
                          f"Truppführer: {meta['truppfuehrer']}    Maschinenführer: {meta['maschinenfuehrer']}")
        canvas.drawString(56 * mm, page_h - 25 * mm,
                          f"Bez.Suchfeld: {meta['bez_suchfeld']}    Messgerät: {meta['messgeraet']}    "
                          f"Sondierer: {meta['sondierer']}")

        canvas.setFont("Helvetica", 6.5)
        canvas.setFillColor(colors.HexColor("#555555"))
        canvas.drawString(12 * mm, 12 * mm, COMPANY_LINE)
        canvas.drawRightString(page_w - 12 * mm, 12 * mm, f"Seite {doc.page}")
        canvas.setFillColor(colors.black)
        # Sign-off block, left blank for wet signatures exactly as in the template
        for label, x in (("Erstellt von", 12), ("Geprüft von", 90), ("Freigabe von", 168), ("Datum", 246)):
            canvas.line(x * mm, 20 * mm, (x + 60) * mm, 20 * mm)
            canvas.setFont("Helvetica", 6.5)
            canvas.drawString(x * mm, 16.5 * mm, label)
        canvas.restoreState()

    buf = io.BytesIO()
    doc = BaseDocTemplate(buf, pagesize=landscape(A4),
                          leftMargin=12 * mm, rightMargin=12 * mm,
                          topMargin=30 * mm, bottomMargin=26 * mm,
                          title=f"Öffnungsmaßnahmen {meta['project']}", author="Nolte Services GmbH")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body")
    doc.addPageTemplates([PageTemplate(id="report", frames=[frame], onPage=draw_frame)])

    cell = ParagraphStyle("cell", fontName="Helvetica", fontSize=6.5, leading=7.8)
    head = ParagraphStyle("head", fontName="Helvetica-Bold", fontSize=6.5, leading=7.8,
                          textColor=colors.white)

    data = [[Paragraph(name, head) for name, _ in COLUMNS]]
    for idx, (fb, an) in enumerate(rows, start=1):
        fund = fb.fundstueck or "---"
        if fb.fundstueck == "Sonstige" and fb.other:
            fund = fb.other
        sohle = "Sohle frei" if (fb.sohle_status or "") == "Frei" else "Sohle nicht frei"
        data.append([
            Paragraph(str(an.vm_nr or "---"), cell),
            Paragraph(_de(an.easting, unit="", decimals=3), cell),
            Paragraph(_de(an.northing, unit="", decimals=3), cell),
            Paragraph(_de(an.evaluated_depth), cell),
            Paragraph(_de(fb.laenge), cell),
            Paragraph(_de(fb.breite), cell),
            Paragraph(_de(fb.tief), cell),
            Paragraph(_de(fb.m_cube, unit=""), cell),
            Paragraph(f"{fund} / {sohle}", cell),
            Paragraph(str(idx), cell),
            Paragraph(fb.notes or "---", cell),
        ])

    if len(data) == 1:
        data.append([Paragraph("Keine Datensätze für die gewählten Filter.", cell)] +
                    [Paragraph("", cell)] * (len(COLUMNS) - 1))

    table = Table(data, colWidths=[w * mm for _, w in COLUMNS], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f3d34")),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#9aa5a1")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (1, 1), (7, -1), "RIGHT"),
        ("ALIGN", (9, 1), (9, -1), "CENTER"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f2f5f4")]),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 1.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5),
    ]))

    doc.build([table])
    return buf.getvalue()


def parse_date(value, end_of_day=False):
    """Accepts YYYY-MM-DD or a full ISO timestamp; returns naive UTC like visit_date."""
    if not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        dt = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    if end_of_day and len(value) == 10:
        dt = dt.replace(hour=23, minute=59, second=59, microsecond=999999)
    return dt
