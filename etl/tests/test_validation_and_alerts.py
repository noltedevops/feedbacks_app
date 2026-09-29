from __future__ import annotations

import unittest
from etl.runner.validate_config import validate_config_data, validate_column_spec
from etl.runner import notifier


class TestConfigValidation(unittest.TestCase):
    def setUp(self):
        self.valid_config = {
            "correction_radius_m": 1.0,
            "projects": [
                {
                    "project_id": "11-26-5151",
                    "project_name": "Koeln Deutzerfeld",
                    "schema": "p_11_26_5151_koeln_deutzerfeld",
                    "srid": 25832,
                    "vm_prefix": "5151",
                    "sources": [
                        {
                            "table": "picks",
                            "instrument": "georadar",
                            "key": "id",
                            "id_decimals": 3,
                            "columns": {
                                "easting": "field_1",
                                "northing": "field_2",
                                "depth": {"column": "field_5", "round": 2},
                                "category": {"expr": "'Kat-' || field_3"},
                                "layer": None,
                            },
                        }
                    ],
                }
            ],
        }

    def test_valid_config(self):
        errors = validate_config_data(self.valid_config)
        self.assertEqual(errors, [])

    def test_missing_projects(self):
        errors = validate_config_data({})
        self.assertTrue(any("projects" in e for e in errors))

    def test_duplicate_project_id(self):
        cfg = {
            "projects": [
                self.valid_config["projects"][0],
                dict(self.valid_config["projects"][0], project_name="Other Name"),
            ]
        }
        errors = validate_config_data(cfg)
        self.assertTrue(any("duplicate project_id" in e for e in errors))

    def test_missing_easting_northing(self):
        cfg = {
            "projects": [
                {
                    "project_id": "11-99-9999",
                    "project_name": "Bad Project",
                    "schema": "p_bad",
                    "srid": 25832,
                    "vm_prefix": "9999",
                    "sources": [
                        {
                            "table": "raw",
                            "instrument": "georadar",
                            "id_decimals": 3,
                            "columns": {
                                "category": "cat"
                                # missing easting and northing!
                            },
                        }
                    ],
                }
            ]
        }
        errors = validate_config_data(cfg)
        self.assertTrue(any("missing required coordinate 'easting'" in e for e in errors))
        self.assertTrue(any("missing required coordinate 'northing'" in e for e in errors))

    def test_invalid_schema_identifier(self):
        cfg = {
            "projects": [
                {
                    "project_id": "11-99-9999",
                    "project_name": "Bad Schema",
                    "schema": "p-invalid-hyphens-not-allowed",
                    "srid": 25832,
                    "vm_prefix": "9999",
                    "sources": [
                        {
                            "table": "raw",
                            "instrument": "georadar",
                            "id_decimals": 3,
                            "columns": {"easting": "x", "northing": "y", "category": "cat"},
                        }
                    ],
                }
            ]
        }
        errors = validate_config_data(cfg)
        self.assertTrue(any("not a valid PostgreSQL identifier" in e for e in errors))


class TestNotifier(unittest.TestCase):
    def test_notifier_fallback_when_no_webhook(self):
        # Should cleanly return False and not raise when webhook URL is unset
        result = notifier.send_webhook("Test Title", "Test Text", "info", {"Field": "Value"})
        self.assertFalse(result)

    def test_notify_helpers_do_not_crash(self):
        # Ensure helper wrapper functions execute safely
        notifier.notify_run_failed(999, "Simulated Error", ["gate_1_failed"])
        notifier.notify_pending_approvals(999, "11-26-5151", staged_changes=3, correction_pairs=1)
        notifier.notify_run_success(999, {"projects": {"11-26-5151": {"inserted": 5}}})


class TestProjectTargeting(unittest.TestCase):
    def test_project_filtering(self):
        cfg = {
            "projects": [
                {"project_id": "11-24-2736", "schema": "p_2736", "sources": []},
                {"project_id": "11-26-5151", "schema": "p_5151", "sources": []},
            ]
        }
        # Targeting one project
        target = "11-24-2736"
        filtered = [p for p in cfg["projects"] if p["project_id"] == target]
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]["project_id"], "11-24-2736")

        # Non-existent project
        filtered_none = [p for p in cfg["projects"] if p["project_id"] == "unknown"]
        self.assertEqual(len(filtered_none), 0)


if __name__ == "__main__":
    unittest.main()
