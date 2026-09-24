-- The app owns these indexes on public.anomalies; the pipeline cannot create or drop
-- them (it does not own the table), so it checks they are there.
with required(indexname, kind) as (
    values ('anomalies_pkey', 'btree'),
           ('ix_anomalies_target_id', 'btree'),
           ('idx_anomalies_geom', 'gist')
)
select r.indexname, r.kind
from required r
where not exists (
    select 1 from pg_indexes i
    where i.schemaname = 'public' and i.tablename = 'anomalies'
      and i.indexname = r.indexname
      and i.indexdef ilike '%using ' || r.kind || '%'
)
