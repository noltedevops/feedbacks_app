{#- One candidate per target. Duplicates collapse: config order first, then layer,
    source key and position, compared byte-wise. The id comes from the uuid5 registry
    the runner fills, or, after an approved coordinate correction, from the alias to the
    existing anomaly (which also keeps that anomaly's target_id). -#}
{{ config(materialized='table',
          indexes=[{'columns': ['id'], 'unique': True},
                   {'columns': ['source_target_id'], 'unique': True},
                   {'columns': ['project_id']}]) }}
with ranked as (
    select c.*,
           row_number() over (partition by project_id, target_id
                              order by source_prio, layer collate "C" nulls first,
                                       source_key collate "C" nulls first, easting, northing) as rn,
           count(*) over (partition by project_id, target_id) as dup_n
    from {{ ref('stg_candidates') }} c
    where c.category is not null
)
select r.project_id, r.source_table, r.source_prio, r.source_key, r.instrument,
       r.easting, r.northing, r.latitude, r.longitude, r.evaluated_depth, r.category, r.layer,
       r.target_id                          as source_target_id,
       coalesce(al.anomaly_id, ir.id)       as id,
       coalesce(pa.target_id, r.target_id)  as target_id,
       al.anomaly_id is not null            as via_alias,
       r.dup_n
from ranked r
left join {{ source('etl', 'target_alias') }} al on al.source_target_id = r.target_id
left join {{ source('etl', 'id_registry') }}  ir on ir.target_id = r.target_id
left join {{ source('app', 'anomalies') }}    pa on pa.id = al.anomaly_id
where r.rn = 1
