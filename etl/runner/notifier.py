from __future__ import annotations

import json
import os
import sys
import urllib.request
from typing import Any


def _safe_print(text: str, file=sys.stdout) -> None:
    try:
        print(text, file=file, flush=True)
    except UnicodeEncodeError:
        safe_text = text.encode("ascii", errors="replace").decode("ascii")
        print(safe_text, file=file, flush=True)


def get_webhook_url() -> str | None:
    return os.environ.get("ETL_WEBHOOK_URL", "").strip() or None


def send_webhook(title: str, text: str, level: str = "info", fields: dict[str, Any] | None = None) -> bool:
    url = get_webhook_url()
    prefix = f"[ETL NOTIFIER] [{level.upper()}] {title}: {text}"
    if not url:
        _safe_print(prefix)
        return False

    color_map = {
        "info": "#2563eb",      # blue
        "success": "#16a34a",   # green
        "warning": "#ca8a04",   # yellow
        "error": "#dc2626",     # red
    }
    color = color_map.get(level.lower(), "#4b5563")

    field_list = []
    if fields:
        for k, v in fields.items():
            field_list.append(f"*{k}*: {v}")
    
    full_message = f"*{title}*\n{text}"
    if field_list:
        full_message += "\n" + "\n".join(field_list)

    # Standard payload compatible with Slack, Discord, Teams, and generic webhook parsers
    payload = {
        "text": full_message,
        "content": full_message,
        "attachments": [
            {
                "color": color,
                "title": title,
                "text": text,
                "fields": [{"title": k, "value": str(v), "short": True} for k, v in (fields or {}).items()],
            }
        ]
    }

    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json", "User-Agent": "Nolte-ETL-Pipeline/1.0"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = resp.status
            return 200 <= status < 300
    except Exception as exc:
        _safe_print(f"[ETL NOTIFIER] Webhook dispatch failed: {exc}", file=sys.stderr)
        return False


def notify_run_failed(run_id: int, error: str, failed_gates: list[str] | None = None) -> None:
    fields = {"Run ID": run_id, "Status": "FAILED"}
    if failed_gates:
        fields["Failed Gates"] = "; ".join(failed_gates)
    send_webhook(
        title=f"[ALERT] ETL Pipeline Run {run_id} FAILED",
        text=f"The pipeline aborted and rolled back: {error}",
        level="error",
        fields=fields
    )


def notify_pending_approvals(run_id: int, project_id: str, staged_changes: int, correction_pairs: int) -> None:
    items = []
    if staged_changes > 0:
        items.append(f"{staged_changes} staged attribute change(s)")
    if correction_pairs > 0:
        items.append(f"{correction_pairs} coordinate correction pair(s)")
    
    send_webhook(
        title=f"[PENDING] Approvals Waiting in Project {project_id}",
        text=f"Run {run_id} held back items requiring human approval: {', '.join(items)}. Run 'etl-approve' to decide.",
        level="warning",
        fields={
            "Project": project_id,
            "Run ID": run_id,
            "Staged Changes": staged_changes,
            "Correction Pairs": correction_pairs
        }
    )


def notify_run_success(run_id: int, summary: dict[str, Any]) -> None:
    projects_info = []
    for pid, pdata in summary.get("projects", {}).items():
        ins = pdata.get("inserted", 0)
        chg = pdata.get("changes_applied", 0)
        cor = pdata.get("corrections_applied", 0)
        projects_info.append(f"{pid}: +{ins} new, {chg} changes, {cor} corrections")

    send_webhook(
        title=f"[SUCCESS] ETL Pipeline Run {run_id} Completed",
        text="The pipeline merged updates successfully into public.anomalies.",
        level="success",
        fields={
            "Run ID": run_id,
            "Summary": " | ".join(projects_info) if projects_info else "No new rows"
        }
    )
