/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PRESENCE SERVICE — the wiring for the Coordination plane (Phase 2)
 *
 * ★ WHY THIS FILE EXISTS ★
 * docs/PHASE-STATUS.md found the failure mode worth catching: three complete,
 * tested subsystems with ZERO call sites —
 *
 *   · `noteLocationFix()`   — nothing ever produced a fix, so every coordinate
 *                             the product displayed or transmitted was a
 *                             boot-time database read;
 *   · `evaluateGeofences()` — a correct, hysteresis-aware evaluator that was
 *                             never handed a position;
 *   · `connectWs()`         — a resumable realtime client nobody dialled, so a
 *                             correctly-escalated incident reached a server no
 *                             phone was listening to.
 *
 * Each of them reviews well and tests well and does nothing. Code with no caller
 * is not a feature, it is a rehearsal — and on a safety product the gap between
 * those two is the whole product. This module is the caller.
 *
 * ★ POWER (P-006, NFR-005: <4%/24h) ★
 * Sampling is driven by state, never by a fixed timer:
 *   IDLE   — significant-change only. NO continuous GNSS, ever.
 *   WATCH  — CONFIG.watchLocationIntervalMs, elevated risk or a live journey
 *   ACTIVE — CONFIG.incidentLocationIntervalMs, only while an incident is live
 * The PRD is explicit that battery is a safety metric: above ~5%/day people
 * disable the app, and a disabled safety app is worse than none because everyone
 * still believes they are protected.
 *
 * ★ PRIVACY (ADR-010) ★
 * Geofences are evaluated HERE, on the device. A crossing leaves as
 * `{geofenceId, transition}` via toWireCrossing() and nothing else — the server
 * never learns where "school" is. Precise coordinates go only into the sealed
 * payload; the plaintext that leaves is the ~1 km coarse cell.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { AppState, type NativeEventSubscription } from 'react-native';
import * as Location from 'expo-location';

import { CONFIG } from '../core/config';
import { DegradationLevel, type Geofence, type UUID } from '../core/types';
import {
  evaluateGeofences,
  toWireCrossing,
  type FenceState,
  type Fix,
  type LocalFenceCrossing,
} from './geofence';
import { isActive } from '../t0/stateMachine.generated';
import type { T0Location } from '../t0/triggerRouter';

/** What the service needs from the store, injected so this stays testable. */
export interface PresenceDeps {
  noteLocationFix: (fix: T0Location) => Promise<void>;
  geofences: () => readonly Geofence[];
  memberId: () => UUID | null;
  /** Current incident state — decides the sampling tier. */
  t0State: () => string;
  riskElevated: () => boolean;
  journeyActive: () => boolean;
  degradation: () => DegradationLevel;
  onCrossing: (crossing: ReturnType<typeof toWireCrossing>, local: LocalFenceCrossing) => void;
  /** Dial the realtime gateway. Safe to call repeatedly; it de-dupes internally. */
  connectRealtime: () => void;
}

type Tier = 'idle' | 'watch' | 'active';

let deps: PresenceDeps | null = null;
let sub: Location.LocationSubscription | null = null;
let tier: Tier | null = null;
let fenceStates: Record<UUID, FenceState> = {};
let started = false;
let lastFixAt = 0;
let fixCount = 0;
/**
 * ★ THE PERMISSION THAT ARRIVES AFTER WE LOOKED ★
 * On a fresh install the order is: bootstrap runs this with no location
 * permission → we take the early return → onboarding asks for it and the user
 * grants it → nothing subscribes, because `started` is already true and every
 * later entry point short-circuits. `cachedFix` stays null and the FIRST SOS
 * after onboarding seals lat 0, lon 0, accuracy -1 and coarse cell 'c7:unknown'.
 *
 * So a refused permission is remembered as REFUSED, not as started, and every
 * foreground transition re-asks. The service heals itself without onboarding
 * having to know it exists.
 */
let permissionBlocked = false;
let appStateSub: NativeEventSubscription | null = null;

function tierFor(d: PresenceDeps): Tier {
  if (isActive(d.t0State() as never)) return 'active';
  if (d.riskElevated() || d.journeyActive()) return 'watch';
  return 'idle';
}

/**
 * expo-location options per tier.
 *
 * IDLE deliberately uses `Balanced` with a large distance interval rather than a
 * time interval: it lets the OS serve a fix it already computed for another app
 * instead of waking GNSS for us, which is the single biggest battery saving
 * available here.
 */
function optionsFor(t: Tier): Location.LocationOptions {
  switch (t) {
    case 'active':
      return {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: CONFIG.incidentLocationIntervalMs,
        distanceInterval: 0,
      };
    case 'watch':
      return {
        accuracy: Location.Accuracy.High,
        timeInterval: CONFIG.watchLocationIntervalMs,
        distanceInterval: 10,
      };
    case 'idle':
      return {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: CONFIG.idleLocationIntervalMs,
        distanceInterval: 150,
      };
  }
}

function toFix(l: Location.LocationObject): T0Location {
  return {
    lat: l.coords.latitude,
    lon: l.coords.longitude,
    accuracyM: l.coords.accuracy ?? 9999,
    altitude: l.coords.altitude ?? undefined,
    speed: l.coords.speed ?? undefined,
    heading: l.coords.heading ?? undefined,
    at: l.timestamp,
  };
}

async function onFix(l: Location.LocationObject): Promise<void> {
  if (!deps) return;
  const fix = toFix(l);
  lastFixAt = fix.at;
  fixCount++;

  // 1. Feed the cache + the sealed location stream. This is what makes an SOS
  //    carry a position that is seconds old rather than hours old — and the
  //    trigger path reads the CACHE, never a fresh acquisition (a cold GNSS fix
  //    is 5–30 s and would blow the 500 ms t0→t2 budget sixty times over).
  await deps.noteLocationFix(fix);

  // 2. Evaluate fences on-device. The coordinates never leave (ADR-010).
  const fences = deps.geofences();
  if (fences.length > 0) {
    const geoFix: Fix = { lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM, at: fix.at };
    const result = evaluateGeofences(fences, geoFix, fenceStates, deps.memberId() ?? undefined);
    fenceStates = result.states;
    for (const c of result.crossings) deps.onCrossing(toWireCrossing(c), c);
  }
}

/** Re-subscribe only when the tier actually changes — never per fix. */
async function applyTier(next: Tier): Promise<void> {
  if (!deps || tier === next) return;
  tier = next;
  try {
    sub?.remove();
  } catch {
    /* already gone */
  }
  sub = null;
  try {
    sub = await Location.watchPositionAsync(optionsFor(next), (l) => {
      void onFix(l);
    });
  } catch {
    // Permission refused, or location services off. That is a legitimate user
    // choice and is reported by the diagnostics screen (P-031) — it must not
    // throw here and take the rest of the app down with it.
    sub = null;
  }
}

/**
 * Foreground permission only. Background location is a separate, two-step grant
 * (P-040) that onboarding walks through explicitly; asking for it here would
 * produce a denial the user never understood.
 */
async function foregroundGranted(): Promise<boolean> {
  const { status } = await Location.getForegroundPermissionsAsync().catch(() => ({
    status: 'undetermined' as Location.PermissionStatus,
  }));
  return status === 'granted';
}

/** Subscribe and seed. Assumes the permission has just been confirmed. */
async function beginWatching(d: PresenceDeps): Promise<void> {
  permissionBlocked = false;
  // Seed the cache immediately so the FIRST SOS after launch is not blind.
  try {
    const last = await Location.getLastKnownPositionAsync();
    if (last) await onFix(last);
  } catch {
    /* no cached fix on this device yet */
  }
  await applyTier(tierFor(d));
}

function watchForegroundReturn(): void {
  if (appStateSub !== null) return;
  appStateSub = AppState.addEventListener('change', (next) => {
    // Coming back from Settings, or from the onboarding permission sheet, is the
    // one moment at which a refusal reliably becomes a grant.
    if (next === 'active' && permissionBlocked) void refreshPresenceTier();
  });
}

/**
 * Start the service. Idempotent — bootstrap() can call it more than once, and
 * expo-router can mount the root layout twice.
 */
export async function startPresence(d: PresenceDeps): Promise<void> {
  deps = d;
  if (started) {
    await refreshPresenceTier();
    return;
  }
  started = true;
  watchForegroundReturn();

  if (!(await foregroundGranted())) {
    permissionBlocked = true;
    // No fixes, but the realtime leg is independent of location and still runs:
    // a responder must be able to receive a CLAIM even on a phone that shares
    // no position at all.
    if (d.degradation() >= DegradationLevel.HTTP_ONLY) d.connectRealtime();
    return;
  }

  await beginWatching(d);
  if (d.degradation() >= DegradationLevel.HTTP_ONLY) d.connectRealtime();
}

/**
 * Called when incident state, risk, journeys or connectivity change — and on
 * every return to the foreground while the permission is still missing.
 */
export async function refreshPresenceTier(): Promise<void> {
  const d = deps;
  if (!d || !started) return;

  if (permissionBlocked) {
    if (!(await foregroundGranted())) {
      if (d.degradation() >= DegradationLevel.HTTP_ONLY) d.connectRealtime();
      return;
    }
    await beginWatching(d);
  } else {
    await applyTier(tierFor(d));
  }

  if (d.degradation() >= DegradationLevel.HTTP_ONLY) d.connectRealtime();
}

export function stopPresence(): void {
  try {
    sub?.remove();
  } catch {
    /* already gone */
  }
  sub = null;
  tier = null;
  started = false;
  permissionBlocked = false;
  try {
    appStateSub?.remove();
  } catch {
    /* already gone */
  }
  appStateSub = null;
}

export interface PresenceStatus {
  running: boolean;
  tier: Tier | null;
  fixCount: number;
  lastFixAt: number;
  fencesTracked: number;
  /**
   * True when the service is up but has no location permission. This is the
   * difference between "no fix yet" and "no fix ever", and the panic screen's
   * empty coordinate block is unexplained without it.
   */
  permissionBlocked: boolean;
}

/** Surfaced on the diagnostics screen: a service that is silently not running is the bug. */
export function presenceStatus(): PresenceStatus {
  return {
    running: started && sub !== null,
    tier,
    fixCount,
    lastFixAt,
    fencesTracked: Object.keys(fenceStates).length,
    permissionBlocked,
  };
}

/** Test seam: reset module state between cases. */
export function __resetPresenceForTest(): void {
  deps = null;
  sub = null;
  tier = null;
  fenceStates = {};
  started = false;
  permissionBlocked = false;
  appStateSub = null;
  lastFixAt = 0;
  fixCount = 0;
}
