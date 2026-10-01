import logging
import os
import time
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from config import settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("database")

db_url = settings.database_url
if db_url.startswith("postgresql://"):
    db_url = db_url.replace("postgresql://", "postgresql+psycopg://", 1)
elif db_url.startswith("postgresql+psycopg2://"):
    db_url = db_url.replace("postgresql+psycopg2://", "postgresql+psycopg://", 1)

def safe_url(url: str) -> str:
    """The URL with its password masked, for anything that gets logged.

    The connection string carries the database password, and these lines run on
    every startup - into terminal scrollback, log files and CI output. Rotating
    the password and keeping it out of git achieves nothing if the app prints it
    each time it starts.
    """
    try:
        return make_url(url).render_as_string(hide_password=True)
    except Exception:
        # Never let logging be the thing that stops the app from starting.
        return "<unparseable database URL>"


def _retry_window() -> float:
    """How long to keep retrying the first connection, in seconds."""
    try:
        return max(0.0, float(os.getenv("DB_CONNECT_RETRY_SECONDS", "30")))
    except ValueError:
        return 30.0


def _connect_with_retry(url: str, window: float):
    """Return a connected engine, retrying for `window` seconds before giving up.

    A cold boot starts this process and the database together, and Postgres needs
    a few seconds before it accepts connections. A failed connection is fatal now,
    and nothing supervises this process - no restart policy, no service manager -
    so a single attempt would turn that ordinary race into an outage lasting until
    somebody restarts the app by hand. Retry for a bounded window, then fail just
    as loudly as before: this buys time for a slow database, not for a wrong one.

    Set DB_CONNECT_RETRY_SECONDS=0 to fail on the first attempt.
    """
    engine = create_engine(url, connect_args={"connect_timeout": 5})
    deadline = time.monotonic() + window
    attempt = 0
    while True:
        attempt += 1
        try:
            with engine.connect():
                return engine
        except Exception:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise
            logger.warning(
                "Database not ready (attempt %d); retrying for up to %.0fs more.",
                attempt,
                remaining,
            )
            time.sleep(min(2.0, remaining))


engine = None

try:
    logger.info(f"Attempting to connect to database (mapped URL: {safe_url(db_url)})")
    if db_url.startswith("postgresql"):
        engine = _connect_with_retry(db_url, _retry_window())
        logger.info("Successfully connected to PostgreSQL database.")
    else:
        engine = create_engine(db_url, connect_args={"check_same_thread": False})
        logger.info("Connected to SQLite database.")
except Exception as e:
    logger.error(f"Failed to connect to database URL {safe_url(db_url)}. Error: {e}")
    # This used to fall through to SQLite unconditionally, which turned a wrong
    # password or an unreachable server into an app that started cleanly against an
    # empty database: the data was simply absent and every login failed, with the
    # real cause buried in one warning line among the startup output. A database
    # the app cannot reach is not a condition it can paper over, so it now stops.
    #
    # The fallback remains for deliberate offline work. It is read from the process
    # environment and NOT from .env - nothing loads .env into os.environ, so setting
    # it there has no effect.
    if os.getenv("ALLOW_SQLITE_FALLBACK") != "1":
        raise RuntimeError(
            f"Cannot reach the database at {safe_url(db_url)}: {e}. "
            "Check that the server is running and that DATABASE_URL is correct. "
            "To work offline against a local SQLite file instead, set the "
            "environment variable ALLOW_SQLITE_FALLBACK=1."
        ) from e
    fallback_url = "sqlite:///./uxo_local.db"
    logger.warning(
        f"ALLOW_SQLITE_FALLBACK=1 - falling back to local SQLite database at: {fallback_url}"
    )
    engine = create_engine(fallback_url, connect_args={"check_same_thread": False})

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def init_db():
    """Bring the schema up to the newest migration in migrations/ (Alembic). The server
    runs this at startup; on a database already at the newest revision it does nothing.

    A migration that fails raises, and the server does not start. Before Alembic every
    step here caught and logged its own error, so a failed change left the app running
    against a schema it did not expect, with one log line to show for it.
    """
    from alembic import command
    from alembic.config import Config

    here = os.path.dirname(os.path.abspath(__file__))
    cfg = Config(os.path.join(here, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(here, "migrations"))
    command.upgrade(cfg, "head")
    logger.info("Database schema is at the newest migration.")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
