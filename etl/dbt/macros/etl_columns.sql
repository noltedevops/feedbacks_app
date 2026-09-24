{#- Render one configured column as SQL over the source table (no alias).
    spec: none | "column" | {column, round} | {expr} | {column, fallback} -#}
{% macro etl_col(spec) -%}
  {%- if spec is none -%}NULL
  {%- elif spec is string -%}{{ adapter.quote(spec) }}
  {%- elif 'expr' in spec -%}({{ spec['expr'] }})
  {%- elif 'round' in spec -%}round({{ adapter.quote(spec['column']) }}::numeric, {{ spec['round'] }})
  {%- else -%}{{ adapter.quote(spec['column']) }}
  {%- endif -%}
{%- endmacro %}

{#- Category with the optional fallback rule. trailing_number: the digits at the end of
    the fallback column give Kat-<n>; anything else stays NULL and is not guessed. -#}
{% macro etl_category(spec) -%}
  {%- set base = etl_col(spec) ~ '::text' -%}
  {%- if spec is mapping and 'fallback' in spec -%}
    {%- set fb = spec['fallback'] -%}
    {%- if fb['rule'] != 'trailing_number' -%}
      {{ exceptions.raise_compiler_error("unknown category fallback rule: " ~ fb['rule']) }}
    {%- endif -%}
    coalesce({{ base }}, 'Kat-' || (substring({{ adapter.quote(fb['column']) }}::text from '([0-9]+)\s*$'))::int::text)
  {%- else -%}{{ base }}
  {%- endif -%}
{%- endmacro %}

{#- A coordinate as stored: rounded to coord_round first when the source sets it. -#}
{% macro etl_coord(expr, source) -%}
  {%- if source.get('coord_round') is not none -%}round(({{ expr }})::numeric, {{ source['coord_round'] }})
  {%- else -%}({{ expr }})
  {%- endif -%}
{%- endmacro %}

{#- target_id: <project_id>-<e>-<n>, id_decimals decimals, trailing zeros kept. -#}
{% macro etl_target_id(project, source) -%}
  {%- set cols = source['columns'] -%}
  {%- set idc = source.get('id_columns') or {} -%}
  {%- set e = etl_coord(adapter.quote(idc['easting']) if idc else etl_col(cols['easting']), source) -%}
  {%- set n = etl_coord(adapter.quote(idc['northing']) if idc else etl_col(cols['northing']), source) -%}
  '{{ project['project_id'] }}-' || round(({{ e }})::numeric, {{ source['id_decimals'] }})::text
    || '-' || round(({{ n }})::numeric, {{ source['id_decimals'] }})::text
{%- endmacro %}
