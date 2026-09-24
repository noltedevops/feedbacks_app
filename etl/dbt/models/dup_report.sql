{#- Positions produced by more than one source row; the first in int_candidates' order
    was kept. -#}
{{ config(materialized='view') }}
select project_id, target_id, count(*) as rows_n,
       string_agg(source_table || coalesce(':' || source_key, '') || ' / ' || coalesce(layer, '-'), ' | '
                  order by source_prio, layer collate "C" nulls first, source_key collate "C" nulls first) as rows
from {{ ref('stg_candidates') }}
where category is not null
group by 1, 2
having count(*) > 1
