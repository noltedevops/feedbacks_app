import logging
import math
import os
import time
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from config import settings
from models import Base

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
    logger.info("Initializing database tables...")
    from sqlalchemy import text
    
    # Enable PostGIS extension if using PostgreSQL
    if engine.url.drivername.startswith("postgresql"):
        try:
            with engine.connect() as conn:
                conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis;"))
                conn.commit()
                logger.info("Successfully enabled PostGIS extension.")
        except Exception as e:
            logger.error(f"Failed to enable PostGIS extension: {e}")
            
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables initialized successfully.")

    # create_all only creates missing tables, it never alters existing ones, so new
    # columns have to be added explicitly for databases seeded before they existed.
    try:
        with engine.connect() as conn:
            if engine.url.drivername.startswith("postgresql"):
                conn.execute(text("ALTER TABLE feedback ADD COLUMN IF NOT EXISTS teams_tools JSON;"))
            else:
                existing = {row[1] for row in conn.execute(text("PRAGMA table_info(feedback);"))}
                if "teams_tools" not in existing:
                    conn.execute(text("ALTER TABLE feedback ADD COLUMN teams_tools JSON;"))
            conn.commit()
            logger.info("Verified feedback.teams_tools column exists.")
    except Exception as e:
        logger.error(f"Failed to add feedback.teams_tools column: {e}")

    # Per-surface access flags. Rows created before these existed are backfilled
    # from role, so nobody loses the access they had: collectors keep the field
    # app, dashboard users keep the dashboard.
    user_flags = [
        ("can_field", "BOOLEAN NOT NULL DEFAULT true", "BOOLEAN NOT NULL DEFAULT 1"),
        ("can_dashboard", "BOOLEAN NOT NULL DEFAULT false", "BOOLEAN NOT NULL DEFAULT 0"),
        ("is_admin", "BOOLEAN NOT NULL DEFAULT false", "BOOLEAN NOT NULL DEFAULT 0"),
        ("must_change_password", "BOOLEAN NOT NULL DEFAULT false", "BOOLEAN NOT NULL DEFAULT 0"),
    ]
    try:
        with engine.connect() as conn:
            if engine.url.drivername.startswith("postgresql"):
                existing = {
                    row[0] for row in conn.execute(text(
                        "SELECT column_name FROM information_schema.columns WHERE table_name = 'users';"
                    ))
                }
                type_index = 1
            else:
                existing = {row[1] for row in conn.execute(text("PRAGMA table_info(users);"))}
                type_index = 2

            added = [c for c, _, _ in user_flags if c not in existing]
            for spec in user_flags:
                if spec[0] not in existing:
                    conn.execute(text(f"ALTER TABLE users ADD COLUMN {spec[0]} {spec[type_index]};"))

            # Backfill only the columns this run added, so later edits to a user's
            # access are never overwritten on the next startup.
            if "can_dashboard" in added:
                conn.execute(text("UPDATE users SET can_dashboard = true WHERE role = 'dashboard';"))
            if "can_field" in added:
                # The column default already granted the field app to everyone;
                # take it back off the dashboard-only accounts.
                conn.execute(text("UPDATE users SET can_field = false WHERE role = 'dashboard';"))
            conn.commit()
            logger.info("Verified users access-flag columns exist.")
    except Exception as e:
        logger.error(f"Failed to add users access-flag columns: {e}")


    # Create PL/pgSQL triggers for bidirectional sync in PostgreSQL
    if engine.url.drivername.startswith("postgresql"):
        try:
            with engine.connect() as conn:
                # 1. Trigger function for anomalies table (bidirectional coordinates & geom sync)
                anomalies_trigger_sql = """
                CREATE OR REPLACE FUNCTION sync_anomaly_geom_and_coordinates()
                RETURNS TRIGGER AS $$
                DECLARE
                    lonlat GEOMETRY;
                BEGIN
                    -- Case 1: geom was updated/inserted directly (e.g., from QGIS/ArcGIS Pro)
                    IF (NEW.geom IS NOT NULL) AND (TG_OP = 'INSERT' OR OLD.geom IS NULL OR NEW.geom IS DISTINCT FROM OLD.geom OR NEW.latitude IS NULL OR NEW.longitude IS NULL) THEN
                        NEW.easting := ST_X(NEW.geom);
                        NEW.northing := ST_Y(NEW.geom);
                        lonlat := ST_Transform(NEW.geom, 4326);
                        NEW.longitude := ST_X(lonlat);
                        NEW.latitude := ST_Y(lonlat);
                    -- Case 2: easting/northing updated directly
                    ELSIF (NEW.easting IS NOT NULL AND NEW.northing IS NOT NULL) AND 
                          (TG_OP = 'INSERT' OR OLD.easting IS NULL OR NEW.easting IS DISTINCT FROM OLD.easting OR OLD.northing IS NULL OR NEW.northing IS DISTINCT FROM OLD.northing) THEN
                        NEW.geom := ST_SetSRID(ST_MakePoint(NEW.easting, NEW.northing), 32632);
                        lonlat := ST_Transform(NEW.geom, 4326);
                        NEW.longitude := ST_X(lonlat);
                        NEW.latitude := ST_Y(lonlat);
                    -- Case 3: lat/lon updated directly (e.g., from web app Leaflet dragging)
                    ELSIF (NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL) AND 
                          (TG_OP = 'INSERT' OR OLD.latitude IS NULL OR NEW.latitude IS DISTINCT FROM OLD.latitude OR OLD.longitude IS NULL OR NEW.longitude IS DISTINCT FROM OLD.longitude) THEN
                        lonlat := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326);
                        NEW.geom := ST_Transform(lonlat, 32632);
                        NEW.easting := ST_X(NEW.geom);
                        NEW.northing := ST_Y(NEW.geom);
                    END IF;
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql;

                DROP TRIGGER IF EXISTS trigger_sync_anomaly_geom_coordinates ON anomalies;
                CREATE TRIGGER trigger_sync_anomaly_geom_coordinates
                BEFORE INSERT OR UPDATE ON anomalies
                FOR EACH ROW
                EXECUTE FUNCTION sync_anomaly_geom_and_coordinates();

                -- Clean up legacy triggers from prior tables
                DROP TRIGGER IF EXISTS trigger_sync_point_geom_coordinates ON points;
                DROP TRIGGER IF EXISTS trigger_sync_feedback_geom ON feedback;
                DROP TRIGGER IF EXISTS trigger_update_associated_feedback_geom ON points;
                """
                conn.execute(text(anomalies_trigger_sql))
                conn.commit()
                logger.info("Successfully created/updated PL/pgSQL database triggers for spatial synchronization.")
        except Exception as e:
            logger.error(f"Failed to create database triggers: {e}")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Coordinate Conversion: UTM Zone 32N (EPSG:32632) to WGS84 Lat/Lng
def utm32n_to_latlon(easting: float, northing: float):
    # WGS84 Ellipsoid
    a = 6378137.0
    f = 1.0 / 298.257223563
    b = a * (1.0 - f)
    
    e2 = (a**2 - b**2) / a**2
    ep2 = (a**2 - b**2) / b**2
    
    k0 = 0.9996
    lon0 = 9.0 * math.pi / 180.0 # Central Meridian for Zone 32 (9 degrees East)
    
    x = easting - 500000.0
    y = northing
    
    # Footprint latitude calculation (Divide northing by scale factor k0 to get meridian distance M)
    M = y / k0
    mu = M / (a * (1.0 - e2/4.0 - 3.0*e2**2/64.0 - 5.0*e2**3/256.0))
    e1 = (1.0 - math.sqrt(1.0 - e2)) / (1.0 + math.sqrt(1.0 - e2))
    
    foot_lat = (mu + (3.0*e1/2.0 - 27.0*e1**3/32.0)*math.sin(2.0*mu)
                + (21.0*e1**2/16.0 - 55.0*e1**4/32.0)*math.sin(4.0*mu)
                + (151.0*e1**3/96.0)*math.sin(6.0*mu)
                + (1097.0*e1**4/512.0)*math.sin(8.0*mu))
    
    sin_foot = math.sin(foot_lat)
    cos_foot = math.cos(foot_lat)
    tan_foot = math.tan(foot_lat)
    
    N1 = a / math.sqrt(1.0 - e2 * sin_foot**2)
    R1 = a * (1.0 - e2) / (1.0 - e2 * sin_foot**2)**1.5
    D_val = x / (N1 * k0)
    
    lat = (foot_lat - (N1 * tan_foot / R1) * (D_val**2/2.0 
           - (5.0 + 3.0*tan_foot**2 + 10.0*ep2*cos_foot**2 - 4.0*(ep2*cos_foot**2)**2 - 9.0*ep2)*D_val**4/24.0
           + (61.0 + 90.0*tan_foot**2 + 298.0*ep2*cos_foot**2 + 45.0*tan_foot**4 - 252.0*ep2 - 3.0*(ep2*cos_foot**2)**2)*D_val**6/720.0))
           
    lon = (lon0 + (D_val - (1.0 + 2.0*tan_foot**2 + ep2*cos_foot**2)*D_val**3/6.0
           + (5.0 - 2.0*ep2*cos_foot**2 + 28.0*tan_foot**2 - 3.0*(ep2*cos_foot**2)**2 + 8.0*ep2 + 24.0*tan_foot**4)*D_val**5/120.0) / cos_foot)
           
    return lat * 180.0 / math.pi, lon * 180.0 / math.pi

# Coordinate Conversion: WGS84 Lat/Lng to UTM Zone 32N (EPSG:32632)
def latlon_to_utm32n(lat: float, lon: float):
    a = 6378137.0
    f = 1.0 / 298.257223563
    b = a * (1.0 - f)
    
    e2 = (a**2 - b**2) / a**2
    ep2 = (a**2 - b**2) / b**2
    
    k0 = 0.9996
    lon0 = 9.0 * math.pi / 180.0
    
    lat_rad = lat * math.pi / 180.0
    lon_rad = lon * math.pi / 180.0
    
    N = a / math.sqrt(1.0 - e2 * math.sin(lat_rad)**2)
    T = math.tan(lat_rad)**2
    C = ep2 * math.cos(lat_rad)**2
    A = (lon_rad - lon0) * math.cos(lat_rad)
    
    M = a * (
        (1.0 - e2/4.0 - 3.0*e2**2/64.0 - 5.0*e2**3/256.0) * lat_rad
        - (3.0*e2/8.0 + 3.0*e2**2/32.0 + 45.0*e2**3/1024.0) * math.sin(2.0*lat_rad)
        + (15.0*e2**2/256.0 + 45.0*e2**3/1024.0) * math.sin(4.0*lat_rad)
        - (35.0*e2**3/3072.0) * math.sin(6.0*lat_rad)
    )
    
    x = k0 * N * (
        A + (1.0 - T + C) * A**3 / 6.0
        + (5.0 - 18.0*T + T**2 + 72.0*C - 58.0*ep2) * A**5 / 120.0
    ) + 500000.0
    
    y = k0 * (
        M + N * math.tan(lat_rad) * (
            A**2 / 2.0
            + (5.0 - T + 9.0*C + 4.0*C**2) * A**4 / 24.0
            + (61.0 - 58.0*T + T**2 + 600.0*C - 330.0*ep2) * A**6 / 720.0
        )
    )
    
    return x, y

