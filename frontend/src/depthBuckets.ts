// The dashboard's depth filter, shared by the Dashboard component and App's filtered
// lists so both narrow targets identically. Kept out of Dashboard.tsx so that file
// exports only its component (React fast refresh).
import { type LocalPoint } from './db/indexedDb';

// Depth buckets for the dashboard depth filter. Edges are inclusive-low /
// exclusive-high - [0,0.5), [0.5,1.0), [1.0,1.5), [1.5,inf) - so a target at exactly
// 0.5 m lands in the second bucket and never in two at once. The range labels stay
// German in both language modes because the crew reads them as fixed depth classes;
// only the "all" entry is ordinary UI text, translated through depthBucketLabel().
export const DEPTH_BUCKETS: { id: string; label: string; min: number; max: number | null }[] = [
  { id: 'all', label: 'All depths', min: 0, max: null },
  { id: '0-0.5', label: '0 – 0,5 m', min: 0, max: 0.5 },
  { id: '0.5-1', label: '0,5 – 1,0 m', min: 0.5, max: 1.0 },
  { id: '1-1.5', label: '1,0 – 1,5 m', min: 1.0, max: 1.5 },
  { id: '1.5+', label: '> 1,5 m', min: 1.5, max: null }
];

// Which depth column a bucket reads has to follow the status selection: `tief` (the
// actual excavated depth) is null until a target is opened, so filtering pending
// targets on it would make every one of them disappear.
function resolveDepth(point: LocalPoint, filterStatus: string): number | null {
  const actual = point.feedback?.actual_depth ?? null;   // tief
  const evaluated = point.evaluated_depth ?? null;       // errechnete Tiefe
  if (filterStatus === 'pending') return evaluated;
  if (filterStatus === 'investigated') return actual;
  return actual ?? evaluated;                            // all: actual wins, else calculated
}

// Shared by every dashboard dataset so the cards, the log list and the map markers all
// narrow identically. `all` is the only value that imposes no constraint; under any
// specific bucket a target with no value on the relevant column is excluded.
export function matchesDepthBucket(point: LocalPoint, bucketId: string, filterStatus: string): boolean {
  if (bucketId === 'all') return true;
  const bucket = DEPTH_BUCKETS.find(b => b.id === bucketId);
  if (!bucket) return true;

  const depth = resolveDepth(point, filterStatus);
  if (depth === null || Number.isNaN(depth)) return false;

  return depth >= bucket.min && (bucket.max === null || depth < bucket.max);
}
