"""The KPI report's rules and PDF, without a database.

The rule cases mirror frontend/tests/dashboardStats.test.ts one for one: the PDF has
to say what the dashboard says.

    python -m unittest tests/test_kpi_report.py
"""
import datetime
import unittest
from types import SimpleNamespace as NS

import kpi_report as k


def an(depth=1.2, instrument="georadar", vm="0001-1", project="99-99-0001"):
    return NS(evaluated_depth=depth, instrument=instrument, vm_nr=vm, project_id=project)


def fb(**over):
    base = dict(sohle_status=None, fundstueck=None, tief=None, m_cube=None,
                visit_date=datetime.datetime(2026, 9, 15, 10, 0))
    base.update(over)
    return NS(**base)


class TestRules(unittest.TestCase):
    def test_sohle_missing_status_is_not_a_clearance(self):
        for s in ("Frei", " frei ", "Clear"):
            self.assertTrue(k.is_sohle_clear(s))
        for s in ("Nicht Frei", None, ""):
            self.assertFalse(k.is_sohle_clear(s))

    def test_sohle_compliance(self):
        self.assertIsNone(k.sohle_compliance([]))
        dug = [(an(), fb(sohle_status=s)) for s in ("Frei", "frei", "Nicht Frei", None)]
        self.assertEqual(k.sohle_compliance(dug), 50)

    def test_shallow(self):
        self.assertTrue(k.is_shallow(0.39))
        for d in (0.4, 0, None):
            self.assertFalse(k.is_shallow(d))

    def test_accuracy_is_none_not_zero_without_pairs(self):
        s = k.accuracy_stats([(an(), fb(fundstueck="Eisenteil"))])
        for key in ("mean_error", "bias", "gpr_drift", "mag_error"):
            self.assertIsNone(s[key])
        self.assertEqual(s["fpr"], 0)
        self.assertIsNone(k.accuracy_stats([])["fpr"])

    def test_accuracy_values(self):
        s = k.accuracy_stats([
            (an(0.8, "Georadar"), fb(tief=1.0, fundstueck="ohne Fund")),
            (an(1.2, "Georadar"), fb(tief=1.2, fundstueck="Eisenteil")),
            (an(0.8, "Magnetic"), fb(tief=0.5, fundstueck="Steine")),
            (an(0.6, "Magnetic"), fb(fundstueck="ohne Fund")),
        ])
        self.assertAlmostEqual(s["mean_error"], 0.5 / 3)
        self.assertAlmostEqual(s["bias"], 0.1 / 3)
        self.assertEqual(s["fpr"], 50)
        self.assertAlmostEqual(s["gpr_drift"], (2.2 / 2.0 - 1) * 100)
        self.assertAlmostEqual(s["mag_error"], 0.3)

    def test_volume(self):
        self.assertEqual(k.volume_stats([(an(), fb())]),
                         {"pits": 0, "total": None, "mean_pit": None, "finds_per_m3": None})
        v = k.volume_stats([(an(), fb(m_cube=2, fundstueck="Eisenteil")),
                            (an(), fb(m_cube=2, fundstueck="ohne Fund")),
                            (an(), fb(fundstueck="Eisenteil")),
                            (an(), fb(m_cube=0, fundstueck="Steine"))])
        self.assertEqual((v["total"], v["mean_pit"], v["finds_per_m3"]), (4, 2, 0.25))


class TestCompute(unittest.TestCase):
    def setUp(self):
        self.targets = [
            (an(0.8, vm="1"), fb(sohle_status="Frei", fundstueck="Eisenteil", tief=1.0, m_cube=0.5,
                                 visit_date=datetime.datetime(2026, 9, 10))),
            (an(0.3, "magnetic", vm="2"), fb(fundstueck="ohne Fund", visit_date=datetime.datetime(2026, 9, 20))),
            (an(0.25, vm="3"), None),
            (an(1.2, vm="4"), None),
        ]

    def test_whole_period(self):
        s = k.compute(self.targets)
        self.assertEqual((s["total"], s["investigated"], s["pending"]), (4, 2, 2))
        self.assertEqual(s["sohle_compliance"], 50)
        # The dug shallow target (VM 2) is no longer a hazard.
        self.assertEqual([a.vm_nr for a in s["open_hazards"]], ["3"])
        self.assertEqual(dict(s["findings"])["ohne Fund"], {"count": 1, "frei": 0, "nicht_frei": 1})
        self.assertEqual(set(s["accuracy_by_instrument"]), {"Georadar", "Magnetik"})

    def test_range_narrows_excavation_figures_only(self):
        s = k.compute(self.targets, start=datetime.datetime(2026, 9, 15), end=None)
        self.assertEqual(s["excavated_in_range"], 1)
        self.assertEqual(s["sohle_compliance"], 0)
        self.assertEqual((s["investigated"], len(s["open_hazards"])), (2, 1))

    def test_pdf_builds_with_data_and_empty(self):
        for targets in (self.targets, []):
            pdf = k.build_pdf(k.compute(targets), "99-99-0001", "Test", datetime.datetime(2026, 9, 1), None)
            self.assertTrue(pdf.startswith(b"%PDF"))

    def test_formatting(self):
        self.assertEqual(k._num(None), "k. A.")
        self.assertEqual(k._num(-0.001, signed=True), "0,00")
        self.assertEqual(k._num(0.25, unit="m", signed=True), "+0,25 m")
        self.assertEqual(k._bias_text(-0.2), "zu flach (-0,20 m)")
        self.assertEqual(k._int(2215), "2.215")

    def test_hazards_sort_naturally(self):
        targets = [(an(0.2, vm=v), None) for v in ("2736-1002", "2736-10", "2736-2")]
        self.assertEqual([a.vm_nr for a in k.compute(targets)["open_hazards"]], ["2736-2", "2736-10", "2736-1002"])


if __name__ == "__main__":
    unittest.main()
