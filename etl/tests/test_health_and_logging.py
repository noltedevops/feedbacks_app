"""Tests for Structured JSON Logging and Health Monitoring endpoint."""
from __future__ import annotations

import json
import logging
import unittest
from datetime import datetime, timezone, timedelta
from etl.runner.logger import JsonFormatter, ConsoleFormatter, set_run_context, clear_run_context, get_logger
from server import get_etl_pipeline_health


class TestStructuredLogging(unittest.TestCase):
    def setUp(self):
        clear_run_context()

    def tearDown(self):
        clear_run_context()

    def test_json_formatter_structure(self):
        formatter = JsonFormatter()
        record = logging.LogRecord(
            name="etl.test",
            level=logging.INFO,
            pathname=__file__,
            lineno=25,
            msg="Processing project targets",
            args=(),
            exc_info=None
        )
        set_run_context(run_id=42, project_id="11-26-5151")
        output = formatter.format(record)
        
        parsed = json.loads(output)
        self.assertEqual(parsed["level"], "INFO")
        self.assertEqual(parsed["logger"], "etl.test")
        self.assertEqual(parsed["message"], "Processing project targets")
        self.assertEqual(parsed["run_id"], 42)
        self.assertEqual(parsed["project_id"], "11-26-5151")
        self.assertIn("timestamp", parsed)

    def test_console_formatter_output(self):
        formatter = ConsoleFormatter()
        record = logging.LogRecord(
            name="etl.test",
            level=logging.WARNING,
            pathname=__file__,
            lineno=45,
            msg="DB-only rows changed",
            args=(),
            exc_info=None
        )
        set_run_context(run_id=99, project_id="11-24-2736")
        output = formatter.format(record)
        self.assertIn("[WARNING]", output)
        self.assertIn("[run:99]", output)
        self.assertIn("[proj:11-24-2736]", output)
        self.assertIn("DB-only rows changed", output)


class TestHealthEndpoint(unittest.TestCase):
    def test_etl_health_response(self):
        health = get_etl_pipeline_health()
        self.assertIn("status", health)
        self.assertIn(health["status"], ("healthy", "degraded", "unhealthy"))
        self.assertIn("timestamp", health)
        if health["status"] != "unhealthy" or "database_latency_ms" in health:
            self.assertIn("database_latency_ms", health)
            self.assertIsInstance(health["database_latency_ms"], float)
            self.assertIn("staleness", health)
            self.assertIn("pending_approvals", health)
            self.assertIn("data_counts", health)


if __name__ == "__main__":
    unittest.main()
