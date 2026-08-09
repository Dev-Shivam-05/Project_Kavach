/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * JOURNEY PREDICTION & CORRIDOR DEVIATION — FR-042
 *
 * Two jobs, both entirely on-device (Journey.corridorPoints is Class A and is
 * never synced — see core/types and ADR-010):
 *
 *  1. LEARNED ETA. The commute from Navsari station to the house takes what it
 *     takes; a maps API's idea of it is a stranger's guess. We keep the family's
 *     own history of that route and predict from it.
 *  2. CORRIDOR DEVIATION. If the position leaves the polyline the route usually
 *     follows by more than the tolerance, the journey "looks off".
 *
 * ★ WHY MEDIAN + MAD RATHER THAN MEAN + σ ★
 * One trip where she stopped for groceries adds 40 minutes. A mean is destroyed
 * by that sample and every subsequent trip looks early; σ inflates until nothing
 * is ever late and the feature quietly stops working. The median ignores it and
 * MAD (median absolute deviation) measures spread without ever seeing it. This
 * is the same false-positive discipline as P-002 applied to time instead of
 * sensors: a predictor that cries wolf is a predictor the family switches off.
 *
 * ★ WHY THIS IS "MARKOV-ISH" AND NOT A MODEL ★
 * Prediction is conditioned on the one state variable that actually moves the
 * distribution — peak versus off-peak departure — and weights recent trips more
 * heavily (exponential decay), because roads change. That is the whole model. It
 * is inspectable, it runs in microseconds, and it degrades to "no opinion" when
 * it has not seen enough trips, which is the honest answer (PRD §3.3: alert one
 * family member with "Priya's journey looks off — can someone call her?", never
 * escalate a machine's guess).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import type { Journey } from '../core/types';
import { haversineM, type Fix, type GeoPoint } from './geofence';

export interface RouteSample {
  durationS: number;
  /** Departure wall-clock. Conditions the prediction on peak vs off-peak. */
  startedAt: number;
}

export interface RouteHistory {
  /** Local-only identity for an origin→destination pair. Never transmitted. */
  routeKey: string;
  samples: RouteSample[];
  updatedAt: number;
}

export interface EtaPrediction {
  /** Best estimate of arrival, epoch ms. */
  etaAt: number;
  /** When silence stops being normal and becomes a missed arrival, epoch ms. */
  overdueAt: number;
  medianS: number;
  /** Median absolute deviation, seconds. The honest spread of this route. */
  madS: number;
  samples: number;
  /** 0 = no opinion (use the traveller's own ETA); 1 = a well-worn route. */
  confidence: number;
}

/** Trips older than this stop informing the prediction — roads and jobs change. */
const HISTORY_LIMIT = 24;
/** Per-trip decay: the most recent trip counts ~7× a trip twelve journeys ago. */
const RECENCY_DECAY = 0.85;
/** Below this many samples in a bucket, do not condition on time of day. */
const MIN_BUCKET_SAMPLES = 3;
/** Never declare someone overdue on a rounding error. */
const MIN_OVERDUE_GRACE_S = 300;
/** Base corridor half-width. Wide enough for a lane change or a bus diversion. */
export const CORRIDOR_TOLERANCE_M = 200;
/** Within this of the last corridor point, the journey is finished. */
export const ARRIVAL_RADIUS_M = 120;

const EARTH_R_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function emptyRouteHistory(key: string, atMs: number = Date.now()): RouteHistory {
  return { routeKey: key, samples: [], updatedAt: atMs };
}

/**
 * Stable local key for an origin→destination pair. Place names are Class A; this
 * key is only ever a map lookup inside this device's own storage.
 */
export function routeKey(originName: string, destName: string): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return `${norm(originName)}␟${norm(destName)}`;
}

/** Append a completed trip, bounded to the most recent HISTORY_LIMIT. */
export function recordRouteDuration(
  history: RouteHistory,
  durationS: number,
  startedAt: number,
): RouteHistory {
  if (!Number.isFinite(durationS) || durationS <= 0) return history;
  const samples = [...history.samples, { durationS, startedAt }].slice(-HISTORY_LIMIT);
  return { routeKey: history.routeKey, samples, updatedAt: Date.now() };
}

/** Peak hours on the Navsari–Bilimora corridor: school run and evening return. */
function isPeak(atMs: number): boolean {
  const h = new Date(atMs).getHours();
  return (h >= 7 && h < 11) || (h >= 17 && h < 21);
}

/** Weighted median: the smallest value whose cumulative weight reaches half. */
function weightedMedian(pairs: { value: number; weight: number }[]): number {
  if (pairs.length === 0) return 0;
  const sorted = [...pairs].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, p) => s + p.weight, 0);
  if (total <= 0) return sorted[Math.floor(sorted.length / 2)].value;
  let acc = 0;
  for (const p of sorted) {
    acc += p.weight;
    if (acc >= total / 2) return p.value;
  }
  return sorted[sorted.length - 1].value;
}

function normaliseHistory(
  history: RouteHistory | readonly number[] | readonly RouteSample[],
  now: number,
): RouteSample[] {
  if (Array.isArray(history)) {
    return (history as readonly (number | RouteSample)[]).map((s) =>
      typeof s === 'number' ? { durationS: s, startedAt: now } : s,
    );
  }
  const h = history as RouteHistory;
  return Array.isArray(h.samples) ? h.samples : [];
}

/**
 * Predict arrival from the family's own history of this route.
 *
 * Returns confidence 0 and etaAt === now when there is nothing to learn from;
 * the caller must then fall back to the traveller's declared ETA rather than
 * inventing one. Guessing quietly is how these features lose trust.
 */
export function predictEta(
  history: RouteHistory | readonly number[] | readonly RouteSample[],
  now: number = Date.now(),
): EtaPrediction {
  const all = normaliseHistory(history, now).filter(
    (s) => Number.isFinite(s.durationS) && s.durationS > 0,
  );

  if (all.length === 0) {
    return { etaAt: now, overdueAt: now + MIN_OVERDUE_GRACE_S * 1000, medianS: 0, madS: 0, samples: 0, confidence: 0 };
  }

  // Condition on departure bucket only when the bucket has enough evidence of
  // its own; otherwise a single rush-hour trip would define rush hour.
  const wantPeak = isPeak(now);
  const bucket = all.filter((s) => isPeak(s.startedAt) === wantPeak);
  const used = bucket.length >= MIN_BUCKET_SAMPLES ? bucket : all;

  // Newest sample carries weight 1; each older one decays.
  const weighted = used.map((s, i) => ({
    value: s.durationS,
    weight: RECENCY_DECAY ** (used.length - 1 - i),
  }));

  const medianS = weightedMedian(weighted);
  const madS = weightedMedian(
    weighted.map((p) => ({ value: Math.abs(p.value - medianS), weight: p.weight })),
  );

  // 1.4826·MAD is the consistent estimator of σ for normal data; three of them
  // is the "something has actually happened" line rather than "traffic".
  const robustSigmaS = 1.4826 * madS;
  const graceS = Math.max(MIN_OVERDUE_GRACE_S, 3 * robustSigmaS);

  const sampleFactor = Math.min(1, used.length / 6);
  const stability = medianS > 0 ? Math.max(0, 1 - robustSigmaS / medianS / 0.5) : 0;
  const confidence = Math.round(sampleFactor * Math.min(1, stability) * 100) / 100;

  return {
    etaAt: now + medianS * 1000,
    overdueAt: now + (medianS + graceS) * 1000,
    medianS: Math.round(medianS),
    madS: Math.round(madS),
    samples: used.length,
    confidence,
  };
}

// ── Corridor geometry ─────────────────────────────────────────────────────────

/**
 * Local equirectangular projection around `origin`. Over the few kilometres a
 * corridor segment spans, the error against the true geodesic is well under a
 * metre — far below GNSS accuracy — and it makes point-to-segment distance a
 * plain 2-D problem instead of a spherical one.
 */
function project(p: GeoPoint, origin: GeoPoint): { x: number; y: number } {
  return {
    x: EARTH_R_M * toRad(p.lon - origin.lon) * Math.cos(toRad(origin.lat)),
    y: EARTH_R_M * toRad(p.lat - origin.lat),
  };
}

function pointToSegmentM(p: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const P = project(p, a);
  const B = project(b, a);
  const len2 = B.x * B.x + B.y * B.y;
  if (len2 === 0) return haversineM(p, a); // degenerate segment
  // Clamped projection parameter: the closest point on the SEGMENT, not the line.
  const t = Math.max(0, Math.min(1, (P.x * B.x + P.y * B.y) / len2));
  const dx = P.x - t * B.x;
  const dy = P.y - t * B.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Shortest distance from a point to the corridor polyline, in metres.
 * Returns 0 for an empty corridor: with no route to compare against, nothing can
 * be a deviation, and the caller must not treat "no data" as "off route".
 */
export function corridorDeviationM(point: GeoPoint, corridor: readonly GeoPoint[]): number {
  if (corridor.length === 0) return 0;
  if (corridor.length === 1) return haversineM(point, corridor[0]);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < corridor.length - 1; i++) {
    const d = pointToSegmentM(point, corridor[i], corridor[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

export type JourneyStatus = 'on_track' | 'deviated' | 'overdue' | 'arrived';

/**
 * Classify a live journey against a fix.
 *
 * Precedence is arrived → overdue → deviated → on_track. A journey that is both
 * late and off-corridor reports `overdue` because time is the objective signal
 * and drives the DEADMAN policy; deviation alone is the soft, human-in-the-loop
 * path ("Priya's journey looks off — can someone call her?", PRD §3.3).
 *
 * `arrived` also covers a cancelled journey: the enum answers "does this journey
 * still owe the family an arrival?", and a cancelled one does not.
 */
export function journeyStatus(j: Journey, pos: Fix): JourneyStatus {
  const now = Number.isFinite(pos.at) ? pos.at : Date.now();

  if (j.arrivedAt !== null || j.state === 'arrived' || j.state === 'cancelled') return 'arrived';

  const dest = j.corridorPoints.length > 0 ? j.corridorPoints[j.corridorPoints.length - 1] : null;
  if (dest && haversineM(pos, dest) <= ARRIVAL_RADIUS_M + Math.max(0, pos.accuracyM)) {
    return 'arrived';
  }

  if (j.state === 'overdue') return 'overdue';

  if (j.etaAt !== null) {
    const plannedS = Math.max(0, (j.etaAt - j.startedAt) / 1000);
    const graceMs = Math.max(MIN_OVERDUE_GRACE_S, plannedS * 0.15) * 1000;
    if (now > j.etaAt + graceMs) return 'overdue';
  }

  // A missed check-in is the same failure as a missed arrival, half a policy
  // earlier: it is the DEADMAN trigger's evidence (core/policy DEADMAN).
  if (j.checkInIntervalS !== null && j.checkInIntervalS > 0) {
    const last = j.lastCheckInAt ?? j.startedAt;
    if (now - last > j.checkInIntervalS * 1000 * 1.5) return 'overdue';
  }

  if (j.corridorPoints.length >= 2) {
    const tolerance = CORRIDOR_TOLERANCE_M + 2 * Math.max(0, pos.accuracyM);
    if (corridorDeviationM(pos, j.corridorPoints) > tolerance) return 'deviated';
  }

  return 'on_track';
}
