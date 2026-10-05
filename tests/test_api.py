"""HTTP-level tests of the app's API, against a real, disposable PostgreSQL database.

They pin what each endpoint does today - status codes, who may call it, the shape of
what it returns - so a restructuring of server.py can be checked against them.

The database is wiped and rebuilt from nothing (init_db) at the start, so these refuse
to run unless DATABASE_URL names a database ending in "_test":

    DATABASE_URL=postgresql://postgres:...@127.0.0.1:5432/nolte_api_test \\
        python -m unittest tests/test_api.py
"""
from __future__ import annotations

import base64
import unittest
import uuid

from sqlalchemy import text

import database
import models
import security


def setUpModule():
    url = database.engine.url
    if url.get_backend_name() != "postgresql" or not (url.database or "").endswith("_test"):
        raise unittest.SkipTest(
            f"refusing to run against {url.database!r}: point DATABASE_URL at a PostgreSQL "
            "database whose name ends in '_test' (it is wiped)")
    with database.engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    database.init_db()

    global server, client
    from fastapi.testclient import TestClient
    import server as server_module
    server = server_module
    client = TestClient(server.app)  # no `with`: the lifespan (init_db, seeding) is not run
    _seed()


PASSWORD = "correct-horse-1"
PROJECT = "99-99-0001"


def _seed():
    db = database.SessionLocal()
    try:
        def user(name, **flags):
            db.add(models.User(id=f"usr-{name}", full_name=name.title(), username=name,
                               password_hash=security.hash_password(PASSWORD), **flags))
        user("admin", can_field=True, can_dashboard=True, is_admin=True)
        user("collector", can_field=True, can_dashboard=False)
        user("analyst", can_field=False, can_dashboard=True)
        user("nobody", can_field=False, can_dashboard=False)
        user("temp", can_field=True, can_dashboard=True, must_change_password=True)
        db.add(models.Project(project_id=PROJECT, project_name="Test Project"))
        db.flush()
        for i in range(3):
            e, n = 440000.0 + i, 5935000.0 + i
            tid = f"{PROJECT}-{e:.3f}-{n:.3f}"
            db.add(models.Anomaly(id=str(uuid.uuid5(uuid.NAMESPACE_DNS, tid)), project_id=PROJECT,
                                  instrument="georadar", easting=e, northing=n, latitude=53.5, longitude=8.1,
                                  vm_nr=f"0001-{i + 1}", category="Kat-2", target_id=tid, status="pending"))
        db.commit()
    finally:
        db.close()


def _token(username):
    r = client.post("/api/auth/login", json={"username": username, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _auth(username):
    return {"Authorization": f"Bearer {_token(username)}"}


def _anomaly_ids():
    db = database.SessionLocal()
    try:
        return [a.id for a in db.query(models.Anomaly).order_by(models.Anomaly.vm_nr)]
    finally:
        db.close()


class TestAuth(unittest.TestCase):
    def test_login_returns_payload_and_token(self):
        r = client.post("/api/auth/login", json={"username": "collector", "password": PASSWORD})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual((body["username"], body["can_field"], body["can_dashboard"], body["is_admin"]),
                         ("collector", True, False, False))
        self.assertIn("token", body)

    def test_wrong_password_is_401(self):
        r = client.post("/api/auth/login", json={"username": "collector", "password": "nope"})
        self.assertEqual(r.status_code, 401)

    def test_me_needs_a_valid_token(self):
        self.assertEqual(client.get("/api/auth/me").status_code, 401)
        self.assertEqual(client.get("/api/auth/me", headers={"Authorization": "Bearer x.1.y"}).status_code, 401)
        r = client.get("/api/auth/me", headers=_auth("analyst"))
        self.assertEqual((r.status_code, r.json()["username"]), (200, "analyst"))
        self.assertNotIn("token", r.json())

    def test_register_validates_and_starts_field_only(self):
        self.assertEqual(client.post("/api/auth/register", json={
            "full_name": "X", "username": "short", "password": "1234567"}).status_code, 400)
        self.assertEqual(client.post("/api/auth/register", json={
            "full_name": "X", "username": "spaces", "password": "        "}).status_code, 400)
        self.assertEqual(client.post("/api/auth/register", json={
            "full_name": "X", "username": "collector", "password": PASSWORD}).status_code, 400)
        r = client.post("/api/auth/register", json={
            "full_name": "New Person", "username": "newbie", "password": PASSWORD})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["can_field"], r.json()["can_dashboard"]), (True, False))

    def test_temporary_password_blocks_surfaces_until_changed(self):
        headers = _auth("temp")
        r = client.get("/api/stats", headers=headers)
        self.assertEqual(r.status_code, 403)
        self.assertTrue(r.json()["detail"]["must_change_password"])
        self.assertEqual(client.post("/api/auth/change-password", headers=headers, json={
            "current_password": "wrong", "new_password": "another-pass-9"}).status_code, 401)
        self.assertEqual(client.post("/api/auth/change-password", headers=headers, json={
            "current_password": PASSWORD, "new_password": PASSWORD}).status_code, 400)
        r = client.post("/api/auth/change-password", headers=headers, json={
            "current_password": PASSWORD, "new_password": "another-pass-9"})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["must_change_password"])
        new_headers = {"Authorization": f"Bearer {r.json()['token']}"}
        self.assertEqual(client.get("/api/stats", headers=new_headers).status_code, 200)


class TestSurfacesAndAdmin(unittest.TestCase):
    def test_surface_gates(self):
        # sync: field only; stats + PDF: dashboard only; CSV: either; points/projects: any login
        no_field = client.post("/api/sync", headers=_auth("analyst"), json={"feedback": []})
        self.assertEqual(no_field.status_code, 403)
        self.assertEqual(no_field.json()["detail"]["surface"], "field")
        self.assertEqual(client.get("/api/stats", headers=_auth("collector")).status_code, 403)
        self.assertEqual(client.get("/api/reports/feedback.pdf", headers=_auth("collector")).status_code, 403)
        self.assertEqual(client.get("/api/reports/kennzahlen.pdf", headers=_auth("collector")).status_code, 403)
        self.assertEqual(client.get("/api/reports/feedback.csv", headers=_auth("collector")).status_code, 200)
        self.assertEqual(client.get("/api/reports/feedback.csv", headers=_auth("analyst")).status_code, 200)
        csv_denied = client.get("/api/reports/feedback.csv", headers=_auth("nobody"))
        self.assertEqual((csv_denied.status_code, csv_denied.json()["detail"]["surface"]), (403, "field"))
        self.assertEqual(client.get("/api/points", headers=_auth("nobody")).status_code, 200)
        self.assertEqual(client.get("/api/projects", headers=_auth("nobody")).status_code, 200)
        self.assertEqual(client.get("/api/points").status_code, 401)

    def test_admin_only_routes(self):
        for method, path in [("get", "/api/admin/users"), ("get", "/api/permissions/requests"),
                             ("patch", "/api/admin/users/usr-nobody/access"),
                             ("post", "/api/admin/users/usr-nobody/reset-password"),
                             ("get", "/api/etl/status"), ("get", "/api/etl/health/details"),
                             ("get", "/api/etl/history"), ("post", "/api/etl/run"),
                             ("post", "/api/etl/approvals/change"), ("post", "/api/etl/approvals/correction")]:
            kwargs = {"json": {}} if method in ("post", "patch") else {}
            self.assertEqual(getattr(client, method)(path, **kwargs).status_code, 401, path)
            r = getattr(client, method)(path, headers=_auth("analyst"), **kwargs)
            self.assertEqual(r.status_code, 403, path)

    def test_admin_user_list_and_access(self):
        users = client.get("/api/admin/users", headers=_auth("admin")).json()
        self.assertIn("nobody", [u["username"] for u in users])
        r = client.patch("/api/admin/users/usr-nobody/access", headers=_auth("admin"), json={"can_dashboard": True})
        self.assertEqual((r.status_code, r.json()["can_dashboard"]), (200, True))
        client.patch("/api/admin/users/usr-nobody/access", headers=_auth("admin"), json={"can_dashboard": False})
        self.assertEqual(client.patch("/api/admin/users/usr-missing/access", headers=_auth("admin"),
                                      json={}).status_code, 404)

    def test_last_admin_cannot_be_removed(self):
        r = client.patch("/api/admin/users/usr-admin/access", headers=_auth("admin"), json={"is_admin": False})
        self.assertEqual(r.status_code, 409)

    def test_reset_password_issues_a_one_time_temporary(self):
        db = database.SessionLocal()
        db.add(models.User(id="usr-resetme", full_name="R", username="resetme",
                           password_hash=security.hash_password(PASSWORD), can_field=True))
        db.commit(); db.close()
        r = client.post("/api/admin/users/usr-resetme/reset-password", headers=_auth("admin"))
        self.assertEqual(r.status_code, 200)
        temp = r.json()["temporary_password"]
        login = client.post("/api/auth/login", json={"username": "resetme", "password": temp})
        self.assertTrue(login.json()["must_change_password"])


class TestPermissionRequests(unittest.TestCase):
    def test_request_decide_flow(self):
        db = database.SessionLocal()
        db.add(models.User(id="usr-asker", full_name="A", username="asker",
                           password_hash=security.hash_password(PASSWORD), can_field=True, can_dashboard=False))
        db.commit(); db.close()
        asker = _auth("asker")
        self.assertEqual(client.post("/api/permissions/request", headers=asker,
                                     json={"surface": "moon"}).status_code, 400)
        self.assertEqual(client.post("/api/permissions/request", headers=asker,
                                     json={"surface": "field"}).json()["status"], "already_granted")
        first = client.post("/api/permissions/request", headers=asker, json={"surface": "dashboard"}).json()
        again = client.post("/api/permissions/request", headers=asker, json={"surface": "dashboard"}).json()
        self.assertEqual((first["status"], again["request_id"]), ("pending", first["request_id"]))

        pending = client.get("/api/permissions/requests", headers=_auth("admin")).json()
        self.assertIn(first["request_id"], [p["id"] for p in pending])
        rid = first["request_id"]
        self.assertEqual(client.post(f"/api/permissions/requests/{rid}/decide", headers=_auth("admin"),
                                     json={"approve": True}).json()["status"], "approved")
        self.assertEqual(client.post(f"/api/permissions/requests/{rid}/decide", headers=_auth("admin"),
                                     json={"approve": True}).status_code, 409)
        self.assertTrue(client.get("/api/auth/me", headers=asker).json()["can_dashboard"])


class TestPointsSyncReports(unittest.TestCase):
    def test_points_and_projects(self):
        points = client.get("/api/points", headers=_auth("collector")).json()
        self.assertEqual(len(points), 3)
        p = points[0]
        for key in ("id", "project_id", "target_id", "vm_nr", "easting", "northing", "latitude", "longitude",
                    "category", "instrument", "feedback"):
            self.assertIn(key, p)
        projects = client.get("/api/projects", headers=_auth("collector")).json()
        self.assertEqual(projects, [{"project_id": PROJECT, "project_name": "Test Project"}])

    def test_sync_feedback_and_point_move(self):
        a1, a2, _ = _anomaly_ids()
        photo = "data:image/png;base64," + base64.b64encode(b"png").decode()
        fid = str(uuid.uuid4())
        body = {"feedback": [{
            "id": fid, "point_id": a1, "visited": True, "status": "clear", "actual_depth": 0.8,
            "photos": [photo], "notes": "nothing", "fundstueck": "ohne Fund",
            "logged_at": "2026-09-30T10:00:00Z", "teams_tools": {"messgeraet": "EM61"}},
            {"id": str(uuid.uuid4()), "point_id": "no-such-target", "visited": True, "status": "clear"}],
            "point_updates": [{"id": a2, "easting": 440009.5, "northing": 5935009.5,
                               "latitude": 53.6, "longitude": 8.2}]}
        r = client.post("/api/sync", headers=_auth("collector"), json=body)
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual((out["synced_feedback"], out["synced_points"]), (1, 1))  # unknown target skipped
        by_id = {p["id"]: p for p in out["points"]}
        self.assertEqual(by_id[a1]["feedback"]["status"], "false_alarm")
        self.assertEqual(by_id[a1]["feedback"]["photos"], [photo])
        self.assertEqual(by_id[a2]["easting"], 440009.5)

        # re-sending the same id is idempotent; an older copy never overwrites a newer one
        again = client.post("/api/sync", headers=_auth("collector"), json={"feedback": [{
            "id": fid, "point_id": a1, "visited": True, "status": "clear", "notes": "stale",
            "logged_at": "2026-09-01T10:00:00Z"}]})
        self.assertEqual(again.status_code, 200)
        self.assertEqual({p["id"]: p for p in again.json()["points"]}[a1]["feedback"]["notes"], "nothing")

        # the move is in the audit history as a field_sync version
        with database.engine.connect() as conn:
            reasons = [r[0] for r in conn.execute(text(
                "select change_reason from anomaly_history where anomaly_id = :a order by history_id"), {"a": a2})]
        self.assertEqual(reasons[-1], "field_sync")

        # the photo gallery page for that record is public (it is linked from the PDF)
        g = client.get(f"/api/reports/bilder/{fid}")
        self.assertEqual(g.status_code, 200)
        self.assertIn("no-store", g.headers["cache-control"])
        self.assertEqual(client.get("/api/reports/bilder/unknown").status_code, 404)

    def test_points_query_count_does_not_grow_with_targets(self):
        """GET /api/points once asked the database once per target (2,659 queries for
        2,658 targets). It must stay a fixed handful however many targets there are."""
        from sqlalchemy import event

        def count_queries():
            seen = []
            listener = lambda *a, **k: seen.append(1)  # noqa: E731
            event.listen(database.engine, "before_cursor_execute", listener)
            try:
                self.assertEqual(client.get("/api/points", headers=headers).status_code, 200)
            finally:
                event.remove(database.engine, "before_cursor_execute", listener)
            return len(seen)

        headers = _auth("collector")
        before = count_queries()
        extra = [str(uuid.uuid4()) for _ in range(10)]
        db = database.SessionLocal()
        try:
            for i, aid in enumerate(extra):
                db.add(models.Anomaly(id=aid, project_id=PROJECT, instrument="georadar",
                                      easting=441000.0 + i, northing=5936000.0, target_id=f"extra-{aid}"))
            db.commit()
            self.assertEqual(count_queries(), before)
            self.assertLessEqual(before, 4)
        finally:
            db.query(models.Anomaly).filter(models.Anomaly.id.in_(extra)).delete(synchronize_session=False)
            db.commit()
            db.close()

    def test_points_show_the_newest_of_several_feedback_records(self):
        _, _, a3 = _anomaly_ids()
        older, newer = str(uuid.uuid4()), str(uuid.uuid4())
        for fid, when, note in ((newer, "2026-09-20T08:00:00Z", "second visit"),
                                (older, "2026-09-10T08:00:00Z", "first visit")):  # older arrives last
            r = client.post("/api/sync", headers=_auth("collector"), json={"feedback": [{
                "id": fid, "point_id": a3, "visited": True, "status": "clear", "notes": note,
                "logged_at": when}]})
            self.assertEqual(r.status_code, 200)
        point = {p["id"]: p for p in client.get("/api/points", headers=_auth("collector")).json()}[a3]
        self.assertEqual((point["feedback"]["id"], point["feedback"]["notes"]), (newer, "second visit"))

    def test_stats_and_reports(self):
        stats = client.get("/api/stats", headers=_auth("analyst")).json()
        self.assertEqual(set(stats), {"total_points", "visited_points", "unvisited_points",
                                      "progress_percentage", "status_distribution"})
        self.assertEqual(stats["total_points"], 3)

        csv = client.get("/api/reports/feedback.csv", headers=_auth("analyst"), params={"project_id": PROJECT})
        self.assertEqual(csv.status_code, 200)
        self.assertTrue(csv.content.startswith("﻿".encode("utf-8")))
        self.assertIn(f'filename="feedback-{PROJECT}.csv"', csv.headers["content-disposition"])
        self.assertIn("bez_suchfeld", csv.text.splitlines()[1])

        # The field app's export leaves out target_id and bez_suchfeld; nothing else moves.
        trimmed = client.get("/api/reports/feedback.csv", headers=_auth("collector"),
                             params={"project_id": PROJECT, "exclude": ["target_id", "bez_suchfeld"]})
        self.assertEqual(trimmed.status_code, 200)
        header = trimmed.text.splitlines()[1].split(";")
        self.assertNotIn("target_id", header)
        self.assertNotIn("bez_suchfeld", header)
        self.assertEqual(len(header), len(csv.text.splitlines()[1].split(";")) - 2)
        self.assertTrue(all(len(line.split(";")) == len(header) for line in trimmed.text.splitlines()[2:]))
        self.assertEqual(client.get("/api/reports/feedback.csv", headers=_auth("analyst"),
                                    params={"exclude": "no_such_column"}).status_code, 400)

        pdf = client.get("/api/reports/feedback.pdf", headers=_auth("analyst"),
                         params={"start": "2026-01-01", "end": "2026-12-31"})
        self.assertEqual(pdf.status_code, 200)
        self.assertTrue(pdf.content.startswith(b"%PDF"))
        self.assertEqual(client.get("/api/reports/feedback.pdf", headers=_auth("analyst"),
                                    params={"start": "not-a-date"}).status_code, 400)

        kpi = client.get("/api/reports/kennzahlen.pdf", headers=_auth("analyst"),
                         params={"project_id": PROJECT, "start": "2026-01-01"})
        self.assertEqual(kpi.status_code, 200)
        self.assertTrue(kpi.content.startswith(b"%PDF"))
        self.assertIn(f'filename="kennzahlen-{PROJECT}-2026-01-01.pdf"', kpi.headers["content-disposition"])
        self.assertEqual(client.get("/api/reports/kennzahlen.pdf", headers=_auth("analyst"),
                                    params={"end": "31.12.2026"}).status_code, 400)


class TestPublicSurface(unittest.TestCase):
    def test_public_health_probe_shape(self):
        r = client.get("/api/etl/health")
        self.assertIn(r.status_code, (200, 503))
        self.assertEqual(set(r.json()), {"status"})

    def test_frontend_is_served(self):
        r = client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("<html", r.text.lower())


if __name__ == "__main__":
    unittest.main()
