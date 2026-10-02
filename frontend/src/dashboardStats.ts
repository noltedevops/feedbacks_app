// The Dashboard's KPI rules, kept apart from any component so the same rule is applied
// everywhere a figure appears (stat tiles, charts, log cards, map popup, 3D view) and
// so the arithmetic can be tested without a browser (dashboardStats.test.ts).
//
// One convention throughout: a figure with nothing measured behind it is null, shown
// as N/A - never 0, which would read as a measurement (a perfect error, an empty pit).
import type { LocalPoint } from './db/indexedDb';

// Targets whose calculated depth is under this sit within reach of an excavator bucket
// or a fence post, and are flagged as shallow hazards.
export const SHALLOW_HAZARD_DEPTH_M = 0.4;

// Sohle compliance at or above this share reads as on track.
export const SOHLE_COMPLIANCE_TARGET_PCT = 80;

// A target counts as excavated once a field crew has filed its opening record. Sohle,
// Fundstück and the actual measurements all live on that record, so nothing derived from
// them exists before it.
export const hasExcavation = (p: LocalPoint): boolean =>
  !!p.local_status && p.local_status !== 'unvisited' && !!p.feedback;

export const isShallowHazard = (p: LocalPoint): boolean =>
  p.evaluated_depth != null && p.evaluated_depth > 0 && p.evaluated_depth < SHALLOW_HAZARD_DEPTH_M;

// A shallow target stays a hazard until a crew has opened it.
export const isOpenShallowHazard = (p: LocalPoint): boolean => isShallowHazard(p) && !hasExcavation(p);

// Sohle is certified clear only when the crew recorded it so. A record with no Sohle
// status is not a clearance: it counts as not clear, in every figure that reads it.
export function isSohleClear(status: string | null | undefined): boolean {
  const s = (status ?? '').toLowerCase().trim();
  return s === 'frei' || s === 'clear';
}

/** Share of excavated targets with a clear Sohle, in whole percent; null with none dug. */
export function sohleCompliance(excavated: LocalPoint[]): number | null {
  if (excavated.length === 0) return null;
  const clear = excavated.filter(p => isSohleClear(p.feedback?.sohle_status)).length;
  return Math.round((clear / excavated.length) * 100);
}

export interface AccuracyStats {
  /** Mean |evaluated - actual| in m, over targets with both depths. */
  meanDepthError: number | null;
  /** Mean (evaluated - actual) in m: positive means the survey placed targets too deep. */
  bias: number | null;
  /** Share of excavated targets that turned up nothing (ohne Fund), whole percent. */
  falsePositiveRate: number | null;
  /** Georadar: (sum actual / sum evaluated - 1) in percent. */
  gprVelocityDrift: number | null;
  /** Magnetics: mean |evaluated - actual| in m. */
  magError: number | null;
}

export function accuracyStats(excavated: LocalPoint[]): AccuracyStats {
  let absSum = 0, biasSum = 0, pairs = 0, empty = 0;
  let gprActual = 0, gprEval = 0, gprPairs = 0;
  let magAbs = 0, magPairs = 0;

  for (const p of excavated) {
    if (p.feedback?.fundstueck === 'ohne Fund') empty++;
    const evalD = p.evaluated_depth;
    const actual = p.feedback?.actual_depth;
    if (evalD == null || actual == null) continue;

    absSum += Math.abs(evalD - actual);
    biasSum += evalD - actual;
    pairs++;

    const inst = (p.instrument ?? '').toLowerCase();
    if (inst.includes('radar')) {
      if (evalD > 0 && actual > 0) { gprActual += actual; gprEval += evalD; gprPairs++; }
    } else if (inst.includes('mag')) {
      magAbs += Math.abs(evalD - actual);
      magPairs++;
    }
  }

  return {
    meanDepthError: pairs ? absSum / pairs : null,
    bias: pairs ? biasSum / pairs : null,
    falsePositiveRate: excavated.length ? Math.round((empty / excavated.length) * 100) : null,
    gprVelocityDrift: gprPairs && gprEval > 0 ? (gprActual / gprEval - 1) * 100 : null,
    magError: magPairs ? magAbs / magPairs : null
  };
}

export interface VolumeStats {
  /** Sum of recorded pit volumes, m³. */
  total: number | null;
  /** Mean recorded pit volume, m³. */
  meanPit: number | null;
  /** Finds (anything but ohne Fund) per m³ dug, over pits whose volume was recorded. */
  findsPerM3: number | null;
}

export function volumeStats(excavated: LocalPoint[]): VolumeStats {
  let total = 0, pits = 0, finds = 0;
  for (const p of excavated) {
    const vol = p.feedback?.m_cube;
    if (vol == null || vol <= 0) continue;
    total += vol;
    pits++;
    const fund = p.feedback?.fundstueck;
    if (fund && fund !== 'ohne Fund') finds++;
  }
  return {
    total: pits ? total : null,
    meanPit: pits ? total / pits : null,
    findsPerM3: pits ? finds / total : null
  };
}
