/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * JOURNEYS · learned ETA, corridor deviation, and the "arrived at the origin" bug
 *
 * `domain/journey.ts` is pure and had no tests (FR-042). The case that matters
 * most is the last: the store seeds a journey's corridor with the ONE fix the
 * traveller is standing on, and `journeyStatus` treated the last corridor point
 * as the destination — so every active journey read "Arrived" at its own front
 * door, and the DEADMAN escalation never had a valid input.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARRIVAL_RADIUS_M,
  CORRIDOR_TOLERANCE_M,
  corridorDeviationM,
  emptyRouteHistory,
  journeyStatus,
  predictEta,
  recordRouteDuration,
  routeKey,
} from '../src/domain/journey.ts';
import type { Journey } from '../src/core/types.ts';

const NOW = 1_700_000_000_000;
const HOME = { lat: 20.9463, lon: 72.952 };
const STATION = { lat: 20.9520, lon: 72.9300 }; // ~2.4 km west
const MIDWAY = { lat: (HOME.lat + STATION.lat) / 2, lon: (HOME.lon + STATION.lon) / 2 };

function journey(over: Partial<Journey> = {}): Journey {
  return {
    id: 'j1',
    familyId: 'f1',
    memberId: 'm1',
    label: 'Home from the station',
    startedAt: NOW,
    etaAt: NOW + 20 * 60_000,
    arrivedAt: null,
    originName: 'Navsari station',
    destName: 'Home',
    corridorPoints: [STATION],
    state: 'active',
    checkInIntervalS: null,
    lastCheckInAt: null,
    ...over,
  };
}

const fix = (p: { lat: number; lon: number }, at = NOW + 60_000, accuracyM = 10) => ({ ...p, at, accuracyM });

// ── journeyStatus ─────────────────────────────────────────────────────────────

test('★ t0-10 · a one-point corridor is the ORIGIN: standing on it is not "arrived"', () => {
  const j = journey({ corridorPoints: [STATION] });
  assert.equal(journeyStatus(j, fix(STATION)), 'on_track');
  // …and neither is coming back to it later.
  assert.equal(journeyStatus(j, fix(STATION, NOW + 5 * 60_000)), 'on_track');
});

test('an empty corridor cannot be arrived at or deviated from', () => {
  const j = journey({ corridorPoints: [] });
  assert.equal(journeyStatus(j, fix(HOME)), 'on_track');
  assert.equal(journeyStatus(j, fix({ lat: 21.5, lon: 73.5 })), 'on_track');
});

test('with two or more corridor points the LAST one is the destination', () => {
  const j = journey({ corridorPoints: [STATION, MIDWAY, HOME] });
  assert.equal(journeyStatus(j, fix(HOME)), 'arrived');
  assert.equal(journeyStatus(j, fix(STATION)), 'on_track', 'the first point is still the origin');
  // Just outside the arrival radius (+ accuracy) is not arrived.
  const justOutside = { lat: HOME.lat + (ARRIVAL_RADIUS_M + 60) / 111_320, lon: HOME.lon };
  assert.equal(journeyStatus(j, fix(justOutside, NOW + 60_000, 10)), 'on_track');
});

test('precedence: arrived beats overdue beats deviated beats on_track', () => {
  const late = NOW + 60 * 60_000;
  const j = journey({ corridorPoints: [STATION, HOME] });
  assert.equal(journeyStatus(j, fix(HOME, late)), 'arrived');
  assert.equal(journeyStatus(j, fix({ lat: 21.2, lon: 73.2 }, late)), 'overdue', 'late AND off-route reports overdue');
  assert.equal(journeyStatus(j, fix({ lat: 21.2, lon: 73.2 })), 'deviated');
  assert.equal(journeyStatus(j, fix(MIDWAY)), 'on_track');
});

test('overdue needs the ETA plus a grace of at least five minutes', () => {
  const j = journey({ corridorPoints: [STATION, HOME], etaAt: NOW + 20 * 60_000 });
  assert.equal(journeyStatus(j, fix(MIDWAY, NOW + 22 * 60_000)), 'on_track', 'two minutes late is traffic');
  assert.equal(journeyStatus(j, fix(MIDWAY, NOW + 26 * 60_000)), 'overdue');
});

test('a missed check-in is a missed arrival half a policy early (DEADMAN evidence)', () => {
  const j = journey({ corridorPoints: [STATION, HOME], etaAt: null, checkInIntervalS: 600, lastCheckInAt: NOW });
  assert.equal(journeyStatus(j, fix(MIDWAY, NOW + 14 * 60_000)), 'on_track');
  assert.equal(journeyStatus(j, fix(MIDWAY, NOW + 16 * 60_000)), 'overdue');
});

test('a cancelled or completed journey owes nobody an arrival', () => {
  assert.equal(journeyStatus(journey({ state: 'cancelled' }), fix(MIDWAY)), 'arrived');
  assert.equal(journeyStatus(journey({ arrivedAt: NOW + 1 }), fix(MIDWAY)), 'arrived');
});

// ── corridor geometry ─────────────────────────────────────────────────────────

test('corridorDeviationM is 0 for no corridor, ~0 on the line, and the perpendicular distance off it', () => {
  assert.equal(corridorDeviationM(HOME, []), 0);
  const corridor = [STATION, HOME];
  assert.ok(corridorDeviationM(MIDWAY, corridor) < 1, 'a point on the segment');
  const north = { lat: MIDWAY.lat + 300 / 111_320, lon: MIDWAY.lon };
  const d = corridorDeviationM(north, corridor);
  assert.ok(d > 250 && d < 350, `300 m north of the corridor measured ${d.toFixed(0)} m`);
  assert.ok(d > CORRIDOR_TOLERANCE_M, 'and that is outside the base tolerance');
});

// ── learned ETA ───────────────────────────────────────────────────────────────

test('predictEta has no opinion without history, and never invents an ETA', () => {
  const p = predictEta(emptyRouteHistory('k'), NOW);
  assert.equal(p.confidence, 0);
  assert.equal(p.etaAt, NOW);
  assert.equal(p.samples, 0);
  assert.ok(p.overdueAt >= NOW + 5 * 60_000, 'even "no opinion" carries the minimum grace');
});

test('predictEta learns a well-worn route and ignores one grocery stop (median + MAD)', () => {
  let h = emptyRouteHistory('k');
  for (let i = 0; i < 8; i++) h = recordRouteDuration(h, 1200 + (i % 3) * 30, NOW - (8 - i) * 86_400_000);
  const steady = predictEta(h, NOW);
  assert.ok(steady.medianS >= 1200 && steady.medianS <= 1260, `median ${steady.medianS}`);
  assert.ok(steady.confidence > 0.5, `confidence ${steady.confidence}`);

  const withOutlier = recordRouteDuration(h, 1200 + 40 * 60, NOW - 3600_000);
  const p = predictEta(withOutlier, NOW);
  assert.ok(Math.abs(p.medianS - steady.medianS) <= 60, 'one 40-minute stop must not move the estimate');
  assert.ok(p.etaAt > NOW && p.overdueAt > p.etaAt);
});

test('recordRouteDuration rejects nonsense and keeps the most recent 24 trips', () => {
  let h = emptyRouteHistory('k');
  h = recordRouteDuration(h, 0, NOW);
  h = recordRouteDuration(h, -5, NOW);
  h = recordRouteDuration(h, Number.NaN, NOW);
  assert.equal(h.samples.length, 0);
  for (let i = 0; i < 30; i++) h = recordRouteDuration(h, 600 + i, NOW + i);
  assert.equal(h.samples.length, 24);
  assert.equal(h.samples[0].durationS, 606, 'the oldest six were dropped');
});

test('routeKey is a local lookup key, not a coordinate', () => {
  assert.equal(routeKey('  Navsari Station ', 'home'), routeKey('navsari station', 'HOME'));
  assert.doesNotMatch(routeKey('a', 'b'), /\d+\.\d+/);
});
