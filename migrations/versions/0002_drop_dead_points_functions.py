"""Drop three trigger functions left over from the retired points table.

sync_feedback_geom, sync_point_geom_and_coordinates and update_associated_feedback_geom
served triggers on public.points and public.feedback that init_db dropped long ago, and
the points table itself is gone. Checked on live before writing this: no trigger uses
them, nothing depends on them (pg_depend), and no other function's body names them. They
exist only on databases old enough to have had points; a database built from 0001 never
had them, hence IF EXISTS.

downgrade() puts them back exactly as they were on live.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-01
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

FUNCTIONS = ("sync_feedback_geom", "sync_point_geom_and_coordinates", "update_associated_feedback_geom")

# public.sync_feedback_geom(), as pg_get_functiondef printed it on live, 2026-10-01
SYNC_FEEDBACK_GEOM = r"""
CREATE OR REPLACE FUNCTION public.sync_feedback_geom()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
                BEGIN
                    -- Copy geom from points table for the associated point_id
                    NEW.geom := (SELECT geom FROM points WHERE id = NEW.point_id);
                    RETURN NEW;
                END;
                $function$
"""

# public.sync_point_geom_and_coordinates(), as pg_get_functiondef printed it on live, 2026-10-01
SYNC_POINT_GEOM_AND_COORDINATES = r"""
CREATE OR REPLACE FUNCTION public.sync_point_geom_and_coordinates()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
                DECLARE
                    lonlat GEOMETRY;
                BEGIN
                    -- Case 1: geom was updated/inserted directly (e.g., from QGIS/ArcGIS Pro)
                    IF (NEW.geom IS NOT NULL) AND (TG_OP = 'INSERT' OR OLD.geom IS NULL OR NEW.geom IS DISTINCT FROM OLD.geom) THEN
                        NEW.easting := ST_X(NEW.geom);
                        NEW.northing := ST_Y(NEW.geom);
                        lonlat := ST_Transform(NEW.geom, 4326);
                        NEW.longitude := ST_X(lonlat);
                        NEW.latitude := ST_Y(lonlat);
                    -- Case 2: easting/northing updated directly (e.g., from GPR import)
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
                $function$
"""

# public.update_associated_feedback_geom(), as pg_get_functiondef printed it on live, 2026-10-01
UPDATE_ASSOCIATED_FEEDBACK_GEOM = r"""
CREATE OR REPLACE FUNCTION public.update_associated_feedback_geom()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
                BEGIN
                    IF (OLD.geom IS DISTINCT FROM NEW.geom) THEN
                        UPDATE feedback SET geom = NEW.geom WHERE point_id = NEW.id;
                    END IF;
                    RETURN NEW;
                END;
                $function$
"""


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for name in FUNCTIONS:
        op.execute(f"DROP FUNCTION IF EXISTS public.{name}()")


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    for definition in (SYNC_FEEDBACK_GEOM, SYNC_POINT_GEOM_AND_COORDINATES, UPDATE_ASSOCIATED_FEEDBACK_GEOM):
        op.execute(definition)
