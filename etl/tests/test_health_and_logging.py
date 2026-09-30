"""Tests for Structured JSON Logging and Health Monitoring endpoint."""
from __future__ import annotations

import json
import logging
import unittest
from datetime import datetime, timezone, timedelta
from etl.runner.logger import JsonFormatter, ConsoleFormatter, set_run_context, clear_run_context, get_logger
import os
from unittest import mock

# server.py runs init_db() on import, against DATABASE_URL - by default the live database.
# These are unit tests with the database mocked out: point the import at a throwaway
# in-memory SQLite and skip the schema setup entirely.
os.environ["DATABASE_URL"] = "sqlite://"
with mock.patch("database.init_db"):
    import server  # noqa: E402


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


class _FakeConn:
    """Answers _etl_health's queries from a canned last run / last ok-or-skipped run."""
    def __init__(self, last_run, last_alive):
        self.last_run, self.last_alive = last_run, last_alive

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, q, *args):
        if "status <> 'running'" in q:
            row = self.last_run
        elif "status IN ('ok', 'skipped')" in q:
            row = self.last_alive
        else:
            row = (0,) if "count(*)" in q else (1,)
        return mock.Mock(fetchone=mock.Mock(return_value=row))


def _health(last_run, last_alive):
    with mock.patch.object(server, "get_etl_approver_conn", return_value=_FakeConn(last_run, last_alive)):
        return server._etl_health()


class TestHealthClassification(unittest.TestCase):
    now = datetime.now(timezone.utc)

    def test_recent_skipped_run_is_healthy(self):
        """No new data for days is normal: skipped runs keep the pipeline fresh."""
        recent = self.now - timedelta(minutes=10)
        h = _health((115, "skipped", recent, recent), (115, "skipped", recent))
        self.assertEqual(h["status"], "healthy")
        self.assertEqual(h["staleness"]["last_success_status"], "skipped")

    def test_old_last_alive_run_is_degraded(self):
        old = self.now - timedelta(hours=30)
        h = _health((10, "ok", old, old), (10, "ok", old))
        self.assertEqual(h["status"], "degraded")

    def test_latest_failed_run_is_unhealthy(self):
        recent = self.now - timedelta(minutes=10)
        h = _health((12, "failed", recent, recent), (11, "ok", recent))
        self.assertEqual(h["status"], "unhealthy")

    def test_never_succeeded_is_unhealthy(self):
        recent = self.now - timedelta(minutes=10)
        h = _health((1, "failed", recent, recent), None)
        self.assertEqual(h["status"], "unhealthy")

    def test_no_runs_is_unknown(self):
        self.assertEqual(_health(None, None)["status"], "unknown")

    def test_unreachable_database_hides_the_error(self):
        with mock.patch.object(server, "get_etl_approver_conn", side_effect=RuntimeError('password authentication failed for user "etl_approver"')):
            h = server._etl_health()
        self.assertEqual(h["status"], "unhealthy")
        self.assertNotIn("etl_approver", str(h))


class TestPublicHealthProbe(unittest.TestCase):
    def setUp(self):
        server._etl_health_cache.update(at=0.0, status=None)

    def tearDown(self):
        server._etl_health_cache.update(at=0.0, status=None)

    def test_public_probe_returns_status_only_and_503_when_unhealthy(self):
        full = {"status": "unhealthy", "timestamp": "x", "error": "approval database unreachable"}
        with mock.patch.object(server, "_etl_health", return_value=full):
            response = mock.Mock(status_code=200)
            body = server.get_etl_pipeline_health(response)
        self.assertEqual(body, {"status": "unhealthy"})
        self.assertEqual(response.status_code, 503)

    def test_public_probe_is_cached(self):
        with mock.patch.object(server, "_etl_health", return_value={"status": "healthy"}) as calc:
            for _ in range(5):
                server.get_etl_pipeline_health(mock.Mock(status_code=200))
        self.assertEqual(calc.call_count, 1)

    def test_details_route_requires_admin_and_probe_does_not(self):
        def deps(path):
            route = next(r for r in server.app.routes if getattr(r, "path", None) == path)
            return {d.call for d in route.dependant.dependencies}
        self.assertIn(server.require_admin, deps("/api/etl/health/details"))
        self.assertNotIn(server.require_admin, deps("/api/etl/health"))


class TestCronSchedule(unittest.TestCase):
    def test_cron_schedule_parsing(self):
        from etl.runner.run import CronSchedule
        c = CronSchedule("*/15 * * * *")
        self.assertEqual(c.minutes, {0, 15, 30, 45})
        self.assertEqual(len(c.hours), 24)

    def test_cron_schedule_next_run(self):
        from etl.runner.run import CronSchedule
        c = CronSchedule("*/15 * * * *")
        ref_dt = datetime(2026, 9, 29, 10, 5, 0)
        secs = c.next_run_seconds(ref_dt)
        self.assertEqual(secs, 600.0)  # Next is 10:15:00 = 10 mins = 600s

    def test_cron_invalid_expression(self):
        from etl.runner.run import CronSchedule
        with self.assertRaises(ValueError):
            CronSchedule("*/15 * * *")  # Only 4 fields


if __name__ == "__main__":
    unittest.main()
