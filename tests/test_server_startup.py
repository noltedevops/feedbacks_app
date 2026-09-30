"""Importing server.py must have no side effects on the database; startup does the DDL.

    python -m unittest tests/test_server_startup.py
"""
from __future__ import annotations

import asyncio
import os
import unittest
from unittest import mock

# Never the configured (live) database: nothing here should reach one anyway.
os.environ["DATABASE_URL"] = "sqlite://"


class TestServerStartup(unittest.TestCase):
    def test_import_runs_no_ddl_and_startup_runs_it_once(self):
        with mock.patch("database.init_db") as at_import:
            import server
        self.assertEqual(at_import.call_count, 0, "importing server must not run init_db")

        with mock.patch.object(server, "init_db") as at_start, \
                mock.patch.object(server, "seed_default_users"):
            async def start_and_stop():
                async with server.lifespan(server.app):
                    pass
            asyncio.run(start_and_stop())
        self.assertEqual(at_start.call_count, 1, "startup must run init_db exactly once")


if __name__ == "__main__":
    unittest.main()
