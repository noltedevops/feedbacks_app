"""GET /api/etl/history and /api/etl/status through the HTTP stack: the limit is bounded,
and a database failure is reported without its internals. The approver database is mocked.

    python -m unittest tests/test_etl_read_endpoints.py
"""
from __future__ import annotations

import os
import unittest
from unittest import mock

os.environ["DATABASE_URL"] = "sqlite://"  # never the configured (live) database
from fastapi.testclient import TestClient  # noqa: E402

import security  # noqa: E402
import server  # noqa: E402
from routers import etl as etl_api  # noqa: E402


class _Conn:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, q, params=()):
        self.last = (q, params)
        return mock.Mock(fetchall=mock.Mock(return_value=[]))


class TestEtlReadEndpoints(unittest.TestCase):
    def setUp(self):
        server.app.dependency_overrides[security.require_admin] = lambda: mock.Mock(username="admin")
        self.client = TestClient(server.app)

    def tearDown(self):
        server.app.dependency_overrides.clear()

    def test_history_limit_is_bounded(self):
        conn = _Conn()
        with mock.patch.object(etl_api, "get_etl_approver_conn", return_value=conn):
            self.assertEqual(self.client.get("/api/etl/history?limit=500").status_code, 200)
            self.assertEqual(conn.last[1][-1], 500)
            self.assertEqual(self.client.get("/api/etl/history").status_code, 200)
            self.assertEqual(conn.last[1][-1], 50)
            for bad in ("0", "501", "100000"):
                self.assertEqual(self.client.get(f"/api/etl/history?limit={bad}").status_code, 422, bad)

    def test_database_errors_are_not_echoed(self):
        boom = RuntimeError('connection to server at "10.0.0.5" failed: password authentication failed')
        with mock.patch.object(etl_api, "get_etl_approver_conn", side_effect=boom):
            for path in ("/api/etl/history", "/api/etl/status"):
                r = self.client.get(path)
                self.assertEqual(r.status_code, 500, path)
                self.assertNotIn("10.0.0.5", r.text)
                self.assertNotIn("password", r.text)


if __name__ == "__main__":
    unittest.main()
