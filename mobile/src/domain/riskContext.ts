/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RISK CONTEXT ENGINE — PRD §13.5
 *
 * Deterministic weights. No learned model, no inference server, no network call.
 * The whole engine is a readable, testable scoring function precisely because
 * this is the layer that will be tuned for two years and every firing must be
 * explainable after the fact (same reasoning as the §13.4 fusion stage).
 *
 * ★★★ PRIVACY CONTRACT — THE REASON THIS FILE EXISTS ON-DEVICE ★★★
 * The engine needs continuous multi-sensor context: time, location class, motion,
 * who is nearby, heart rate against baseline, weather. That set of inputs is a
 * near-perfect surveillance record of a person's day. It NEVER leaves the phone.
 * The ONLY value that is ever transmitted is the single opaque integer 0–4 that
 * computeRisk() returns — it rides in `IncidentEnvelope.riskContext` and in
 * `Incident.riskContext`, and nothing else from this module is serialised,
 * synced, logged to the server, or attached to telemetry. The inputs stay here.
 * (PRD §13.5 privacy note; NFR-013; docs/02 §10.2.)
 *
 * ★ WORKED EXAMPLE (PRD §13.5, reproduced verbatim as the engine's fixture) ★
 *   "Sister walking home from the station at 21:40, unknown location class, no
 *    BLE peers nearby, monsoon rain, HR 15% above baseline → risk context HIGH.
 *    The system silently raises location sampling to 5 s, drops the fall
 *    threshold, shortens the cancel window to 10 s, pre-warms the WebSocket, and
 *    pre-caches the neighbour list. She did nothing and noticed nothing. If her
 *    phone hits the ground, the family knows in eight seconds instead of never."
 *
 *   Scored here:  hour 21 → +2 · unknown → +3 · walking → +1 · 0 peers → +2 ·
 *                 HR +15% → +2 · weather alert → +2 · not declared → 0
 *                 total 12 → bucket 3 (HIGH).
 *   Effects at 3: sampling 15 s, cancel window ×0.55, fall threshold 2.4 g.
 *   Had she also tapped "walking home alone" (+4 → 16) the level would be 4 and
 *   sampling would be the full 5 s of the narrative.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { CONFIG } from '../core/config';
import { DEFAULT_POLICY, effectiveCancelWindowS } from '../core/policy';
import type { RiskContextInputs, RiskLevel } from '../core/types';

/** One scored signal. Kept as data so explainRisk() and computeRisk() cannot drift. */
export interface RiskContribution {
  readonly key: string;
  readonly label: string;
  readonly points: number;
}

/**
 * The weight table, stated once.
 *
 * Signs matter as much as magnitudes: being at home and having family within BLE
 * range REDUCE risk. An engine that can only ever add points ratchets everyone to
 * maximum paranoia over a day, which burns battery (NFR-005) and destroys trust.
 */
export const RISK_WEIGHTS = {
  hourLateNight: 3, // 22:00–04:59
  hourAfterDark: 2, // 19:00–21:59
  hourPreDawn: 1, // 05:00–06:59
  hourDaytime: 0,
  locationUnknown: 3,
  locationKnown: 0,
  locationHome: -2,
  motionVehicle: 2, // C2: two-wheelers dominate in Gujarat; a rider is exposed
  motionCycling: 2,
  motionRunning: 1,
  motionWalking: 1,
  motionStill: 0,
  peersNone: 2,
  peersOne: 0,
  peersMany: -1,
  hrSevere: 3, // ≥25% above baseline
  hrHigh: 2, // ≥15%
  hrMild: 1, // ≥8%
  weatherAlert: 2, // IMD cyclone/flood warning — C2 says this is real here
  userDeclared: 4,
} as const;

/**
 * Bucket boundaries over the raw score. Range of the score is −3 … +19.
 * Deliberately wide buckets at the bottom: most of life is level 0 and should be.
 */
const BUCKETS: readonly { min: number; level: RiskLevel }[] = [
  { min: 13, level: 4 },
  { min: 9, level: 3 },
  { min: 5, level: 2 },
  { min: 2, level: 1 },
  { min: -Infinity, level: 0 },
];

function hourContribution(hourOfDay: number): RiskContribution {
  // Normalise defensively — a bad sensor read must not throw inside T0's path.
  const h = Number.isFinite(hourOfDay) ? ((Math.floor(hourOfDay) % 24) + 24) % 24 : 12;
  if (h >= 22 || h < 5) return { key: 'hour', label: 'Late night', points: RISK_WEIGHTS.hourLateNight };
  if (h >= 19) return { key: 'hour', label: 'After dark', points: RISK_WEIGHTS.hourAfterDark };
  if (h < 7) return { key: 'hour', label: 'Before dawn', points: RISK_WEIGHTS.hourPreDawn };
  return { key: 'hour', label: 'Daytime', points: RISK_WEIGHTS.hourDaytime };
}

function locationContribution(cls: RiskContextInputs['locationClass']): RiskContribution {
  if (cls === 'unknown') return { key: 'location', label: 'Unfamiliar area', points: RISK_WEIGHTS.locationUnknown };
  if (cls === 'known') return { key: 'location', label: 'Familiar area', points: RISK_WEIGHTS.locationKnown };
  return { key: 'location', label: 'At home', points: RISK_WEIGHTS.locationHome };
}

function motionContribution(m: RiskContextInputs['motionState']): RiskContribution {
  switch (m) {
    case 'vehicle':
      return { key: 'motion', label: 'In a vehicle', points: RISK_WEIGHTS.motionVehicle };
    case 'cycling':
      return { key: 'motion', label: 'Cycling', points: RISK_WEIGHTS.motionCycling };
    case 'running':
      return { key: 'motion', label: 'Running', points: RISK_WEIGHTS.motionRunning };
    case 'walking':
      return { key: 'motion', label: 'Walking', points: RISK_WEIGHTS.motionWalking };
    default:
      return { key: 'motion', label: 'Still', points: RISK_WEIGHTS.motionStill };
  }
}

function peersContribution(n: number): RiskContribution {
  const peers = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (peers === 0) return { key: 'peers', label: 'No family nearby', points: RISK_WEIGHTS.peersNone };
  if (peers === 1) return { key: 'peers', label: 'One family device nearby', points: RISK_WEIGHTS.peersOne };
  return { key: 'peers', label: `${peers} family devices nearby`, points: RISK_WEIGHTS.peersMany };
}

function heartContribution(hrDeltaPct: number | null): RiskContribution {
  // null is the honest value when there is no wearable. Absence of data is not
  // evidence of calm, so it scores zero rather than being imputed either way.
  if (hrDeltaPct === null || !Number.isFinite(hrDeltaPct)) {
    return { key: 'hr', label: 'No heart-rate data', points: 0 };
  }
  if (hrDeltaPct >= 25) return { key: 'hr', label: `Heart rate ${Math.round(hrDeltaPct)}% above baseline`, points: RISK_WEIGHTS.hrSevere };
  if (hrDeltaPct >= 15) return { key: 'hr', label: `Heart rate ${Math.round(hrDeltaPct)}% above baseline`, points: RISK_WEIGHTS.hrHigh };
  if (hrDeltaPct >= 8) return { key: 'hr', label: `Heart rate ${Math.round(hrDeltaPct)}% above baseline`, points: RISK_WEIGHTS.hrMild };
  return { key: 'hr', label: 'Heart rate normal', points: 0 };
}

/**
 * Every signal that fed the score, with its contribution. On-device only —
 * this is what powers the "why does my phone think this?" screen, which is the
 * counterweight to running a context engine on someone's life at all.
 */
export function riskContributions(inputs: RiskContextInputs): RiskContribution[] {
  const out: RiskContribution[] = [
    hourContribution(inputs.hourOfDay),
    locationContribution(inputs.locationClass),
    motionContribution(inputs.motionState),
    peersContribution(inputs.blePeersNearby),
    heartContribution(inputs.hrDeltaPct),
  ];
  if (inputs.weatherAlert) {
    out.push({ key: 'weather', label: 'Weather warning in force', points: RISK_WEIGHTS.weatherAlert });
  }
  if (inputs.userDeclaredVulnerable) {
    out.push({ key: 'declared', label: 'You said you feel unsafe', points: RISK_WEIGHTS.userDeclared });
  }
  return out;
}

/** The raw additive score, before bucketing. Exposed for tests and tuning. */
export function riskScore(inputs: RiskContextInputs): number {
  return riskContributions(inputs).reduce((sum, c) => sum + c.points, 0);
}

/**
 * ★ The single opaque integer. This — and nothing else in this file — is what
 * the server ever sees. See the privacy contract at the top.
 */
export function computeRisk(inputs: RiskContextInputs): RiskLevel {
  const score = riskScore(inputs);
  let level: RiskLevel = 0;
  for (const b of BUCKETS) {
    if (score >= b.min) {
      level = b.level;
      break;
    }
  }
  // A person who has told us they feel unsafe is never scored below "elevated",
  // whatever the sensors say. The model does not get to overrule the human.
  if (inputs.userDeclaredVulnerable && level < 2) return 2;
  return level;
}

const DESCRIPTIONS: Record<RiskLevel, string> = {
  0: 'Normal',
  1: 'Slightly raised',
  2: 'Raised',
  3: 'High',
  4: 'Very high',
};

export function describeRisk(level: RiskLevel): string {
  return DESCRIPTIONS[level] ?? DESCRIPTIONS[0];
}

export interface RiskEffects {
  /** Location sampling period. PRD §13.5: 15 min at rest → 5 s at maximum risk. */
  samplingMs: number;
  /** Multiplier the escalation policy applies to the cancel window. */
  cancelWindowFactor: number;
  /** Free-fall impact threshold for the fall detector, in g. Lower = more sensitive. */
  fallThresholdG: number;
  /** Cap on PROBE prompts per hour. Zero at rest: never nag a calm person. */
  probeFrequency: number;
}

/** Endpoints come from CONFIG so the power budget (NFR-005) has one owner. */
const SAMPLING_MS: Record<RiskLevel, number> = {
  0: CONFIG.idleLocationIntervalMs,
  1: 300_000,
  2: 60_000,
  3: 15_000,
  4: CONFIG.watchLocationIntervalMs,
};

const FALL_THRESHOLD_G: Record<RiskLevel, number> = { 0: 3.0, 1: 2.8, 2: 2.6, 3: 2.4, 4: 2.2 };
const PROBES_PER_HOUR: Record<RiskLevel, number> = { 0: 0, 1: 1, 2: 2, 3: 4, 4: 6 };

/**
 * The cancel-window multiplier is DERIVED from core/policy.effectiveCancelWindowS
 * rather than restated here. Two copies of the risk→window curve is exactly the
 * "two divergent escalation policies" bug class ADR-013 exists to prevent; the
 * policy module stays authoritative and this is a read-only mirror for the UI.
 */
function cancelWindowFactor(level: RiskLevel): number {
  const base = DEFAULT_POLICY.scenarios.MANUAL.cancelWindowS;
  if (base <= 0) return 1;
  return effectiveCancelWindowS(DEFAULT_POLICY, 'MANUAL', level) / base;
}

export function riskEffects(level: RiskLevel): RiskEffects {
  const l: RiskLevel = ([0, 1, 2, 3, 4] as RiskLevel[]).includes(level) ? level : 0;
  return {
    samplingMs: SAMPLING_MS[l],
    cancelWindowFactor: cancelWindowFactor(l),
    fallThresholdG: FALL_THRESHOLD_G[l],
    probeFrequency: PROBES_PER_HOUR[l],
  };
}

/**
 * Human-readable reasons, strongest first. Never leaves the device — it exists so
 * the subject of the monitoring can audit the monitoring.
 */
export function explainRisk(inputs: RiskContextInputs): string[] {
  return riskContributions(inputs)
    .filter((c) => c.points !== 0)
    .sort((a, b) => b.points - a.points)
    .map((c) => c.label);
}

/**
 * Inputs for a device that has not yet acquired context — used on cold boot so
 * the engine always has something defensible to score. Everything unknown is
 * assumed benign (familiar area, still, one peer, no vitals); the hour is the
 * one thing a phone always knows, so it is the only signal that can raise the
 * level before the sensors warm up.
 */
export function neutralRiskInputs(atMs: number = Date.now()): RiskContextInputs {
  return {
    hourOfDay: new Date(atMs).getHours(),
    locationClass: 'known',
    motionState: 'still',
    blePeersNearby: 1,
    hrDeltaPct: null,
    weatherAlert: false,
    userDeclaredVulnerable: false,
  };
}
