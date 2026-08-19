#!/usr/bin/env python
"""Diagnose the database and pgAdmin setup.

Codifies the checks that were previously done by hand, one shell command at a
time, the last time nobody could log in. That session turned up three separate
things - a stale POSTGRES_PASSWORD, a pgAdmin password that had never been
applied, and pg_hba still on trust - none of which announced themselves. This
script asks all of those questions at once.

    python scripts/doctor.py

It is read-only. It connects, reads and reports; it changes nothing. Exit status
is 1 if any check FAILs, so it can gate a deploy or run in CI.

No password is ever printed. Where one has to be identified it is named by where
it came from ("DATABASE_URL"), never by its value. pgAdmin is inspected only by
reading its database - never by attempting a login, which would count against the
lockout threshold and could lock the very account being diagnosed.
"""
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = REPO_ROOT / ".env"

# These match container_name in docker-compose.yml.
DB_CONTAINER = "feedback_postgres_db"
PGADMIN_CONTAINER = "nolte-pgadmin"
PGADMIN_DB = "/var/lib/pgadmin/pgadmin4.db"
PG_HBA = "/var/lib/postgresql/data/pg_hba.conf"

OK, WARN, FAIL, SKIP = "OK", "WARN", "FAIL", "SKIP"
_results = []


def report(status, label, detail=""):
    _results.append(status)
    print(f"[{status:^4}] {label}" + (f"\n         {detail}" if detail else ""))


def load_env():
    """.env as a dict, with real environment variables taking precedence.

    Mirrors how pydantic-settings resolves the two, so this reports on the values
    the app would actually use rather than only on what is written to disk.
    """
    values = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip()
    for key in ("DATABASE_URL", "POSTGRES_PASSWORD", "POSTGRES_USER", "POSTGRES_DB"):
        if os.getenv(key) is not None:
            values[key] = os.environ[key]
    return values


def docker(*args, timeout=20):
    """Run a docker command, returning (ok, output). Never raises."""
    try:
        proc = subprocess.run(
            ("docker",) + args, capture_output=True, text=True, timeout=timeout
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return False, str(exc)
    return proc.returncode == 0, (proc.stdout or proc.stderr).strip()


def container_running(name):
    ok, out = docker("ps", "--filter", f"name=^{name}$", "--format", "{{.Names}}")
    return ok and out.strip() == name


# --- checks ------------------------------------------------------------------

def check_env_consistency(env):
    """POSTGRES_PASSWORD and DATABASE_URL must agree - see config.py."""
    url = env.get("DATABASE_URL")
    if not url:
        report(FAIL, "DATABASE_URL is set", "It is not; the app cannot start.")
        return
    compose_password = env.get("POSTGRES_PASSWORD")
    if not compose_password:
        report(SKIP, "POSTGRES_PASSWORD matches DATABASE_URL", "POSTGRES_PASSWORD not set.")
        return
    url_password = urlparse(url).password
    if url_password is None:
        report(SKIP, "POSTGRES_PASSWORD matches DATABASE_URL", "URL carries no password.")
    elif unquote(url_password) == compose_password:
        report(OK, "POSTGRES_PASSWORD matches the password in DATABASE_URL")
    else:
        report(
            WARN,
            "POSTGRES_PASSWORD does NOT match the password in DATABASE_URL",
            "Inert while the current volume exists. A recreated postgres_data volume "
            "would initialise with POSTGRES_PASSWORD, and the app could not connect.",
        )


def check_postgres_credentials(env):
    """Report which known credential Postgres accepts, identified by name only."""
    try:
        import psycopg
    except ImportError:
        report(SKIP, "Postgres accepts the app's credentials", "psycopg is not installed.")
        return None

    url = urlparse(env.get("DATABASE_URL", ""))
    if url.scheme and not url.scheme.startswith("postgres"):
        report(SKIP, "Postgres accepts the app's credentials", f"DATABASE_URL is {url.scheme}.")
        return None

    candidates = [("DATABASE_URL", unquote(url.password) if url.password else None)]
    if env.get("POSTGRES_PASSWORD"):
        candidates.append(("POSTGRES_PASSWORD", env["POSTGRES_PASSWORD"]))

    accepted, reachable = [], False
    for label, password in candidates:
        if password is None:
            continue
        try:
            psycopg.connect(
                host=url.hostname or "localhost",
                port=url.port or 5432,
                user=url.username or env.get("POSTGRES_USER", "postgres"),
                password=password,
                dbname=(url.path or "/").lstrip("/") or env.get("POSTGRES_DB", "postgres"),
                connect_timeout=5,
            ).close()
            reachable = True
            accepted.append(label)
        except Exception as exc:
            # A rejected password still proves something answered on the port.
            if "password authentication failed" in str(exc):
                reachable = True

    if not reachable:
        report(
            FAIL,
            "Postgres is reachable",
            f"Nothing answered at {url.hostname or 'localhost'}:{url.port or 5432}. "
            "Is the db container running?",
        )
    elif "DATABASE_URL" in accepted:
        report(OK, "Postgres accepts the credentials in DATABASE_URL")
    else:
        report(
            FAIL,
            "Postgres REJECTS the credentials in DATABASE_URL",
            "The app cannot connect. Accepted instead: "
            + (", ".join(accepted) if accepted else "none of the known passwords"),
        )
    return reachable and "DATABASE_URL" in accepted


def check_startup_target(postgres_ok):
    """What the app would bind to on startup: Postgres, or the SQLite fallback."""
    if postgres_ok is None:
        report(SKIP, "App startup target", "Could not be determined.")
    elif postgres_ok:
        report(OK, "App would start against PostgreSQL")
    elif os.getenv("ALLOW_SQLITE_FALLBACK") == "1":
        report(
            WARN,
            "App would start against the SQLite FALLBACK, not PostgreSQL",
            "ALLOW_SQLITE_FALLBACK=1 masks the unreachable database. Anything written "
            "now goes to a local file, not Postgres.",
        )
    else:
        report(
            FAIL,
            "App would refuse to start",
            "Postgres is unreachable and ALLOW_SQLITE_FALLBACK is not set. That is "
            "intended - fix the connection rather than setting that variable.",
        )


def check_pg_hba():
    """pg_hba should not trust local connections - see POSTGRES_INITDB_ARGS."""
    if not container_running(DB_CONTAINER):
        report(SKIP, "pg_hba does not use trust", f"{DB_CONTAINER} is not running.")
        return
    ok, out = docker("exec", DB_CONTAINER, "cat", PG_HBA)
    if not ok:
        report(SKIP, "pg_hba does not use trust", "pg_hba.conf could not be read.")
        return
    trusting = [
        line.strip()
        for line in out.splitlines()
        if line.strip()
        and not line.strip().startswith("#")
        and re.search(r"\btrust\s*$", line)
    ]
    if trusting:
        report(
            WARN,
            f"pg_hba still trusts {len(trusting)} rule(s)",
            "Any process inside the container reaches the database as superuser with "
            "no password. Rules: " + "; ".join(trusting),
        )
    else:
        report(OK, "pg_hba requires a password on every rule")


def check_pgadmin():
    """Read pgAdmin's own database. Never attempts a login."""
    if not container_running(PGADMIN_CONTAINER):
        report(SKIP, "pgAdmin accounts are usable", f"{PGADMIN_CONTAINER} is not running.")
        return
    script = (
        "import sqlite3;"
        f"c=sqlite3.connect('file:{PGADMIN_DB}?mode=ro',uri=True);"
        "print('\\n'.join('%s|%s|%s' % r for r in "
        "c.execute('select username,login_attempts,locked from user')))"
    )
    ok, out = docker("exec", PGADMIN_CONTAINER, "/venv/bin/python", "-c", script)
    if not ok or not out:
        report(SKIP, "pgAdmin accounts are usable", "pgAdmin's database could not be read.")
        return

    locked, near = [], []
    for row in out.splitlines():
        parts = row.split("|")
        if len(parts) != 3:
            continue
        username, attempts, is_locked = parts[0], int(parts[1] or 0), parts[2] == "1"
        if is_locked:
            locked.append(username)
        elif attempts > 0:
            near.append(f"{username} ({attempts} failed)")

    if locked:
        report(
            FAIL,
            "pgAdmin accounts are LOCKED: " + ", ".join(locked),
            "Reset with setup.py update-user, then clear login_attempts.",
        )
    elif near:
        report(
            WARN,
            "pgAdmin accounts have failed attempts: " + ", ".join(near),
            "The default threshold is 3; a successful login resets the count.",
        )
    else:
        report(OK, "No pgAdmin account is locked or has failed attempts")


def main():
    print(f"Diagnosing {REPO_ROOT}\n")
    if not ENV_FILE.exists():
        report(WARN, ".env is present", "Not found; relying on environment variables.")
    env = load_env()

    check_env_consistency(env)
    postgres_ok = check_postgres_credentials(env)
    check_startup_target(postgres_ok)
    check_pg_hba()
    check_pgadmin()

    failures, warnings = _results.count(FAIL), _results.count(WARN)
    print(
        f"\n{len(_results)} checks: {_results.count(OK)} ok, {warnings} warning(s), "
        f"{failures} failure(s), {_results.count(SKIP)} skipped"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
