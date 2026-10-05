"""Kennzahlenbericht: the dashboard's KPIs as a portrait A4 PDF.

A separate export from the Öffnungen protocol (report.py), which reproduces
reportTemplate.pdf and stays exactly that. This one summarises the selection the
way the dashboard does.

The rules are a Python copy of frontend/src/dashboardStats.ts, and
tests/test_kpi_report.py runs the same cases as frontend/tests/dashboardStats.test.ts,
so the PDF and the dashboard cannot drift apart. Change one, change both.

  - A target is excavated once it has a feedback record (the field app's
    local_status is 'unvisited' exactly when it has none).
  - Sohle is clear only when recorded as Frei/clear; no recorded status is not a
    clearance.
  - A shallow hazard has a calculated depth above 0 and under 0.4 m, and stays open
    until the target is dug.
  - A figure with nothing measured behind it is None, printed as "k. A.", never 0.

The date range: progress and open hazards are reported as of now, for the whole
project - a hazard still in the ground is open whatever the period. Everything
measured at excavation reads the targets whose latest opening falls in the range.
"""
import datetime
import io
import logging
import os
import re
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, PageTemplate, Paragraph, Spacer, Table, TableStyle,
)
from sqlalchemy.orm import Session

import models
from report import COMPANY_LINE, FONT, FONT_BOLD, GREEN, LOGO_PATH, NAVY, RED

logger = logging.getLogger("kpi_report")

SHALLOW_HAZARD_DEPTH_M = 0.4
SOHLE_COMPLIANCE_TARGET_PCT = 80
NA = "k. A."


# --------------------------------------------------------------------------
# rules - keep in step with frontend/src/dashboardStats.ts
# --------------------------------------------------------------------------

def is_sohle_clear(status) -> bool:
    return (status or "").strip().lower() in ("frei", "clear")


def is_shallow(depth) -> bool:
    return depth is not None and 0 < depth < SHALLOW_HAZARD_DEPTH_M


def instrument_group(instrument) -> str:
    inst = (instrument or "").lower()
    if "radar" in inst:
        return "Georadar"
    if "mag" in inst:
        return "Magnetik"
    return "Sonstige"


def sohle_compliance(excavated):
    """excavated: [(anomaly, feedback)]. Whole percent, or None with nothing dug."""
    if not excavated:
        return None
    clear = sum(1 for _, fb in excavated if is_sohle_clear(fb.sohle_status))
    return round(clear / len(excavated) * 100)


def accuracy_stats(excavated) -> dict:
    abs_sum = bias_sum = 0.0
    pairs = empty = 0
    gpr_actual = gpr_eval = 0.0
    gpr_pairs = 0
    mag_abs = 0.0
    mag_pairs = 0
    for an, fb in excavated:
        if fb.fundstueck == "ohne Fund":
            empty += 1
        ev, actual = an.evaluated_depth, fb.tief
        if ev is None or actual is None:
            continue
        abs_sum += abs(ev - actual)
        bias_sum += ev - actual
        pairs += 1
        group = instrument_group(an.instrument)
        if group == "Georadar":
            if ev > 0 and actual > 0:
                gpr_actual += actual
                gpr_eval += ev
                gpr_pairs += 1
        elif group == "Magnetik":
            mag_abs += abs(ev - actual)
            mag_pairs += 1
    return {
        "n": len(excavated),
        "pairs": pairs,
        "mean_error": abs_sum / pairs if pairs else None,
        "bias": bias_sum / pairs if pairs else None,
        "fpr": round(empty / len(excavated) * 100) if excavated else None,
        "gpr_drift": (gpr_actual / gpr_eval - 1) * 100 if gpr_pairs and gpr_eval > 0 else None,
        "mag_error": mag_abs / mag_pairs if mag_pairs else None,
    }


def volume_stats(excavated) -> dict:
    total = 0.0
    pits = finds = 0
    for _, fb in excavated:
        vol = fb.m_cube
        if vol is None or vol <= 0:
            continue
        total += vol
        pits += 1
        if fb.fundstueck and fb.fundstueck != "ohne Fund":
            finds += 1
    return {
        "pits": pits,
        "total": total if pits else None,
        "mean_pit": total / pits if pits else None,
        "finds_per_m3": finds / total if pits else None,
    }


def _natural(text):
    """'2736-2' before '2736-10': digit runs compare as numbers."""
    return [(0, int(part), "") if part.isdigit() else (1, 0, part) for part in re.split(r"(\d+)", text or "")]


def compute(targets, start=None, end=None) -> dict:
    """targets: [(anomaly, latest feedback or None)] for the selected project(s).
    start/end: naive UTC datetimes bounding the latest opening, or None."""
    def in_range(fb):
        if start is None and end is None:
            return True
        if fb.visit_date is None:
            return False
        return (start is None or fb.visit_date >= start) and (end is None or fb.visit_date <= end)

    dug_ever = [(an, fb) for an, fb in targets if fb is not None]
    excavated = [(an, fb) for an, fb in dug_ever if in_range(fb)]
    open_hazards = sorted(
        (an for an, fb in targets if fb is None and is_shallow(an.evaluated_depth)),
        key=lambda an: _natural(an.vm_nr),
    )

    by_instrument = {}
    for group in ("Georadar", "Magnetik", "Sonstige"):
        subset = [(an, fb) for an, fb in excavated if instrument_group(an.instrument) == group]
        if subset:
            by_instrument[group] = accuracy_stats(subset)

    findings = {}
    for _, fb in excavated:
        name = fb.fundstueck or "ohne Fund"
        row = findings.setdefault(name, {"count": 0, "frei": 0, "nicht_frei": 0})
        row["count"] += 1
        row["frei" if is_sohle_clear(fb.sohle_status) else "nicht_frei"] += 1

    return {
        "total": len(targets),
        "investigated": len(dug_ever),
        "pending": len(targets) - len(dug_ever),
        "projects": len({an.project_id for an, _ in targets}),
        "excavated_in_range": len(excavated),
        "sohle_compliance": sohle_compliance(excavated),
        "sohle_clear": sum(1 for _, fb in excavated if is_sohle_clear(fb.sohle_status)),
        "open_hazards": open_hazards,
        "accuracy": accuracy_stats(excavated),
        "accuracy_by_instrument": by_instrument,
        "findings": sorted(findings.items(), key=lambda kv: (-kv[1]["count"], kv[0])),
        "volume": volume_stats(excavated),
    }


def fetch_targets(db: Session, project_id=None):
    from routers.points import _latest_feedback_by_anomaly  # the pick /api/points uses
    q = db.query(models.Anomaly)
    if project_id:
        q = q.filter(models.Anomaly.project_id == project_id)
    latest = _latest_feedback_by_anomaly(db)
    return [(an, latest.get(an.id)) for an in q.all()]


# --------------------------------------------------------------------------
# formatting
# --------------------------------------------------------------------------

def _num(value, decimals=2, unit="", signed=False):
    if value is None:
        return NA
    text = f"{value:+.{decimals}f}" if signed else f"{value:.{decimals}f}"
    if text in ("-0." + "0" * decimals, "+0." + "0" * decimals):
        text = "0." + "0" * decimals
    text = text.replace(".", ",")
    return f"{text} {unit}".strip() if unit else text


def _pct(value):
    return NA if value is None else f"{value} %"


def _int(value):
    """German thousands separator: 2215 -> '2.215'."""
    return f"{value:,}".replace(",", ".")


def _bias_text(bias):
    if bias is None:
        return NA
    if bias > 0.02:
        verdict = "zu tief"
    elif bias < -0.02:
        verdict = "zu flach"
    else:
        verdict = "ausgeglichen"
    return f"{verdict} ({_num(bias, unit='m', signed=True)})"


def _date_de(dt):
    return dt.strftime("%d.%m.%Y") if dt else None


# --------------------------------------------------------------------------
# pdf
# --------------------------------------------------------------------------

MARGIN = 18 * mm
PAGE_W, PAGE_H = A4
CONTENT_W = PAGE_W - 2 * MARGIN
GRID = colors.HexColor("#BFBFBF")
SHADE = colors.HexColor("#F2F2F2")
MUTED = colors.HexColor("#595959")


def _ps(name, size=9.5, bold=False, align=0, colour=colors.black, leading=None):
    return ParagraphStyle(name, fontName=FONT_BOLD if bold else FONT, fontSize=size,
                          leading=leading or size * 1.25, alignment=align, textColor=colour)


TITLE = _ps("title", 18, bold=True, colour=NAVY, leading=22)
SUB = _ps("sub", 9.5, colour=MUTED)
H2 = _ps("h2", 12, bold=True, colour=NAVY, leading=15)
BODY = _ps("body", 9.5)
SMALL = _ps("small", 8, colour=MUTED, leading=10.5)
TILE_LABEL = _ps("tl", 8, bold=True, colour=MUTED)
TILE_VALUE = _ps("tv", 16, bold=True, colour=NAVY, leading=19)
TILE_NOTE = _ps("tn", 8, colour=MUTED, leading=10)
TH = _ps("th", 8.5, bold=True)
THR = _ps("thr", 8.5, bold=True, align=2)
TD = _ps("td", 9)
TDR = _ps("tdr", 9, align=2)


def _p(text, style):
    return Paragraph(escape(str(text)), style)


def _tiles(items, cols=3):
    """KPI tiles: (label, value, note, colour or None)."""
    cells = []
    for label, value, note, colour in items:
        value_style = TILE_VALUE if colour is None else ParagraphStyle("tvc", parent=TILE_VALUE, textColor=colour)
        cell = [_p(label.upper(), TILE_LABEL), _p(value, value_style)]
        if note:
            cell.append(_p(note, TILE_NOTE))
        cells.append(cell)
    while len(cells) % cols:
        cells.append("")
    rows = [cells[i:i + cols] for i in range(0, len(cells), cols)]
    w = CONTENT_W / cols
    table = Table(rows, colWidths=[w] * cols)
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.5, GRID),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, GRID),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ]))
    return table


def _table(header, rows, widths, numeric_from=1):
    data = [[_p(h, TH if i < numeric_from else THR) for i, h in enumerate(header)]]
    for row in rows:
        data.append([_p(v, TD if i < numeric_from else TDR) for i, v in enumerate(row)])
    table = Table(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), SHADE),
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, colors.black),
        ("LINEBELOW", (0, 1), (-1, -1), 0.25, GRID),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return table


def _section(title, *flowables):
    return [KeepTogether([Spacer(0, 5 * mm), _p(title, H2), Spacer(0, 2 * mm), flowables[0]]), *flowables[1:]]


def _story(stats, meta):
    acc, vol = stats["accuracy"], stats["volume"]
    period = meta["period"]
    story = [
        _p("Kennzahlenbericht", TITLE),
        Spacer(0, 1.5 * mm),
        _p(f"Projekt: {meta['project']}" + (f" – {meta['project_name']}" if meta["project_name"] else ""), SUB),
        _p(f"Zeitraum der Öffnungen: {period}  ·  Stand: {meta['generated']}", SUB),
    ]

    # 1. Fortschritt - always the whole project, as of now.
    # One decimal: early in a project, 11 of 2,215 dug is 0,5 %, not 0 %.
    share = _num(stats["investigated"] / stats["total"] * 100, 1, "%") if stats["total"] else NA
    story += _section("Fortschritt (Stand heute)", _tiles([
        ("Ziele gesamt", _int(stats["total"]), f"{stats['projects']} Messprojekt(e)", None),
        ("Untersucht", _int(stats["investigated"]), f"{share} der Ziele", None),
        ("Offen", _int(stats["pending"]), None, None),
    ]))

    # 2. Sicherheit.
    compliance = stats["sohle_compliance"]
    compliance_colour = None if compliance is None else (GREEN if compliance >= SOHLE_COMPLIANCE_TARGET_PCT else RED)
    hazards = stats["open_hazards"]
    story += _section("Sicherheit", _tiles([
        ("Sohle-Freigabe", _pct(compliance),
         f"{_int(stats['sohle_clear'])} von {_int(stats['excavated_in_range'])} Öffnungen im Zeitraum frei "
         f"(Ziel ≥ {SOHLE_COMPLIANCE_TARGET_PCT} %)", compliance_colour),
        ("Offene Flachlieger", _int(len(hazards)),
         f"noch nicht ausgehoben, errechnete Tiefe unter {_num(SHALLOW_HAZARD_DEPTH_M, 1, 'm')}",
         RED if hazards else None),
    ], cols=2))

    # 3. Sensorgenauigkeit.
    rows = []
    for group, s in [*stats["accuracy_by_instrument"].items(), ("Alle", acc)]:
        rows.append([group, _int(s["n"]), _int(s["pairs"]), _num(s["mean_error"], unit="m"),
                     _bias_text(s["bias"]), _pct(s["fpr"]),
                     _num(s["gpr_drift"], 1, "%", signed=True) if group in ("Georadar", "Alle") else "–"])
    story += _section("Sensorgenauigkeit (Öffnungen im Zeitraum)", _table(
        ["Instrument", "Öffnungen", "Tiefenpaare", "Mittl. Fehler", "Tendenz", "Leerquote", "GPR Δv"],
        rows, [CONTENT_W * f for f in (0.15, 0.11, 0.12, 0.13, 0.25, 0.11, 0.13)]))

    # 4. Funde.
    story += _section("Funde und Sohle (Öffnungen im Zeitraum)", _table(
        ["Fundstück", "Anzahl", "Sohle frei", "Sohle nicht frei"],
        [[name, _int(r["count"]), _int(r["frei"]), _int(r["nicht_frei"])] for name, r in stats["findings"]]
        or [["Keine Öffnungen im Zeitraum.", "", "", ""]],
        [CONTENT_W * f for f in (0.46, 0.18, 0.18, 0.18)]))

    # 5. Aushub.
    story += _section("Aushub (Öffnungen im Zeitraum)", _tiles([
        ("Gesamtvolumen", _num(vol["total"], 1, "m³"), f"{vol['pits']} Grube(n) mit erfasstem Volumen", None),
        ("Mittleres Grubenvolumen", _num(vol["mean_pit"], unit="m³"), None, None),
        ("Funde je m³", _num(vol["finds_per_m3"]), "Funde (außer ohne Fund) je m³ Aushub", None),
    ]))

    story += [Spacer(0, 6 * mm), _p("Definitionen", _ps("h3s", 8.5, bold=True, colour=MUTED)), Spacer(0, 1 * mm)]
    for line in (
        "Untersucht: Ziel mit Feldprotokoll. Fortschritt und offene Flachlieger gelten für das ganze Projekt zum "
        "Stand des Berichts; alle anderen Kennzahlen für Ziele, deren letzte Öffnung im Zeitraum liegt.",
        "Sohle-Freigabe: Anteil der Öffnungen mit Sohle-Status „Frei“. Ein Protokoll ohne Sohle-Status zählt als "
        "nicht frei.",
        f"Flachlieger: errechnete Tiefe über 0 und unter {_num(SHALLOW_HAZARD_DEPTH_M, 1, 'm')}; offen, solange "
        "das Ziel nicht ausgehoben ist.",
        "Mittlerer Fehler / Tendenz: Mittel von |errechnet − tatsächlich| bzw. (errechnet − tatsächlich) über Ziele "
        "mit beiden Tiefen. Positive Tendenz: Ziele wurden zu tief verortet.",
        "Leerquote: Anteil der Öffnungen „ohne Fund“. GPR Δv: Summe tatsächlicher / Summe errechneter Tiefen "
        "− 1 über Georadar-Ziele; positiv heißt, die Radargeschwindigkeit wurde unterschätzt.",
        f"„{NA}“: nichts gemessen, worauf die Kennzahl beruhen könnte – nicht null.",
    ):
        story.append(_p(line, SMALL))

    return story


def _make_doc(buf, meta, page_count):
    def decorate(canvas, doc):
        canvas.saveState()
        if doc.page == 1 and os.path.exists(LOGO_PATH):
            w, h = 52 * mm, 12.3 * mm
            canvas.drawImage(LOGO_PATH, PAGE_W - MARGIN - w, PAGE_H - MARGIN - h + 2 * mm, width=w, height=h,
                             preserveAspectRatio=True, anchor="ne", mask="auto")
        canvas.setFont(FONT, 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(MARGIN, 10 * mm, COMPANY_LINE)
        canvas.drawRightString(PAGE_W - MARGIN, 10 * mm, f"Seite {doc.page} von {page_count}")
        canvas.restoreState()

    doc = BaseDocTemplate(buf, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN,
                          topMargin=MARGIN, bottomMargin=MARGIN,
                          title=f"Kennzahlenbericht {meta['project']}", author="Nolte Services GmbH")
    frame = Frame(MARGIN, MARGIN, CONTENT_W, PAGE_H - 2 * MARGIN, id="body",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="kpi", frames=[frame], onPage=decorate)])
    return doc


def build_pdf(stats: dict, project_id=None, project_name="", start=None, end=None, now=None) -> bytes:
    now = now or datetime.datetime.now()
    s, e = _date_de(start), _date_de(end)
    meta = {
        "project": project_id or "Alle Projekte",
        "project_name": project_name or "",
        "period": f"{s} – {e}" if s and e else f"ab {s}" if s else f"bis {e}" if e else "gesamt",
        "generated": now.strftime("%d.%m.%Y %H:%M"),
    }
    probe = _make_doc(io.BytesIO(), meta, "1")
    probe.build(_story(stats, meta))
    buf = io.BytesIO()
    doc = _make_doc(buf, meta, str(probe.page))
    doc.build(_story(stats, meta))
    logger.info("KPI report for %s: %s targets, %s opened in range, %s page(s).",
                meta["project"], stats["total"], stats["excavated_in_range"], probe.page)
    return buf.getvalue()


def build_for(db: Session, project_id=None, start=None, end=None) -> bytes:
    stats = compute(fetch_targets(db, project_id), start, end)
    name = ""
    if project_id:
        row = db.query(models.Project.project_name).filter(models.Project.project_id == project_id).first()
        name = (row[0] if row else "") or ""
    return build_pdf(stats, project_id, name, start, end)
