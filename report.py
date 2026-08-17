"""Feedback reporting: filtered CSV and a PDF laid out after reportTemplate.pdf.

reportTemplate.pdf is an Excel export with no AcroForm fields, so it cannot be
filled in; this module reproduces its layout instead. Every coordinate below is
taken straight off the template with pdf text/vector extraction, so the numbers
are points on a landscape A4 page and not round figures.

The crew header is *not* driven by the report's date filter: the template shows
who ran the project, so it reads feedback.teams_tools and feedback.visit_date
for the whole selected project while the table below stays filtered.
"""
import csv
import datetime
import io
import json
import logging
import os
import re
from urllib.parse import quote
from xml.sax.saxutils import escape, quoteattr

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

from sqlalchemy import func
from sqlalchemy.orm import Session

import models

logger = logging.getLogger("report")

COMPANY_LINE = "Nolte Services GmbH, Hanns Martin Schleyer Straße 14, 48301 Nottuln"
# Deliberately not under static/: vite builds with emptyOutDir, so anything the
# frontend does not produce is wiped from that directory on every build.
ASSETS = os.path.join(os.path.dirname(__file__), "assets")
LOGO_PATH = os.path.join(ASSETS, "report-logo.png")
MISSING = "---"

# --- colours lifted from the template -------------------------------------
NAVY = colors.HexColor("#002060")    # every value the field crew supplied
GREEN = colors.HexColor("#00B050")   # Sohle frei
RED = colors.HexColor("#FF0000")     # Sohle nicht frei, and every Bemerkung
LINE = colors.black

# --- page geometry, in points, measured off reportTemplate.pdf ------------
PAGE_W, PAGE_H = landscape(A4)
LEFT = 27.7
RIGHT = 764.5                       # Excel's print area is not centred
TOP = 66.9                          # top border of the crew header box
BODY_BOTTOM = 529.4                 # bottom border of the table on a full page
CONTENT_W = RIGHT - LEFT            # 736.8

# crew header box: 5 columns, 4 rows of 12.35pt
HEAD_COLS = [104.3, 58.1, 155.4, 104.3, 130.6]
HEAD_ROW = 12.35
HEAD_TO_TITLE = 12.3                # blank gap between header box and title row

# data table: VM | x | y | errechn. | Länge | Breite | Tiefe | m³ | Fundstück | Bild | Bemerkung
BODY_COLS = [52.1, 52.2, 58.1, 50.9, 52.2, 52.3, 52.1, 52.2, 130.6, 27.3, 156.8]
COL_FUND = 8
COL_BEMERKUNG = 10

# footer: company line, sign-off labels, blank signature strip
FOOT_COLS = [213.3, 208.9, 210.1, 104.5]
FOOT_ROWS = [12.4, 11.7, 24.2]

LOGO_X, LOGO_TOP, LOGO_W, LOGO_H = 599.4, 73.5, 156.7, 37.2

BASE_SIZE = 8.9
BASE_LEADING = 10.5
MIN_SIZE = 7.0                      # floor when a column has to shrink to fit

# Photo galleries are served by this app, so the Bild link is an ordinary http(s)
# annotation - every PDF viewer blocks data: and file: link targets.
GALLERY_PATH = "/api/reports/bilder"
# The only visual deviation from the template: linked Bild numbers are underlined
# so it is discoverable which rows carry a photo. Set False for a pixel-exact match.
UNDERLINE_BILD_LINKS = True

DATA_URI_RE = re.compile(r"^data:image/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$")

CSV_HEADER = [
    "vm_nr", "target_id", "project_id", "easting", "northing", "evaluated_depth",
    "laenge", "breite", "tiefe", "m_cube", "fundstueck", "sohle_status", "bemerkung",
    "investigator", "visit_date", "bilder_n",
    "truppfuehrer", "maschinenfuehrer", "bez_suchfeld", "messgeraet", "sondierer",
]


def _register_fonts():
    """The template is set in Calibri. Fall back through the usual metric-compatible
    substitutes so the report still builds on a Linux host."""
    candidates = [
        ("Calibri", "calibri.ttf", "calibrib.ttf"),
        ("Carlito", "Carlito-Regular.ttf", "Carlito-Bold.ttf"),
        ("DejaVuSans", "DejaVuSans.ttf", "DejaVuSans-Bold.ttf"),
    ]
    dirs = [
        ASSETS,
        os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"),
        "/usr/share/fonts/truetype/crosextra",
        "/usr/share/fonts/truetype/dejavu",
        "/usr/share/fonts/truetype/msttcorefonts",
    ]
    for name, regular, bold in candidates:
        for d in dirs:
            reg, bld = os.path.join(d, regular), os.path.join(d, bold)
            if os.path.exists(reg) and os.path.exists(bld):
                try:
                    pdfmetrics.registerFont(TTFont(name, reg))
                    pdfmetrics.registerFont(TTFont(name + "-Bold", bld))
                    return name, name + "-Bold"
                except Exception as exc:
                    logger.warning("Could not register %s from %s: %s", name, d, exc)
    logger.warning("Calibri and its substitutes are unavailable; falling back to Helvetica.")
    return "Helvetica", "Helvetica-Bold"


FONT, FONT_BOLD = _register_fonts()


def _de(value, unit="m", decimals=2):
    """German number formatting: 1.2 -> '1,20 m'. Empty values render as the
    template's own placeholder."""
    if value is None:
        return MISSING
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


def _team_tools(raw):
    """teams_tools is JSON on postgres but arrives as a string from sqlite, and a
    double-encoded string from some of the older field-app writes."""
    for _ in range(2):
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except (ValueError, TypeError):
                return {}
        else:
            break
    return raw if isinstance(raw, dict) else {}


def parse_photos(raw):
    """feedback.photos is a stringified JSON array of base64 data URIs. Older field-app
    writes double-encoded it, and a few rows hold a bare data URI. A bad cell must never
    stop the report, so anything unparseable degrades to 'this point has no photo'."""
    if raw is None:
        return []
    value = raw
    if isinstance(value, str):
        value = value.strip()
        if not value or value == "[]":
            return []
        if DATA_URI_RE.match(value):        # a single, unwrapped data URI
            return [value]
    for _ in range(2):                      # once for JSON, twice for double-encoded JSON
        if not isinstance(value, str):
            break
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            logger.warning("feedback.photos is not valid JSON (%s...); treating as no photo.",
                           str(raw)[:40])
            return []
    if not isinstance(value, list):
        logger.warning("feedback.photos did not decode to a list (%s); treating as no photo.",
                       type(value).__name__)
        return []
    photos = []
    for entry in value:
        candidate = entry.strip() if isinstance(entry, str) else ""
        if DATA_URI_RE.match(candidate):
            photos.append(candidate)
        else:
            logger.warning("Skipping a photos entry that is not a base64 image data URI.")
    return photos


def _photo_extension(data_uri):
    mime = data_uri[len("data:"):data_uri.index(";")].lower()
    return {"image/jpeg": "jpg", "image/svg+xml": "svg"}.get(mime, mime.split("/")[-1] or "img")


def gallery_url(base, feedback_id):
    return f"{base.rstrip('/')}{GALLERY_PATH}/{quote(str(feedback_id))}"


def photo_gallery_html(fb, an) -> str:
    """A standalone page - no external assets - showing every photo of one VM point
    with a download link each, opened from the Bild column of the PDF."""
    photos = parse_photos(fb.photos)
    vm_nr = an.vm_nr or an.target_id or "?"
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", f"{an.project_id}_{vm_nr}")
    when = fb.visit_date.strftime("%d.%m.%Y") if fb.visit_date else MISSING
    subtitle = f"{an.project_id} · {when}"
    if fb.investigator:
        subtitle += f" · {fb.investigator}"

    if photos:
        cards = "\n".join(
            f"""    <figure>
      <img src={quoteattr(uri)} alt="Bild {i} zu VM {escape(str(vm_nr))}">
      <figcaption>
        <span>Bild {i} von {len(photos)}</span>
        <a class="dl" download={quoteattr(f"{stem}_{i}.{_photo_extension(uri)}")} href={quoteattr(uri)}>Herunterladen</a>
      </figcaption>
    </figure>"""
            for i, uri in enumerate(photos, start=1)
        )
    else:
        cards = '    <p class="empty">Für diesen Punkt sind keine Bilder hinterlegt.</p>'

    return f"""<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bilder VM {escape(str(vm_nr))} – {escape(str(an.project_id))}</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; padding: 24px; background: #10201b; color: #e7efeb;
         font-family: Segoe UI, Calibri, system-ui, sans-serif; }}
  header {{ max-width: 1100px; margin: 0 auto 20px; }}
  h1 {{ margin: 0 0 4px; font-size: 1.25rem; color: #fff; }}
  .sub {{ margin: 0; font-size: 0.85rem; color: #8fa89e; }}
  main {{ max-width: 1100px; margin: 0 auto; display: grid; gap: 18px;
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }}
  figure {{ margin: 0; background: #172c25; border: 1px solid #2c443b; border-radius: 8px;
            overflow: hidden; }}
  /* Field photos are portrait and large; cap them so the download button stays in view. */
  img {{ display: block; width: 100%; height: auto; max-height: 70vh; object-fit: contain;
         background: #0b1512; }}
  figcaption {{ display: flex; align-items: center; justify-content: space-between; gap: 12px;
                padding: 10px 12px; font-size: 0.8rem; color: #9fb8ae; }}
  .dl {{ background: #f2c230; color: #16241f; text-decoration: none; font-weight: 700;
         padding: 6px 12px; border-radius: 5px; }}
  .dl:hover {{ background: #ffd95c; }}
  .empty {{ color: #8fa89e; }}
</style>
</head>
<body>
<header>
  <h1>Bilder zu VM {escape(str(vm_nr))}</h1>
  <p class="sub">{escape(subtitle)}</p>
</header>
<main>
{cards}
</main>
</body>
</html>
"""


def rows_to_csv(rows) -> str:
    buf = io.StringIO()
    # Excel on a German locale needs the separator hint to split on ';'
    buf.write("sep=;\r\n")
    writer = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    writer.writerow(CSV_HEADER)
    for fb, an in rows:
        tt = _team_tools(fb.teams_tools)
        writer.writerow([
            an.vm_nr, an.target_id, an.project_id, an.easting, an.northing,
            an.evaluated_depth, fb.laenge, fb.breite, fb.tief, fb.m_cube,
            fb.fundstueck, fb.sohle_status, fb.notes, fb.investigator,
            fb.visit_date.isoformat() if fb.visit_date else None, fb.bilder_n,
            tt.get("truppfuehrer"), tt.get("maschinenfuehrer"), tt.get("bez_suchfeld"),
            tt.get("messgeraet"), tt.get("sondierer"),
        ])
    return buf.getvalue()


# --------------------------------------------------------------------------
# header data
# --------------------------------------------------------------------------

def _latest_team_tools(db: Session, project_id):
    """The crew block describes the project, not the filtered window, so search
    every feedback row of the project and take the most recent populated one."""
    q = (
        db.query(models.Feedback.teams_tools)
        .join(models.Anomaly, models.Feedback.anomaly_id == models.Anomaly.id)
        .filter(models.Feedback.teams_tools.isnot(None))
    )
    if project_id:
        q = q.filter(models.Anomaly.project_id == project_id)
    for (raw,) in q.order_by(models.Feedback.visit_date.desc()).all():
        tt = _team_tools(raw)
        if any(v for v in tt.values() if isinstance(v, str) and v.strip()):
            return tt
    return {}


def _visit_range(db: Session, project_id):
    """Datum is MIN(visit_date) - MAX(visit_date) over the whole project."""
    q = (
        db.query(func.min(models.Feedback.visit_date), func.max(models.Feedback.visit_date))
        .join(models.Anomaly, models.Feedback.anomaly_id == models.Anomaly.id)
    )
    if project_id:
        q = q.filter(models.Anomaly.project_id == project_id)
    earliest, latest = q.one()
    if not earliest or not latest:
        return MISSING
    # Always a range, even for a single-day project, so the field reads the same way.
    return f"{earliest.strftime('%d.%m.%Y')} - {latest.strftime('%d.%m.%Y')}"


def _created_by(db: Session, project_id, tt, truppfuehrer):
    """Prefer a real created_by, then anything the field form stored, then the
    team leader - which is what the template itself shows."""
    if hasattr(models.Feedback, "created_by"):
        q = (
            db.query(models.Feedback.created_by)
            .join(models.Anomaly, models.Feedback.anomaly_id == models.Anomaly.id)
            .filter(models.Feedback.created_by.isnot(None))
        )
        if project_id:
            q = q.filter(models.Anomaly.project_id == project_id)
        row = q.order_by(models.Feedback.visit_date.desc()).first()
        if row and str(row[0]).strip():
            logger.info("Erstellt von <- feedback.created_by")
            return str(row[0]).strip()
    for key in ("created_by", "erstellt_von"):
        if str(tt.get(key) or "").strip():
            logger.info("Erstellt von <- teams_tools.%s", key)
            return str(tt[key]).strip()
    logger.info("Erstellt von <- teams_tools.truppfuehrer (no created_by source available)")
    return truppfuehrer


def _header_values(db: Session, project_id):
    tt = _latest_team_tools(db, project_id)

    def pick(key):
        value = str(tt.get(key) or "").strip()
        return value or MISSING

    project_name = ""
    if project_id:
        row = (
            db.query(models.Project.project_name)
            .filter(models.Project.project_id == project_id)
            .first()
        )
        project_name = (row[0] if row else "") or ""

    meta = {
        "project_id": project_id or "Alle Projekte",
        "project_name": project_name,
        "truppfuehrer": pick("truppfuehrer"),
        "maschinenfuehrer": pick("maschinenfuehrer"),
        "bez_suchfeld": pick("bez_suchfeld"),
        "messgeraet": pick("messgeraet"),
        "sondierer": pick("sondierer"),
        "datum": _visit_range(db, project_id),
    }
    meta["erstellt_von"] = _created_by(db, project_id, tt, meta["truppfuehrer"])

    if not tt:
        logger.warning("No populated teams_tools row for project %s; crew fields fall back to '%s'.",
                       project_id, MISSING)
    for field, value in meta.items():
        if value == MISSING:
            logger.warning("Report header field '%s' could not be mapped for project %s.",
                           field, project_id)
    logger.info("Report header for %s: %s", project_id, meta)
    return meta


# --------------------------------------------------------------------------
# pdf
# --------------------------------------------------------------------------

def _style(name, size=BASE_SIZE, bold=False, align=1, colour=colors.black, leading=None):
    return ParagraphStyle(
        name,
        fontName=FONT_BOLD if bold else FONT,
        fontSize=size,
        leading=leading or (size * BASE_LEADING / BASE_SIZE),
        alignment=align,          # 0 left, 1 centre, 2 right
        textColor=colour,
    )


def _hex(colour):
    return "#%02X%02X%02X" % (int(colour.red * 255), int(colour.green * 255), int(colour.blue * 255))


def _run(text, colour=None, bold=False):
    """One inline coloured run for a Paragraph."""
    out = escape(str(text))
    if bold:
        out = f"<b>{out}</b>"
    if colour is not None:
        out = f'<font color="{_hex(colour)}">{out}</font>'
    return out


def _fit_size(texts, width, size=BASE_SIZE, padding=3.4):
    """Shrink a whole column uniformly rather than letting single rows wrap - the
    template keeps every data row on one 11.78pt line."""
    usable = width - padding
    widest = max((pdfmetrics.stringWidth(t, FONT, size) for t in texts if t), default=0)
    if widest <= usable or widest == 0:
        return size
    return max(MIN_SIZE, round(size * usable / widest, 2))


def _header_table(meta, page_count):
    label = _style("hlabel", bold=True)
    cell = _style("hcell")

    def pair(label_text, value):
        return Paragraph(_run(label_text, bold=True) + "&nbsp;&nbsp;&nbsp;&nbsp;" +
                         _run(value, NAVY), cell)

    data = [
        [Paragraph(_run("Öffnungen von Verdachtmomenten", bold=True), cell), "", "",
         Paragraph(_run("Seitenanzahl:", bold=True) + " " + _run(page_count, NAVY), cell), ""],
        [pair("Truppführer:", meta["truppfuehrer"]), "",
         pair("Maschinenführer:", meta["maschinenfuehrer"]),
         Paragraph("Bez. Suchfeld", label), Paragraph(_run(meta["bez_suchfeld"], NAVY), cell)],
        [Paragraph("Datum", label), Paragraph(_run(meta["datum"], NAVY), cell), "",
         Paragraph("Messgerät", label), Paragraph(_run(meta["messgeraet"], NAVY), cell)],
        [Paragraph("Erstellt von", label), Paragraph(_run(meta["erstellt_von"], NAVY), cell), "",
         Paragraph("Sondierer", label), Paragraph(_run(meta["sondierer"], NAVY), cell)],
    ]
    # Narrower than the frame - keep it flush with the table below instead of centred.
    table = Table(data, colWidths=HEAD_COLS, rowHeights=[HEAD_ROW] * 4, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("SPAN", (0, 0), (2, 0)),          # title cell
        ("SPAN", (3, 0), (4, 0)),          # Seitenanzahl
        ("SPAN", (0, 1), (1, 1)),          # Truppführer
        ("SPAN", (1, 2), (2, 2)),          # Datum value
        ("SPAN", (1, 3), (2, 3)),          # Erstellt von value
        ("GRID", (0, 0), (-1, -1), 0.8, LINE),
        ("BOX", (0, 0), (-1, -1), 1.2, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 1.5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 1.5),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return table


def _bild_cell(row, gallery_base):
    """The Bild number links to this point's photo gallery. Rows without photos - and
    every row when no base URL is known - stay exactly the plain text they were."""
    text = escape(row["bild"])
    if not (gallery_base and row["photos"] and row["bild"] != MISSING):
        return text
    if UNDERLINE_BILD_LINKS:
        text = f"<u>{text}</u>"
    href = gallery_url(gallery_base, row["feedback_id"])
    return f"<a href={quoteattr(href)}>{text}</a>"


def _body_table(meta, rows, gallery_base=None):
    head = _style("colhead")
    title_text = " ".join(filter(None, [meta["project_id"], meta["project_name"]]))
    title = Paragraph(_run(title_text, NAVY, bold=True), _style("title", size=21, leading=22))

    data = [
        [title] + [""] * (len(BODY_COLS) - 1),
        [Paragraph("VM Nr.", head), Paragraph("Koordinaten", head), "",
         Paragraph("errechnete<br/>Tiefe", head), Paragraph("Öffnung", head), "", "", "",
         Paragraph("Fundstück", head), Paragraph("Bild", head), Paragraph("Bemerkung", head)],
        ["", Paragraph("x", head), Paragraph("y", head), "",
         Paragraph("Länge", head), Paragraph("Breite", head), Paragraph("Tiefe", head),
         Paragraph("m³", head), "", "", ""],
    ]

    body = []
    for fb, an in rows:
        item = fb.fundstueck or MISSING
        if fb.fundstueck == "Sonstige" and fb.other:
            item = fb.other
        frei = (fb.sohle_status or "").strip().lower() == "frei"
        body.append({
            "vm": str(an.vm_nr or MISSING),
            "x": _de(an.easting, unit="", decimals=3),
            "y": _de(an.northing, unit="", decimals=3),
            "depth": _de(an.evaluated_depth),
            "laenge": _de(fb.laenge),
            "breite": _de(fb.breite),
            "tiefe": _de(fb.tief),
            "m3": _de(fb.m_cube, unit=""),
            "fund": f"{item} / " + ("Sohle frei" if frei else "Sohle nicht frei"),
            "item": item,
            "sohle": "Sohle frei" if frei else "Sohle nicht frei",
            "frei": frei,
            "bild": str(fb.bilder_n) if fb.bilder_n is not None else MISSING,
            "photos": len(parse_photos(fb.photos)),
            "feedback_id": fb.id,
            "note": (fb.notes or "").strip() or MISSING,
        })

    fund_size = _fit_size([r["fund"] for r in body], BODY_COLS[COL_FUND])
    note_size = _fit_size([r["note"] for r in body], BODY_COLS[COL_BEMERKUNG])
    plain = _style("plain")
    navy = _style("navy", colour=NAVY)
    fund_style = _style("fund", size=fund_size, align=0)
    note_style = _style("note", size=note_size, colour=RED)
    right = _style("bild", align=2, colour=NAVY)

    for r in body:
        data.append([
            Paragraph(escape(r["vm"]), plain),
            Paragraph(escape(r["x"]), navy),
            Paragraph(escape(r["y"]), navy),
            Paragraph(escape(r["depth"]), navy),
            Paragraph(escape(r["laenge"]), plain),
            Paragraph(escape(r["breite"]), plain),
            Paragraph(escape(r["tiefe"]), plain),
            Paragraph(escape(r["m3"]), plain),
            Paragraph(_run(r["item"] + " / ", NAVY) +
                      _run(r["sohle"], GREEN if r["frei"] else RED), fund_style),
            Paragraph(_bild_cell(r, gallery_base), right),
            Paragraph(escape(r["note"]), note_style),
        ])

    if not body:
        data.append([Paragraph("Keine Datensätze für die gewählten Filter.", _style("empty", align=0))] +
                    [""] * (len(BODY_COLS) - 1))

    table = Table(data, colWidths=BODY_COLS, repeatRows=0)
    table.setStyle(TableStyle([
        ("SPAN", (0, 0), (-1, 0)),         # project title across the full width
        ("SPAN", (0, 1), (0, 2)),          # VM Nr.
        ("SPAN", (1, 1), (2, 1)),          # Koordinaten
        ("SPAN", (3, 1), (3, 2)),          # errechnete Tiefe
        ("SPAN", (4, 1), (7, 1)),          # Öffnung
        ("SPAN", (8, 1), (8, 2)),          # Fundstück
        ("SPAN", (9, 1), (9, 2)),          # Bild
        ("SPAN", (10, 1), (10, 2)),        # Bemerkung
        ("GRID", (0, 0), (-1, -1), 0.8, LINE),
        ("BOX", (0, 0), (-1, -1), 1.2, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 1.5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 1.5),
        ("TOPPADDING", (0, 0), (-1, -1), 0.6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0.7),
        ("TOPPADDING", (0, 0), (-1, 0), 1),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 1),
    ]))
    if body:
        # Bemerkung and Fundstück sit tight against their left/right borders.
        table.setStyle(TableStyle([("LEFTPADDING", (COL_FUND, 3), (COL_FUND, -1), 1.7)]))
    return table


def _footer_table(meta):
    cell = _style("foot")
    data = [
        [Paragraph(escape(COMPANY_LINE), cell), "", "", ""],
        [Paragraph("Erstellt von&nbsp;&nbsp;" + escape(meta["erstellt_von"]), cell),
         Paragraph("Geprüft von", cell), Paragraph("Freigabe von", cell),
         Paragraph("Datum", cell)],
        ["", "", "", ""],                  # left blank for wet signatures
    ]
    table = Table(data, colWidths=FOOT_COLS, rowHeights=FOOT_ROWS)
    table.setStyle(TableStyle([
        ("SPAN", (0, 0), (-1, 0)),
        ("GRID", (0, 0), (-1, -1), 0.8, LINE),
        ("BOX", (0, 0), (-1, -1), 1.2, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return table


def _story(meta, rows, page_count, gallery_base=None):
    return [
        _header_table(meta, page_count),
        Spacer(0, HEAD_TO_TITLE),
        _body_table(meta, rows, gallery_base),
        KeepTogether(_footer_table(meta)),
    ]


def _make_doc(buf, meta):
    def draw_logo(canvas, doc):
        # The template prints the logo beside the header box, on page 1 only.
        if doc.page != 1 or not os.path.exists(LOGO_PATH):
            return
        canvas.saveState()
        canvas.drawImage(LOGO_PATH, LOGO_X, PAGE_H - LOGO_TOP - LOGO_H,
                         width=LOGO_W, height=LOGO_H,
                         preserveAspectRatio=True, anchor="ne", mask="auto")
        canvas.restoreState()

    doc = BaseDocTemplate(
        buf, pagesize=(PAGE_W, PAGE_H),
        leftMargin=LEFT, rightMargin=PAGE_W - RIGHT,
        topMargin=TOP, bottomMargin=PAGE_H - BODY_BOTTOM,
        title=f"Öffnungen von Verdachtmomenten {meta['project_id']}",
        author="Nolte Services GmbH",
    )
    frame = Frame(LEFT, PAGE_H - BODY_BOTTOM, CONTENT_W, BODY_BOTTOM - TOP,
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0, id="body")
    doc.addPageTemplates([PageTemplate(id="report", frames=[frame], onPage=draw_logo)])
    return doc


def build_pdf(db: Session, rows, project_id=None, start=None, end=None, gallery_base=None) -> bytes:
    """start/end only describe the rows handed in; the header always reports the
    whole project, exactly like the template does.

    gallery_base is the absolute origin this server is reachable on (e.g.
    'http://10.0.0.5:8000'); pass it to turn the Bild numbers into links to the
    photo galleries. Without it the report is byte-for-byte the plain one.
    """
    meta = _header_values(db, project_id)

    # Seitenanzahl is the real page count, so lay the document out once to learn it.
    probe = _make_doc(io.BytesIO(), meta)
    probe.build(_story(meta, rows, "1", gallery_base))
    page_count = probe.page

    buf = io.BytesIO()
    doc = _make_doc(buf, meta)
    doc.build(_story(meta, rows, str(page_count), gallery_base))
    linked = sum(1 for fb, _ in rows if parse_photos(fb.photos))
    logger.info("Report for %s: %s rows over %s page(s), %s Bild link(s).",
                project_id, len(rows), page_count, linked if gallery_base else 0)
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
