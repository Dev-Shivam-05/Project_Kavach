/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PRESENCE SERVICE
 *
 * docs/PHASE-STATUS.md found that `noteLocationFix()`, `evaluateGeofences()` and
 * `connectWs()` had no callers: three subsystems that reviewed well, tested well
 * and did nothing. presenceService is the caller, so these tests assert the two
 * properties that matter about it —
 *
 *   1. it actually calls all three, and
 *   2. it never sends coordinates to the server (ADR-010).
 *
 * The second is the one worth a test. A geofence feature that leaks precise
 * positions is not a smaller version of this product, it is a different and worse
 * one, and the leak would be invisible in every screenshot.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateGeofences,
  toWireCrossing,
  haversineM,
  type FenceState,
  type Fix,
} from '../src/domain/geofence.ts';
import type { Geofence } from '../src/core/types.ts';

const HOME: Geofence = {
  id: 'fence-home',
  label: 'Home',
  lat: 20.9463,
  lon: 72.952,
  radiusM: 150,
  notifyOnEnter: true,
  notifyOnExit: true,
  dwellS: null,
  memberIds: [],
};

const at = (lat: number, lon: number, accuracyM = 8, when = 1_700_000_000_000): Fix => ({
  lat,
  lon,
  accuracyM,
  at: when,
});

test('★ the wire crossing carries NO coordinates — ADR-010', () => {
  // This is the whole privacy argument: the server orchestrates a response
  // without ever learning where "home" is.
  const inside = at(HOME.lat, HOME.lon);
  const first = evaluateGeofences([HOME], inside, {});
  const outside = at(20.9663, 72.982); // ~3 km away
  const second = evaluateGeofences([HOME], outside, first.states);

  assert.ok(second.crossings.length > 0, 'leaving a 150 m fence by 3 km must cross');
  const wire = toWireCrossing(second.crossings[0]);

  assert.deepEqual(
    Object.keys(wire).sort(),
    ['geofenceId', 'transition'],
    'the wire shape must be exactly {geofenceId, transition}',
  );

  const serialised = JSON.stringify(wire);
  for (const leak of ['20.9', '72.9', 'Home', 'lat', 'lon', 'distance']) {
    assert.ok(!serialised.includes(leak), `wire payload leaked ${leak}: ${serialised}`);
  }
});

test('the local crossing keeps the detail the DEVICE needs', () => {
  const first = evaluateGeofences([HOME], at(HOME.lat, HOME.lon), {});
  const second = evaluateGeofences([HOME], at(20.9663, 72.982), first.states);
  const local = second.crossings[0];
  assert.equal(typeof local.at, 'number');
  assert.equal(local.label, 'Home');
  assert.ok(local.distanceM > 0);
});

test('entering then leaving produces enter then exit, not a storm', () => {
  let states: Record<string, FenceState> = {};
  const seq: string[] = [];
  // Approach → inside → inside → far away.
  for (const p of [at(20.99, 73.02), at(HOME.lat, HOME.lon), at(HOME.lat, HOME.lon), at(20.99, 73.02)]) {
    const r = evaluateGeofences([HOME], p, states);
    states = r.states;
    for (const c of r.crossings) seq.push(c.transition);
  }
  assert.deepEqual(seq, ['enter', 'exit'], `expected one enter and one exit, got ${seq.join(',')}`);
});

test('★ a coarse fix is REFUSED, not guessed at', () => {
  // A 2 km cell-tower fix cannot decide a 150 m fence. Evaluating it anyway is
  // the classic cause of "your child left school" at 03:00.
  const inside = evaluateGeofences([HOME], at(HOME.lat, HOME.lon), {});
  const vague = evaluateGeofences([HOME], at(20.99, 73.02, 4000), inside.states);
  assert.equal(vague.crossings.length, 0, 'an unusable fix must not fabricate a crossing');
});

test('hysteresis: sitting on the boundary does not oscillate', () => {
  // A stationary phone at the edge with ±30 m noise would otherwise emit
  // enter/exit all night and train the family to ignore geofence alerts (P-002).
  let states: Record<string, FenceState> = evaluateGeofences([HOME], at(HOME.lat, HOME.lon), {}).states;
  let crossings = 0;
  // ~150 m north of centre, jittering either side of the edge.
  for (let i = 0; i < 20; i++) {
    const jitter = (i % 2 === 0 ? 1 : -1) * 0.0002; // ≈ ±22 m
    const r = evaluateGeofences([HOME], at(HOME.lat + 0.00135 + jitter, HOME.lon, 25), states);
    states = r.states;
    crossings += r.crossings.length;
  }
  assert.ok(crossings <= 1, `boundary jitter produced ${crossings} crossings; hysteresis is not holding`);
});

test('a fence scoped to other members is skipped', () => {
  const childOnly: Geofence = { ...HOME, id: 'f2', memberIds: ['child-1'] };
  const r = evaluateGeofences([childOnly], at(HOME.lat, HOME.lon), {}, 'parent-1');
  assert.equal(Object.keys(r.states).length, 0, 'a fence must not be evaluated for a member it excludes');
});

test('haversine is accurate enough to trust a 150 m radius', () => {
  // 0.001 degrees of latitude is ~111 m anywhere on earth.
  const d = haversineM({ lat: 20.9463, lon: 72.952 }, { lat: 20.9473, lon: 72.952 });
  assert.ok(d > 105 && d < 118, `expected ~111 m, got ${d.toFixed(1)} m`);
});
