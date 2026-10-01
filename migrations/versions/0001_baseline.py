"""Baseline: the schema as it stood on 2026-10-01, before Alembic.

Until then init_db() built and patched the schema on every startup, every step written to
be repeatable (IF NOT EXISTS, CREATE OR REPLACE). This revision is exactly those steps,
frozen: the tables as the models defined them that day, the additive columns and their
backfills, the coordinate-sync trigger and the anomaly_history audit. Because each step is
repeatable, upgrading a database that already has the schema - live, any copy of it -
changes nothing and only records this revision.

Frozen on purpose: later model changes belong in new revisions, never here.

Revision ID: 0001
Revises:
Create Date: 2026-10-01
"""
import logging

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

log = logging.getLogger("alembic.runtime.migration")

# PostgreSQL tables and indexes, compiled from models.py as it stood (SQLAlchemy 2.0.50,
# GeoAlchemy2 0.20.0). The names match the live database's.
TABLES_SQL = r"""
CREATE TABLE IF NOT EXISTS anomaly_history (
	history_id BIGSERIAL NOT NULL,
	anomaly_id VARCHAR(36) NOT NULL,
	project_id VARCHAR(50),
	target_id VARCHAR(100),
	vm_nr VARCHAR(50),
	instrument VARCHAR(50),
	category VARCHAR(50),
	layer VARCHAR(255),
	evaluated_depth FLOAT,
	easting FLOAT,
	northing FLOAT,
	latitude FLOAT,
	longitude FLOAT,
	status VARCHAR(50),
	valid_from TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
	valid_to TIMESTAMP WITH TIME ZONE,
	is_current BOOLEAN NOT NULL,
	change_reason TEXT NOT NULL,
	decision_id BIGINT,
	changed_by TEXT,
	PRIMARY KEY (history_id)
);
CREATE INDEX IF NOT EXISTS ix_anomaly_history_anomaly_id ON anomaly_history (anomaly_id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_anomaly_history_current ON anomaly_history (anomaly_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS ix_anomaly_history_project_id ON anomaly_history (project_id);
CREATE INDEX IF NOT EXISTS ix_anomaly_history_target_id ON anomaly_history (target_id);
CREATE INDEX IF NOT EXISTS ix_anomaly_history_vm_nr ON anomaly_history (vm_nr);
CREATE TABLE IF NOT EXISTS projects (
	project_id VARCHAR(50) NOT NULL,
	project_name VARCHAR(255) NOT NULL,
	created_at TIMESTAMP WITHOUT TIME ZONE,
	updated_at TIMESTAMP WITHOUT TIME ZONE,
	PRIMARY KEY (project_id)
);
CREATE TABLE IF NOT EXISTS users (
	id VARCHAR(36) NOT NULL,
	full_name VARCHAR(100) NOT NULL,
	username VARCHAR(50) NOT NULL,
	email VARCHAR(100),
	password_hash VARCHAR(255) NOT NULL,
	role VARCHAR(50) NOT NULL,
	created_at TIMESTAMP WITHOUT TIME ZONE,
	can_field BOOLEAN DEFAULT true NOT NULL,
	can_dashboard BOOLEAN DEFAULT false NOT NULL,
	is_admin BOOLEAN DEFAULT false NOT NULL,
	must_change_password BOOLEAN DEFAULT false NOT NULL,
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username);
CREATE TABLE IF NOT EXISTS anomalies (
	id VARCHAR(36) NOT NULL,
	project_id VARCHAR(50) NOT NULL,
	instrument VARCHAR(50) NOT NULL,
	geom geometry(POINT,32632),
	easting FLOAT NOT NULL,
	northing FLOAT NOT NULL,
	latitude FLOAT,
	longitude FLOAT,
	vm_nr VARCHAR(50),
	category VARCHAR(50),
	layer VARCHAR(255),
	status VARCHAR(50),
	target_id VARCHAR(100),
	evaluated_depth FLOAT,
	PRIMARY KEY (id),
	FOREIGN KEY(project_id) REFERENCES projects (project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_anomalies_geom ON anomalies USING gist (geom);
CREATE UNIQUE INDEX IF NOT EXISTS ix_anomalies_target_id ON anomalies (target_id);
CREATE INDEX IF NOT EXISTS ix_anomalies_vm_nr ON anomalies (vm_nr);
CREATE TABLE IF NOT EXISTS permission_requests (
	id VARCHAR(36) NOT NULL,
	user_id VARCHAR(36) NOT NULL,
	surface VARCHAR(20) NOT NULL,
	status VARCHAR(20) NOT NULL,
	message VARCHAR(500),
	created_at TIMESTAMP WITHOUT TIME ZONE,
	decided_at TIMESTAMP WITHOUT TIME ZONE,
	decided_by VARCHAR(36),
	PRIMARY KEY (id),
	FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_permission_requests_user_id ON permission_requests (user_id);
CREATE TABLE IF NOT EXISTS feedback (
	id VARCHAR(36) NOT NULL,
	anomaly_id VARCHAR(36) NOT NULL,
	project_id VARCHAR(50),
	visited BOOLEAN,
	visit_date TIMESTAMP WITHOUT TIME ZONE,
	tief FLOAT,
	laenge FLOAT,
	breite FLOAT,
	m_cube FLOAT,
	fundstueck VARCHAR(255),
	investigator VARCHAR(100),
	investigator_username VARCHAR(100),
	photos VARCHAR,
	notes VARCHAR,
	target_id VARCHAR(100),
	sohle_status VARCHAR(50),
	bilder_n INTEGER,
	other VARCHAR(255),
	teams_tools JSON,
	PRIMARY KEY (id),
	FOREIGN KEY(anomaly_id) REFERENCES anomalies (id) ON DELETE CASCADE,
	FOREIGN KEY(project_id) REFERENCES projects (project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_feedback_project_id ON feedback (project_id);
CREATE INDEX IF NOT EXISTS ix_feedback_target_id ON feedback (target_id);
"""

# Bidirectional geom <-> easting/northing/lat/lon sync on anomalies.
ANOMALIES_TRIGGER_SQL = r"""
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

# anomaly_history: table fixes, append-only guard, SCD Type 2 audit trigger, backfill, grants.
SCD_AUDIT_SQL = r"""
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


def upgrade() -> None:
    bind = op.get_bind()
    postgres = bind.dialect.name == "postgresql"

    if postgres:
        op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        op.execute(sa.text(TABLES_SQL))
    else:
        # The SQLite fallback is for offline development only and is not migrated: it is
        # built from the models as they are now.
        import models
        models.Base.metadata.create_all(bind=bind)

    _additive_columns(bind, postgres)

    if postgres:
        op.execute(sa.text(ANOMALIES_TRIGGER_SQL))
        op.execute(sa.text(SCD_AUDIT_SQL))


def _additive_columns(bind, postgres: bool) -> None:
    """Columns added to tables after they first existed, with their backfills - exactly as
    init_db applied them. On a database created above they are already there and this
    changes nothing."""
    def columns(table):
        if postgres:
            return {r[0] for r in bind.execute(sa.text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = :t"), {"t": table})}
        return {r[1] for r in bind.execute(sa.text(f"PRAGMA table_info({table})"))}

    # feedback.teams_tools
    if "teams_tools" not in columns("feedback"):
        bind.execute(sa.text("ALTER TABLE feedback ADD COLUMN teams_tools JSON"))

    # feedback.project_id, a denormalisation of anomalies.project_id through anomaly_id,
    # backfilled from that join for rows written before the column existed.
    if "project_id" not in columns("feedback"):
        if postgres:
            bind.execute(sa.text("ALTER TABLE feedback ADD COLUMN project_id VARCHAR(50) "
                                 "REFERENCES projects(project_id) ON DELETE CASCADE"))
        else:
            bind.execute(sa.text("ALTER TABLE feedback ADD COLUMN project_id VARCHAR(50)"))
    bind.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_feedback_project_id ON feedback (project_id)"))
    filled = bind.execute(sa.text(
        "UPDATE feedback SET project_id = ("
        "  SELECT a.project_id FROM anomalies a WHERE a.id = feedback.anomaly_id"
        ") WHERE project_id IS NULL")).rowcount
    if filled:
        log.info("Backfilled feedback.project_id on %s row(s).", filled)

    # Per-surface access flags; accounts that predate them keep the access their role gave.
    flags = [
        ("can_field", "BOOLEAN NOT NULL DEFAULT true", "BOOLEAN NOT NULL DEFAULT 1"),
        ("can_dashboard", "BOOLEAN NOT NULL DEFAULT false", "BOOLEAN NOT NULL DEFAULT 0"),
        ("is_admin", "BOOLEAN NOT NULL DEFAULT false", "BOOLEAN NOT NULL DEFAULT 0"),
        ("must_change_password", "BOOLEAN NOT NULL DEFAULT false", "BOOLEAN NOT NULL DEFAULT 0"),
    ]
    existing = columns("users")
    added = [name for name, _, _ in flags if name not in existing]
    for name, pg_type, sqlite_type in flags:
        if name in added:
            bind.execute(sa.text(f"ALTER TABLE users ADD COLUMN {name} {pg_type if postgres else sqlite_type}"))
    if "can_dashboard" in added:
        bind.execute(sa.text("UPDATE users SET can_dashboard = true WHERE role = 'dashboard'"))
    if "can_field" in added:
        bind.execute(sa.text("UPDATE users SET can_field = false WHERE role = 'dashboard'"))


def downgrade() -> None:
    raise NotImplementedError("The baseline cannot be undone; restore a backup instead.")
