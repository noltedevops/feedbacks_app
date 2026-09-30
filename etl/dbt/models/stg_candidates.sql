{#- Every row of every configured source, mapped to the anomalies columns.
    One UNION ALL branch per source, generated from etl/config/projects.yml.
    lat/lon come from the source coordinates before any coord_round, in the project's
    own SRID. -#}
{{ config(materialized='view') }}
{%- set projects = var('etl')['projects'] -%}
{% for p in projects %}{% set pl = loop %}{% for s in p['sources'] %}
{%- set c = s['columns'] %}
select
    '{{ p['project_id'] }}'::varchar(50)                         as project_id,
    '{{ s['table'] }}'::text                                      as source_table,
    {{ loop.index }}                                              as source_prio,
    {% if s.get('key') %}{{ adapter.quote(s['key']) }}::text{% else %}null::text{% endif %} as source_key,
    '{{ s['instrument'] }}'::varchar(50)                          as instrument,
    {{ etl_coord(etl_col(c['easting']), s) }}::float8             as easting,
    {{ etl_coord(etl_col(c['northing']), s) }}::float8            as northing,
    ST_Y(ST_Transform(ST_SetSRID(ST_MakePoint(({{ etl_col(c['easting']) }})::float8,
         ({{ etl_col(c['northing']) }})::float8), {{ p['srid'] }}), 4326)) as latitude,
    ST_X(ST_Transform(ST_SetSRID(ST_MakePoint(({{ etl_col(c['easting']) }})::float8,
         ({{ etl_col(c['northing']) }})::float8), {{ p['srid'] }}), 4326)) as longitude,
    ({{ etl_col(c['depth']) }})::float8                           as evaluated_depth,
    {{ etl_category(c['category']) }}                             as category,
    ({{ etl_col(c.get('layer')) }})::text                         as layer,
    ({{ etl_target_id(p, s) }})::varchar(100)                     as target_id
from {{ adapter.quote(p['schema']) }}.{{ adapter.quote(s['table']) }}
where ({{ etl_col(c['easting']) }}) is not null and ({{ etl_col(c['northing']) }}) is not null
  {%- if s.get('where') %} and ({{ s['where'] }}){% endif %}
{% if not (pl.last and loop.last) %}union all{% endif %}
{% endfor %}{% endfor %}
