/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · TRIGGER ROUTER — the orchestrator
 *
 * Owns the incident state machine instance, the cancel window, the PROBE timer
 * and the escalation ladder. Everything else in T0 is a component; this is the
 * thing that decides.
 *
 * ★ THE 500 ms BUDGET (§2.3) ★
 *   t0  trigger registered                                            0 ms
 *      ├─ PocketSuppressor.check()                                 ≤   5 ms
 *      ├─ StateMachine.transition(IDLE|WATCH → PENDING)            ≤   2 ms
 *      ├─ LocalAlarmController.prime()                             ≤  20 ms
 *      ├─ BlackBoxRingBuffer.seal()   (fired, NOT awaited)         ≤  30 ms
 *      ├─ Location: LAST KNOWN, never a fresh fix ★                ≤   1 ms
 *      ├─ SignedEnvelope.build() + Ed25519 sign                    ≤  80 ms
 *      └─ TransportDispatcher.fanOut() → returns immediately       ≤  10 ms
 *   t2  first byte leaves the device                          total ≤ 150 ms
 *
 * ★ LAST KNOWN LOCATION, NEVER A FRESH FIX ★
 * `deps.lastKnownLocation()` must be a synchronous read of a cached fix. A cold
 * GNSS fix takes 5–30 SECONDS and would blow the entire budget sixty times over
 * — and the person is not usually moving fast enough for a 200 m stale fix to
 * matter, while thirty seconds of silence always matters. Accuracy travels with
 * the fix so the responder UI shows a confidence radius rather than a false pin.
 * A fresh fix is streamed later as a LOCATION_UPDATE event.
 *
 * ★ CONSTANT-TIME DURESS (I-7, T-213) ★
 * `verifyPin` compares the entry against BOTH the cancel PIN and the duress PIN,
 * every time, with `timingSafeEqual`, with no early return. Both outcomes then
 * run the SAME code path: same timers cleared, same alarm stopped, same
 * fixed-size envelope built, dispatched at the same fixed offset over the same
 * legs. The only difference is one bit inside the ciphertext.
 *
 * ★ AN UNSET PIN IS NOT A PIN ★
 * `padPin('')` is 32 zero bytes, which is also what an EMPTY entry pads to. On a
 * phone whose SecureStore holds no PINs yet (mid-onboarding, or a restore that
 * kept `kavach.onboarded` but lost the THIS_DEVICE_ONLY items) a bare tap on
 * Cancel therefore matched BOTH PINs and, by the identical-PIN rule, opened a
 * silent duress incident to the whole family. So an unset PIN never matches
 * anything, an empty entry never matches anything, and the snapshot says which
 * PINs are actually set so the UI can ask for them instead of pretending.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import {
  ACTIVE_STATES,
  isTerminal,
  nextState,
  timeoutsFor,
  type GuardSet,
  type IncidentEvent,
  type IncidentState,
} from './stateMachine.generated';
import {
  DEFAULT_POLICY,
  DEFAULT_POLICY_VERSION,
  effectiveCancelWindowS,
  ladderFor,
} from '../core/policy';
import { CONFIG } from '../core/config';
import { coarseCell, inc8 as toInc8, nowHlc, uuidv7 } from '../core/ids';
import {
  bleTag,
  bytesToBase64,
  concat,
  incidentContentKey,
  blePseudonym,
  bleWindow,
  sealJson,
  timingSafeEqual,
  type DeviceKeypair,
} from '../crypto';
import type {
  DegradationLevel,
  EscalationPolicy,
  IncidentSealedPayload,
  MedicalCard,
  RiskLevel,
  TriggerType,
  UUID,
} from '../core/types';
import { DegradationLevel as Degradation } from '../core/types';
import {
  EnvelopeSizeError,
  buildMinimalEnvelope,
  buildSignedEnvelope,
  type BuildEnvelopeInput,
  type SignedEnvelope,
} from './envelope';
import { TRIGGER_CODE, encodeSms } from './smsPayload';
import { cancelPendingSms, fanOut, forceSms, noteAck, type FanOutContext } from './dispatcher';
import {
  playCue,
  primeAlarm,
  releaseAlarm,
  startAlarm,
  startCountdownHaptics,
  stopAlarm,
  stopCountdownHaptics,
  isAlarmActive,
} from './alarm';
import { initBlackBox, sealBlackBox } from './blackbox';
import {
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  setFusionMode,
  startFusion,
  stopFusion,
  resetFusionContext,
  type FusionCandidate,
} from './fusion';
import {
  pocketState,
  shouldSuppress,
  startPocketWatch,
  stopPocketWatch,
  type TriggerSource,
} from './pocketSuppressor';
import { registerWatchdog } from './watchdog';

// ── Dependency injection ──────────────────────────────────────────────────────

export interface T0Location {
  lat: number;
  lon: number;
  accuracyM: number;
  altitude?: number;
  /** m/s. Feeds the crash detector's speed-drop term. */
  speed?: number;
  heading?: number;
  /** Epoch ms of the fix. Staleness is information, not a defect. */
  at: number;
}

export interface T0Deps {
  familyId: UUID;
  deviceId: UUID;
  memberId: UUID;
  /** ASCII, ≤8 chars, unique per family (F-18). Goes into the SMS payload. */
  asciiShortName: string;
  keypair: DeviceKeypair;
  groupSecret: Uint8Array;
  /** Plaintext PINs. Held in memory only; persisted by the caller in SecureStore. */
  cancelPin: string;
  duressPin: string;
  policy?: EscalationPolicy;
  /** ★ Synchronous read of a CACHED fix. Must never trigger a GNSS acquisition. */
  lastKnownLocation: () => T0Location | null;
  batteryPct: () => number;
  risk: () => RiskLevel;
  degradation: () => DegradationLevel;
  /** P-054, cached: true when the SIM is on a visited network that may bar SMS. */
  roaming?: () => boolean;
  /** Family numbers AND the aggregator inbound number (docs/02 §2.7.5). */
  smsRecipients: () => string[];
  /** Attached to the sealed payload so a responder has it before they arrive. */
  medical?: () => MedicalCard | null;
  /** P-017: adaptive lengthening of the cancel window after repeated mistakes. */
  falsePositiveStreak?: () => number;
  onEvent?: (event: T0Event) => void;
  /** Start fusion, the pocket watch and the watchdog from initT0. Default true. */
  autoStart?: boolean;
}

export interface T0Event {
  incidentId: UUID;
  /** A state-machine event, or one of the router's own lifecycle markers. */
  type: IncidentEvent | 'INCIDENT_OPEN' | 'DISPATCHED' | 'SUPPRESSED' | 'BLACKBOX_SEALED' | 'LADDER';
  at: number;
  hlc: string;
  state: IncidentState;
  detail?: Record<string, unknown>;
}

export interface T0Snapshot {
  state: IncidentState;
  incidentId: UUID | null;
  trigger: TriggerType | null;
  duress: boolean;
  isDrill: boolean;
  confidencePct: number;
  /** Epoch ms the cancel window expires, else null. */
  pendingUntil: number | null;
  cancelWindowS: number;
  ladderIndex: number;
  alarmActive: boolean;
  openedAt: number | null;
  autoQuiesceAt: number | null;
  lastTriggerToFanOutMs: number | null;
  budgetExceededCount: number;
  /**
   * Whether a non-empty cancel / duress PIN is configured. While either is
   * false the corresponding outcome cannot be produced by any entry, and the
   * screen should say "set your PINs" rather than showing a pad that cannot work.
   */
  cancelPinSet: boolean;
  duressPinSet: boolean;
}

/**
 * How much of the sealed payload fitted into the fixed-size envelope.
 *   full    — location + battery + medical card + black-box ref
 *   lean    — the medical card was dropped so the PRECISE LOCATION still fits
 *   minimal — no sealed payload at all (KV-1004); only the ≈1 km coarse cell
 */
export type PayloadTier = 'full' | 'lean' | 'minimal';

export interface T0TriggerResult {
  incidentId: UUID | null;
  suppressed: boolean;
  reason: string;
  /** t0 → fanOut, in ms. Budgeted at ≤500 (CONFIG.t2BudgetMs). */
  elapsedMs: number;
}

// ── Module state ──────────────────────────────────────────────────────────────

/** Fixed compare length so PIN length is not observable in the compare itself. */
const PIN_COMPARE_LEN = 32;
/**
 * T-213: both the FALSE_ALARM and the ACTIVE_L1_SILENT paths emit their
 * fixed-size envelope at exactly this offset after the PIN is accepted.
 */
const CANCEL_EVENT_DELAY_MS = 250;

/** The only ladder states. A step that fires from anywhere else is a bug. */
const LADDER_STATES: ReadonlySet<IncidentState> = new Set([
  'ACTIVE_L1',
  'ACTIVE_L1_SILENT',
  'ACTIVE_L2',
  'ACTIVE_L3',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let deps: T0Deps | null = null;
let policy: EscalationPolicy = DEFAULT_POLICY;
let cancelPinBytes: Uint8Array = new Uint8Array(PIN_COMPARE_LEN);
let duressPinBytes: Uint8Array = new Uint8Array(PIN_COMPARE_LEN);
let cancelPinSet = false;
let duressPinSet = false;

let state: IncidentState = 'IDLE';
let incidentId: UUID | null = null;
/**
 * True from the moment an id is allocated for a new incident until the machine
 * reaches a terminal state or falls back to IDLE. `incidentId` itself is kept
 * after that — the store reads it off the snapshot to render the closed
 * incident — but no further transition may be LOGGED under it: with the id left
 * live, the next CONTEXT_ELEVATED or the next incident's opening transition was
 * appended to a RESOLVED incident's timeline (I-4 makes that permanent).
 */
let incidentLive = false;
let incidentTrigger: TriggerType | null = null;
let incidentDuress = false;
let incidentIsDrill = false;
let incidentConfidencePct = 0;
let openedAt: number | null = null;
let autoQuiesceAt: number | null = null;
let pendingUntil: number | null = null;
let cancelWindowS = 0;
let ladderIndex = 0;
let lastEnvelope: SignedEnvelope | null = null;
let lastFanOutCtx: FanOutContext | null = null;
let lastTriggerToFanOutMs: number | null = null;
let budgetExceededCount = 0;
let started = false;

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const subscribers = new Set<(s: T0Snapshot) => void>();

function setTimer(key: string, ms: number, fn: () => void): void {
  clearTimer(key);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      try {
        fn();
      } catch {
        // A throwing timer must never leave the incident stuck (ADR-018).
      }
    }, Math.max(0, ms)),
  );
}

function clearTimer(key: string): void {
  const t = timers.get(key);
  if (t !== undefined) {
    clearTimeout(t);
    timers.delete(key);
  }
}

function clearAllTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

function padPin(pin: string): Uint8Array {
  const out = new Uint8Array(PIN_COMPARE_LEN);
  const n = Math.min(pin.length, PIN_COMPARE_LEN - 1);
  for (let i = 0; i < n; i++) out[i] = pin.charCodeAt(i) & 0xff;
  // Length in the final byte: without it "1234" and "1234\0…" would collide.
  out[PIN_COMPARE_LEN - 1] = pin.length & 0xff;
  return out;
}

function snapshot(): T0Snapshot {
  return {
    state,
    incidentId,
    trigger: incidentTrigger,
    duress: incidentDuress,
    isDrill: incidentIsDrill,
    confidencePct: incidentConfidencePct,
    pendingUntil,
    cancelWindowS,
    ladderIndex,
    alarmActive: isAlarmActive(),
    openedAt,
    autoQuiesceAt,
    lastTriggerToFanOutMs,
    budgetExceededCount,
    cancelPinSet,
    duressPinSet,
  };
}

function notify(): void {
  const s = snapshot();
  for (const fn of subscribers) {
    try {
      fn(s);
    } catch {
      // A crashing screen must never stop the state machine.
    }
  }
}

function emit(
  type: T0Event['type'],
  detail?: Record<string, unknown>,
  id: UUID | null = incidentLive ? incidentId : null,
): void {
  if (!id) return;
  try {
    deps?.onEvent?.({ incidentId: id, type, at: Date.now(), hlc: nowHlc().hex, state, detail });
  } catch {
    // Event persistence is a T1 concern; T0 never awaits or depends on it.
  }
}

// ── Envelope + SMS construction ───────────────────────────────────────────────

/**
 * `withMedical: false` builds the LEAN payload — everything except the medical
 * card. A filled card (3 allergies, 3 medications, 2 conditions, 2 ICE contacts,
 * the capacity core/types documents) seals to ~640 bytes and pushes the envelope
 * past FIXED_ENVELOPE_SIZE, and the old fallback then dropped the WHOLE sealed
 * payload — lat, lon and accuracy included. Exactly the people a responder most
 * needs to find fast were the ones whose SOS carried only a ≈1 km cell.
 */
function buildSealedPayload(
  id: UUID,
  loc: T0Location | null,
  withMedical: boolean,
  blackBoxRef?: string,
): string {
  if (!deps) return '';
  const payload: IncidentSealedPayload = {
    lat: loc?.lat ?? 0,
    lon: loc?.lon ?? 0,
    accuracyM: loc?.accuracyM ?? -1,
    altitude: loc?.altitude,
    speed: loc?.speed,
    heading: loc?.heading,
    batteryPct: deps.batteryPct(),
    medical: withMedical ? (deps.medical?.() ?? undefined) : undefined,
    blackBoxRef,
  };
  return sealJson(incidentContentKey(deps.groupSecret, id), payload, id);
}

/**
 * The 26-byte BLE distress body (§4.4 L1): rotating family pseudonym so a
 * stranger cannot correlate the device across days (F-12 accepts windows
 * n-1/n/n+1), the incident prefix so a relayed report deduplicates against the
 * HTTP one (F-09), and an HMAC so a peer can verify it offline.
 *
 * ★ The second meta byte is a constant 0. ★ It used to carry the duress bit —
 * in PLAINTEXT, under an HMAC, to any BLE scanner within ten metres, under a
 * pseudonym that linked it to the open advert sent seconds earlier. The padded
 * envelope, the fixed 250 ms offset and the constant-time compare exist so the
 * T4 attacker standing next to her cannot tell duress from cancel; the advert
 * was broadcasting that exact bit. Duress travels inside the sealed payload and
 * nowhere else. The slot stays so the advert length does not change.
 *
 * Exported for the invariant test only; nothing outside this module calls it.
 */
export function buildBleAdvert(id: UUID, trigger: TriggerType): string | undefined {
  if (!deps) return undefined;
  try {
    const pseudonym = blePseudonym(deps.groupSecret, bleWindow());
    const prefix = new Uint8Array(8);
    const inc = toInc8(id);
    for (let i = 0; i < 8; i++) prefix[i] = inc.charCodeAt(i) & 0xff;
    const code = TRIGGER_CODE[trigger] ?? 'SOS';
    const meta = new Uint8Array([code.charCodeAt(0) & 0xff, 0]);
    const body = concat(pseudonym, prefix, meta);
    return bytesToBase64(concat(body, bleTag(deps.groupSecret, body)));
  } catch {
    return undefined;
  }
}

interface BuiltEnvelope {
  envelope: SignedEnvelope | null;
  tier: PayloadTier;
}

/**
 * Build the envelope, degrading the sealed payload in tiers when it cannot fit:
 * full → lean (no medical card, location kept) → minimal (KV-1004, no sealed
 * payload). Every tier is the same fixed size and signed; never variable-size,
 * which would leak duress (F-01).
 */
function buildEnvelope(
  id: UUID,
  trigger: TriggerType,
  loc: T0Location | null,
  duress: boolean,
  isDrill: boolean,
  confidencePct: number,
  sealedPayload: string,
  leanSealedPayload?: () => string,
): BuiltEnvelope {
  if (!deps) return { envelope: null, tier: 'minimal' };
  const input: BuildEnvelopeInput = {
    incidentId: id,
    familyId: deps.familyId,
    deviceId: deps.deviceId,
    memberId: deps.memberId,
    trigger,
    confidencePct,
    riskContext: deps.risk(),
    duress,
    isDrill,
    policyVersion: policy.version ?? DEFAULT_POLICY_VERSION,
    coarseCell: loc ? coarseCell(loc.lat, loc.lon) : 'c7:unknown',
    batteryPct: deps.batteryPct(),
    sealedPayload,
  };
  try {
    return { envelope: buildSignedEnvelope(input, deps.keypair), tier: 'full' };
  } catch (e) {
    if (!(e instanceof EnvelopeSizeError)) return { envelope: null, tier: 'minimal' };
  }
  // Too big. The precise location has priority over the card: retry without
  // the medical card before giving up the sealed payload altogether.
  if (leanSealedPayload) {
    try {
      const lean = leanSealedPayload();
      return { envelope: buildSignedEnvelope({ ...input, sealedPayload: lean }, deps.keypair), tier: 'lean' };
    } catch (e) {
      if (!(e instanceof EnvelopeSizeError)) return { envelope: null, tier: 'minimal' };
    }
  }
  // KV-1004: strip the sealed payload and retry minimal. Still fixed-size,
  // still signed — never a variable-size envelope, which would leak duress.
  try {
    return { envelope: buildMinimalEnvelope(input, deps.keypair), tier: 'minimal' };
  } catch {
    return { envelope: null, tier: 'minimal' };
  }
}

function buildFanOutContext(
  id: UUID,
  trigger: TriggerType,
  loc: T0Location | null,
  duress: boolean,
  isDrill: boolean,
  kind: 'open' | 'event' = 'open',
): FanOutContext {
  const d = deps!;
  const sms = encodeSms({
    incidentId: id,
    asciiShortName: d.asciiShortName,
    trigger,
    lat: loc?.lat ?? 0,
    lon: loc?.lon ?? 0,
    accuracyM: loc?.accuracyM ?? 0,
    batteryPct: d.batteryPct(),
    atMs: Date.now(),
    groupSecret: d.groupSecret,
  });
  return {
    degradation: d.degradation(),
    familyId: d.familyId,
    smsText: sms.text,
    smsRecipients: d.smsRecipients(),
    bleAdvert: buildBleAdvert(id, trigger),
    kind,
    // Cached like batteryPct: a synchronous read, never an await (P-054).
    roaming: d.roaming?.() ?? false,
    isDrill,
    duress,
  };
}

// ── State transitions ─────────────────────────────────────────────────────────

function transition(event: IncidentEvent, guards: GuardSet = {}): boolean {
  const next = nextState(state, event, guards);
  if (next === null) return false;
  const from = state;
  state = next;
  emit(event, { from, to: next });
  onEnterState(from, next);
  notify();
  return true;
}

function armSpecTimeouts(s: IncidentState): void {
  // The generated spec is the authority on which timeouts exist; the policy is
  // the authority on their duration (ADR-013). Where both speak, policy wins.
  for (const t of timeoutsFor(s)) {
    if (t.afterS === undefined) continue;
    if (t.on === 'PROBE_TIMEOUT') {
      setTimer('probe', t.afterS * 1000, () => transition('PROBE_TIMEOUT'));
    } else if (t.on === 'PROGRESS_WATCHDOG') {
      setTimer('progress', t.afterS * 1000, () => transition('PROGRESS_WATCHDOG'));
    }
  }
}

function armAutoQuiesce(): void {
  // F-02: an incident nobody ever closed must not stay live forever.
  if (openedAt === null) return;
  autoQuiesceAt = openedAt + CONFIG.autoQuiesceMs;
  setTimer('quiesce', autoQuiesceAt - Date.now(), () => transition('AUTO_QUIESCE'));
}

function onEnterState(from: IncidentState, to: IncidentState): void {
  const scenario = incidentTrigger ? policy.scenarios[incidentTrigger] : undefined;

  switch (to) {
    case 'WATCH':
      // §13.5: elevated context silently raises the sampling rate. She notices
      // nothing; if her phone hits the ground the family knows in eight seconds.
      setFusionMode('watch');
      break;

    case 'IDLE':
      clearAllTimers();
      stopAlarm();
      stopCountdownHaptics();
      setFusionMode('idle');
      pendingUntil = null;
      resetFusionContext();
      // A SUSPECT/PROBE that resolved itself never became an incident; whatever
      // id was allocated for it must not label the next WATCH transition.
      incidentLive = false;
      break;

    case 'SUSPECT':
      setFusionMode('watch');
      break;

    case 'PROBE':
      // "Are you all right?" — 45 s to answer before we assume the worst.
      playCue('probe');
      armSpecTimeouts('PROBE');
      break;

    case 'PENDING':
      clearTimer('probe');
      break;

    case 'ACTIVE_L1':
      stopCountdownHaptics();
      pendingUntil = null;
      startAlarm({ silent: false, strobe: true, haptics: true });
      startLadder();
      armEscalation();
      armAutoQuiesce();
      break;

    case 'ACTIVE_L1_SILENT':
      // ★ Duress. Byte-identical UI to FALSE_ALARM, full telemetry underneath.
      stopCountdownHaptics();
      stopAlarm();
      pendingUntil = null;
      startLadder();
      armEscalation();
      armAutoQuiesce();
      break;

    case 'ACTIVE_L2':
      clearTimer('escalate');
      if (!incidentDuress) startAlarm({ silent: false, strobe: true, haptics: true });
      armEscalation();
      break;

    case 'ACTIVE_L3':
      clearTimer('escalate');
      if (!incidentDuress) startAlarm({ silent: false, strobe: true, haptics: true });
      break;

    case 'OWNED':
      // Someone is coming. This is the sound that matters most in the system.
      playCue('ack');
      if (incidentId) noteAck(incidentId);
      clearTimer('escalate');
      // ★ The ladder stops on CLAIM. It used to keep running: a claim at 30 s
      //   still SMSed every family number at 60 s and restarted the siren,
      //   strobe and haptics at 90 s on a phone whose responder was already on
      //   the way. Only the terminal states cleared this timer.
      clearTimer('ladder');
      armSpecTimeouts('OWNED');
      break;

    case 'RESOLVING':
      clearTimer('escalate');
      clearTimer('progress');
      clearTimer('ladder');
      stopAlarm();
      break;

    case 'FALSE_ALARM':
    case 'RESOLVED':
    case 'DORMANT':
      clearAllTimers();
      stopAlarm();
      stopCountdownHaptics();
      pendingUntil = null;
      if (to === 'RESOLVED') playCue('resolve');
      setFusionMode('idle');
      resetFusionContext();
      incidentLive = false;
      break;

    default:
      break;
  }

  if (to !== from && !isTerminal(to) && to !== 'PENDING' && to !== 'IDLE') playCue('state');
  if (scenario?.loudCancel && to === 'PENDING') {
    // Fall/crash: the cancel window itself is loud, so a bystander looks over
    // even while the subject still has time to cancel.
    startAlarm({ silent: false, strobe: true, haptics: false });
  }
}

// ── Escalation ladder ─────────────────────────────────────────────────────────

function armEscalation(): void {
  if (!incidentTrigger) return;
  const p = policy.scenarios[incidentTrigger] ?? DEFAULT_POLICY.scenarios.MANUAL;
  if (state === 'ACTIVE_L1' || state === 'ACTIVE_L1_SILENT') {
    setTimer('escalate', p.l2AfterS * 1000, () => transition('NO_ACK'));
  } else if (state === 'ACTIVE_L2') {
    setTimer('escalate', Math.max(1, p.l3AfterS - p.l2AfterS) * 1000, () => transition('NO_ACK'));
  }
}

function startLadder(): void {
  ladderIndex = 0;
  scheduleLadderStep();
}

function scheduleLadderStep(): void {
  if (!incidentTrigger || openedAt === null) return;
  const steps = ladderFor(policy, incidentTrigger);
  if (ladderIndex >= steps.length) return;
  const step = steps[ladderIndex];
  const dueAt = openedAt + step.atS * 1000;
  setTimer('ladder', dueAt - Date.now(), () => runLadderStep());
}

function runLadderStep(): void {
  if (!incidentTrigger || !incidentId) return;
  // Belt to the braces above: a step that was already queued as a macrotask
  // when CLAIM landed must not fire either. Claimed, resolving and closed
  // incidents have no ladder.
  if (!LADDER_STATES.has(state)) return;
  const steps = ladderFor(policy, incidentTrigger);
  if (ladderIndex >= steps.length) return;
  const step = steps[ladderIndex];
  emit('LADDER', { index: ladderIndex, tier: step.tier, label: step.label, channels: step.channels });

  // The SMS tier is the one T0 can actually execute by itself; push, CallKit
  // and voice belong to the notification plane and are driven by the server.
  if (step.channels.includes('sms') && lastEnvelope && lastFanOutCtx) {
    forceSms(lastEnvelope, lastFanOutCtx);
  }
  if (step.tier >= 2 && !incidentDuress) {
    startAlarm({ silent: false, strobe: true, haptics: true });
  }

  ladderIndex++;
  scheduleLadderStep();
  notify();
}

/** Skip the wait and fire the next ladder step now. */
export function advanceLadder(): void {
  clearTimer('ladder');
  runLadderStep();
}

// ── The trigger path ──────────────────────────────────────────────────────────

export interface TriggerOptions {
  confidencePct?: number;
  isDrill?: boolean;
  /** Physical origin. Only button sources are eligible for pocket suppression. */
  source?: TriggerSource;
  /** P-053: the caller may pre-allocate the client-side UUIDv7. */
  incidentId?: UUID;
}

/**
 * The id an incident is opened under. A caller may pre-allocate one (P-053) —
 * but a relay handing us '' or a malformed string used to reach `inc8`, which
 * threw out of `onTrigger` after the alarm had primed and before the fan-out.
 * Anything that is not a UUID is replaced, never trusted, on the one path that
 * must not throw (ADR-018).
 */
function allocateIncidentId(requested?: UUID): UUID {
  const id = requested && UUID_RE.test(requested) ? requested : uuidv7();
  incidentId = id;
  incidentLive = true;
  return id;
}

/**
 * A closed incident leaves the machine parked in its terminal state — nothing
 * in the app calls `resetT0()` — and terminal states have no exits. So the next
 * manual press took the forced path with no opening row logged, and the fall
 * detector was DEAD until the next app start (`noteSensorCandidate` only acts
 * from IDLE/WATCH). For the purpose of the next incident, closed IS idle: leave
 * the terminal state quietly (the closed incident's own record is complete) and
 * let the spec transition fire normally.
 */
function leaveTerminal(): void {
  if (isTerminal(state)) state = 'IDLE';
}

function enterPending(trigger: TriggerType, options: TriggerOptions, startedAtMs: number): T0TriggerResult {
  const d = deps;
  if (!d) return { incidentId: null, suppressed: false, reason: 'T0 not initialised', elapsedMs: 0 };

  // Already allocated by the caller before the opening transition, so that
  // transition was logged under THIS incident and not the previous one.
  const id = incidentId && incidentLive ? incidentId : allocateIncidentId(options.incidentId);
  incidentTrigger = trigger;
  incidentIsDrill = options.isDrill ?? trigger === 'DRILL';
  incidentDuress = false;
  incidentConfidencePct = Math.round(options.confidencePct ?? 100);
  openedAt = Date.now();
  ladderIndex = 0;

  // Prime the audio session while we still have the CPU; sounding it is a
  // separate decision made by the policy below.
  void primeAlarm();

  // ★ LAST KNOWN location. Never a fresh GNSS fix (5–30 s would blow the budget).
  const loc = d.lastKnownLocation();
  const sealedPayload = buildSealedPayload(id, loc, true);
  const built = buildEnvelope(
    id,
    trigger,
    loc,
    false,
    incidentIsDrill,
    incidentConfidencePct,
    sealedPayload,
    () => buildSealedPayload(id, loc, false),
  );
  const envelope = built.envelope;
  const ctx = buildFanOutContext(id, trigger, loc, false, incidentIsDrill);
  lastEnvelope = envelope;
  lastFanOutCtx = ctx;

  emit('INCIDENT_OPEN', {
    trigger,
    confidencePct: incidentConfidencePct,
    isDrill: incidentIsDrill,
    locationAgeMs: loc ? Date.now() - loc.at : null,
    accuracyM: loc?.accuracyM ?? null,
    // Surfaced so the timeline can say "medical card did not fit" instead of
    // the responder discovering it on arrival.
    payloadTier: built.tier,
  }, id);

  if (envelope) {
    fanOut(envelope, ctx);
    emit('DISPATCHED', { legs: ctx.smsRecipients.length, degradation: ctx.degradation }, id);
  }

  // ★ AFTER the first byte has left, and as a macrotask. The seal packs ~3000
  //   samples, encrypts, base64s and writes 384 KiB; §2.3.2 budgets 30 ms for it
  //   and it must not spend one of them before the transports have fired.
  setTimer('blackbox', 0, () => {
    void sealBlackBox(id)
      .then((ref) => {
        if (ref) emit('BLACKBOX_SEALED', { ref }, id);
      })
      .catch(() => {
        // A black box we could not seal costs us the after-action detail, nothing more.
      });
  });

  const elapsedMs = Date.now() - startedAtMs;
  lastTriggerToFanOutMs = elapsedMs;
  if (elapsedMs > CONFIG.t2BudgetMs) budgetExceededCount++;

  // The cancel window opens AFTER the first byte has left — the family is
  // already being told while the subject still has time to say "I'm fine".
  cancelWindowS = effectiveCancelWindowS(
    policy,
    trigger,
    d.risk(),
    d.falsePositiveStreak?.() ?? 0,
  );
  if (cancelWindowS > 0) {
    pendingUntil = Date.now() + cancelWindowS * 1000;
    startCountdownHaptics(cancelWindowS * 1000);
    setTimer('cancelWindow', cancelWindowS * 1000, () => transition('CANCEL_WINDOW_EXPIRED'));
  } else {
    pendingUntil = null;
    // A zero-length window (DEADMAN, RELAY, DEVICE_SILENCED) still goes through
    // the same transition, so the event log reads identically everywhere.
    setTimer('cancelWindow', 0, () => transition('CANCEL_WINDOW_EXPIRED'));
  }

  setFusionMode('incident');
  notify();
  return { incidentId: id, suppressed: false, reason: 'opened', elapsedMs };
}

/**
 * The hot path. Synchronous end to end: every dependency it touches is a cached
 * read, so nothing here can await a network, a GNSS fix or a disk flush.
 */
export function onTrigger(trigger: TriggerType, options: TriggerOptions = {}): T0TriggerResult {
  const startedAtMs = Date.now();
  if (!deps) return { incidentId: null, suppressed: false, reason: 'T0 not initialised', elapsedMs: 0 };

  // An incident is already live: a second press escalates rather than opening a
  // duplicate. Two incidents for one emergency splits the family's attention.
  // The spec (P-058) defines REESCALATE from ACTIVE_L1 and ACTIVE_L2 only; from
  // PENDING, ACTIVE_L1_SILENT, ACTIVE_L3, OWNED or RESOLVING the press changes
  // nothing, and the reason must say so rather than claim an escalation.
  if (incidentId !== null && ACTIVE_STATES.has(state)) {
    const escalated = (state === 'ACTIVE_L1' || state === 'ACTIVE_L2') && transition('REESCALATE');
    return {
      incidentId,
      suppressed: false,
      reason: escalated
        ? 'incident already active; escalated'
        : 'incident already active; no further escalation available from this state',
      elapsedMs: Date.now() - startedAtMs,
    };
  }

  const source: TriggerSource = options.source ?? (trigger === 'MANUAL' ? 'in_app' : 'sensor');
  const { suppressed, reason } = shouldSuppress(trigger, source);
  if (suppressed) {
    emit('SUPPRESSED', { trigger, source, reason }, uuidv7());
    return { incidentId: null, suppressed: true, reason, elapsedMs: Date.now() - startedAtMs };
  }

  // Set before the transition: onEnterState reads the scenario policy off it to
  // decide whether the cancel window itself should be loud (fall/crash), and
  // the id is allocated first so MANUAL_TRIGGER is logged under the incident it
  // opens — not dropped (first of the session) or appended to the last one.
  incidentTrigger = trigger;
  allocateIncidentId(options.incidentId);
  leaveTerminal();

  if (!transition('MANUAL_TRIGGER')) {
    // Not in IDLE or WATCH — e.g. mid-PROBE. Force the machine forward rather
    // than dropping a trigger the user deliberately made (ADR-018).
    const from = state;
    state = 'PENDING';
    onEnterState(from, 'PENDING');
  }

  return enterPending(trigger, options, startedAtMs);
}

// ── PIN verification — the constant-time path ─────────────────────────────────

/**
 * ★ INVARIANT I-7 / TEST T-213 ★
 *
 * Both comparisons ALWAYS run. There is no early return, no short-circuit, and
 * no branch whose cost depends on which PIN matched. The two accepting outcomes
 * then execute the same function with a single boolean argument, so there is
 * exactly one code path to time.
 *
 * Residual, stated honestly: a genuine cancel stops the OPEN's pending SMS tier
 * and a duress does not, because a false alarm must not spam the family every
 * time. That is a difference on the CELLULAR leg, not on the padded envelope the
 * T4 attacker is watching — and the PRD's constant-time requirement is scoped
 * to the envelope's size and schedule, which this satisfies exactly. The PIN
 * record itself is fanned out identically for both outcomes: network legs only.
 *
 * Returns 'wrong' for an empty entry, for an entry against an unset PIN, and for
 * a correct PIN in a state that has no PIN transition (only PENDING does): in
 * each case nothing happens to the incident. The verdict type is shared with
 * the store and has no fourth value, and "this PIN cannot do anything now" is
 * what 'wrong' means to the caller — the entry is rejected, nothing moves.
 */
export function verifyPin(entered: string): 'cancel' | 'duress' | 'wrong' {
  const candidate = padPin(entered);
  // Both, every time, no early return. timingSafeEqual itself never breaks out.
  // The configuration flags are ANDed in AFTER both compares so the cost of the
  // compare never depends on which PIN is set.
  const eqCancel = timingSafeEqual(candidate, cancelPinBytes);
  const eqDuress = timingSafeEqual(candidate, duressPinBytes);
  const nonEmpty = entered.length > 0;
  const matchesCancel = eqCancel && cancelPinSet && nonEmpty;
  const matchesDuress = eqDuress && duressPinSet && nonEmpty;

  if (!matchesCancel && !matchesDuress) return 'wrong';

  // If a family has (mis)configured both PINs identically, the silent reading is
  // the safe one: assuming "cancel" when they meant "duress" is unrecoverable.
  const duress = matchesDuress;
  if (!acceptCancel(duress)) return 'wrong';
  return duress ? 'duress' : 'cancel';
}

/**
 * One function, one schedule, for both outcomes. Returns false — having done
 * NOTHING — when the machine has no PIN transition from its current state:
 * silencing the alarm and cancelling the SMS tier while the incident stayed
 * ACTIVE_L1 would leave a live emergency with no siren and a ladder about to
 * restart it at tier 2.
 */
function acceptCancel(duress: boolean): boolean {
  const event: IncidentEvent = duress ? 'PIN_DURESS' : 'PIN_CORRECT';
  // Same table lookup for both outcomes; both are valid from PENDING only.
  if (nextState(state, event) === null) return false;

  const id = incidentId;
  clearTimer('cancelWindow');
  stopCountdownHaptics();
  stopAlarm();
  pendingUntil = null;
  incidentDuress = duress;

  transition(event);

  if (!id || !deps) return true;

  // Identical-length sealed record: one character differs, so the ciphertext,
  // the padded envelope and therefore the packet are the same size in both cases.
  const loc = deps.lastKnownLocation();
  const marker = sealJson(
    incidentContentKey(deps.groupSecret, id),
    { k: 'CX', v: duress ? '1' : '0' },
    id,
  );
  const { envelope } = buildEnvelope(
    id,
    incidentTrigger ?? 'MANUAL',
    loc,
    duress,
    incidentIsDrill,
    incidentConfidencePct,
    marker,
  );
  // 'event', not 'open': this is the PIN_CORRECT / PIN_DURESS record, and it has
  // to become its own durable outbox row. Filed as an open, it deduplicated
  // against the incident the server already had — so a duress entered in a
  // basement with no signal was never delivered at all, even once she had bars.
  // The dispatcher sends an 'event' over the network legs only (to /append), so
  // the two outcomes now share every leg; the SMS the family gets is the open's.
  const ctx = buildFanOutContext(id, incidentTrigger ?? 'MANUAL', loc, duress, incidentIsDrill, 'event');

  // Same fixed offset for both outcomes (T-213).
  setTimer('cancelEvent', CANCEL_EVENT_DELAY_MS, () => {
    if (envelope) fanOut(envelope, ctx);
    // A genuine cancel must not fire the SMS tier it just cancelled.
    if (!duress) cancelPendingSms(id);
  });
  return true;
}

// ── Sensor candidates ─────────────────────────────────────────────────────────

/**
 * Route a fusion candidate through SUSPECT → PROBE|PENDING. The guards are the
 * ones named in the generated spec, evaluated here from published thresholds so
 * a reviewer can check the mapping by eye.
 */
export function noteSensorCandidate(candidate: FusionCandidate): void {
  if (!deps || candidate.trigger === null) return;
  if (incidentId !== null && ACTIVE_STATES.has(state)) return;
  leaveTerminal();

  if (state === 'IDLE' || state === 'WATCH') {
    // The id is allocated before the first transition so SENSOR_ANOMALY and the
    // CONFIDENCE steps are logged under the incident they may become.
    allocateIncidentId();
    // WATCH → SUSPECT carries guard `lowerThreshold`: in an elevated context we
    // deliberately accept weaker evidence (§13.5).
    if (!transition('SENSOR_ANOMALY', { lowerThreshold: true })) {
      incidentLive = false;
      return;
    }
    incidentTrigger = candidate.trigger;
  }

  if (state !== 'SUSPECT') return;
  incidentConfidencePct = Math.round(candidate.confidence * 100);
  const high = candidate.confidence >= CONFIDENCE_HIGH;
  transition('CONFIDENCE', {
    confidenceMedium: !high && candidate.confidence >= CONFIDENCE_MEDIUM,
    confidenceHigh: high,
  });

  // Read through currentState(): `transition()` mutates the module-level `state`,
  // but the `state !== 'SUSPECT'` guard above has already narrowed it to 'SUSPECT'
  // for the rest of this scope, so a direct comparison is a compile error.
  if (currentState() === 'PENDING') {
    enterPending(candidate.trigger, {
      confidencePct: incidentConfidencePct,
      source: 'sensor',
    }, candidate.at);
  }
}

/** The subject answered the PROBE. `true` = "I'm fine". */
export function probeRespond(ok: boolean): void {
  if (state !== 'PROBE') return;
  clearTimer('probe');
  if (ok) {
    transition('USER_FINE');
  } else {
    transition('PROBE_TIMEOUT');
    // Same reason as in noteSensorCandidate: the guard above narrowed `state`.
    if (currentState() === 'PENDING' && incidentTrigger) {
      enterPending(incidentTrigger, { confidencePct: incidentConfidencePct, source: 'in_app' }, Date.now());
    }
  }
}

/** §13.5 raised or dropped the risk context. */
export function setContextElevated(elevated: boolean): void {
  if (elevated) leaveTerminal();
  transition(elevated ? 'CONTEXT_ELEVATED' : 'CONTEXT_ENDED');
}

/** The subject started moving again — SUSPECT resolves itself. */
export function noteMotionResumed(): void {
  transition('MOTION_RESUMED');
}

/**
 * Drive any other spec event from the responder UI or the sync plane: CLAIM,
 * RELEASE, ON_SCENE, TWO_PARTY_CONFIRM, SELF_CLEAR_PIN, REESCALATE.
 * Returns false when the event does not apply — never throws (ADR-018).
 */
export function sendEvent(event: IncidentEvent, guards: GuardSet = {}): boolean {
  return transition(event, guards);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Install the PINs. An empty string is "not set": it never matches, and the
 * snapshot reports it so onboarding can be finished rather than faked.
 */
function installPins(cancelPin: string, duressPin: string): void {
  cancelPinBytes = padPin(cancelPin);
  duressPinBytes = padPin(duressPin);
  cancelPinSet = cancelPin.length > 0;
  duressPinSet = duressPin.length > 0;
}

export async function initT0(next: T0Deps): Promise<void> {
  deps = next;
  policy = next.policy ?? DEFAULT_POLICY;
  installPins(next.cancelPin, next.duressPin);

  // Neither of these may hold the boot: `app/index.tsx` renders a blank view
  // until the store is ready, and the reserve claim (1.5 MiB) and the siren
  // synthesis (44 100 samples) both used to sit on that path. Each now does the
  // one cheap thing the trigger path actually needs and defers the rest.
  initBlackBox({ groupSecret: next.groupSecret });
  await primeAlarm();

  if (next.autoStart !== false && !started) {
    started = true;
    void startPocketWatch();
    startFusion(noteSensorCandidate, {
      riskProvider: () => next.risk(),
      speedProvider: () => next.lastKnownLocation()?.speed ?? -1,
      // The pocket watch already owns the light sensor; reuse its average
      // rather than opening a second subscription to the same hardware.
      luxProvider: () => pocketState().luxAvg ?? -1,
      mode: 'idle',
    });
    void registerWatchdog();
  }

  notify();
}

/** Rotate the PINs without restarting T0 (settings screen). */
export function setPins(cancelPin: string, duressPin: string): void {
  installPins(cancelPin, duressPin);
  if (deps) {
    deps.cancelPin = cancelPin;
    deps.duressPin = duressPin;
  }
  notify();
}

export function shutdownT0(): void {
  clearAllTimers();
  // Release rather than merely stop: the two AudioPlayer instances each hold a
  // native player and a 118 KiB WAV, and a teardown/re-bootstrap cycle (sign-out
  // and back in, or a test run) leaked one pair per cycle.
  releaseAlarm();
  stopCountdownHaptics();
  stopFusion();
  stopPocketWatch();
  started = false;
}

export function currentState(): IncidentState {
  return state;
}

export function currentSnapshot(): T0Snapshot {
  return snapshot();
}

export function subscribeT0(fn: (s: T0Snapshot) => void): () => void {
  subscribers.add(fn);
  fn(snapshot());
  return () => {
    subscribers.delete(fn);
  };
}

/**
 * ★ TEST ONLY ★ Jump the machine to a state without a transition. Used by the
 * drill harness (§16.2) and by state-machine fixtures. Never call this from a
 * screen: it bypasses every guard the spec exists to enforce.
 */
export function forceState(s: IncidentState): void {
  const from = state;
  state = s;
  onEnterState(from, s);
  notify();
}

/** Reset to IDLE and drop the incident. Used between drills and on logout. */
export function resetT0(): void {
  clearAllTimers();
  stopAlarm();
  stopCountdownHaptics();
  state = 'IDLE';
  incidentId = null;
  incidentLive = false;
  incidentTrigger = null;
  incidentDuress = false;
  incidentIsDrill = false;
  incidentConfidencePct = 0;
  openedAt = null;
  autoQuiesceAt = null;
  pendingUntil = null;
  cancelWindowS = 0;
  ladderIndex = 0;
  lastEnvelope = null;
  lastFanOutCtx = null;
  resetFusionContext();
  setFusionMode('idle');
  notify();
}

/** Exposed so the store can label the degraded-transport banner (§4.4). */
export function degradationLevel(): DegradationLevel {
  return deps?.degradation() ?? Degradation.ZERO_INFRA;
}
