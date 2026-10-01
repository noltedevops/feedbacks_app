"""Tests for the SCD Type 2 audit history on public.anomalies.

These run against a real PostgreSQL database and change rows in it, so they refuse to
run unless DATABASE_URL names a database ending in "_test" - never the live one. Each
test works inside one transaction that is rolled back, so even the test database is
left as it was.

    DATABASE_URL=postgresql://postgres:...@127.0.0.1:5432/nolte_phase1_test \
        python -m unittest etl/tests/test_scd_audit.py
"""
from __future__ import annotations

import unittest

from sqlalchemy import text

import database


def _require_test_database() -> None:
    url = database.engine.url
    if url.get_backend_name() != "postgresql":
        raise unittest.SkipTest(f"needs PostgreSQL; DATABASE_URL resolved to {url.get_backend_name()}")
    if not (url.database or "").endswith("_test"):
        raise unittest.SkipTest(
            f"refusing to run against database {url.database!r}: "
            "point DATABASE_URL at a copy whose name ends in '_test'")


class TestScdAuditHistory(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _require_test_database()
        database.init_db()  # the trigger and table must exist; guarded above
        cls.engine = database.engine

    def setUp(self):
        self.conn = self.engine.connect()
        self.trans = self.conn.begin()

    def tearDown(self):
        self.trans.rollback()
        self.conn.close()

    def _any_anomaly(self):
        row = self.conn.execute(text(
            "SELECT id, evaluated_depth FROM public.anomalies ORDER BY id LIMIT 1")).fetchone()
        if row is None:
            # An empty database (CI builds one from the migrations): make a target inside
            # this test's transaction, which is rolled back with everything else.
            self.conn.execute(text(
                "INSERT INTO public.projects (project_id, project_name) VALUES ('ci-0001', 'CI')"))
            self.conn.execute(text(
                "INSERT INTO public.anomalies (id, project_id, instrument, easting, northing, "
                "target_id, vm_nr, evaluated_depth) VALUES ('ci-anomaly-1', 'ci-0001', 'georadar', "
                "440000.0, 5935000.0, 'ci-0001-440000.000-5935000.000', 'ci-1', 1.0)"))
            row = self.conn.execute(text(
                "SELECT id, evaluated_depth FROM public.anomalies ORDER BY id LIMIT 1")).fetchone()
        return row

    def test_scd_type_2_history_lifecycle(self):
        """Updating an anomaly closes the prior history record and creates a new current version."""
        anomaly_id, orig_depth = self._any_anomaly()

        curr = self.conn.execute(text(
            "SELECT history_id, valid_to FROM public.anomaly_history "
            "WHERE anomaly_id = :aid AND is_current"), {"aid": anomaly_id}).fetchone()
        self.assertIsNotNone(curr, "anomaly should have a current history record")
        self.assertIsNone(curr[1], "current record valid_to must be NULL")
        old_history_id = curr[0]

        self.conn.execute(text("SELECT set_config('etl.change_reason', 'test_scd_change', true)"))
        self.conn.execute(text("SELECT set_config('etl.current_decision_id', '99999', true)"))
        new_depth = (orig_depth or 0.0) + 0.35
        self.conn.execute(text("UPDATE public.anomalies SET evaluated_depth = :d WHERE id = :aid"),
                          {"d": new_depth, "aid": anomaly_id})

        closed = self.conn.execute(text(
            "SELECT is_current, valid_to FROM public.anomaly_history WHERE history_id = :hid"),
            {"hid": old_history_id}).fetchone()
        self.assertFalse(closed[0], "previous record must no longer be current")
        self.assertIsNotNone(closed[1], "previous record valid_to must be set")

        new = self.conn.execute(text(
            "SELECT evaluated_depth, change_reason, decision_id FROM public.anomaly_history "
            "WHERE anomaly_id = :aid AND is_current"), {"aid": anomaly_id}).fetchone()
        self.assertIsNotNone(new, "a new current record must exist")
        self.assertEqual(new[0], new_depth)
        self.assertEqual(new[1], "test_scd_change")
        self.assertEqual(new[2], 99999)

    def test_unrelated_update_writes_no_history(self):
        """An update that changes no tracked value adds no version."""
        anomaly_id, _ = self._any_anomaly()
        before = self.conn.execute(text(
            "SELECT count(*) FROM public.anomaly_history WHERE anomaly_id = :aid"), {"aid": anomaly_id}).scalar()
        self.conn.execute(text("UPDATE public.anomalies SET evaluated_depth = evaluated_depth WHERE id = :aid"),
                          {"aid": anomaly_id})
        after = self.conn.execute(text(
            "SELECT count(*) FROM public.anomaly_history WHERE anomaly_id = :aid"), {"aid": anomaly_id}).scalar()
        self.assertEqual(before, after)

    def _assert_refused(self, sql: str, params: dict | None = None) -> None:
        nested = self.conn.begin_nested()
        with self.assertRaises(Exception) as ctx:
            self.conn.execute(text(sql), params or {})
        nested.rollback()
        self.assertIn("append-only", str(ctx.exception))

    def test_history_rows_cannot_be_deleted(self):
        self._any_anomaly()  # at least one history row to refuse to touch
        self._assert_refused("DELETE FROM public.anomaly_history WHERE history_id = "
                             "(SELECT min(history_id) FROM public.anomaly_history)")

    def test_history_rows_cannot_be_truncated(self):
        self._assert_refused("TRUNCATE public.anomaly_history")

    def test_history_values_cannot_be_edited(self):
        self._any_anomaly()  # at least one history row to refuse to touch
        self._assert_refused("UPDATE public.anomaly_history SET easting = easting + 1 WHERE history_id = "
                             "(SELECT min(history_id) FROM public.anomaly_history)")

    def test_closed_version_cannot_be_reopened(self):
        anomaly_id, orig_depth = self._any_anomaly()
        self.conn.execute(text("UPDATE public.anomalies SET evaluated_depth = :d WHERE id = :aid"),
                          {"d": (orig_depth or 0.0) + 1, "aid": anomaly_id})
        self._assert_refused("UPDATE public.anomaly_history SET is_current = true, valid_to = NULL "
                             "WHERE anomaly_id = :aid AND NOT is_current", {"aid": anomaly_id})

    def test_history_outlives_a_deleted_anomaly(self):
        anomaly_id, _ = self._any_anomaly()
        before = self.conn.execute(text(
            "SELECT count(*) FROM public.anomaly_history WHERE anomaly_id = :aid"), {"aid": anomaly_id}).scalar()
        self.assertGreater(before, 0)
        self.conn.execute(text("DELETE FROM public.anomalies WHERE id = :aid"), {"aid": anomaly_id})
        after = self.conn.execute(text(
            "SELECT count(*) FROM public.anomaly_history WHERE anomaly_id = :aid"), {"aid": anomaly_id}).scalar()
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
