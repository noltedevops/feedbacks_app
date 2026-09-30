import logging
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

    # feedback.project_id, and the backfill for rows written before it existed.
    #
    # The value is a denormalisation of anomalies.project_id, reached through the
    # anomaly_id foreign key that every feedback row already has and cannot be without.
    # That join is the source of truth here rather than parsing the project out of
    # target_id: target_id is free text with no constraint behind it, so a value that
    # drifted from its shape would be mis-attributed silently, while the join either
    # resolves or does not.
    #
    # WHERE project_id IS NULL rather than a run-once guard, so this also repairs rows
    # written by an older server after the column already existed. Once every row is
    # filled it matches nothing and costs one indexed scan per startup.
    #
    # A correlated subquery rather than UPDATE ... FROM: it is the one spelling both
    # PostgreSQL and the SQLite fallback accept.
    try:
        with engine.connect() as conn:
            if engine.url.drivername.startswith("postgresql"):
                conn.execute(text(
                    "ALTER TABLE feedback ADD COLUMN IF NOT EXISTS project_id VARCHAR(50) "
                    "REFERENCES projects(project_id) ON DELETE CASCADE;"
                ))
            else:
                existing = {row[1] for row in conn.execute(text("PRAGMA table_info(feedback);"))}
                if "project_id" not in existing:
                    # SQLite cannot add a column and a foreign key in one statement; the
                    # fallback database does not enforce foreign keys by default anyway.
                    conn.execute(text("ALTER TABLE feedback ADD COLUMN project_id VARCHAR(50);"))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_feedback_project_id ON feedback (project_id);"
            ))
            result = conn.execute(text(
                "UPDATE feedback SET project_id = ("
                "  SELECT a.project_id FROM anomalies a WHERE a.id = feedback.anomaly_id"
                ") WHERE project_id IS NULL;"
            ))
            conn.commit()
            if result.rowcount:
                logger.info("Backfilled feedback.project_id on %s row(s).", result.rowcount)
            logger.info("Verified feedback.project_id column exists.")
    except Exception as e:
        logger.error(f"Failed to add or backfill feedback.project_id column: {e}")

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

                # 2. SCD Type 2 audit table & trigger for anomalies
                scd_audit_sql = """
                CREATE TABLE IF NOT EXISTS public.anomaly_history (
                    history_id BIGSERIAL PRIMARY KEY,
                    anomaly_id VARCHAR(36) NOT NULL,
                    project_id VARCHAR(50),
                    target_id VARCHAR(100),
                    vm_nr VARCHAR(50),
                    instrument VARCHAR(50),
                    category VARCHAR(50),
                    layer VARCHAR(255),
                    evaluated_depth DOUBLE PRECISION,
                    easting DOUBLE PRECISION,
                    northing DOUBLE PRECISION,
                    latitude DOUBLE PRECISION,
                    longitude DOUBLE PRECISION,
                    status VARCHAR(50),
                    valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    valid_to TIMESTAMPTZ,
                    is_current BOOLEAN NOT NULL DEFAULT TRUE,
                    change_reason TEXT NOT NULL DEFAULT 'initial',
                    decision_id BIGINT,
                    changed_by TEXT
                );

                -- History outlives the anomaly: no foreign key, so deleting an anomaly or its
                -- project keeps the record of every version. Tables created before this rule
                -- carried an ON DELETE CASCADE foreign key; drop whatever foreign key exists.
                DO $$ DECLARE c record; BEGIN
                    FOR c IN SELECT conname FROM pg_constraint
                              WHERE conrelid = 'public.anomaly_history'::regclass AND contype = 'f' LOOP
                        EXECUTE format('ALTER TABLE public.anomaly_history DROP CONSTRAINT %I', c.conname);
                    END LOOP;
                END $$;

                -- Tables first created by create_all had zone-less timestamps and capped text.
                -- The trigger wrote now() into them under the server's zone, Etc/UTC.
                DO $$ BEGIN
                    IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
                         WHERE attrelid = 'public.anomaly_history'::regclass AND attname = 'valid_from')
                       = 'timestamp without time zone' THEN
                        ALTER TABLE public.anomaly_history
                            ALTER COLUMN valid_from TYPE TIMESTAMPTZ USING valid_from AT TIME ZONE 'UTC',
                            ALTER COLUMN valid_to TYPE TIMESTAMPTZ USING valid_to AT TIME ZONE 'UTC',
                            ALTER COLUMN valid_from SET DEFAULT now();
                    END IF;
                    IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
                         WHERE attrelid = 'public.anomaly_history'::regclass AND attname = 'change_reason') <> 'text' THEN
                        ALTER TABLE public.anomaly_history
                            ALTER COLUMN change_reason TYPE TEXT,
                            ALTER COLUMN changed_by TYPE TEXT;
                    END IF;
                END $$;

                CREATE INDEX IF NOT EXISTS ix_anomaly_history_anomaly_id ON public.anomaly_history (anomaly_id);
                CREATE INDEX IF NOT EXISTS ix_anomaly_history_project_id ON public.anomaly_history (project_id);
                CREATE INDEX IF NOT EXISTS ix_anomaly_history_target_id ON public.anomaly_history (target_id);
                CREATE INDEX IF NOT EXISTS ix_anomaly_history_vm_nr ON public.anomaly_history (vm_nr);
                CREATE UNIQUE INDEX IF NOT EXISTS ix_anomaly_history_current ON public.anomaly_history (anomaly_id) WHERE is_current = TRUE;

                CREATE OR REPLACE FUNCTION public.fn_anomaly_scd_audit()
                RETURNS TRIGGER AS $$
                DECLARE
                    v_reason TEXT;
                    v_decision_id BIGINT;
                    v_user TEXT;
                BEGIN
                    v_reason := NULLIF(current_setting('etl.change_reason', true), '');
                    v_decision_id := NULLIF(current_setting('etl.current_decision_id', true), '')::BIGINT;
                    v_user := session_user;

                    IF TG_OP = 'INSERT' THEN
                        INSERT INTO public.anomaly_history (
                            anomaly_id, project_id, target_id, vm_nr, instrument,
                            category, layer, evaluated_depth, easting, northing,
                            latitude, longitude, status, valid_from, valid_to,
                            is_current, change_reason, decision_id, changed_by
                        ) VALUES (
                            NEW.id, NEW.project_id, NEW.target_id, NEW.vm_nr, NEW.instrument,
                            NEW.category, NEW.layer, NEW.evaluated_depth, NEW.easting, NEW.northing,
                            NEW.latitude, NEW.longitude, NEW.status, now(), NULL,
                            true, COALESCE(v_reason, 'created'), v_decision_id, v_user
                        );
                        RETURN NEW;
                    ELSIF TG_OP = 'UPDATE' THEN
                        IF (OLD.easting IS DISTINCT FROM NEW.easting) OR
                           (OLD.northing IS DISTINCT FROM NEW.northing) OR
                           (OLD.latitude IS DISTINCT FROM NEW.latitude) OR
                           (OLD.longitude IS DISTINCT FROM NEW.longitude) OR
                           (OLD.evaluated_depth IS DISTINCT FROM NEW.evaluated_depth) OR
                           (OLD.category IS DISTINCT FROM NEW.category) OR
                           (OLD.layer IS DISTINCT FROM NEW.layer) OR
                           (OLD.instrument IS DISTINCT FROM NEW.instrument) OR
                           (OLD.status IS DISTINCT FROM NEW.status) OR
                           (OLD.vm_nr IS DISTINCT FROM NEW.vm_nr) OR
                           (OLD.target_id IS DISTINCT FROM NEW.target_id) THEN

                            UPDATE public.anomaly_history
                               SET valid_to = now(),
                                   is_current = false
                             WHERE anomaly_id = OLD.id
                               AND is_current = true;

                            IF NOT FOUND THEN
                                INSERT INTO public.anomaly_history (
                                    anomaly_id, project_id, target_id, vm_nr, instrument,
                                    category, layer, evaluated_depth, easting, northing,
                                    latitude, longitude, status, valid_from, valid_to,
                                    is_current, change_reason, decision_id, changed_by
                                ) VALUES (
                                    OLD.id, OLD.project_id, OLD.target_id, OLD.vm_nr, OLD.instrument,
                                    OLD.category, OLD.layer, OLD.evaluated_depth, OLD.easting, OLD.northing,
                                    OLD.latitude, OLD.longitude, OLD.status, now() - INTERVAL '1 millisecond', now(),
                                    false, 'baseline', NULL, 'system'
                                );
                            END IF;

                            INSERT INTO public.anomaly_history (
                                anomaly_id, project_id, target_id, vm_nr, instrument,
                                category, layer, evaluated_depth, easting, northing,
                                latitude, longitude, status, valid_from, valid_to,
                                is_current, change_reason, decision_id, changed_by
                            ) VALUES (
                                NEW.id, NEW.project_id, NEW.target_id, NEW.vm_nr, NEW.instrument,
                                NEW.category, NEW.layer, NEW.evaluated_depth, NEW.easting, NEW.northing,
                                NEW.latitude, NEW.longitude, NEW.status, now(), NULL,
                                true, COALESCE(v_reason, 'update'), v_decision_id, v_user
                            );
                        END IF;
                        RETURN NEW;
                    END IF;
                    RETURN NULL;
                END;
                $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

                -- Append-only: the only change a history row may ever take is the audit
                -- trigger closing the current version. Everything else - edits, deletes,
                -- truncate - is refused, whoever asks (short of disabling the trigger).
                CREATE OR REPLACE FUNCTION public.fn_anomaly_history_append_only()
                RETURNS TRIGGER AS $$
                BEGIN
                    IF TG_OP = 'UPDATE' THEN
                        IF OLD.is_current AND NOT NEW.is_current
                           AND OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL
                           AND (to_jsonb(OLD) - 'is_current' - 'valid_to')
                             = (to_jsonb(NEW) - 'is_current' - 'valid_to') THEN
                            RETURN NEW;
                        END IF;
                    END IF;
                    RAISE EXCEPTION 'anomaly_history is append-only: % refused', TG_OP
                        USING HINT = 'Only closing the current version (is_current to false, valid_to set) is allowed.';
                END;
                $$ LANGUAGE plpgsql SET search_path = pg_catalog, public;

                DROP TRIGGER IF EXISTS trigger_anomaly_history_append_only ON public.anomaly_history;
                CREATE TRIGGER trigger_anomaly_history_append_only
                BEFORE UPDATE OR DELETE ON public.anomaly_history
                FOR EACH ROW
                EXECUTE FUNCTION public.fn_anomaly_history_append_only();

                DROP TRIGGER IF EXISTS trigger_anomaly_history_no_truncate ON public.anomaly_history;
                CREATE TRIGGER trigger_anomaly_history_no_truncate
                BEFORE TRUNCATE ON public.anomaly_history
                FOR EACH STATEMENT
                EXECUTE FUNCTION public.fn_anomaly_history_append_only();

                DROP TRIGGER IF EXISTS trigger_anomaly_scd_audit ON public.anomalies;
                CREATE TRIGGER trigger_anomaly_scd_audit
                AFTER INSERT OR UPDATE ON public.anomalies
                FOR EACH ROW
                EXECUTE FUNCTION public.fn_anomaly_scd_audit();

                -- Backfill existing anomalies into history if not already present
                INSERT INTO public.anomaly_history (
                    anomaly_id, project_id, target_id, vm_nr, instrument,
                    category, layer, evaluated_depth, easting, northing,
                    latitude, longitude, status, valid_from, valid_to,
                    is_current, change_reason, changed_by
                )
                SELECT
                    id, project_id, target_id, vm_nr, instrument,
                    category, layer, evaluated_depth, easting, northing,
                    latitude, longitude, status, now(), NULL,
                    TRUE, 'initial', 'system'
                FROM public.anomalies a
                WHERE NOT EXISTS (
                    SELECT 1 FROM public.anomaly_history h WHERE h.anomaly_id = a.id
                );

                -- Grants for pipeline and approver roles
                DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etl_pipeline') THEN
                        GRANT SELECT ON public.anomaly_history TO etl_pipeline;
                    END IF;
                    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etl_approver') THEN
                        GRANT SELECT ON public.anomaly_history TO etl_approver;
                    END IF;
                END $$;
                """
                conn.execute(text(scd_audit_sql))
                conn.commit()
                logger.info("Successfully created/updated SCD Type 2 audit history table and trigger.")
        except Exception as e:
            logger.error(f"Failed to create database triggers: {e}")

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
