"""Generates a professional PDF version of docs/ETL_OPERATOR_GUIDE.md using ReportLab."""
import os
import re
import sys
from datetime import datetime
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether, HRFlowable, Preformatted
)
from reportlab.pdfgen import canvas

MD_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "ETL_OPERATOR_GUIDE.md")
PDF_PATH = os.path.join(os.path.dirname(__file__), "..", "docs", "ETL_OPERATOR_GUIDE.pdf")


class NumberedCanvas(canvas.Canvas):
    """Two-pass canvas to dynamically compute and draw total page numbers and running headers."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_decorations(num_pages)
            super().showPage()
        super().save()

    def draw_page_decorations(self, page_count):
        self.saveState()
        self.setFont("Helvetica", 8)
        self.setFillColor(colors.HexColor("#64748b"))

        # Running Header (pages > 1)
        if self._pageNumber > 1:
            self.setStrokeColor(colors.HexColor("#e2e8f0"))
            self.setLineWidth(0.5)
            self.line(40, 805, 555, 805)
            self.drawString(40, 810, "NOLTE Geoservices -- ETL Operator & Maintenance Guide")
            self.drawRightString(555, 810, "Production Architecture")

        # Running Footer (all pages)
        self.setStrokeColor(colors.HexColor("#e2e8f0"))
        self.setLineWidth(0.5)
        self.line(40, 45, 555, 45)
        self.drawString(40, 32, "NOLTE Services GmbH - Technical Operations Manual")
        self.drawRightString(555, 32, f"Page {self._pageNumber} of {page_count}")
        self.restoreState()


def format_inline_markdown(text: str) -> str:
    """Format markdown bold, code, and entities for ReportLab XML/HTML paragraphs."""
    # Replace HTML entities first
    text = text.replace("&rarr;", " -> ").replace("&amp;", "&").replace("—", " -- ").replace("–", " - ")
    # Escape raw XML
    text = escape(text)
    # Restore bold
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    # Restore code
    text = re.sub(r"`(.+?)`", r'<font name="Courier" color="#0f766e"><b>\1</b></font>', text)
    # Restore italic
    text = re.sub(r"\*(.+?)\*", r"<i>\1</i>", text)
    # Convert <br> or <br/>
    text = text.replace("&lt;br&gt;", "<br/>").replace("&lt;br/&gt;", "<br/>")
    return text


def build_pdf():
    with open(MD_PATH, "r", encoding="utf-8") as f:
        md_text = f.read()

    doc = SimpleDocTemplate(
        PDF_PATH,
        pagesize=A4,
        leftMargin=40,
        rightMargin=40,
        topMargin=50,
        bottomMargin=55,
        title="Nolte Geoservices ETL Operator Guide",
        author="Nolte DevOps"
    )

    styles = getSampleStyleSheet()

    # Custom typography
    styles.add(ParagraphStyle(
        name="DocTitle",
        fontName="Helvetica-Bold",
        fontSize=20,
        leading=24,
        textColor=colors.HexColor("#0f172a"),
        spaceAfter=6
    ))
    styles.add(ParagraphStyle(
        name="DocSubtitle",
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        textColor=colors.HexColor("#475569"),
        spaceAfter=14
    ))
    styles.add(ParagraphStyle(
        name="SectionHeader",
        fontName="Helvetica-Bold",
        fontSize=13,
        leading=16,
        textColor=colors.HexColor("#1e3a8a"),
        spaceBefore=14,
        spaceAfter=6,
        keepWithNext=True
    ))
    styles.add(ParagraphStyle(
        name="SubSectionHeader",
        fontName="Helvetica-Bold",
        fontSize=10.5,
        leading=13.5,
        textColor=colors.HexColor("#0369a1"),
        spaceBefore=10,
        spaceAfter=4,
        keepWithNext=True
    ))
    styles.add(ParagraphStyle(
        name="BodyTextCustom",
        fontName="Helvetica",
        fontSize=8.5,
        leading=11.5,
        textColor=colors.HexColor("#1e293b"),
        spaceAfter=5
    ))
    styles.add(ParagraphStyle(
        name="BulletItem",
        fontName="Helvetica",
        fontSize=8.5,
        leading=11.5,
        textColor=colors.HexColor("#1e293b"),
        leftIndent=12,
        firstLineIndent=-8,
        spaceAfter=3
    ))
    styles.add(ParagraphStyle(
        name="TableHeader",
        fontName="Helvetica-Bold",
        fontSize=8,
        leading=10,
        textColor=colors.white
    ))
    styles.add(ParagraphStyle(
        name="TableCell",
        fontName="Helvetica",
        fontSize=7.5,
        leading=9.5,
        textColor=colors.HexColor("#1e293b")
    ))
    styles.add(ParagraphStyle(
        name="CodeBlockText",
        fontName="Courier",
        fontSize=7.5,
        leading=9.5,
        textColor=colors.HexColor("#0f172a")
    ))

    story = []

    # Title & Metadata Banner
    story.append(Paragraph("Nolte Geoservices UXO Target Platform", styles["DocTitle"]))
    story.append(Paragraph("ETL Operator, Maintenance & Scheduling Architecture Guide", styles["DocSubtitle"]))

    meta_table_data = [
        [
            Paragraph("<b>Document Version:</b> 2.4", styles["TableCell"]),
            Paragraph("<b>Target Environment:</b> Production / Staging", styles["TableCell"]),
            Paragraph(f"<b>Last Updated:</b> {datetime.now().strftime('%Y-%m-%d')}", styles["TableCell"]),
            Paragraph("<b>Status:</b> Fully Operational", styles["TableCell"]),
        ]
    ]
    meta_table = Table(meta_table_data, colWidths=[120, 140, 125, 130])
    meta_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
        ('BOX', (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    story.append(meta_table)
    story.append(Spacer(1, 12))

    lines = md_text.splitlines()
    in_code_block = False
    code_lines = []
    table_lines = []

    def flush_table(tbl_lines):
        if not tbl_lines:
            return
        rows = []
        is_header = True
        for tline in tbl_lines:
            if re.match(r"^\s*\|?\s*[-:| ]+\s*\|?\s*$", tline):
                # Separator line
                continue
            cells = [c.strip() for c in tline.split("|")]
            if len(cells) > 2 and cells[0] == "" and cells[-1] == "":
                cells = cells[1:-1]
            elif len(cells) >= 1 and cells[0] == "":
                cells = cells[1:]
            
            p_cells = []
            for cell in cells:
                style = styles["TableHeader"] if is_header else styles["TableCell"]
                p_cells.append(Paragraph(format_inline_markdown(cell), style))
            rows.append(p_cells)
            is_header = False

        if rows:
            num_cols = len(rows[0])
            content_w = 515.0
            col_w = content_w / num_cols
            
            # Check table header text to set optimal widths
            first_row_text = " ".join([cell.text for cell in rows[0]])
            if "Variable" in first_row_text and "Default" in first_row_text:
                widths = [140, 95, 280]
            elif "Action" in first_row_text and "Privileges" in first_row_text:
                widths = [120, 275, 120]
            elif num_cols == 3:
                widths = [120, 275, 120]
            elif num_cols == 4:
                widths = [90, 150, 160, 115]
            else:
                widths = [col_w] * num_cols

            t = Table(rows, colWidths=widths, repeatRows=1)
            t.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor("#1e293b")),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('TOPPADDING', (0, 0), (-1, -1), 3),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
                ('LEFTPADDING', (0, 0), (-1, -1), 4),
                ('RIGHTPADDING', (0, 0), (-1, -1), 4),
                ('BOX', (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                ('INNERGRID', (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
                ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
            ]))
            story.append(t)
            story.append(Spacer(1, 8))

    i = 0
    while i < len(lines):
        line = lines[i]

        # Handle code blocks
        if line.startswith("```"):
            if in_code_block:
                in_code_block = False
                code_text = "\n".join(code_lines)
                code_table = Table([[Preformatted(code_text, styles["CodeBlockText"])]], colWidths=[515])
                code_table.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor("#f1f5f9")),
                    ('BOX', (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                    ('TOPPADDING', (0, 0), (-1, -1), 4),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
                    ('LEFTPADDING', (0, 0), (-1, -1), 6),
                    ('RIGHTPADDING', (0, 0), (-1, -1), 6),
                ]))
                story.append(code_table)
                story.append(Spacer(1, 6))
                code_lines = []
            else:
                in_code_block = True
                code_lines = []
            i += 1
            continue

        if in_code_block:
            code_lines.append(line)
            i += 1
            continue

        # Handle Markdown Tables
        if line.strip().startswith("|") and "|" in line.strip()[1:]:
            table_lines.append(line)
            i += 1
            continue
        elif table_lines:
            flush_table(table_lines)
            table_lines = []

        # Horizontal Rule
        if line.strip() in ("---", "***"):
            story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#cbd5e1"), spaceBefore=8, spaceAfter=8))
            i += 1
            continue

        # Headers
        if line.startswith("# "):
            # Main doc title already placed
            i += 1
            continue
        elif line.startswith("## "):
            header_text = line[3:].strip()
            story.append(Paragraph(format_inline_markdown(header_text), styles["SectionHeader"]))
            i += 1
            continue
        elif line.startswith("### "):
            header_text = line[4:].strip()
            story.append(Paragraph(format_inline_markdown(header_text), styles["SubSectionHeader"]))
            i += 1
            continue

        # Bullet points
        stripped = line.strip()
        if stripped.startswith("- ") or stripped.startswith("* "):
            bullet_text = "- " + format_inline_markdown(stripped[2:])
            story.append(Paragraph(bullet_text, styles["BulletItem"]))
            i += 1
            continue
        elif re.match(r"^\d+\.\s+", stripped):
            num_match = re.match(r"^(\d+\.)\s+(.+)$", stripped)
            if num_match:
                prefix, text = num_match.group(1), num_match.group(2)
                item_text = f"<b>{prefix}</b> " + format_inline_markdown(text)
                story.append(Paragraph(item_text, styles["BulletItem"]))
            i += 1
            continue

        # Empty line
        if not stripped:
            i += 1
            continue

        # Regular Paragraph
        story.append(Paragraph(format_inline_markdown(stripped), styles["BodyTextCustom"]))
        i += 1

    if table_lines:
        flush_table(table_lines)

    # Build document with NumberedCanvas
    doc.build(story, canvasmaker=NumberedCanvas)
    print(f"Successfully generated PDF: {PDF_PATH} ({os.path.getsize(PDF_PATH)} bytes)")


if __name__ == "__main__":
    build_pdf()
