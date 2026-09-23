{#- Source rows left out because their category is null and no fallback resolves it.
    Never guessed; listed in every run report. -#}
{{ config(materialized='view') }}
select project_id, source_table, source_key, easting, northing, layer, target_id
from {{ ref('stg_candidates') }}
where category is null
