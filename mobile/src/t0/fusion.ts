/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · SENSOR FUSION
 *
 * ★ PRD §13.4: "The fusion stage is explicitly NOT a learned model. It is a
 *   readable, testable ~80-line function. That is the layer you will be tuning
 *   for two years, and you must be able to reason about why it fired." ★
 *
 * So this is a weighted evidence accumulator with named terms and published
 * constants. Every number below is a threshold you can argue about in a bug
 * report, change, and unit-test. There is no model file, no inference runtime,
 * and no situation in which the answer to "why did it fire?" is "the network
 * said so".
 *
 * Pipeline (§13.4): 4 s sliding window, 50% overlap → features → per-hazard
 * detectors → fusion × risk-context multiplier → confidence → state machine.
 *
 * ★ POWER (P-006) ★
 * 50 Hz continuous sampling is a battery-drain uninstall. When IDLE we sample at
 * 5 Hz — enough to notice an impact worth investigating — and only climb to
 * 50 Hz once the risk engine elevates context or an impact has been seen. The
 * native module additionally requests hardware FIFO batching at
 * CONFIG.sensorBatchLatencyUs (30 s) so the app CPU is not woken per sample;
 * expo-sensors exposes no batching API, so on the JS path we trade rate for
 * wakeups instead.
 *
 * ★ ONE ACCELEROMETER SUBSCRIPTION FOR THE WHOLE PROCESS ★
 * `Accelerometer.setUpdateInterval` is global, so a second listener anywhere in
 * the app runs at whatever rate THIS module asked for. `ingest()` therefore fans
 * each sample out to the black box and to the pocket suppressor rather than
 * letting either open its own — the arithmetic is free, the bridge crossings
 * were not.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { Accelerometer, Gyroscope } from 'expo-sensors';
import type { EventSubscription } from 'expo-modules-core';
import { CONFIG } from '../core/config';
import type { RiskLevel, TriggerType } from '../core/types';
import { pushSample } from './blackbox';
import { notePocketAccel } from './pocketSuppressor';

// ── Published thresholds ──────────────────────────────────────────────────────

/** Below this an event is not an impact at all; it is walking. */
export const IMPACT_ARM_G = 2.5;
/** PRD: fall = impact > 3.5 g followed by no motion for 30 s. */
export const FALL_IMPACT_G = 3.5;
export const FALL_NO_MOTION_MS = 30_000;
/** PRD: crash = impact > 4 g + no motion for 10 s + a speed drop. */
export const CRASH_IMPACT_G = 4.0;
export const CRASH_NO_MOTION_MS = 10_000;
/** 18 km/h. Below this "a crash" is someone dropping their phone off a chair. */
export const CRASH_MIN_SPEED_MPS = 5.0;

/** Guard thresholds consumed by the generated state machine. */
export const CONFIDENCE_LOW = 0.3;
export const CONFIDENCE_MEDIUM = 0.5;
export const CONFIDENCE_HIGH = 0.8;

/** Stillness band: 1 g ± 0.15 with almost no rotation. */
const STILL_SMV_LOW = 0.85;
const STILL_SMV_HIGH = 1.15;
const STILL_GYRO_MAX = 0.35; // rad/s

const WINDOW_MS = 4_000;
const HOP_MS = WINDOW_MS / 2; // 50% overlap (§13.4)
const MAX_WINDOW_SAMPLES = 256; // 4 s at 50 Hz plus headroom
const ENTROPY_BINS = 16;

export type FusionMode = 'idle' | 'watch' | 'incident';

const MODE_INTERVAL_MS: Record<FusionMode, number> = {
  idle: 200, // 5 Hz — the power-budget default (P-006)
  watch: 20, // 50 Hz — risk context elevated (§13.5); the DETECTION rate
  /**
   * 25 Hz. An incident is already open, so nothing here is still trying to
   * detect an impact: the remaining detectors measure stillness over 10 s
   * (CRASH_NO_MOTION_MS) and 30 s (FALL_NO_MOTION_MS), which 25 Hz resolves many
   * times over. Halving it matters because `setUpdateInterval` is global to the
   * process and this is the exact window in which the panic screen has to paint
   * the one animation §6.4 permits.
   */
  incident: 40,
};

// ── Feature types ─────────────────────────────────────────────────────────────

export interface FusionFeatures {
  /** Signal magnitude vector: sqrt(ax²+ay²+az²), in g. 1.0 at rest. */
  smvMean: number;
  smvMax: number;
  smvMin: number;
  /** Population variance of SMV over the window. */
  variance: number;
  /** RMS of d(SMV)/dt, in g/s. Separates an impact from a slow lean. */
  jerkRms: number;
  /** Shannon entropy of the SMV histogram, normalised to [0,1]. */
  entropy: number;
  /** Angle between the mean acceleration vector and vertical, degrees. */
  tiltDeg: number;
  /** Change in tilt across the window, degrees. */
  tiltChangeDeg: number;
  /** Peak |SMV| in the window, in g. Same as smvMax; named for readability. */
  peak: number;
  /** Peak gyroscope magnitude, rad/s. */
  gyroMax: number;
  sampleCount: number;
  windowMs: number;
  startedAt: number;
  endedAt: number;
}

/** Cross-window state. A 4 s window cannot see 30 s of stillness by itself. */
export interface FusionContext {
  /** Largest SMV of the most recent impact, in g. 0 when there has been none. */
  impactG: number;
  /** ms since that impact. Number.POSITIVE_INFINITY when there has been none. */
  msSinceImpact: number;
  /** Uninterrupted stillness since the impact, in ms. */
  stillMs: number;
  /** Tilt change measured from the moment of impact, degrees. */
  tiltChangeSinceImpactDeg: number;
  /** Ground speed just before the impact, m/s. -1 when unknown. */
  speedBeforeMps: number;
  /** Ground speed now, m/s. -1 when unknown. */
  speedAfterMps: number;
  /** Minimum SMV in the 500 ms before the impact — free-fall evidence. */
  preImpactMinG: number;
}

export interface FusionWindow {
  features: FusionFeatures;
  ctx: FusionContext;
}

export interface FusionResult {
  /** [0,1]. Compare against CONFIDENCE_MEDIUM / CONFIDENCE_HIGH. */
  confidence: number;
  trigger: TriggerType | null;
  scores: { fall: number; crash: number; noMotion: number };
  /** Human-readable evidence, for the after-action report and for tuning. */
  reasons: string[];
}

export interface FusionCandidate extends FusionResult {
  window: FusionWindow;
  at: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function emptyContext(): FusionContext {
  return {
    impactG: 0,
    msSinceImpact: Number.POSITIVE_INFINITY,
    stillMs: 0,
    tiltChangeSinceImpactDeg: 0,
    speedBeforeMps: -1,
    speedAfterMps: -1,
    preImpactMinG: 1,
  };
}

// ── Feature extraction ────────────────────────────────────────────────────────

/**
 * Computed over the raw window rather than a filtered one: a 0.5–15 Hz bandpass
 * belongs on the DSP (§13.4) and re-implementing an IIR filter in JS at 50 Hz
 * would cost more battery than it buys accuracy. Tilt uses the mean vector,
 * which is a DC (gravity) estimate — that is the filtering we actually need.
 */
export function extractFeatures(
  t: Float64Array,
  ax: Float32Array,
  ay: Float32Array,
  az: Float32Array,
  gyro: Float32Array,
  count: number,
): FusionFeatures {
  if (count === 0) {
    const now = Date.now();
    return {
      smvMean: 1, smvMax: 1, smvMin: 1, variance: 0, jerkRms: 0, entropy: 0,
      tiltDeg: 0, tiltChangeDeg: 0, peak: 1, gyroMax: 0,
      sampleCount: 0, windowMs: 0, startedAt: now, endedAt: now,
    };
  }

  let sum = 0;
  let max = 0;
  let min = Number.POSITIVE_INFINITY;
  let gyroMax = 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  const smv = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const x = ax[i];
    const y = ay[i];
    const z = az[i];
    const m = Math.sqrt(x * x + y * y + z * z);
    smv[i] = m;
    sum += m;
    if (m > max) max = m;
    if (m < min) min = m;
    if (gyro[i] > gyroMax) gyroMax = gyro[i];
    mx += x;
    my += y;
    mz += z;
  }

  const mean = sum / count;
  let varAcc = 0;
  for (let i = 0; i < count; i++) {
    const d = smv[i] - mean;
    varAcc += d * d;
  }
  const variance = varAcc / count;

  // Jerk: RMS of the first difference, scaled to per-second units.
  let jerkAcc = 0;
  let jerkN = 0;
  for (let i = 1; i < count; i++) {
    const dt = (t[i] - t[i - 1]) / 1000;
    if (dt <= 0) continue;
    const j = (smv[i] - smv[i - 1]) / dt;
    jerkAcc += j * j;
    jerkN++;
  }
  const jerkRms = jerkN > 0 ? Math.sqrt(jerkAcc / jerkN) : 0;

  // Amplitude-histogram entropy over [0, 4] g. Walking is broad and noisy;
  // free-fall-then-impact is sharply bimodal; a phone on a table is a spike.
  const bins = new Uint16Array(ENTROPY_BINS);
  for (let i = 0; i < count; i++) {
    let b = Math.floor((smv[i] / 4) * ENTROPY_BINS);
    if (b < 0) b = 0;
    if (b >= ENTROPY_BINS) b = ENTROPY_BINS - 1;
    bins[b]++;
  }
  let entropy = 0;
  for (let b = 0; b < ENTROPY_BINS; b++) {
    if (bins[b] === 0) continue;
    const p = bins[b] / count;
    entropy -= p * Math.log2(p);
  }
  entropy /= Math.log2(ENTROPY_BINS);

  const tiltOf = (x: number, y: number, z: number): number => {
    const mag = Math.sqrt(x * x + y * y + z * z);
    if (mag === 0) return 0;
    return (Math.acos(Math.max(-1, Math.min(1, z / mag))) * 180) / Math.PI;
  };
  const tiltDeg = tiltOf(mx / count, my / count, mz / count);

  // First eighth vs last eighth: robust to the impact spike in the middle.
  const seg = Math.max(1, Math.floor(count / 8));
  let fx = 0, fy = 0, fz = 0, lx = 0, ly = 0, lz = 0;
  for (let i = 0; i < seg; i++) {
    fx += ax[i]; fy += ay[i]; fz += az[i];
    const j = count - 1 - i;
    lx += ax[j]; ly += ay[j]; lz += az[j];
  }
  const tiltChangeDeg = Math.abs(tiltOf(lx / seg, ly / seg, lz / seg) - tiltOf(fx / seg, fy / seg, fz / seg));

  return {
    smvMean: mean,
    smvMax: max,
    smvMin: min === Number.POSITIVE_INFINITY ? 0 : min,
    variance,
    jerkRms,
    entropy,
    tiltDeg,
    tiltChangeDeg,
    peak: max,
    gyroMax,
    sampleCount: count,
    windowMs: count > 1 ? t[count - 1] - t[0] : 0,
    startedAt: t[0],
    endedAt: t[count - 1],
  };
}

// ── Detectors ─────────────────────────────────────────────────────────────────

/**
 * Fall: impact > 3.5 g followed by no motion for 30 s.
 *
 * The gate is deliberate and hard — no amount of stillness turns a 1.2 g event
 * into a fall, because "elderly person put their phone down and went to sleep"
 * is the single most common false positive in this whole category.
 */
export function detectFall(w: FusionWindow): number {
  const { ctx, features } = w;
  if (ctx.impactG < FALL_IMPACT_G) return 0;

  const impact = clamp01((ctx.impactG - FALL_IMPACT_G) / 3.5);
  const stillness = clamp01(ctx.stillMs / FALL_NO_MOTION_MS);
  // A fall almost always ends with the phone at a very different angle.
  const reorientation = clamp01(ctx.tiltChangeSinceImpactDeg / 60);
  // Free fall registers as near-zero g for a few tens of ms before impact.
  const freeFall = clamp01((0.6 - ctx.preImpactMinG) / 0.5);
  // Post-impact quiet: high entropy here means the person is still moving.
  const quiet = clamp01(1 - features.entropy);

  const score =
    0.30 * impact + 0.34 * stillness + 0.15 * reorientation + 0.13 * freeFall + 0.08 * quiet;
  return clamp01(score);
}

/**
 * Crash: impact > 4 g + no motion for 10 s + a speed drop.
 *
 * Speed is the term that separates a two-wheeler crash from dropping the phone
 * down a stairwell. When speed is unknown (-1) we do NOT invent it — the term
 * contributes nothing and the score is capped, so an unknown-speed event can
 * reach PROBE but not PENDING on its own.
 */
export function detectCrash(w: FusionWindow): number {
  const { ctx, features } = w;
  if (ctx.impactG < CRASH_IMPACT_G) return 0;

  const impact = clamp01((ctx.impactG - CRASH_IMPACT_G) / 6);
  const stillness = clamp01(ctx.stillMs / CRASH_NO_MOTION_MS);
  const rotation = clamp01(features.gyroMax / 8); // a tumbling handset
  const speedKnown = ctx.speedBeforeMps >= 0 && ctx.speedAfterMps >= 0;
  const speedDrop = speedKnown
    ? clamp01(
        (ctx.speedBeforeMps - ctx.speedAfterMps) /
          Math.max(CRASH_MIN_SPEED_MPS, ctx.speedBeforeMps),
      ) * (ctx.speedBeforeMps >= CRASH_MIN_SPEED_MPS ? 1 : 0.3)
    : 0;

  const score = 0.30 * impact + 0.26 * stillness + 0.14 * rotation + 0.30 * speedDrop;
  return clamp01(speedKnown ? score : Math.min(score, 0.72));
}

/**
 * The in-between case the PRD names separately: "no motion after impact"
 * (ScenarioPolicy NO_MOTION). An impact too small to be a fall, but the person
 * has not moved since. Slower, quieter escalation — which is exactly why it is
 * its own trigger rather than a weak FALL.
 */
export function detectNoMotion(w: FusionWindow): number {
  const { ctx } = w;
  if (ctx.impactG < IMPACT_ARM_G || ctx.impactG >= FALL_IMPACT_G) return 0;
  const impact = clamp01((ctx.impactG - IMPACT_ARM_G) / (FALL_IMPACT_G - IMPACT_ARM_G));
  const stillness = clamp01(ctx.stillMs / FALL_NO_MOTION_MS);
  if (stillness < 1) return clamp01(0.35 * impact + 0.35 * stillness);
  return clamp01(0.4 * impact + 0.5 * stillness);
}

/**
 * ★ THE FUSION STAGE ★ — the weighted evidence accumulator itself.
 *
 * Risk context does not add evidence; it changes how much evidence we demand
 * (§13.5: at HIGH risk the system "drops the fall threshold"). Multiplying the
 * confidence is the same operation as lowering the threshold, and it keeps the
 * threshold constants in one place. The multiplier is bounded and published so
 * that no combination of context can manufacture a HIGH-confidence incident out
 * of nothing: a zero score stays zero.
 */
export const RISK_MULTIPLIER: readonly number[] = [1.0, 1.08, 1.18, 1.3, 1.45];

export function fuse(
  features: FusionFeatures,
  risk: RiskLevel,
  ctx: FusionContext = emptyContext(),
): FusionResult {
  const w: FusionWindow = { features, ctx };
  const fall = detectFall(w);
  const crash = detectCrash(w);
  const noMotion = detectNoMotion(w);

  const multiplier = RISK_MULTIPLIER[risk] ?? 1;
  const scores = { fall, crash, noMotion };

  let trigger: TriggerType | null = null;
  let base = 0;
  if (crash >= fall && crash >= noMotion && crash > 0) {
    trigger = 'CRASH';
    base = crash;
  } else if (fall >= noMotion && fall > 0) {
    trigger = 'FALL';
    base = fall;
  } else if (noMotion > 0) {
    trigger = 'NO_MOTION';
    base = noMotion;
  }

  const confidence = clamp01(base * multiplier);
  if (confidence < CONFIDENCE_LOW) trigger = null;

  const reasons: string[] = [];
  if (ctx.impactG > 0) reasons.push(`impact ${ctx.impactG.toFixed(1)}g`);
  if (ctx.stillMs > 0) reasons.push(`still ${Math.round(ctx.stillMs / 1000)}s`);
  if (ctx.tiltChangeSinceImpactDeg > 15) {
    reasons.push(`reoriented ${Math.round(ctx.tiltChangeSinceImpactDeg)}°`);
  }
  if (ctx.preImpactMinG < 0.6) reasons.push(`free-fall ${ctx.preImpactMinG.toFixed(2)}g`);
  if (ctx.speedBeforeMps >= 0 && ctx.speedAfterMps >= 0) {
    reasons.push(
      `speed ${(ctx.speedBeforeMps * 3.6).toFixed(0)}→${(ctx.speedAfterMps * 3.6).toFixed(0)} km/h`,
    );
  }
  if (features.gyroMax > 4) reasons.push(`rotation ${features.gyroMax.toFixed(1)} rad/s`);
  if (multiplier > 1) reasons.push(`risk ×${multiplier.toFixed(2)}`);

  return { confidence, trigger, scores, reasons };
}

// ── Live pipeline ─────────────────────────────────────────────────────────────

const bufT = new Float64Array(MAX_WINDOW_SAMPLES);
const bufAx = new Float32Array(MAX_WINDOW_SAMPLES);
const bufAy = new Float32Array(MAX_WINDOW_SAMPLES);
const bufAz = new Float32Array(MAX_WINDOW_SAMPLES);
const bufGyro = new Float32Array(MAX_WINDOW_SAMPLES);

let bufHead = 0;
let bufCount = 0;
let accelSub: EventSubscription | null = null;
let gyroSub: EventSubscription | null = null;
let hopTimer: ReturnType<typeof setInterval> | null = null;
let mode: FusionMode = 'idle';
let running = false;

let lastGx = 0;
let lastGy = 0;
let lastGz = 0;
let lastGyroMag = 0;
let context = emptyContext();
let impactAt = 0;
let tiltAtImpact = 0;
let lastStillBreakAt = 0;
let recentMinG = 1;
let recentMinAt = 0;
let windowsProcessed = 0;
let candidatesEmitted = 0;

let onCandidateFn: ((c: FusionCandidate) => void) | null = null;
let getSpeedMps: () => number = () => -1;
let getRisk: () => RiskLevel = () => 0;
let getLux: () => number = () => -1;

export interface StartFusionOptions {
  /** Ground speed from the location plane, m/s. Return -1 when unknown. */
  speedProvider?: () => number;
  /** Current risk context (§13.5). Drives both thresholds and sampling rate. */
  riskProvider?: () => RiskLevel;
  /** Ambient light, for the black box and the pocket suppressor. */
  luxProvider?: () => number;
  mode?: FusionMode;
}

function tiltOfSample(x: number, y: number, z: number): number {
  const mag = Math.sqrt(x * x + y * y + z * z);
  if (mag === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, z / mag))) * 180) / Math.PI;
}

/** Runs per accelerometer sample: O(1), no allocation. */
function ingest(at: number, x: number, y: number, z: number): void {
  const gyroMag = lastGyroMag;
  const i = bufHead;
  bufT[i] = at;
  bufAx[i] = x;
  bufAy[i] = y;
  bufAz[i] = z;
  bufGyro[i] = gyroMag;
  bufHead = i + 1 === MAX_WINDOW_SAMPLES ? 0 : i + 1;
  if (bufCount < MAX_WINDOW_SAMPLES) bufCount++;

  // FR-007: the black box has exactly one producer, and it is this loop.
  pushSample({
    atMs: at,
    ax: x,
    ay: y,
    az: z,
    gx: lastGx,
    gy: lastGy,
    gz: lastGz,
    lux: getLux(),
    speedMps: getSpeedMps(),
  });

  // ★ And so does the pocket suppressor. The accelerometer update rate is global
  //   to the process, so a second subscription there cost ~50 extra bridge
  //   crossings a second and reduced nothing. Forwarding is one call; the
  //   suppressor throttles to its own 5 Hz internally.
  notePocketAccel(x, y, z);

  const smv = Math.sqrt(x * x + y * y + z * z);

  // Rolling 500 ms minimum, so free-fall immediately before an impact is still
  // visible when the impact itself arrives. The age check re-arms the minimum
  // so one old dip cannot keep claiming free-fall forever.
  if (smv < recentMinG || at - recentMinAt > 500) {
    recentMinG = smv;
    recentMinAt = at;
  }

  const still = smv >= STILL_SMV_LOW && smv <= STILL_SMV_HIGH && gyroMag <= STILL_GYRO_MAX;
  if (!still) lastStillBreakAt = at;

  if (smv >= IMPACT_ARM_G && smv > context.impactG) {
    // A bigger impact supersedes the previous one and restarts the clock: the
    // stillness that matters is the stillness after the WORST hit.
    context.impactG = smv;
    impactAt = at;
    tiltAtImpact = tiltOfSample(x, y, z);
    context.preImpactMinG = recentMinG;
    context.speedBeforeMps = getSpeedMps();
    lastStillBreakAt = at;
  }

  if (context.impactG > 0) {
    context.msSinceImpact = at - impactAt;
    context.stillMs = Math.max(0, at - Math.max(lastStillBreakAt, impactAt));
    context.tiltChangeSinceImpactDeg = Math.abs(tiltOfSample(x, y, z) - tiltAtImpact);
    context.speedAfterMps = getSpeedMps();

    // Forget an impact that led nowhere: the person got up and walked away.
    // Two minutes is long enough to have confirmed a fall many times over.
    if (context.msSinceImpact > 120_000) context = emptyContext();
  }
}

function snapshotWindow(): { features: FusionFeatures; ctx: FusionContext } {
  // Copy oldest-first into contiguous scratch arrays for the feature pass.
  const n = bufCount;
  const t = new Float64Array(n);
  const ax = new Float32Array(n);
  const ay = new Float32Array(n);
  const az = new Float32Array(n);
  const gy = new Float32Array(n);
  const start = bufCount === MAX_WINDOW_SAMPLES ? bufHead : 0;
  const cutoff = n > 0 ? bufT[(start + n - 1) % MAX_WINDOW_SAMPLES] - WINDOW_MS : 0;
  let m = 0;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % MAX_WINDOW_SAMPLES;
    if (bufT[i] < cutoff) continue;
    t[m] = bufT[i];
    ax[m] = bufAx[i];
    ay[m] = bufAy[i];
    az[m] = bufAz[i];
    gy[m] = bufGyro[i];
    m++;
  }
  return { features: extractFeatures(t, ax, ay, az, gy, m), ctx: { ...context } };
}

function step(): void {
  if (!running) return;
  windowsProcessed++;
  const { features, ctx } = snapshotWindow();
  if (features.sampleCount === 0) return;
  const result = fuse(features, getRisk(), ctx);
  if (result.trigger === null) return;
  candidatesEmitted++;
  const candidate: FusionCandidate = { ...result, window: { features, ctx }, at: Date.now() };
  try {
    onCandidateFn?.(candidate);
  } catch {
    // A throwing consumer must never stop the sensor pipeline (ADR-018).
  }
}

function applyInterval(): void {
  const ms = MODE_INTERVAL_MS[mode];
  try {
    Accelerometer.setUpdateInterval(ms);
    Gyroscope.setUpdateInterval(ms);
  } catch {
    // Some devices reject very short intervals; the OS clamps and continues.
  }
}

/** Raise or lower the sampling rate. Cheap; safe to call on every risk change. */
export function setFusionMode(next: FusionMode): void {
  if (mode === next) return;
  mode = next;
  if (running) applyInterval();
}

export function fusionMode(): FusionMode {
  return mode;
}

/**
 * Subscribe to the sensors and start emitting candidates. Idempotent.
 *
 * Every sample is also pushed to the black box (FR-007) — the ring buffer has
 * exactly one producer, and it is this one.
 */
export function startFusion(
  onCandidate: (candidate: FusionCandidate) => void,
  options: StartFusionOptions = {},
): void {
  onCandidateFn = onCandidate;
  if (options.speedProvider) getSpeedMps = options.speedProvider;
  if (options.riskProvider) getRisk = options.riskProvider;
  if (options.luxProvider) getLux = options.luxProvider;
  if (options.mode) mode = options.mode;
  if (running) {
    applyInterval();
    return;
  }
  running = true;

  try {
    gyroSub = Gyroscope.addListener(({ x, y, z }) => {
      lastGx = x;
      lastGy = y;
      lastGz = z;
      lastGyroMag = Math.sqrt(x * x + y * y + z * z);
    });
  } catch {
    gyroSub = null; // No gyro: the rotation term simply contributes 0.
  }
  try {
    accelSub = Accelerometer.addListener(({ x, y, z }) => {
      ingest(Date.now(), x, y, z);
    });
  } catch {
    accelSub = null;
  }
  applyInterval();

  if (hopTimer === null) hopTimer = setInterval(step, HOP_MS);
}

export function stopFusion(): void {
  running = false;
  try {
    accelSub?.remove();
  } catch {
    // Already removed.
  }
  try {
    gyroSub?.remove();
  } catch {
    // Already removed.
  }
  accelSub = null;
  gyroSub = null;
  if (hopTimer !== null) {
    clearInterval(hopTimer);
    hopTimer = null;
  }
  bufHead = 0;
  bufCount = 0;
  context = emptyContext();
}

export interface FusionStats {
  running: boolean;
  mode: FusionMode;
  intervalMs: number;
  /** The hardware FIFO batch latency the native module requests (P-006). */
  batchLatencyUs: number;
  bufferedSamples: number;
  windowsProcessed: number;
  candidatesEmitted: number;
  context: FusionContext;
}

export function fusionStats(): FusionStats {
  return {
    running,
    mode,
    intervalMs: MODE_INTERVAL_MS[mode],
    batchLatencyUs: CONFIG.sensorBatchLatencyUs,
    bufferedSamples: bufCount,
    windowsProcessed,
    candidatesEmitted,
    context: { ...context },
  };
}

/** Clear the impact tracker — used after a false alarm so it cannot re-fire. */
export function resetFusionContext(): void {
  context = emptyContext();
  recentMinG = 1;
  recentMinAt = 0;
}
