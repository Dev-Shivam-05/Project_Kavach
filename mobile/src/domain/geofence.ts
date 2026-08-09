/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * GEOFENCE EVALUATION — ADR-010
 *
 * ★★★ THIS RUNS ON-DEVICE AND THE COORDINATES NEVER LEAVE IT ★★★
 * `local_geofence` holds full precise coordinates in on-device storage and is
 * NEVER synced (docs/02 §2.2.4, §2.8 storage table). A crossing emits exactly
 * `{ geofenceId, transition }` — an opaque uuid and an enum, Class B — and
 * nothing else. That is the whole reason a family can use geofences here without
 * handing a server the home address, the school, the temple, and ten years of
 * daily routine (docs/01 §87).
 *
 * `toWireCrossing()` is the only function whose output may be transmitted. If
 * you find yourself wanting to send `distanceM` or the fence label "for the
 * timeline", compose that string on the receiving device from its own copy of
 * the fence — that is what the E2EE group state is for.
 *
 * Two design choices carry the false-positive budget (P-002, FR-002):
 *
 *  1. HYSTERESIS. Enter and exit use different thresholds, widened by the fix's
 *     own accuracy. A stationary phone at the boundary with ±30 m noise would
 *     otherwise emit enter/exit/enter/exit all night and train the family to
 *     ignore geofence alerts entirely.
 *  2. COARSE FIXES ARE REFUSED, NOT GUESSED. A 2 km cell-tower fix cannot decide
 *     a 150 m fence. Evaluating it anyway is the classic cause of "your child
 *     left school" at 03:00. We hold the previous state and wait for a real fix.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import type { Geofence, UUID } from '../core/types';

export type FenceTransition = 'enter' | 'exit' | 'dwell';

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** A position fix. `accuracyM` is the 68% confidence radius reported by the OS. */
export interface Fix extends GeoPoint {
  accuracyM: number;
  at: number;
}

/**
 * Per-fence, per-member membership state. Persisted locally between evaluations;
 * without it every app restart would replay an "entered Home" for the house you
 * have been sitting in all day.
 */
export interface FenceState {
  inside: boolean;
  /** When the current inside/outside run began — dwell is measured from here. */
  since: number;
  /** Dwell already announced for this visit. One dwell per visit, never a stream. */
  dwellFired: boolean;
  lastEvaluatedAt: number;
}

/** ★ The ONLY shape that may be synced. Class B: an opaque id and an enum. */
export interface FenceCrossing {
  geofenceId: UUID;
  transition: FenceTransition;
}

/** On-device enrichment for the local timeline and notification text. Never synced. */
export interface LocalFenceCrossing extends FenceCrossing {
  at: number;
  label: string;
  distanceM: number;
}

export interface GeofenceEvaluation {
  states: Record<UUID, FenceState>;
  crossings: LocalFenceCrossing[];
}

/** Below this the hysteresis band is dominated by ordinary GNSS jitter. */
const MIN_HYSTERESIS_M = 25;
/** A fix whose error dwarfs the fence cannot decide it. Tuned against MIN radius. */
const UNUSABLE_ACCURACY_M = 250;

const EARTH_R_M = 6_371_008.8; // IUGG mean radius
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. Accurate to ~0.5% at any distance on Earth. */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Metres from the fix to the fence edge. Negative when inside the circle. */
export function distanceToEdgeM(fence: Geofence, p: GeoPoint): number {
  return haversineM({ lat: fence.lat, lon: fence.lon }, p) - fence.radiusM;
}

/** Strip everything the server is not allowed to learn. */
export function toWireCrossing(c: LocalFenceCrossing): FenceCrossing {
  return { geofenceId: c.geofenceId, transition: c.transition };
}

function hysteresisBandM(fence: Geofence, accuracyM: number): number {
  const acc = Number.isFinite(accuracyM) && accuracyM > 0 ? accuracyM : MIN_HYSTERESIS_M;
  // Never let the band swallow the fence: half the radius is the hard ceiling.
  return Math.min(Math.max(acc, MIN_HYSTERESIS_M), fence.radiusM * 0.5);
}

/** A fix too coarse to decide this fence — held, not guessed. See note 2 above. */
function fixIsUnusable(fence: Geofence, fix: Fix): boolean {
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return true;
  const acc = Number.isFinite(fix.accuracyM) ? fix.accuracyM : Number.POSITIVE_INFINITY;
  return acc > UNUSABLE_ACCURACY_M && acc > fence.radiusM * 4;
}

/**
 * Evaluate every fence against one fix.
 *
 * `prevStates` is keyed by geofence id and is returned updated — callers persist
 * it and hand it straight back on the next fix. Passing `{}` seeds membership
 * SILENTLY: the first evaluation after a cold start establishes where you are
 * without claiming you just arrived there.
 *
 * `memberId`, when given, drops fences that do not name that member.
 */
export function evaluateGeofences(
  fences: readonly Geofence[],
  pos: Fix,
  prevStates: Readonly<Record<UUID, FenceState>>,
  memberId?: UUID,
): GeofenceEvaluation {
  const states: Record<UUID, FenceState> = {};
  const crossings: LocalFenceCrossing[] = [];
  const at = Number.isFinite(pos.at) ? pos.at : Date.now();

  for (const fence of fences) {
    if (memberId !== undefined && fence.memberIds.length > 0 && !fence.memberIds.includes(memberId)) {
      continue;
    }
    if (!(fence.radiusM > 0)) continue; // a zero-radius fence can never be satisfied

    const prev = prevStates[fence.id];
    const edge = distanceToEdgeM(fence, pos);
    const distanceM = edge + fence.radiusM;

    if (fixIsUnusable(fence, pos)) {
      // Hold the previous belief untouched. Silence beats a fabricated crossing.
      if (prev) states[fence.id] = { ...prev, lastEvaluatedAt: at };
      continue;
    }

    const band = hysteresisBandM(fence, pos.accuracyM);

    if (!prev) {
      // Cold start: adopt the truth, announce nothing.
      states[fence.id] = { inside: edge <= 0, since: at, dwellFired: false, lastEvaluatedAt: at };
      continue;
    }

    let inside = prev.inside;
    let since = prev.since;
    let dwellFired = prev.dwellFired;
    let transition: FenceTransition | null = null;

    if (!prev.inside && edge <= -band) {
      inside = true;
      since = at;
      dwellFired = false;
      transition = 'enter';
    } else if (prev.inside && edge >= band) {
      inside = false;
      since = at;
      dwellFired = false;
      transition = 'exit';
    }

    // Dwell is a property of an ongoing visit, so it is checked after settling
    // membership and only while inside — including on the very fix that entered,
    // which is why `since` is compared rather than assumed stale.
    if (transition === null && inside && !dwellFired && fence.dwellS !== null && fence.dwellS > 0) {
      if (at - since >= fence.dwellS * 1000) {
        dwellFired = true;
        transition = 'dwell';
      }
    }

    states[fence.id] = { inside, since, dwellFired, lastEvaluatedAt: at };

    if (transition === null) continue;
    // The fence's own notify flags decide what is worth waking a family for.
    // Dwell has no flag of its own: configuring dwellS IS the opt-in.
    const wanted =
      transition === 'enter' ? fence.notifyOnEnter : transition === 'exit' ? fence.notifyOnExit : true;
    if (!wanted) continue;

    crossings.push({
      geofenceId: fence.id,
      transition,
      at,
      label: fence.label,
      distanceM: Math.round(distanceM),
    });
  }

  return { states, crossings };
}
