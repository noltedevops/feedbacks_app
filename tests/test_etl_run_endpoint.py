"""POST /api/etl/run: outcomes, the lock, and the command it builds. Docker is mocked.

    python -m unittest tests/test_etl_run_endpoint.py
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import unittest
from unittest import mock

os.environ["DATABASE_URL"] = "sqlite://"  # never the configured (live) database
import server  # noqa: E402
import security  # noqa: E402
from routers import etl as etl_api  # noqa: E402

ADMIN = mock.Mock(username="admin")
PROJECTS = {"11_24_2704": "Giessen Oberhof"}


def _call(req, completed=None, raises=None):
    run = mock.Mock(side_effect=raises) if raises else mock.Mock(return_value=completed)
    with mock.patch.object(etl_api, "_etl_configured_projects", return_value=PROJECTS), \
            mock.patch.object(etl_api.subprocess, "run", run):
        result = asyncio.run(etl_api.trigger_etl_run(req, ADMIN))
    return result, run


def _done(stdout="", rc=0):
    return subprocess.CompletedProcess(args=[], returncode=rc, stdout=stdout, stderr="")


class TestEtlRunEndpoint(unittest.TestCase):
    def test_default_is_not_forced_and_uses_explicit_compose_file(self):
        _, run = _call(etl_api.EtlRunRequest(), _done("run 5 ok."))
        cmd = run.call_args.args[0]
        self.assertNotIn("--force", cmd)
        self.assertIn("--no-deps", cmd)
        self.assertEqual(cmd[cmd.index("-f") + 1], etl_api._COMPOSE_FILE)
        self.assertEqual(run.call_args.kwargs["cwd"], etl_api._REPO_DIR)

    def test_scoped_forced_run_passes_both_flags(self):
        _, run = _call(etl_api.EtlRunRequest(project_id="11_24_2704", force=True), _done("run 5 ok."))
        cmd = run.call_args.args[0]
        self.assertEqual(cmd[-3:], ["--force", "--project", "11_24_2704"])

    def test_outcomes(self):
        r, _ = _call(etl_api.EtlRunRequest(), _done("run 5 ok."))
        self.assertEqual((r["success"], r["outcome"]), (True, "ok"))
        r, _ = _call(etl_api.EtlRunRequest(), _done("  no change since the last successful run: skipped"))
        self.assertEqual((r["success"], r["outcome"]), (True, "skipped"))
        r, _ = _call(etl_api.EtlRunRequest(), _done("RUN 5 FAILED", rc=1))
        self.assertEqual((r["success"], r["outcome"]), (False, "failed"))

    def test_lock_held_is_409(self):
        with self.assertRaises(etl_api.HTTPException) as ctx:
            _call(etl_api.EtlRunRequest(), _done("another run holds the lock; nothing done"))
        self.assertEqual(ctx.exception.status_code, 409)

    def test_unknown_project_is_400_and_starts_nothing(self):
        with mock.patch.object(etl_api, "_etl_configured_projects", return_value=PROJECTS), \
                mock.patch.object(etl_api.subprocess, "run") as run:
            with self.assertRaises(etl_api.HTTPException) as ctx:
                asyncio.run(etl_api.trigger_etl_run(etl_api.EtlRunRequest(project_id="nope"), ADMIN))
        self.assertEqual(ctx.exception.status_code, 400)
        run.assert_not_called()

    def test_timeout_is_504_and_says_it_may_still_run(self):
        with self.assertRaises(etl_api.HTTPException) as ctx:
            _call(etl_api.EtlRunRequest(), raises=subprocess.TimeoutExpired(cmd="docker", timeout=180))
        self.assertEqual(ctx.exception.status_code, 504)
        self.assertIn("may still be running", ctx.exception.detail)

    def test_route_requires_admin(self):
        route = next(r for r in server.app.routes if getattr(r, "path", None) == "/api/etl/run")
        self.assertIn(security.require_admin, {d.call for d in route.dependant.dependencies})


if __name__ == "__main__":
    unittest.main()
