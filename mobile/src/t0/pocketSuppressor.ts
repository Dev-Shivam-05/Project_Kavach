/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · POCKET SUPPRESSOR  (P-056, FR-015)
 *
 * "The power button gets pressed repeatedly in a pocket or a bike jacket."
 * Suppress the hardware-button trigger when ALL of:
 *   proximity NEAR  ∧  lux < 10  ∧  sustained on-foot/in-vehicle motion > 60 s
 *
 * ★ THIS IS THE ONE PLACE IN T0 THAT FAILS CLOSED, AND IT IS DANGEROUS. ★
 * ADR-018 says fail OPEN on the safety path. Suppression is the inverse: it
 * discards a trigger the user may have meant. So the gate is conjunctive, every
 * decision is logged with its inputs (the PRD explicitly asks for this so the
 * thresholds can be tuned), and only button-originated triggers are eligible.
 * An in-app panic press, a BLE fob press, a voice phrase and a sensor-fusion
 * candidate are NEVER suppressed, whatever the sensors say.
 *
 * Degradation: expo-sensors exposes no proximity sensor on any platform, and
 * LightSensor is Android-only. Without proximity we require a stricter, longer
 * darkness condition instead of silently pretending the sensor said "near" —
 * and `pocketState().basis` reports which rule was used.
 *
 * ★ THIS MODULE DOES NOT OPEN THE ACCELEROMETER ★
 * The accelerometer update rate is global to the process. A second listener here
 * did not halve anything — it doubled the JS callbacks, because `setUpdateInterval`
 * is shared and fusion holds it at 50 Hz during an incident. Throttling inside our
 * own callback (`notePocketAccel`) saved the arithmetic and none of the ~50 bridge
 * crossings per second, landing on the same thread that has to paint the countdown
 * ring. So fusion owns the one subscription and forwards each sample here.
 *
 * If fusion is not running there are no samples, `motion` stays `still`, the
 * conjunctive gate cannot close, and nothing is suppressed. That is the correct
 * direction to fail (ADR-018), and `pocketState().motionSeen` says so out loud.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { LightSensor } from 'expo-sensors';
import type { EventSubscription } from 'expo-modules-core';
import type { TriggerType } from '../core/types';
import { proximityCm } from './native';

/** PRD §6.2.3: `LastSensorValues.proximityCm < 3f`. */
export const PROXIMITY_NEAR_CM = 3;
/** PRD §6.2.3: `LastSensorValues.luxAverage5s < 10f`. */
export const DARK_LUX = 10;
/** PRD P-056: "in `IN_VEHICLE`/`ON_FOOT` activity for > 60 s". */
export const SUSTAINED_MOTION_MS = 60_000;
/** Without a proximity reading we demand this much continuous darkness instead. */
export const DARK_ONLY_FALLBACK_MS = 20_000;

const LUX_AVERAGE_MS = 5_000;
const MOTION_SAMPLE_MS = 200; // 5 Hz — the P-006 idle budget
const MOTION_VARIANCE_SAMPLES = 15; // ≈3 s of history
const PROXIMITY_POLL_MS = 2_000;
const LOG_LIMIT = 200;

export type MotionState = 'still' | 'on_foot' | 'vehicle';

/** The trigger's physical origin. Only buttons are eligible for suppression. */
export type TriggerSource =
  | 'power_button'
  | 'volume_button'
  | 'in_app'
  | 'fob'
  | 'voice'
  | 'sensor'
  | 'remote';

const SUPPRESSIBLE: ReadonlySet<TriggerSource> = new Set<TriggerSource>([
  'power_button',
  'volume_button',
]);

export interface SuppressionEntry {
  at: number;
  trigger: TriggerType;
  source: TriggerSource;
  suppressed: boolean;
  reason: string;
  /** The raw inputs, so a real-world false positive can be re-argued later. */
  proximityCm: number | null;
  luxAvg: number | null;
  motion: MotionState;
  sustainedMotionMs: number;
  darkForMs: number;
}

export interface PocketState {
  inPocket: boolean;
  proximityCm: number | null;
  luxAvg: number | null;
  luxAvailable: boolean;
  proximityAvailable: boolean;
  motion: MotionState;
  sustainedMotionMs: number;
  darkForMs: number;
  /** Which rule produced `inPocket`. */
  basis: 'full' | 'dark_and_motion_only' | 'insufficient_sensors';
  /**
   * False when no accelerometer sample has ever arrived from fusion — the motion
   * term of the gate is then unavailable, not "still", and suppression is off.
   */
  motionSeen: boolean;
  watching: boolean;
}

// ── Live sensor state ─────────────────────────────────────────────────────────

let watching = false;
let lightSub: EventSubscription | null = null;
let proximityTimer: ReturnType<typeof setInterval> | null = null;

let luxAvailable = false;
let proximityAvailable = false;
let lastProximityCm: number | null = null;

const luxSamples: { at: number; lux: number }[] = [];
let darkSinceAt: number | null = null;

const smvHistory = new Float32Array(MOTION_VARIANCE_SAMPLES);
let smvCount = 0;
let smvHead = 0;
let lastAccelAt = 0;
let motionSeen = false;
let motion: MotionState = 'still';
let motionOverride: MotionState | null = null;
let movingSinceAt: number | null = null;

const log: SuppressionEntry[] = [];

function luxAverage(): number | null {
  const now = Date.now();
  while (luxSamples.length > 0 && now - luxSamples[0].at > LUX_AVERAGE_MS) luxSamples.shift();
  if (luxSamples.length === 0) return null;
  let sum = 0;
  for (const s of luxSamples) sum += s.lux;
  return sum / luxSamples.length;
}

function darkForMs(): number {
  return darkSinceAt === null ? 0 : Date.now() - darkSinceAt;
}

function sustainedMotionMs(): number {
  const state = motionOverride ?? motion;
  if (state === 'still' || movingSinceAt === null) return 0;
  return Date.now() - movingSinceAt;
}

/**
 * Motion class from accelerometer variance alone. Coarse on purpose: this is a
 * gate on a suppression rule, not a fitness tracker. `notePocketMotion` is the
 * seam where an Activity Recognition source would override it — see that
 * function for why nothing does yet.
 */
function classifyMotion(): MotionState {
  if (smvCount < 4) return 'still';
  let sum = 0;
  for (let i = 0; i < smvCount; i++) sum += smvHistory[i];
  const mean = sum / smvCount;
  let acc = 0;
  for (let i = 0; i < smvCount; i++) {
    const d = smvHistory[i] - mean;
    acc += d * d;
  }
  const variance = acc / smvCount;
  // A phone on a table sits at ~0. A phone in a moving car picks up road
  // vibration. A phone in a walking person's pocket swings hard at ~2 Hz.
  if (variance < 0.003) return 'still';
  if (variance < 0.02) return 'vehicle';
  return 'on_foot';
}

/**
 * One accelerometer sample, forwarded by `t0/fusion.ingest` — the single owner of
 * the subscription. Throttled to MOTION_SAMPLE_MS: the variance heuristic below
 * wants ~3 s of history at 5 Hz, not 50 samples a second.
 */
export function notePocketAccel(x: number, y: number, z: number): void {
  const now = Date.now();
  if (now - lastAccelAt < MOTION_SAMPLE_MS) return;
  lastAccelAt = now;
  motionSeen = true;
  smvHistory[smvHead] = Math.sqrt(x * x + y * y + z * z);
  smvHead = smvHead + 1 === MOTION_VARIANCE_SAMPLES ? 0 : smvHead + 1;
  if (smvCount < MOTION_VARIANCE_SAMPLES) smvCount++;

  const next = classifyMotion();
  if (next === 'still') {
    movingSinceAt = null;
  } else if (motion === 'still' || movingSinceAt === null) {
    movingSinceAt = now;
  }
  motion = next;
}

function onLux(illuminance: number): void {
  const now = Date.now();
  luxSamples.push({ at: now, lux: illuminance });
  const avg = luxAverage();
  if (avg !== null && avg < DARK_LUX) {
    if (darkSinceAt === null) darkSinceAt = now;
  } else {
    darkSinceAt = null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function startPocketWatch(): Promise<void> {
  if (watching) return;
  watching = true;

  try {
    luxAvailable = await LightSensor.isAvailableAsync();
  } catch {
    luxAvailable = false; // iOS: no ambient light sensor is exposed at all.
  }
  if (luxAvailable) {
    try {
      LightSensor.setUpdateInterval(1000);
      lightSub = LightSensor.addListener(({ illuminance }) => onLux(illuminance));
    } catch {
      luxAvailable = false;
      lightSub = null;
    }
  }

  // No accelerometer subscription here — see the module header. Samples arrive
  // through `notePocketAccel` from the one listener fusion already owns.

  const pollProximity = async () => {
    const cm = await proximityCm();
    proximityAvailable = cm !== null;
    lastProximityCm = cm;
  };
  void pollProximity();
  proximityTimer = setInterval(() => {
    void pollProximity();
  }, PROXIMITY_POLL_MS);
}

export function stopPocketWatch(): void {
  watching = false;
  try {
    lightSub?.remove();
  } catch {
    // Already removed.
  }
  lightSub = null;
  if (proximityTimer !== null) {
    clearInterval(proximityTimer);
    proximityTimer = null;
  }
  luxSamples.length = 0;
  darkSinceAt = null;
  smvCount = 0;
  smvHead = 0;
  movingSinceAt = null;
  motionSeen = false;
  motion = 'still';
}

/**
 * Injection seam for a real Activity Recognition source, which would replace the
 * variance heuristic above with the OS's own answer.
 *
 * ★ Nothing calls this today. ★ There is no Activity Recognition provider in
 * `t0/native.ts` and none is planned in this phase, so every suppression decision
 * runs on accelerometer variance alone. The seam is kept rather than deleted
 * because the variance heuristic is explicitly the weaker path and this is where
 * the better one plugs in — but the comment on `classifyMotion` must not be read
 * as saying a native source exists.
 */
export function notePocketMotion(state: MotionState | null): void {
  motionOverride = state;
  if (state === null) return;
  if (state === 'still') movingSinceAt = null;
  else if (movingSinceAt === null) movingSinceAt = Date.now();
}

export function pocketState(): PocketState {
  const avg = luxAverage();
  const dark = darkForMs();
  const sustained = sustainedMotionMs();
  const motionNow = motionOverride ?? motion;
  const near = lastProximityCm !== null && lastProximityCm < PROXIMITY_NEAR_CM;
  const isDark = avg !== null && avg < DARK_LUX;
  const moving = motionNow !== 'still' && sustained > SUSTAINED_MOTION_MS;

  let inPocket = false;
  let basis: PocketState['basis'] = 'insufficient_sensors';
  // No motion evidence at all means the gate has one of its three terms missing,
  // which is the same situation as a missing light sensor: fail open.
  if (!motionSeen && motionOverride === null) {
    basis = 'insufficient_sensors';
  } else if (proximityAvailable && luxAvailable) {
    basis = 'full';
    inPocket = near && isDark && moving;
  } else if (luxAvailable) {
    // No proximity: darkness must be sustained, not a passing shadow.
    basis = 'dark_and_motion_only';
    inPocket = isDark && dark > DARK_ONLY_FALLBACK_MS && moving;
  }

  return {
    inPocket,
    proximityCm: lastProximityCm,
    luxAvg: avg,
    luxAvailable,
    proximityAvailable,
    motion: motionNow,
    sustainedMotionMs: sustained,
    darkForMs: dark,
    basis,
    motionSeen: motionSeen || motionOverride !== null,
    watching,
  };
}

export function isProbablyInPocket(): boolean {
  return pocketState().inPocket;
}

/**
 * The decision the trigger router actually asks for. Always logged, both ways —
 * a trigger that was let through while the phone looked pocketed is just as
 * interesting for tuning as one that was blocked.
 */
export function shouldSuppress(
  trigger: TriggerType,
  source: TriggerSource,
): { suppressed: boolean; reason: string } {
  const state = pocketState();
  let suppressed = false;
  let reason: string;

  if (!SUPPRESSIBLE.has(source)) {
    reason = `source=${source} is never suppressed`;
  } else if (state.basis === 'insufficient_sensors') {
    // No light sensor at all (iOS), or no motion samples because fusion is not
    // running. Fail open — a false alarm costs a phone call; a suppressed real
    // alarm costs a life (ADR-018).
    reason = state.luxAvailable
      ? 'no motion samples; failing open'
      : 'no ambient-light sensor; failing open';
  } else if (state.inPocket) {
    suppressed = true;
    reason =
      state.basis === 'full'
        ? `proximity ${state.proximityCm?.toFixed(1)}cm < ${PROXIMITY_NEAR_CM}, lux ${state.luxAvg?.toFixed(1)} < ${DARK_LUX}, ${state.motion} for ${Math.round(state.sustainedMotionMs / 1000)}s`
        : `no proximity sensor; dark ${Math.round(state.darkForMs / 1000)}s and ${state.motion} for ${Math.round(state.sustainedMotionMs / 1000)}s`;
  } else {
    reason = `not pocketed (lux ${state.luxAvg === null ? 'n/a' : state.luxAvg.toFixed(1)}, ${state.motion} ${Math.round(state.sustainedMotionMs / 1000)}s)`;
  }

  log.push({
    at: Date.now(),
    trigger,
    source,
    suppressed,
    reason,
    proximityCm: state.proximityCm,
    luxAvg: state.luxAvg,
    motion: state.motion,
    sustainedMotionMs: state.sustainedMotionMs,
    darkForMs: state.darkForMs,
  });
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);

  return { suppressed, reason };
}

/** Newest first. Rendered on the diagnostics screen so thresholds can be tuned. */
export function suppressionLog(): readonly SuppressionEntry[] {
  return log.slice().reverse();
}

export function clearSuppressionLog(): void {
  log.length = 0;
}
