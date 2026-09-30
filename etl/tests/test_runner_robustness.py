"""The runner closes its connection on every path, and a scheduler survives a run that
cannot start. No database: connect() and the run body are mocked.

    python -m unittest etl/tests/test_runner_robustness.py
"""
from __future__ import annotations

import unittest
from unittest import mock

from etl.runner import run as runner

CFG = {"projects": [{"project_id": "p1"}]}


class TestRunClosesConnection(unittest.TestCase):
    def _run_with(self, body=None, lock_free=True):
        conn = mock.MagicMock()
        conn.execute.return_value.fetchone.return_value = (lock_free,)
        patches = [mock.patch.object(runner, "load_config", return_value=CFG),
                   mock.patch.object(runner, "connect", return_value=conn)]
        if body is not None:
            patches.append(mock.patch.object(runner, "_run_on", side_effect=body))
        with patches[0], patches[1], (patches[2] if body is not None else mock.MagicMock()):
            try:
                return conn, runner.run(), None
            except BaseException as exc:  # noqa: BLE001 - the test inspects it
                return conn, None, exc

    def test_lock_held_closes_connection(self):
        conn, rc, exc = self._run_with(lock_free=False)
        self.assertEqual(rc, 0)
        self.assertIsNone(exc)
        conn.close.assert_called_once()

    def test_success_closes_connection(self):
        conn, rc, _ = self._run_with(body=lambda *a: 0)
        self.assertEqual(rc, 0)
        conn.close.assert_called_once()

    def test_source_mismatch_closes_connection(self):
        def body(*a):
            raise SystemExit("config does not match the database")
        conn, _, exc = self._run_with(body=body)
        self.assertIsInstance(exc, SystemExit)
        conn.close.assert_called_once()

    def test_unexpected_error_closes_connection(self):
        def body(*a):
            raise RuntimeError("boom")
        conn, _, exc = self._run_with(body=body)
        self.assertIsInstance(exc, RuntimeError)
        conn.close.assert_called_once()


class TestScheduledRunSurvives(unittest.TestCase):
    def _scheduled(self, exc):
        with mock.patch.object(runner, "run", side_effect=exc), \
                mock.patch.object(runner, "send_webhook") as hook:
            runner.scheduled_run()  # must not raise
        return hook

    def test_config_error_is_alerted_not_fatal(self):
        hook = self._scheduled(SystemExit("Configuration validation failed"))
        hook.assert_called_once()
        self.assertIn("Configuration validation failed", hook.call_args.args[1])

    def test_unreachable_database_is_alerted_not_fatal(self):
        hook = self._scheduled(ConnectionError("connection refused"))
        hook.assert_called_once()

    def test_normal_run_sends_no_extra_alert(self):
        with mock.patch.object(runner, "run", return_value=0), \
                mock.patch.object(runner, "send_webhook") as hook:
            runner.scheduled_run()
        hook.assert_not_called()


if __name__ == "__main__":
    unittest.main()
