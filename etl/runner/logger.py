"""Structured logging module for the ETL pipeline.

Provides dual-destination logging:
1. Console (stdout): Human-readable formatted logs for interactive CLI & docker compose output.
2. Rotating File (etl/logs/etl.jsonl): Machine-readable JSON Lines with log rotation for SIEM/observability.
"""
from __future__ import annotations

import contextvars
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys
from datetime import datetime, timezone
from typing import Any

# Context variables for tagging log entries with run_id and project_id
current_run_id: contextvars.ContextVar[int | None] = contextvars.ContextVar("current_run_id", default=None)
current_project_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("current_project_id", default=None)


def set_run_context(run_id: int | None = None, project_id: str | None = None) -> None:
    """Set contextual run and project metadata for all loggers in the current execution context."""
    if run_id is not None:
        current_run_id.set(run_id)
    if project_id is not None:
        current_project_id.set(project_id)


def clear_run_context() -> None:
    """Clear contextual run and project metadata."""
    current_run_id.set(None)
    current_project_id.set(None)


class JsonFormatter(logging.Formatter):
    """Formats log records as structured JSON Lines (JSONL)."""

    def format(self, record: logging.LogRecord) -> str:
        log_entry: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Inject context variables
        run_id = current_run_id.get()
        if run_id is not None:
            log_entry["run_id"] = run_id

        project_id = current_project_id.get()
        if project_id is not None:
            log_entry["project_id"] = project_id

        # Include custom extra attributes if present
        if hasattr(record, "details") and record.details is not None:
            log_entry["details"] = record.details

        # Include exception traceback if present
        if record.exc_info:
            log_entry["exception"] = self.formatException(record.exc_info)

        return json.dumps(log_entry, default=str)


class ConsoleFormatter(logging.Formatter):
    """Formats log records for clear human-readable console output."""

    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        run_id = current_run_id.get()
        run_tag = f" [run:{run_id}]" if run_id is not None else ""
        project_id = current_project_id.get()
        proj_tag = f" [proj:{project_id}]" if project_id is not None else ""
        
        msg = record.getMessage()
        exc = f"\n{self.formatException(record.exc_info)}" if record.exc_info else ""
        return f"[{ts}] [{record.levelname:5s}]{run_tag}{proj_tag} {msg}{exc}"


def get_logger(name: str = "etl.runner") -> logging.Logger:
    """Retrieve or initialize a configured logger with console and rotating JSON file handlers."""
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    logger.propagate = False

    # 1. Console Handler (stdout)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(ConsoleFormatter())
    console_handler.setLevel(logging.INFO)
    logger.addHandler(console_handler)

    # 2. Rotating JSONL File Handler
    try:
        log_dir = Path(os.environ.get("ETL_LOG_DIR", Path(__file__).resolve().parent.parent / "logs"))
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / "etl.jsonl"

        # Max 10MB per file, rotate up to 5 backups
        file_handler = RotatingFileHandler(
            log_file,
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8"
        )
        file_handler.setFormatter(JsonFormatter())
        file_handler.setLevel(logging.INFO)
        logger.addHandler(file_handler)
    except Exception as exc:
        logger.warning(f"Could not initialize rotating file logger: {exc}")

    return logger
