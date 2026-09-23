-- No feedback row may lose its anomaly, and the denormalised project_id / target_id must
-- agree with it.
select f.id, f.anomaly_id, f.project_id, f.target_id
from {{ source('app', 'feedback') }} f
left join {{ source('app', 'anomalies') }} a on a.id = f.anomaly_id
where a.id is null
   or f.project_id is distinct from a.project_id
   or f.target_id is distinct from a.target_id
