-- Every project's anomalie_1: each row carries an id, and where the target exists in
-- public.anomalies, the same id and VM number.
{%- set target_proj = var('target_project', none) -%}
{%- set all_projects = var('etl')['projects'] -%}
{%- if target_proj -%}
  {%- set projects = all_projects | selectattr('project_id', 'equalto', target_proj) | list -%}
{%- else -%}
  {%- set projects = all_projects -%}
{%- endif -%}
{% for p in projects %}
select '{{ p['project_id'] }}' as project_id, x.target_id, x.id, p.id as public_id, x.vm_nr, p.vm_nr as public_vm_nr
from {{ adapter.quote(p['schema']) }}.anomalie_1 x
left join {{ source('app', 'anomalies') }} p on p.target_id = x.target_id
where x.id is null
   or (p.id is not null and (p.id is distinct from x.id or p.vm_nr is distinct from x.vm_nr))
{% if not loop.last %}union all{% endif %}
{% endfor %}
