# Operations runbook

Running the services, managing accounts and credentials, and diagnosing the failures
this project actually produces.

## Services

`docker-compose.yml` defines two containers. Credentials come from `.env`; nothing secret
is in the compose file, and every variable uses the `${VAR:?message}` form so a missing
value fails the command loudly instead of falling back to a well-known default.

| Service | Container | Image | Address |
|---|---|---|---|
| Database | `feedback_postgres_db` | `postgis/postgis:16-3.4` | `127.0.0.1:5432` |
| pgAdmin | `nolte-pgadmin` | `dpage/pgadmin4:latest` | http://127.0.0.1:8080 |

```powershell
docker compose up -d          # start
docker compose ps             # status, including health
docker compose logs -f db     # follow the database log
docker compose down           # stop, volumes preserved
```

Both publish to **loopback only**. They are reached from this machine — the API over
`DATABASE_URL`, pgAdmin in a browser — so binding them to every interface only offered
the database to the rest of the network. Both use `restart: unless-stopped`, because
without it the database does not come back after a reboot and the app, which is not
managed by compose, then starts against nothing. pgAdmin waits on the database's
`pg_isready` healthcheck rather than merely on the container existing.

The application itself is **not** in compose. Start it separately:

```powershell
.venv\Scripts\python server.py
```

### Volumes

`postgres_data` and `pgadmin_data` are named Docker volumes and survive
`docker compose down`. This matters more than it looks:

- `POSTGRES_PASSWORD` is applied **only when `postgres_data` is first created**. On an
  existing volume it is inert.
- `PGADMIN_DEFAULT_PASSWORD` likewise applies only at `pgadmin_data` creation.

Removing a volume (`docker compose down -v`) destroys the data and re-runs initialisation
with whatever `.env` currently says.

## Credentials

### The three passwords

| Variable | Consumer | Effective when |
|---|---|---|
| `POSTGRES_PASSWORD` | Postgres `initdb`, via compose | first creation of `postgres_data` only |
| password inside `DATABASE_URL` | the app, `ingest_anomalies.py`, `doctor.py` | every connection |
| `PGADMIN_DEFAULT_PASSWORD` | pgAdmin, via compose | first creation of `pgadmin_data` only |

`config.py` compares the first two on startup and prints a warning when they disagree —
percent-decoding the URL's password first, so an escaped password does not read as a
mismatch. It **warns rather than fails**, because a volume whose password was rotated
with `ALTER USER` sits in that state legitimately. It still matters: a recreated volume
would initialise with `POSTGRES_PASSWORD`, and the app would not be able to connect.

To rotate the database password on a live volume:

```sql
ALTER USER postgres WITH PASSWORD '...';
```

then update **both** `DATABASE_URL` and `POSTGRES_PASSWORD` in `.env` so they agree, and
restart the app.

### `AUTH_SECRET`

Signs session tokens. Unset means a random key per process, so every restart signs
everyone out; changing it does the same once. Generate one with:

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
```

### `SEED_PASSWORD`

Given to the default accounts, and **only when the users table is seeded empty**. Once
any account exists it has no effect — use `manage_access.py set-password` or the admin
reset. Unset means each seeded account gets its own random password, which has to be
reset rather than guessed.

The seeded accounts are `collector` (field), `dashboard` (dashboard) and `eric.musonera`
(field + dashboard + admin — somebody has to be able to approve the first request).

### `pg_hba` and trust authentication

`initdb` writes `trust` for local and `127.0.0.1` connections by default, which means any
process inside the container reaches the database as superuser with no password. The
compose file sets:

```
POSTGRES_INITDB_ARGS: "--auth-local=scram-sha-256 --auth-host=scram-sha-256"
```

so a freshly created volume comes up requiring a password. The existing running volume
was corrected in place — `POSTGRES_INITDB_ARGS` cannot retroactively change a volume that
already exists. `doctor.py` re-checks this every run: it reads
`/var/lib/postgresql/data/pg_hba.conf` out of the container and warns about any rule
still ending in `trust`.

## `scripts/doctor.py`

```powershell
.venv\Scripts\python scripts\doctor.py
```

**Run this first** whenever the app will not start, logins fail, accounts appear to be
missing, or pgAdmin refuses you. It codifies the checks that were previously done by hand
the last time nobody could log in — a session that turned up three separate causes at
once, none of which announced itself.

It is read-only: it connects, reads and reports, and changes nothing. It prints no
password; where one must be identified it is named by origin (`"DATABASE_URL"`), never by
value. pgAdmin is inspected by reading its SQLite database, never by attempting a login —
that would count against the lockout threshold and could lock the account being
diagnosed.

Checks performed:

| Check | Catches |
|---|---|
| `POSTGRES_PASSWORD` vs `DATABASE_URL` | a rotation applied to only one of them |
| Which credential Postgres accepts | a wrong password vs. nothing listening at all |
| App startup target | **silently running on the SQLite fallback** instead of Postgres |
| `pg_hba` trust rules | a volume still authenticating without a password |
| pgAdmin account state | locked accounts and accumulated failed attempts |

It resolves `.env` the same way pydantic-settings does — real environment variables take
precedence — so it reports on the values the app would actually use, not merely on what
is written to disk. Exit status is 1 if any check FAILs, so it can gate a deploy or run
in CI.

## `manage_access.py`

Command-line access management for the two cases the admin UI cannot cover: appointing
the first administrator, and getting back in when nobody can.

```powershell
.venv\Scripts\python manage_access.py list
.venv\Scripts\python manage_access.py grant eric.musonera --admin --dashboard
.venv\Scripts\python manage_access.py revoke someone --dashboard
.venv\Scripts\python manage_access.py set-password eric.musonera
```

`--field`, `--dashboard` and `--admin` map to the `can_field`, `can_dashboard` and
`is_admin` columns; `grant` and `revoke` accept any combination.

Behaviour worth knowing:

- **The last administrator cannot be revoked.** Grant admin elsewhere first.
- **`set-password` requires an interactive terminal.** It refuses piped stdin rather than
  hanging on `getpass`.
- It strips CR/LF from the typed password — MinTTY (Git Bash) can hand back a trailing
  carriage return, and hashing that would store a password nobody could ever type again.
  Spaces are left alone.
- After writing, it re-reads the row and verifies the new password against the stored
  hash. A password that cannot be verified here would not work at the login screen
  either, and finding out now beats finding out from a locked-out user.

It imports `database.SessionLocal`, so it uses the same `DATABASE_URL` as the app and
must be run on the machine that holds it. There is no network path to any of this, which
is the point.

## Access administration from the UI

Admins have equivalent controls in the app itself:

- `GET /api/admin/users` — every account and its flags.
- `PATCH /api/admin/users/{id}/access` — flip flags. The server refuses to remove the
  last admin and returns its reason, which the UI surfaces.
- `POST /api/admin/users/{id}/reset-password` — issues a temporary password, returns it
  **once**, and sets `must_change_password`. It is never stored in the clear and no
  endpoint can return it again; the admin reads it off the screen and passes it on. The
  user is blocked from every surface until they choose their own.
- `GET /api/permissions/requests` and `POST /api/permissions/requests/{id}/decide` — the
  queue raised when a user opens a surface they lack.

A user who has been offline picks up permissions granted while they were away via
`GET /api/auth/me`, which the client re-reads on login.

## Backups

The database holds the `users` table, so dumps are sensitive. `.gitignore` excludes
`backup-*.sql` for that reason — keep that naming so the rule catches new dumps.

```powershell
docker exec feedback_postgres_db pg_dump -U postgres nolte_geoservices > backup-nolte_geoservices-$(Get-Date -Format yyyyMMdd-HHmmss).sql
```

Take one before anything destructive — in particular before `ingest_anomalies.py`, which
drops and rebuilds `projects`, `anomalies` and `feedback` (see
[DATA_PIPELINE.md](DATA_PIPELINE.md)), and before `POST /api/seed`.

There is no automated backup or retention policy yet; it is listed as an open item in
[PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md).

## Common failures

**The app refuses to start with "Cannot reach the database at …".**
Working as intended. It used to fall through to an empty SQLite file, which produced an
app that started cleanly, held no data, and failed every login — with the real cause
buried in one warning line. Fix the connection; run `doctor.py`. Only set
`ALLOW_SQLITE_FALLBACK=1` for deliberate offline work, and remember it is read from the
**process environment**, not `.env`.

**Startup pauses, logging "Database not ready (attempt N)".**
The bounded first-connection retry, default 30 seconds, controlled by
`DB_CONNECT_RETRY_SECONDS` (also process-environment only). It buys time for a slow
database, not for a wrong one — a bad password still fails at the end of the window. Set
it to `0` to fail on the first attempt.

**Everyone is signed out after a restart.**
`AUTH_SECRET` is unset, so the signing key was random and changed with the process.

**A user cannot open a surface.**
Check the flags with `manage_access.py list`. The 403 body names the surface, and the UI
offers to raise a permission request an admin decides.

**pgAdmin will not accept the password.**
`PGADMIN_DEFAULT_PASSWORD` only applied when `pgadmin_data` was created; if it was
changed in `.env` afterwards, nothing happened. Check for a lockout with `doctor.py`
first — the default threshold is 3 failed attempts, and a successful login resets the
count. Reset with `setup.py update-user` inside the container, then clear
`login_attempts`.

**"Database synchronization failed" on sync.**
`/api/sync` returns this when the commit fails, most often because the anomalies the
device is reporting against do not exist server-side — an un-ingested or re-ingested
database. Feedback whose parent anomaly is missing is skipped with a warning rather than
failing the whole request, so check the server log for `Skipping sync of feedback log …`.
