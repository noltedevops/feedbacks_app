// Run with: npm test (node --test; Node strips the types, no build step).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LocalPoint } from '../src/db/indexedDb';
import {
  accuracyStats,
  hasExcavation,
  isOpenShallowHazard,
  isShallowHazard,
  isSohleClear,
  sohleCompliance,
  volumeStats
} from '../src/dashboardStats.ts';

type Fb = Partial<NonNullable<LocalPoint['feedback']>>;

const pending = (over: Partial<LocalPoint> = {}): LocalPoint =>
  ({ id: 'p', local_status: 'unvisited', feedback: null, ...over }) as unknown as LocalPoint;

const dug = (fb: Fb, over: Partial<LocalPoint> = {}): LocalPoint =>
  ({ id: 'd', local_status: 'investigated', feedback: { visited: true, ...fb }, ...over }) as unknown as LocalPoint;

test('hasExcavation needs an investigated status and a record', () => {
  assert.equal(hasExcavation(pending()), false);
  assert.equal(hasExcavation(dug({})), true);
  assert.equal(hasExcavation(pending({ local_status: 'investigated' })), false);
});

test('isSohleClear: missing status is not a clearance', () => {
  assert.equal(isSohleClear('Frei'), true);
  assert.equal(isSohleClear(' frei '), true);
  assert.equal(isSohleClear('Clear'), true);
  assert.equal(isSohleClear('Nicht Frei'), false);
  assert.equal(isSohleClear(null), false);
  assert.equal(isSohleClear(undefined), false);
  assert.equal(isSohleClear(''), false);
});

test('sohleCompliance counts a missing status as not clear, and is null with nothing dug', () => {
  assert.equal(sohleCompliance([]), null);
  const pts = [dug({ sohle_status: 'Frei' }), dug({ sohle_status: 'frei' }), dug({ sohle_status: 'Nicht Frei' }), dug({})];
  assert.equal(sohleCompliance(pts), 50);
});

test('shallow hazards: under 0.4 m, above 0, and open only until dug', () => {
  assert.equal(isShallowHazard(pending({ evaluated_depth: 0.39 })), true);
  assert.equal(isShallowHazard(pending({ evaluated_depth: 0.4 })), false);
  assert.equal(isShallowHazard(pending({ evaluated_depth: 0 })), false);
  assert.equal(isShallowHazard(pending({ evaluated_depth: null })), false);
  assert.equal(isOpenShallowHazard(pending({ evaluated_depth: 0.2 })), true);
  assert.equal(isOpenShallowHazard(dug({}, { evaluated_depth: 0.2 })), false);
});

test('accuracyStats: null, not 0, with no depth pairs', () => {
  const s = accuracyStats([dug({ fundstueck: 'Eisenteil' })]);
  assert.equal(s.meanDepthError, null);
  assert.equal(s.bias, null);
  assert.equal(s.gprVelocityDrift, null);
  assert.equal(s.magError, null);
  assert.equal(s.falsePositiveRate, 0);
  assert.equal(accuracyStats([]).falsePositiveRate, null);
});

test('accuracyStats: error, bias, FPR, radar drift and magnetics error', () => {
  const s = accuracyStats([
    dug({ actual_depth: 1.0, fundstueck: 'ohne Fund' }, { evaluated_depth: 0.8, instrument: 'Georadar' }),
    dug({ actual_depth: 1.2, fundstueck: 'Eisenteil' }, { evaluated_depth: 1.2, instrument: 'Georadar' }),
    dug({ actual_depth: 0.5, fundstueck: 'Steine' }, { evaluated_depth: 0.8, instrument: 'Magnetic' }),
    dug({ fundstueck: 'ohne Fund' }, { evaluated_depth: 0.6, instrument: 'Magnetic' })
  ]);
  assert.ok(Math.abs(s.meanDepthError! - (0.2 + 0 + 0.3) / 3) < 1e-9);
  assert.ok(Math.abs(s.bias! - (-0.2 + 0 + 0.3) / 3) < 1e-9);
  assert.equal(s.falsePositiveRate, 50);
  assert.ok(Math.abs(s.gprVelocityDrift! - ((2.2 / 2.0) - 1) * 100) < 1e-9);
  assert.ok(Math.abs(s.magError! - 0.3) < 1e-9);
});

test('volumeStats: null with no recorded volume; only recorded pits count', () => {
  assert.deepEqual(volumeStats([dug({})]), { total: null, meanPit: null, findsPerM3: null });
  const v = volumeStats([
    dug({ m_cube: 2, fundstueck: 'Eisenteil' }),
    dug({ m_cube: 2, fundstueck: 'ohne Fund' }),
    dug({ fundstueck: 'Eisenteil' }),
    dug({ m_cube: 0, fundstueck: 'Steine' })
  ]);
  assert.equal(v.total, 4);
  assert.equal(v.meanPit, 2);
  assert.equal(v.findsPerM3, 0.25);
});
