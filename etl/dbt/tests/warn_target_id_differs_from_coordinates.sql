-- A warning, not an error: a target moved in the field, or re-pointed by an approved
-- coordinate correction, keeps its target_id while its coordinates change.
{{ config(severity='warn') }}
select id, vm_nr, target_id, easting, northing
from {{ source('app', 'anomalies') }}
where target_id <> project_id || '-' || round(easting::numeric, 3)::text
                             || '-' || round(northing::numeric, 3)::text
