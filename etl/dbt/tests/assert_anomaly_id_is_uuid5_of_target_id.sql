-- Identity rule: every anomaly's id is uuid5(NAMESPACE_DNS, target_id). The runner fills
-- etl.id_registry with Python's uuid.uuid5 for every target_id in public.anomalies, so
-- any row returned here breaks the rule, and feedback would stop resolving.
select a.id, a.target_id, r.id as expected_id
from {{ source('app', 'anomalies') }} a
left join {{ source('etl', 'id_registry') }} r on r.target_id = a.target_id
where r.id is distinct from a.id
