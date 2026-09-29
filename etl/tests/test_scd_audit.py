"""Tests for SCD Type 2 Audit History and Web Approver / Runner Endpoints."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone
import database
import models
from sqlalchemy import text


class TestScdAuditHistory(unittest.TestCase):
    def setUp(self):
        self.engine = database.engine
        # Ensure database tables and triggers are up to date
        database.init_db()

    def test_scd_type_2_history_lifecycle(self):
        """Verify that updating an anomaly closes the prior history record and creates a new current version."""
        with self.engine.connect() as conn:
            # 1. Fetch a test anomaly
            anomaly = conn.execute(
                text("SELECT id, easting, northing, evaluated_depth FROM public.anomalies ORDER BY id LIMIT 1")
            ).fetchone()
            self.assertIsNotNone(anomaly, "Database should contain at least one anomaly")
            anomaly_id, orig_e, orig_n, orig_depth = anomaly[0], anomaly[1], anomaly[2], anomaly[3]

            # 2. Check that it currently has exactly 1 current record in anomaly_history
            curr_rec = conn.execute(
                text("SELECT history_id, is_current, valid_to, evaluated_depth, easting FROM public.anomaly_history WHERE anomaly_id = :aid AND is_current = true"),
                {"aid": anomaly_id}
            ).fetchone()
            self.assertIsNotNone(curr_rec, "Anomaly should have an active current history record")
            self.assertIsNone(curr_rec[2], "Current record valid_to must be None")

            old_history_id = curr_rec[0]

            # 3. Perform an update simulating an approver change with session config set
            conn.execute(text("SELECT set_config('etl.change_reason', 'test_scd_change', true)"))
            conn.execute(text("SELECT set_config('etl.current_decision_id', '99999', true)"))
            new_depth = (orig_depth or 0.0) + 0.35
            conn.execute(
                text("UPDATE public.anomalies SET evaluated_depth = :depth WHERE id = :aid"),
                {"depth": new_depth, "aid": anomaly_id}
            )
            conn.commit()

            # 4. Verify SCD Type 2 state
            # Old record should now be closed
            closed_rec = conn.execute(
                text("SELECT is_current, valid_to FROM public.anomaly_history WHERE history_id = :hid"),
                {"hid": old_history_id}
            ).fetchone()
            self.assertFalse(closed_rec[0], "Previous record is_current must be false")
            self.assertIsNotNone(closed_rec[1], "Previous record valid_to must now be set")

            # A new current record should exist
            new_curr_rec = conn.execute(
                text("SELECT history_id, is_current, valid_to, evaluated_depth, change_reason, decision_id FROM public.anomaly_history WHERE anomaly_id = :aid AND is_current = true"),
                {"aid": anomaly_id}
            ).fetchone()
            self.assertIsNotNone(new_curr_rec, "A new current record must exist")
            self.assertEqual(new_curr_rec[3], new_depth, "New record must hold the updated evaluated_depth")
            self.assertEqual(new_curr_rec[4], "test_scd_change", "change_reason should match session setting")
            self.assertEqual(new_curr_rec[5], 99999, "decision_id should match session setting")

            # 5. Clean up / restore original depth
            conn.execute(text("SELECT set_config('etl.change_reason', 'test_cleanup', true)"))
            conn.execute(
                text("UPDATE public.anomalies SET evaluated_depth = :depth WHERE id = :aid"),
                {"depth": orig_depth, "aid": anomaly_id}
            )
            # Remove test history rows created during this test
            conn.execute(
                text("DELETE FROM public.anomaly_history WHERE anomaly_id = :aid AND history_id > :hid"),
                {"aid": anomaly_id, "hid": old_history_id}
            )
            # Reopen original history record
            conn.execute(
                text("UPDATE public.anomaly_history SET is_current = true, valid_to = NULL WHERE history_id = :hid"),
                {"hid": old_history_id}
            )
            conn.commit()


if __name__ == "__main__":
    unittest.main()
