-- anomalie_1: derived from picks, structured like public.anomalies
--
-- Source : p_11_26_5151_koeln_deutzerfeld.picks  (5592 rows)
-- Target : p_11_26_5151_koeln_deutzerfeld.anomalie_1
--
-- Column set and types mirror public.anomalies so the rows can later be appended
-- there directly. `geom` is deliberately not carried over - easting/northing plus
-- latitude/longitude hold the position, and public.anomalies rebuilds geom from
-- them via its BEFORE INSERT trigger (sync_anomaly_geom_and_coordinates).
--
-- Notes on the source data, verified before this ran:
--   * ST_SRID(picks.geom) = 25832 for every row, none null, so ST_SRID(p.geom)
--     resolves correctly and no literal fallback is needed.
--   * field_3 holds 0 (1 row), 2 (67), 3 (60) and 4 (5464). Kat-4 picks are
--     excluded, leaving 128 rows.
--   * field_4 and field_6 are not used; picks.id is not carried over either -
--     anomalie_1.id stays NULL until the append into public.anomalies assigns it.

CREATE TABLE IF NOT EXISTS p_11_26_5151_koeln_deutzerfeld.anomalie_1 (
    id              varchar(36),
    project_id      varchar(50),
    instrument      varchar(50),
    easting         double precision,
    northing        double precision,
    latitude        double precision,
    longitude       double precision,
    vm_nr           varchar(50),
    category        varchar(50),
    layer           varchar(255),
    status          varchar(50),
    target_id       varchar(100),
    evaluated_depth double precision
);

INSERT INTO p_11_26_5151_koeln_deutzerfeld.anomalie_1
    (id, project_id, instrument, easting, northing, latitude, longitude,
     vm_nr, category, layer, status, target_id, evaluated_depth)
SELECT
    NULL::varchar(36)                                        AS id,
    '11-26-5151'::varchar(50)                                AS project_id,
    'georadar'::varchar(50)                                  AS instrument,
    ROUND(p.field_1::numeric, 2)::double precision           AS easting,
    ROUND(p.field_2::numeric, 2)::double precision           AS northing,
    ST_Y(ST_Transform(
        ST_SetSRID(ST_MakePoint(p.field_1, p.field_2), ST_SRID(p.geom)), 4326)) AS latitude,
    ST_X(ST_Transform(
        ST_SetSRID(ST_MakePoint(p.field_1, p.field_2), ST_SRID(p.geom)), 4326)) AS longitude,
    -- '5151-<n>' with n a gap-free 1..N sequence handed out in random order, so the
    -- numbering is unique per row and carries no ordering information from picks.
    (split_part('11-26-5151', '-', 3) || '-' ||
        ROW_NUMBER() OVER (ORDER BY random()))::varchar(50)  AS vm_nr,
    ('Kat-' || p.field_3::text)::varchar(50)                 AS category,
    NULL::varchar(255)                                       AS layer,
    'pending'::varchar(50)                                   AS status,
    ('11-26-5151-' || ROUND(p.field_1::numeric, 2)::text || '-'
                   || ROUND(p.field_2::numeric, 2)::text)::varchar(100) AS target_id,
    ROUND(p.field_5::numeric, 2)::double precision           AS evaluated_depth
FROM p_11_26_5151_koeln_deutzerfeld.picks AS p
WHERE p.field_3 <> 4;
