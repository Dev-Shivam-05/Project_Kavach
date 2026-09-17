/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RISK CONTEXT · the 0–4 integer that shortens the cancel window (PRD §13.5)
 *
 * `effectiveCancelWindowS` is tested; the derivation of its input was not. The
 * properties worth pinning: the neutral day scores 0, the PRD's worked example
 * (sister walking home at 21:40, unknown area, nobody near, monsoon, HR up)
 * scores high, adding a risk signal never LOWERS the level, and a person who
 * says she feels unsafe is never scored below "raised" by a sensor.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRisk,
  explainRisk,
  neutralRiskInputs,
  riskEffects,
  riskScore,
  RISK_WEIGHTS,
} from '../src/domain/riskContext.ts';
import type { RiskContextInputs, RiskLevel } from '../src/core/types.ts';

const NOON = Date.UTC(2026, 0, 1, 12, 0, 0) + new Date().getTimezoneOffset() * 60_000;

function inputs(over: Partial<RiskContextInputs> = {}): RiskContextInputs {
  return { ...neutralRiskInputs(NOON), ...over };
}

test('a neutral daytime at a familiar place is level 0', () => {
  assert.equal(computeRisk(inputs()), 0);
  assert.equal(riskScore(inputs()), 0);
});

test('the §13.5 worked example scores high', () => {
  const evening = inputs({
    hourOfDay: 21,
    locationClass: 'unknown',
    motionState: 'walking',
    blePeersNearby: 0,
    hrDeltaPct: 15,
    weatherAlert: true,
  });
  assert.ok(computeRisk(evening) >= 3, `expected high, got ${computeRisk(evening)}`);
  const why = explainRisk(evening);
  assert.equal(why[0], 'Unfamiliar area', 'strongest reason first');
  assert.ok(why.includes('Weather warning in force'));
});

test('every level 0..4 is reachable', () => {
  const seen = new Set<RiskLevel>();
  seen.add(computeRisk(inputs()));
  seen.add(computeRisk(inputs({ hourOfDay: 20 })));
  seen.add(computeRisk(inputs({ hourOfDay: 23, blePeersNearby: 0 })));
  seen.add(computeRisk(inputs({ hourOfDay: 23, locationClass: 'unknown', blePeersNearby: 0, motionState: 'walking' })));
  seen.add(computeRisk(inputs({ hourOfDay: 23, locationClass: 'unknown', blePeersNearby: 0, motionState: 'vehicle', hrDeltaPct: 30, weatherAlert: true })));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4]);
});

test('adding a risk signal never lowers the level (monotonic in inputs)', () => {
  const base = inputs({ hourOfDay: 20, locationClass: 'known', blePeersNearby: 1 });
  const b = computeRisk(base);
  const worse: Partial<RiskContextInputs>[] = [
    { hourOfDay: 23 },
    { locationClass: 'unknown' },
    { blePeersNearby: 0 },
    { motionState: 'vehicle' },
    { hrDeltaPct: 25 },
    { weatherAlert: true },
    { userDeclaredVulnerable: true },
  ];
  for (const w of worse) {
    assert.ok(computeRisk({ ...base, ...w }) >= b, `${JSON.stringify(w)} lowered the level`);
  }
  // And the two relieving signals are the only negative weights.
  assert.ok(RISK_WEIGHTS.locationHome < 0 && RISK_WEIGHTS.peersMany < 0);
  assert.ok(computeRisk(inputs({ hourOfDay: 20, locationClass: 'home', blePeersNearby: 3 })) <= computeRisk(inputs({ hourOfDay: 20 })));
});

test('"I feel unsafe" is never overruled below level 2 by the sensors', () => {
  assert.equal(computeRisk(inputs({ locationClass: 'home', blePeersNearby: 5, userDeclaredVulnerable: true })), 2);
  assert.ok(computeRisk(inputs({ hourOfDay: 23, locationClass: 'unknown', blePeersNearby: 0, userDeclaredVulnerable: true })) >= 3);
});

test('bad sensor values never throw and fall back to neutral', () => {
  assert.doesNotThrow(() => computeRisk(inputs({ hourOfDay: Number.NaN, blePeersNearby: Number.NaN, hrDeltaPct: Number.NaN })));
  assert.equal(computeRisk(inputs({ hourOfDay: Number.NaN })), computeRisk(inputs({ hourOfDay: 12 })));
});

test('effects tighten monotonically with the level: faster sampling, shorter window, lower fall threshold', () => {
  for (let l = 1; l <= 4; l++) {
    const prev = riskEffects((l - 1) as RiskLevel);
    const cur = riskEffects(l as RiskLevel);
    assert.ok(cur.samplingMs <= prev.samplingMs, `sampling at ${l}`);
    assert.ok(cur.cancelWindowFactor <= prev.cancelWindowFactor, `window at ${l}`);
    assert.ok(cur.fallThresholdG <= prev.fallThresholdG, `fall threshold at ${l}`);
  }
  assert.equal(riskEffects(99 as RiskLevel).samplingMs, riskEffects(0).samplingMs, 'an unknown level reads as 0');
});
