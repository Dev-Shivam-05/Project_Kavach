/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE KAVACH STORE
 *
 * One zustand store; every screen reads from it and nothing else.
 *
 * ★ WHAT THIS FILE IS NOT ★
 * It is not the state machine. `t0/triggerRouter` owns the incident machine, the
 * cancel window, the PROBE timer, the escalation ladder, the alarm and the
 * constant-time PIN comparison, because all of that has a 500 ms budget and must
 * never await a database. This store is the layer above: it PERSISTS what T0
 * decides, projects it for the UI, and owns everything T0 deliberately does not
 * touch — consent, journeys, geofences, medical, screen time, drills,
 * diagnostics, presence, notifications and sync.
 *
 * The seam is `T0Deps.onEvent`. Every transition T0 makes arrives here as a
 * T0Event and becomes a durable row plus a store update, in that order, without
 * T0 ever waiting for either.
 *
 * ★ THE RULE THAT SHAPES EVERY WRITE PATH (PRD §11.1) ★
 *   "The device is the source of truth. The server is a replica and a relay.
 *    Every operation executes locally first, appends to a local log, and THEN
 *    syncs. There is no loading state and no operation that requires
 *    connectivity to succeed."
 * So every action commits locally, updates the store synchronously, enqueues to
 * the outbox, and only then touches the network — fire-and-forget, failure-
 * tolerant, never awaited into a render.
 *
 * ★ NOTHING IN HERE THROWS INTO THE UI ★
 * bootstrap() is idempotent and swallows everything: a corrupt database, a
 * denied permission or a missing backend must still yield a usable app sitting
 * at the L0 floor, not a white screen (hard rule 8).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import * as Battery from 'expo-battery';

import { CONFIG, STORAGE_KEYS } from '../core/config';
import {
  base64ToBytes,
  bytesToBase64,
  coarseCell,
  hexToBytes,
  inc8,
  nowHlc,
  setHlcNodeId,
  uuidv7,
} from '../core/ids';
import { DEFAULT_POLICY, DEFAULT_POLICY_VERSION, ladderFor } from '../core/policy';
import {
  DegradationLevel,
  type AccessLogEntry,
  type AppUsage,
  type ConsentGrant,
  type ConsentPurpose,
  type ConsentScope,
  type Device,
  type DiagnosticsReport,
  type DrillRun,
  type EscalationPolicy,
  type Geofence,
  type HaSafetyEvent,
  type Incident,
  type IncidentEventRow,
  type IncidentOutcome,
  type IncidentSealedPayload,
  type Journey,
  type Locale,
  type MedicalCard,
  type Member,
  type MemberPresence,
  type RiskContextInputs,
  type RiskLevel,
  type TriggerType,
  type UUID,
  type VaultObject,
} from '../core/types';
import {
  generateDeviceKeypair,
  incidentContentKey,
  randomBytes,
  sealJson,
  type DeviceKeypair,
} from '../crypto';
import { prepareKeys, setHardwareKeyBackend, setSoftwareKeys } from '../crypto/hardware';
import { keyVault } from '../t0/native';
import {
  INCIDENT_EVENTS,
  INCIDENT_STATES,
  isActive,
  isTerminal,
  nextState,
  type GuardSet,
  type IncidentEvent,
  type IncidentState,
} from '../t0/stateMachine.generated';
import type { SignedEnvelope } from '../t0/envelope';
import { clearWarmSocket, pruneOutbox, registerWarmSocket, setOutboxSink } from '../t0/dispatcher';
import { playCue, startAlarm, stopAlarm } from '../t0/alarm';
import {
  heartbeatNow,
  setHeartbeatSender,
  setWatchdogSink,
  unregisterWatchdog,
} from '../t0/watchdog';
import { emptyReport, runSelfCheck, setT0RunningProbe } from '../t0/diagnostics';
/**
 * ★ The T0 router. These four are the contract this store is written against:
 *   onTrigger      — the hot path; returns the client-generated incident id
 *   verifyPin      — the constant-time cancel/duress comparison
 *   subscribeT0    — the snapshot stream that drives t0State and pendingUntil
 *   currentState   — the synchronous read used on cold start
 */
import {
  currentSnapshot,
  currentState,
  initT0,
  onTrigger,
  probeRespond as t0ProbeRespond,
  sendEvent,
  setPins,
  shutdownT0,
  subscribeT0,
  verifyPin,
  type T0Event,
  type T0Location,
  type T0Snapshot,
} from '../t0/triggerRouter';

import { closeDb, openDb, requireDb } from '../db/index';
import {
  consentRepo,
  cursorRepo,
  deviceRepo,
  diagnosticsRepo,
  drillRepo,
  geofenceRepo,
  haRepo,
  incidentRepo,
  journeyRepo,
  locationRepo,
  medicalRepo,
  memberRepo,
  outboxRepo,
  policyRepo,
  presenceRepo,
  t0ConfigRepo,
  usageRepo,
  vaultRepo,
} from '../db/repos';
import {
  getFamily,
  getIncidents,
  getPolicy,
  postCheckIn,
  postClaim,
  postClassify,
  postConsent,
  postDrill,
  postFindPhone,
  postJourney,
  postRelease,
  postResolve,
  putDevicePushToken,
  setAuthToken,
  setIdentity,
  type CheckInInput,
  type HeartbeatInput,
} from '../net/api';
import {
  enqueueCheckIn,
  enqueueConsentGrant,
  enqueueConsentRevoke,
  enqueueGeneric,
  enqueueHeartbeat,
  enqueueIncidentEvent,
  enqueueIncidentOpen,
  startOutboxDrain,
} from '../net/outboxDrain';
import {
  currentDegradation,
  isRoaming,
  lastKnownDegradation,
  subscribeDegradation,
} from '../net/connectivity';

import { computeRisk } from '../domain/riskContext';
import { haversineM } from '../domain/geofence';
import { refreshPresenceTier, startPresence, stopPresence } from '../domain/presenceService';
import { connectWs, disconnectWs, onFrame, sendFrame, subscribeWsStatus, type WsFrame } from '../net/ws';
import {
  emptyRouteHistory,
  predictEta,
  recordRouteDuration,
  routeKey,
  type RouteHistory,
  type RouteSample,
} from '../domain/journey';
import {
  DEMO_CANCEL_PIN,
  DEMO_DURESS_PIN,
  demoFamilyId,
  demoMeDeviceId,
  demoMeMemberId,
  isDemo,
  seedDemoData,
  simulateResponders,
  type DemoResponderEvent,
} from '../domain/demo';
import {
  acquireDevicePushToken,
  clearIncident as clearIncidentNotification,
  initNotifications,
  notifyAgentSilent,
  notifyDegraded,
  notifyIncident,
  notifyOwnership,
  notifyProbe,
  subscribeNotificationResponses,
  subscribePushTokenChanges,
} from './notifications';
import { getLocale, setLocale, t } from '../i18n';

// ═══════════════════════════════════════════════════════════════════════════════
// Store shape
// ═══════════════════════════════════════════════════════════════════════════════

export interface KavachState {
  ready: boolean;
  booting: boolean;
  /**
   * ★ Has T0 — the incident machine, the alarm, the fan-out — actually started?
   *
   * `ready` only ever meant "bootstrap stopped running". It was set in a
   * `finally`, so a database that failed to open skipped `startT0` and the app
   * still came up saying "All clear" with a panic button that returned a UUID
   * and did nothing else: no incident, no siren, no SMS, no error. False here
   * means the safety chain is down and the user must be told in as many words.
   */
  t0Ready: boolean;
  /**
   * True once onboarding has been completed on THIS device, read back from
   * SecureStore during bootstrap.
   *
   * ★ This has to be real persisted state, not something inferred from whether a
   * member row exists. Inferring it raced: the entry route ran on the first frame
   * with `ready === false`, redirected to onboarding before the async bootstrap
   * could load anything, and nothing ever navigated back out — so a fully
   * enrolled device was sent through all six steps on every single launch.
   */
  onboarded: boolean;
  familyId: UUID;
  deviceId: UUID;
  me: Member | null;
  members: Member[];
  devices: Device[];
  incidents: Incident[];
  activeIncident: Incident | null;
  incidentEvents: Record<UUID, IncidentEventRow[]>;
  t0State: IncidentState;
  /** Epoch ms the cancel window expires, else null. */
  pendingUntil: number | null;
  degradation: DegradationLevel;
  risk: RiskLevel;
  /**
   * The evidence behind `risk`. Kept because the opaque 0–4 integer changes
   * user-visible behaviour — it lengthens or shortens the cancel countdown
   * (effectiveCancelWindowS) and lowers the fusion threshold — and a countdown
   * that is a different length on different nights with no way to say why is a
   * feature the family learns to distrust. Never transmitted: only the integer
   * goes into an envelope (§13.5). Render with `explainRisk`/`riskEffects`.
   */
  riskInputs: RiskContextInputs | null;
  diagnostics: DiagnosticsReport;
  presence: Record<UUID, MemberPresence>;
  grants: ConsentGrant[];
  accessLog: AccessLogEntry[];
  journeys: Journey[];
  geofences: Geofence[];
  vault: VaultObject[];
  usage: AppUsage[];
  medical: MedicalCard;
  drills: DrillRun[];
  haEvents: HaSafetyEvent[];
  locale: Locale;
  outboxDepth: number;
  lastCanaryAt: number | null;

  bootstrap(): Promise<void>;
  trigger(t: TriggerType, opts?: { confidencePct?: number; isDrill?: boolean }): Promise<UUID>;
  cancelWithPin(pin: string): Promise<'cancelled' | 'duress' | 'wrong'>;
  claim(id: UUID): Promise<void>;
  release(id: UUID): Promise<void>;
  onScene(id: UUID): Promise<void>;
  resolveIncident(id: UUID): Promise<void>;
  classify(id: UUID, outcome: IncidentOutcome): Promise<void>;
  probeRespond(id: UUID, ok: boolean): Promise<void>;
  checkIn(): Promise<void>;
  findPhone(deviceId: UUID): Promise<void>;
  grantConsent(g: {
    granteeMemberId: UUID;
    scope: ConsentScope;
    purpose: ConsentPurpose;
    hours: number;
  }): Promise<void>;
  revokeConsent(id: UUID): Promise<void>;
  startJourney(j: { label: string; destName: string; etaMinutes: number }): Promise<void>;
  arriveJourney(id: UUID): Promise<void>;
  addGeofence(g: Omit<Geofence, 'id'>): Promise<void>;
  removeGeofence(id: UUID): Promise<void>;
  saveMedical(m: MedicalCard): Promise<void>;
  setLimit(packageName: string, minutes: number | null): Promise<void>;
  runDiagnostics(): Promise<DiagnosticsReport>;
  startDrill(kind: DrillRun['kind']): Promise<void>;
  changeLocale(l: Locale): Promise<void>;
  pauseMonitoring(paused: boolean): Promise<void>;
  /**
   * Persist that onboarding finished, so subsequent launches go straight to the
   * app. `rehearsed` records whether the test SOS was actually practised — it is
   * never a gate, but a device that has never rehearsed is a real gap and the
   * diagnostics screen says so rather than quietly assuming it is fine.
   */
  completeOnboarding(rehearsed: boolean): Promise<void>;
  /** True when onboarding was completed WITHOUT practising the test SOS. */
  rehearsalSkipped: boolean;
  /** Re-run onboarding deliberately (Settings). Does not touch enrolment or keys. */
  resetOnboarding(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Module-scope runtime state — key material and caches, never React state
// ═══════════════════════════════════════════════════════════════════════════════

let keypair: DeviceKeypair | null = null;
let groupSecret: Uint8Array | null = null;
let policy: EscalationPolicy = DEFAULT_POLICY;
let bootPromise: Promise<void> | null = null;
/** Resolved once per process — see identity() for why that is load-bearing. */
let cachedIds: { familyId: UUID; deviceId: UUID; memberId: UUID } | null = null;
/** Named stage failures from the last bootstrap. Surfaced, not swallowed. */
const bootFailures: string[] = [];
const subscriptions: (() => void)[] = [];
const demoStops = new Map<UUID, () => void>();

/**
 * ★ The cached fix that T0 reads synchronously (T0Deps.lastKnownLocation).
 * It must NEVER be a call that could acquire GNSS: a cold fix is 5–30 seconds
 * and would blow the 500 ms budget sixty times over (docs/02 §2.3).
 */
let cachedFix: T0Location | null = null;
/** Battery is read on a timer for the same reason: T0's read must be free. */
let cachedBatteryPct = 100;
/** P-054: same rule again — a roaming check hits the SIM and the database. */
let cachedRoaming = false;

const EMPTY_MEDICAL: MedicalCard = {
  bloodGroup: '',
  allergies: [],
  medications: [],
  conditions: [],
  iceContacts: [],
  organDonor: false,
  notes: '',
};

const EVENT_SET: ReadonlySet<string> = new Set(INCIDENT_EVENTS);

// ═══════════════════════════════════════════════════════════════════════════════

export const useKavach = create<KavachState>()((set, get) => ({
  ready: false,
  booting: false,
  t0Ready: false,
  onboarded: false,
  rehearsalSkipped: false,
  familyId: isDemo() ? demoFamilyId : '',
  deviceId: isDemo() ? demoMeDeviceId : '',
  me: null,
  members: [],
  devices: [],
  incidents: [],
  activeIncident: null,
  incidentEvents: {},
  t0State: 'IDLE',
  pendingUntil: null,
  degradation: DegradationLevel.FULL,
  risk: 0,
  riskInputs: null,
  diagnostics: emptyReport(),
  presence: {},
  grants: [],
  accessLog: [],
  journeys: [],
  geofences: [],
  vault: [],
  usage: [],
  medical: EMPTY_MEDICAL,
  drills: [],
  haEvents: [],
  locale: getLocale(),
  outboxDepth: 0,
  lastCanaryAt: null,

  // ── boot ────────────────────────────────────────────────────────────────────
  async bootstrap(): Promise<void> {
    // Idempotent: expo-router can mount the root layout more than once, and two
    // concurrent migration runs against one database is not survivable.
    if (bootPromise) return bootPromise;
    bootPromise = doBootstrap();
    return bootPromise;
  },

  // ── the write path that must never fail ─────────────────────────────────────
  /**
   * Hand the trigger to T0 and get out of the way.
   *
   * The incident id is pre-allocated here (P-053 — the client owns it, always)
   * and passed in, so this function knows the id even if T0 suppresses the
   * trigger or an incident is already live. Persistence happens in
   * handleT0Event('INCIDENT_OPEN'), which fires synchronously inside onTrigger:
   * by the time this returns, the incident is already in the store. There is no
   * loading state because there is nothing to wait for.
   */
  async trigger(triggerType, opts = {}): Promise<UUID> {
    const preallocated = uuidv7();
    const result = onTrigger(triggerType, {
      confidencePct: opts.confidencePct,
      isDrill: opts.isDrill ?? triggerType === 'DRILL',
      incidentId: preallocated,
      // Only physical buttons are eligible for pocket suppression, so an
      // in-app press can never be swallowed (t0/pocketSuppressor SUPPRESSIBLE).
      source: 'in_app',
    });

    // ★★★ THE L0 FLOOR, FOR REAL ★★★
    // T0 returns a null incident id when it was never initialised — the case a
    // failed bootstrap stage used to produce silently. Every caller `void`s this
    // promise, so without the two lines below a held panic button did NOTHING
    // AT ALL: no incident, no siren, no message, no error, and a screen still
    // saying everything is fine. There are no keys and no database in that
    // state, so nothing can be signed or stored — but the siren, the strobe and
    // the haptics need neither, and §4.4 L0 is exactly "nothing works, still
    // helps". Make noise, and mark the chain down so diagnostics says why.
    if (result.incidentId === null && !result.suppressed) {
      startAlarm({ silent: false, strobe: true, haptics: true });
      set({ t0Ready: false });
    }

    const id = result.incidentId ?? preallocated;
    if (!result.suppressed && isDemo()) startDemoResponders(id);
    // Refresh risk in the background: an incident is itself evidence that the
    // context is not normal, and the next trigger should score accordingly.
    void refreshRisk();
    return id;
  },

  // ── the constant-time cancel path ───────────────────────────────────────────
  /**
   * ★★★ THE DURESS PATH ★★★
   *
   * There is deliberately almost nothing here. `verifyPin` compares against BOTH
   * PINs every time with no early return, then runs ONE function for both
   * accepting outcomes: same timers cleared, same alarm stopped, same fixed-size
   * envelope built and dispatched at the same fixed offset (T-213, t0 router).
   * The only difference is one bit inside the ciphertext.
   *
   * This wrapper adds no branch of its own beyond renaming the verdict, and the
   * caller renders the SAME screen for 'cancelled' and 'duress'. Do not add a
   * log line, a toast, a haptic or an early return to one outcome and not the
   * other — the whole property lives or dies on that.
   */
  async cancelWithPin(pin: string): Promise<'cancelled' | 'duress' | 'wrong'> {
    const verdict = verifyPin(pin);
    return verdict === 'cancel' ? 'cancelled' : verdict;
  },

  // ── responder actions ───────────────────────────────────────────────────────
  async claim(id: UUID): Promise<void> {
    const memberId = get().me?.id ?? (await identity()).memberId;
    // P-003: exactly one owner. The local write wins immediately; the server
    // arbitrates ties later and everyone sees the same name either way (P-030).
    const applied = await driveEvent(id, 'CLAIM', { actorMemberId: memberId });
    if (!applied) return;
    await safe(() => incidentRepo.setOwner(id, memberId), undefined);
    await refreshIncident(id, { ownerMemberId: memberId, firstAckAt: Date.now() });
    void safe(() => postClaim(id, memberId), null);
  },

  async release(id: UUID): Promise<void> {
    const memberId = get().me?.id ?? (await identity()).memberId;
    // Releasing must be exactly as cheap as claiming, or nobody ever claims.
    const applied = await driveEvent(id, 'RELEASE', { actorMemberId: memberId });
    if (!applied) return;
    await safe(() => incidentRepo.setOwner(id, null), undefined);
    await refreshIncident(id, { ownerMemberId: null });
    void safe(() => postRelease(id, memberId), null);
  },

  async onScene(id: UUID): Promise<void> {
    const memberId = get().me?.id ?? (await identity()).memberId;
    await driveEvent(id, 'ON_SCENE', { actorMemberId: memberId });
    await refreshIncident(id, {});
  },

  /**
   * Two-party confirmation where the machine allows it, self-clear where it does
   * not. Trying the stronger transition first and falling back is the honest
   * encoding of "an incident is closed by people, not by a button".
   */
  async resolveIncident(id: UUID): Promise<void> {
    const memberId = get().me?.id ?? (await identity()).memberId;
    const incident = findIncident(id);
    if (!incident) return;

    const event: IncidentEvent =
      nextState(incident.state, 'TWO_PARTY_CONFIRM') !== null ? 'TWO_PARTY_CONFIRM' : 'SELF_CLEAR_PIN';
    const applied = await driveEvent(id, event, { actorMemberId: memberId });
    if (applied) await refreshIncident(id, { resolvedAt: Date.now() });
    void safe(() => postResolve(id, memberId, null), null);
  },

  /**
   * The False Positive Ledger (PRD §16.3 Dashboard 3) is a P0 metric and this is
   * its only input. An unclassified incident silently poisons every threshold
   * the system would otherwise learn from (P-017).
   */
  async classify(id: UUID, outcome: IncidentOutcome): Promise<void> {
    await safe(() => incidentRepo.setOutcome(id, outcome, null), undefined);
    const incident = findIncident(id);
    if (incident) await appendRow(incident, 'CLASSIFIED', { detail: { outcome } });
    await refreshIncident(id, { outcome });
    void safe(() => postClassify(id, outcome, null), null);
  },

  /**
   * The answer to "Are you okay?".
   *
   * `false` — "I need help" — is not a timeout. T0 takes PROBE straight to
   * PENDING and opens the incident; making someone who just pressed "I need
   * help" wait out a countdown would be indefensible.
   */
  async probeRespond(id: UUID, ok: boolean): Promise<void> {
    if (isOwnIncident(id)) {
      t0ProbeRespond(ok);
    } else {
      await applyEvent(id, ok ? 'USER_FINE' : 'PROBE_TIMEOUT', { detail: { answer: ok ? 'fine' : 'need_help' } });
    }
    if (ok) {
      await safe(() => incidentRepo.setOutcome(id, 'false_alarm', 'Answered “I am fine”'), undefined);
      void safe(() => clearIncidentNotification(id), undefined);
    }
    await refreshIncident(id, ok ? { outcome: 'false_alarm' } : {});
  },

  // ── everyday actions ────────────────────────────────────────────────────────
  async checkIn(): Promise<void> {
    const s = get();
    const memberId = s.me?.id ?? (await identity()).memberId;
    const at = Date.now();

    const presence: MemberPresence = {
      ...(s.presence[memberId] ?? emptyPresence(memberId)),
      lastSeenAt: at,
      agentHealthy: true,
    };
    await safe(() => presenceRepo.upsert(presence), undefined);
    set((prev) => ({ presence: { ...prev.presence, [memberId]: presence } }));

    // An active journey's check-in clock is what turns silence into a DEADMAN
    // trigger, so "I'm safe" has to reset it (core/policy DEADMAN).
    const active = s.journeys.find((j) => j.memberId === memberId && j.state === 'active');
    if (active) {
      await safe(() => journeyRepo.checkIn(active.id, at), undefined);
      set((prev) => ({
        journeys: prev.journeys.map((j) => (j.id === active.id ? { ...j, lastCheckInAt: at } : j)),
      }));
    }

    const input: CheckInInput = {
      memberId,
      at,
      journeyId: active?.id ?? null,
      coarseCell: cachedFix ? coarseCell(cachedFix.lat, cachedFix.lon) : null,
    };
    await safe(() => enqueueCheckIn(input), 0);
    await refreshOutboxDepth();
    playCue('ack');
    void safe(() => postCheckIn(input), null);
  },

  /**
   * Ringing someone else's phone is a consent-bearing act, so it writes an
   * access-log row that is surfaced to them. A "find phone" that leaves no trace
   * is a stalkerware feature (PRD §10.6).
   */
  async findPhone(deviceId: UUID): Promise<void> {
    const s = get();
    const accessor = s.me?.id ?? (await identity()).memberId;
    const target = s.devices.find((d) => d.id === deviceId);
    const entry: Omit<AccessLogEntry, 'id'> = {
      familyId: s.familyId,
      grantId: null,
      accessorMemberId: accessor,
      subjectMemberId: target?.memberId ?? deviceId,
      what: 'find_phone',
      context: 'routine',
      at: Date.now(),
      surfacedToSubject: true,
    };
    const rowId = (await safe(() => consentRepo.addLogEntry(entry), 0)) ?? 0;
    set((prev) => ({ accessLog: [{ id: rowId, ...entry }, ...prev.accessLog] }));
    void safe(() => postFindPhone(deviceId), null);
  },

  // ── consent ─────────────────────────────────────────────────────────────────
  async grantConsent(g): Promise<void> {
    const s = get();
    const grantorMemberId = s.me?.id ?? (await identity()).memberId;
    const now = Date.now();
    const grant: ConsentGrant = {
      id: uuidv7(now),
      familyId: s.familyId,
      grantorMemberId,
      granteeMemberId: g.granteeMemberId,
      scope: g.scope,
      purpose: g.purpose,
      grantedAt: now,
      // ★ P-008: expiresAt is NEVER null. There is no permanent grant, so even a
      //   zero or nonsense `hours` still produces a bounded window.
      expiresAt: now + Math.max(1, Math.round(g.hours || 1)) * 3_600_000,
      revokedAt: null,
      grantedVia: 'self',
      keyRotationPending: false,
    };
    await safe(() => consentRepo.upsert(grant), undefined);
    set((prev) => ({ grants: [grant, ...prev.grants] }));

    const input = {
      id: grant.id,
      grantorMemberId: grant.grantorMemberId,
      granteeMemberId: grant.granteeMemberId,
      scope: grant.scope,
      purpose: grant.purpose,
      expiresAt: grant.expiresAt,
    };
    await safe(() => enqueueConsentGrant(input), 0);
    await refreshOutboxDepth();
    void safe(() => postConsent(input), null);
  },

  /**
   * ★ F-14 — TWO-LAYER REVOCATION, STATED HONESTLY ★
   *
   * Layer 1 (routing) is instant and local: revokedAt is set here in under a
   * millisecond, with no server and no network involved. From this moment the
   * grantee cannot REQUEST anything.
   *
   * Layer 2 (plaintext) is the location-stream-key ratchet, and it cannot
   * complete until this device is next online to re-wrap the key to the reduced
   * recipient set. Until then the grantee still holds the key for points already
   * delivered. `keyRotationPending` is set true and the consent ledger MUST
   * render it — see i18n 'consent.revokePending'.
   *
   * Never claim a revocation is complete before the ratchet lands. A UI telling
   * a comfortable lie here is worse than the lag itself.
   */
  async revokeConsent(id: UUID): Promise<void> {
    const at = Date.now();
    await safe(() => consentRepo.revoke(id, at), undefined);
    set((prev) => ({
      grants: prev.grants.map((g) =>
        g.id === id ? { ...g, revokedAt: g.revokedAt ?? at, keyRotationPending: true } : g,
      ),
    }));
    // The server is told, but its answer changes nothing: layer 1 already holds.
    await safe(() => enqueueConsentRevoke(id), 0);
    await refreshOutboxDepth();
  },

  // ── journeys, fences, records ───────────────────────────────────────────────
  async startJourney(j): Promise<void> {
    const s = get();
    const memberId = s.me?.id ?? (await identity()).memberId;
    const now = Date.now();

    // ★ FR-042 — the learned ETA. Past completed journeys to the same place ARE
    //   the training data; there is no other model and there need not be. The
    //   traveller's own estimate wins until the history has earned its
    //   confidence, which is the honest default for a new route.
    //
    //   The persisted RouteHistory is the authority. Re-deriving it from
    //   `journeyRepo.list(50)` was the only source, and that cap meant a family
    //   member's fifty-first journey silently lost ALL history for the route and
    //   fell back to the declared ETA — the model appeared to work and then quietly
    //   stopped. The list is still read as a backfill so an existing install does
    //   not start from nothing.
    const key = routeKey(cachedFix ? 'Current location' : 'Unknown', j.destName);
    const stored = await loadRouteHistory(memberId, key);
    let history: RouteSample[] = stored.samples;
    if (history.length === 0) {
      const past = (await safe(() => journeyRepo.list(50), [])) ?? [];
      history = past
        .filter((p) => p.memberId === memberId && p.destName === j.destName && p.arrivedAt !== null)
        .map((p) => ({ durationS: ((p.arrivedAt as number) - p.startedAt) / 1000, startedAt: p.startedAt }));
    }
    const prediction = predictEta(history, now);
    const declaredEta = now + Math.max(1, Math.round(j.etaMinutes)) * 60_000;

    const journey: Journey = {
      id: uuidv7(now),
      familyId: s.familyId,
      memberId,
      label: j.label,
      startedAt: now,
      etaAt: prediction.confidence >= 0.4 ? prediction.etaAt : declaredEta,
      arrivedAt: null,
      originName: cachedFix ? 'Current location' : 'Unknown',
      destName: j.destName,
      // Class A, never synced (ADR-010). The corridor starts as the single point
      // we are standing on and fills in as the journey is walked; with fewer than
      // two points nothing can be scored as a deviation, which is correct.
      corridorPoints: cachedFix ? [{ lat: cachedFix.lat, lon: cachedFix.lon }] : [],
      state: 'active',
      // A journey with a learned ETA gets a check-in clock at half the predicted
      // duration: silence past that is the DEADMAN evidence, not the arrival.
      checkInIntervalS: prediction.confidence >= 0.4 ? Math.max(600, Math.round(prediction.medianS / 2)) : null,
      lastCheckInAt: null,
    };

    await safe(() => journeyRepo.upsert(journey), undefined);
    set((prev) => ({ journeys: [journey, ...prev.journeys] }));
    // postJourney strips the corridor before it leaves the device (see net/api).
    void safe(() => postJourney(journey), null);
  },

  async arriveJourney(id: UUID): Promise<void> {
    const at = Date.now();
    const journey = get().journeys.find((j) => j.id === id) ?? null;
    await safe(() => journeyRepo.arrive(id, at), undefined);
    set((prev) => ({
      journeys: prev.journeys.map((j) => (j.id === id ? { ...j, arrivedAt: at, state: 'arrived' } : j)),
    }));

    // ★ The half of FR-042 that was missing. Nothing recorded a completed
    //   duration anywhere the model could read it, so the corridor half worked
    //   and the learning half accumulated nothing — which reads as working.
    if (journey) {
      const key = routeKey(journey.originName, journey.destName);
      const history = await loadRouteHistory(journey.memberId, key);
      await saveRouteHistory(
        journey.memberId,
        recordRouteDuration(history, (at - journey.startedAt) / 1000, journey.startedAt),
      );
    }

    playCue('resolve');
  },

  async addGeofence(g): Promise<void> {
    const fence: Geofence = { ...g, id: uuidv7() };
    // ★ Local only. There is no enqueue here and there must never be one: the
    //   centre of a geofence is a home address (ADR-010).
    await safe(() => geofenceRepo.upsert(fence), undefined);
    set((prev) => ({ geofences: [...prev.geofences, fence] }));
    void refreshRisk(); // a new fence can change the location class immediately
  },

  async removeGeofence(id: UUID): Promise<void> {
    await safe(() => geofenceRepo.remove(id), undefined);
    set((prev) => ({ geofences: prev.geofences.filter((f) => f.id !== id) }));
  },

  async saveMedical(m: MedicalCard): Promise<void> {
    const s = get();
    const memberId = s.me?.id ?? (await identity()).memberId;
    await safe(() => medicalRepo.save(memberId, s.familyId, m), undefined);
    // T0 reads this through deps.medical() when it seals a payload, so the next
    // incident carries the new card without any further wiring.
    set({ medical: m });
  },

  async setLimit(packageName: string, minutes: number | null): Promise<void> {
    await safe(() => usageRepo.setLimit(packageName, minutes), undefined);
    set((prev) => ({
      usage: prev.usage.map((u) =>
        u.packageName === packageName
          ? {
              ...u,
              limitMinutes: minutes,
              // Suspension follows the limit immediately, so the screen never
              // shows a limit that is not yet in force.
              suspended: minutes !== null && u.minutesToday >= minutes,
            }
          : u,
      ),
    }));
    const row = get().usage.find((u) => u.packageName === packageName);
    if (row) await safe(() => usageRepo.setSuspended(packageName, row.suspended), undefined);
  },

  // ── diagnostics, drills, settings ───────────────────────────────────────────
  async runDiagnostics(): Promise<DiagnosticsReport> {
    const report =
      (await safe(() => runSelfCheck(), null)) ?? { ...get().diagnostics, lastCheckedAt: Date.now() };
    await safe(() => diagnosticsRepo.record(report), undefined);
    set({ diagnostics: report });

    const deviceId = get().deviceId;
    const device = get().devices.find((d) => d.id === deviceId);
    if (device) {
      const updated: Device = { ...device, diagnostics: report };
      await safe(() => deviceRepo.upsert(updated), undefined);
      set((prev) => ({ devices: prev.devices.map((d) => (d.id === deviceId ? updated : d)) }));
    }
    return report;
  },

  /**
   * ★ F-02 / F-03 — the canary must NOT wake the family.
   * A canary that notifies six people every few minutes gets muted within a day,
   * and then freezes every deploy behind a permanently "active" incident. So the
   * canary exercises the machinery — watchdog tick, outbox, transports — and
   * writes a scorecard; only a quarterly or annual drill opens a real incident.
   */
  async startDrill(kind: DrillRun['kind']): Promise<void> {
    const s = get();
    const now = Date.now();
    const run: DrillRun = {
      id: uuidv7(now),
      familyId: s.familyId,
      kind,
      notifiesFamily: kind !== 'canary',
      audienceDeviceIds:
        kind === 'canary' ? [s.deviceId] : s.devices.filter((d) => d.platform !== 'ha').map((d) => d.id),
      startedAt: now,
      scorecard: null,
    };
    await safe(() => drillRepo.upsert(run), undefined);
    set((prev) => ({
      drills: [run, ...prev.drills],
      ...(kind === 'canary' ? { lastCanaryAt: now } : {}),
    }));
    void safe(() => postDrill(run), null);

    if (kind === 'canary') {
      await safe(() => heartbeatNow(), undefined);
      await refreshOutboxDepth();
      return;
    }
    await get().trigger('DRILL', { isDrill: true, confidencePct: 100 });
  },

  async changeLocale(l: Locale): Promise<void> {
    setLocale(l);
    set({ locale: l });
    // Language is a per-MEMBER preference, not a per-device one (i18n header).
    const me = get().me;
    if (me) {
      const updated: Member = { ...me, locale: l };
      await safe(() => memberRepo.upsert(updated), undefined);
      set((prev) => ({ me: updated, members: prev.members.map((m) => (m.id === me.id ? updated : m)) }));
    }
    await safe(() => t0ConfigRepo.set('locale', l), undefined);
  },

  /**
   * P-066. An adult switching monitoring off is exercising a right, and the
   * system's only job is to make it VISIBLE rather than silently
   * indistinguishable from a dead agent. Not an alarm — just honesty.
   */
  async pauseMonitoring(paused: boolean): Promise<void> {
    const s = get();
    const memberId = s.me?.id ?? (await identity()).memberId;
    await safe(() => presenceRepo.setPaused(memberId, paused), undefined);
    const presence: MemberPresence = {
      ...(s.presence[memberId] ?? emptyPresence(memberId)),
      monitoringPaused: paused,
      lastSeenAt: Date.now(),
    };
    set((prev) => ({ presence: { ...prev.presence, [memberId]: presence } }));
    await safe(
      () =>
        enqueueGeneric(
          { method: 'POST', path: '/v1/presence/paused', body: { memberId, paused, at: Date.now() } },
          `paused:${memberId}:${paused ? 1 : 0}`,
        ),
      0,
    );
    await refreshOutboxDepth();
  },

  /**
   * Persist that onboarding finished.
   *
   * The store flag is set FIRST and awaited second: the router reacts to the
   * store, and a keystore write that is slow (or that fails on a device with no
   * hardware-backed store) must not leave the user staring at step six. A failed
   * write costs one extra onboarding next launch, which is recoverable; blocking
   * the navigation is not.
   */
  async completeOnboarding(rehearsed: boolean): Promise<void> {
    set({ onboarded: true, rehearsalSkipped: !rehearsed });
    await safe(
      () =>
        SecureStore.setItemAsync(
          STORAGE_KEYS.onboarded,
          JSON.stringify({ at: Date.now(), v: 1, rehearsed }),
        ),
      undefined,
    );
  },

  async resetOnboarding(): Promise<void> {
    set({ onboarded: false });
    await safe(() => SecureStore.deleteItemAsync(STORAGE_KEYS.onboarded), undefined);
  },
}));

// ═══════════════════════════════════════════════════════════════════════════════
// Selectors
// ═══════════════════════════════════════════════════════════════════════════════

export function selectMember(s: KavachState, id: UUID): Member | undefined {
  return s.members.find((m) => m.id === id);
}

/**
 * How many incidents are live and acknowledged by NOBODY.
 *
 * Not "unread" (PRD §12.1): an incident five people have seen and one has
 * claimed is being handled, and badging it teaches the family to ignore the
 * badge that matters. This count is what drives the tab badge and the
 * "NOBODY HAS RESPONDED YET" headline, the single most important string in the
 * product.
 *
 * ★ A COUNT, NOT A FILTERED ARRAY ★
 * Both callers are root layouts — `app/_layout.tsx` and `app/(tabs)/_layout.tsx`
 * — mounted for every route in the app. Filtering and then taking `.length`
 * allocated a fresh array on every store notification for the whole life of the
 * process. Counting in place returns a number the subscription can compare, so
 * nothing re-renders and nothing is allocated. During a live incident the store
 * writes on every appended event row, every T0 snapshot and every demo responder
 * frame — exactly when the garbage is least welcome.
 */
export function countUnacked(s: KavachState): number {
  let n = 0;
  for (const i of s.incidents) if (isActive(i.state) && i.firstAckAt === null) n++;
  return n;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ★ ONE FAILING STAGE MUST NOT TAKE THE REST WITH IT ★
 *
 * This whole function used to be a single try block whose catch was empty and
 * whose finally set `ready: true`. So a MigrationError from a corrupt kavach.db,
 * or a full disk, skipped EVERY line after `openDb()` — no keypair, no group
 * secret, no T0, no fusion, no watchdog, no outbox drain — and the app came up
 * fully ready showing "All clear". The panic button then returned its
 * pre-allocated UUID and did absolutely nothing.
 *
 * Each stage now fails alone. `stage()` is `safe()` with a name attached, so a
 * failure is recorded rather than merely swallowed, and `t0Ready` reports the one
 * that actually matters.
 */
async function stage<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    bootFailures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Stage failures from the last bootstrap, for the diagnostics screen. */
export function bootstrapFailures(): readonly string[] {
  return bootFailures;
}

async function doBootstrap(): Promise<void> {
  useKavach.setState({ booting: true });
  bootFailures.length = 0;
  try {
    // A database that will not open is survivable: every repository call is
    // already wrapped in safe(), so the app runs from memory at the L0 floor.
    // What is NOT survivable is skipping the seven stages that follow.
    await stage('openDb', () => openDb());
    await stage('keys', () => loadKeyMaterial());
    const ids = await identity();
    useKavach.setState({ familyId: ids.familyId, deviceId: ids.deviceId });
    setIdentity({ deviceId: ids.deviceId, familyId: ids.familyId });
    await stage('session', () => restoreSession());

    // Read the onboarding flag back BEFORE `ready` flips. The entry route waits
    // on `ready`, so resolving this first means it makes one correct decision
    // instead of guessing on frame one and bouncing an enrolled device back
    // through all six steps.
    const onboardedRaw = await safe(
      () => SecureStore.getItemAsync(STORAGE_KEYS.onboarded),
      null,
    );
    let rehearsed = true;
    if (onboardedRaw != null) {
      try {
        rehearsed = (JSON.parse(onboardedRaw) as { rehearsed?: boolean }).rehearsed !== false;
      } catch {
        /* a v0 flag with no field predates the rehearsal record; assume nothing is owed */
      }
    }
    useKavach.setState({ onboarded: onboardedRaw != null, rehearsalSkipped: !rehearsed });

    // Every event this device writes carries an HLC whose node id is the device
    // id, so a timeline merged across six phones is causally correct even when
    // their wall clocks disagree (P-052).
    try {
      setHlcNodeId(hexToBytes(ids.deviceId.replace(/-/g, '').slice(0, 12)));
    } catch {
      /* a malformed id must not stop the boot; nowHlc keeps its random node */
    }

    policy = (await safe(() => policyRepo.current(), DEFAULT_POLICY)) ?? DEFAULT_POLICY;

    await stage('seed', () => seedIfEmpty(ids));
    await stage('load', () => loadEverything(ids));
    await stage('caches', () => primeCaches(ids.memberId));
    await stage('risk', () => refreshRisk());
    await stage('t0', () => startT0(ids));
    await stage('subscriptions', () => startSubscriptions());

    // ADR-013: the policy is server-authoritative. Nothing ever fetched one, so
    // DEFAULT_POLICY was permanently in force while every incident was stamped
    // with a policyVersion as if it had been negotiated. Fire-and-forget — the
    // cached policy is what T0 runs on either way.
    void pullFromServer('boot');

    void safe(() => initNotifications(), false);
    // ★ W10 · 1.35 — the call site that makes a closed phone reachable. ★
    // Ordered after initNotifications() because POST_NOTIFICATIONS must be
    // granted before FCM will issue a token, and fire-and-forget because a
    // Play-Services round trip must never sit between the user and `ready`.
    void registerForRemotePush(ids.deviceId);
    void sweepSilentAgents();
    void sweepAutoQuiesce();

    // ★ The Coordination plane's call site (Phase 2). ★
    // Until this line existed, noteLocationFix(), evaluateGeofences() and
    // connectWs() had no callers at all: every coordinate the app showed was a
    // boot-time database read, fences were never evaluated, and nothing was
    // listening to the realtime gateway. Started fire-and-forget so a refused
    // location permission can never delay `ready`.
    void safe(
      () =>
        startPresence({
          noteLocationFix,
          geofences: () => useKavach.getState().geofences,
          memberId: () => useKavach.getState().me?.id ?? null,
          t0State: () => useKavach.getState().t0State,
          riskElevated: () => useKavach.getState().risk >= 3,
          journeyActive: () =>
            useKavach.getState().journeys.some((j) => j.state === 'active'),
          degradation: () => useKavach.getState().degradation,
          onCrossing: (wire, local) => {
            // ★ `wire` is Class B and is ALL that is transmitted: an opaque id and
            // an enum. `local` carries the timestamp, the label and the distance —
            // it stays on this device and is used here only to build an
            // idempotency key. The type system enforces the split (FenceCrossing
            // has no `at`), which is why this reads slightly awkwardly: that is
            // the boundary doing its job (ADR-010).
            void safe(
              () =>
                enqueueGeneric(
                  { method: 'POST', path: '/v1/geofence/crossing', body: wire },
                  `fence:${wire.geofenceId}:${wire.transition}:${local.at}`,
                ),
              0,
            );
          },
          connectRealtime: connectWs,
        }),
      undefined,
    );
  } catch {
    // ★ Whatever happened, the app comes up. A store that refuses to become
    //   ready is a panic button that does not render (hard rule 8).
  } finally {
    useKavach.setState({ ready: true, booting: false });
  }
}

/**
 * The device identity triple, resolved ONCE and then immutable for the process.
 *
 * ★ WHY THE CACHE IS THE POINT ★
 * This is called lazily from claim, release, onScene, resolveIncident, checkIn,
 * findPhone, grantConsent, startJourney, saveMedical and pauseMonitoring
 * whenever `me` is null — which is exactly the state after a bootstrap that
 * could not load members. With a dead or locked database every one of those
 * calls used to mint a DIFFERENT memberId, and those ids were then written into
 * the access log, the consent ledger and the presence map as if they were
 * people. Resolving once means a broken read produces one wrong identity, not
 * ten, and the one it produces is the one T0 is already signing with.
 *
 * ★ AND WHY A PARTIAL TRIPLE IS REFUSED ★
 * A first launch interrupted between the three writes leaves, say, familyId and
 * deviceId but no memberId. Minting a fresh triple there silently re-founds the
 * device and orphans every record sealed under the previous deviceId, so the two
 * that DID persist are kept and only the missing one is minted.
 */
async function identity(): Promise<{ familyId: UUID; deviceId: UUID; memberId: UUID }> {
  if (cachedIds) return cachedIds;

  // Deliberately NOT through safe(): a read that threw is not the same as a key
  // that is absent, and treating them alike is what let a locked database look
  // like a brand-new install.
  let existingFamily: string | null = null;
  let existingDevice: string | null = null;
  let existingMember: string | null = null;
  let readFailed = false;
  try {
    [existingFamily, existingDevice, existingMember] = await Promise.all([
      t0ConfigRepo.get('familyId'),
      t0ConfigRepo.get('deviceId'),
      t0ConfigRepo.get('memberId'),
    ]);
  } catch (e) {
    readFailed = true;
    bootFailures.push(`identity read: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (existingFamily && existingDevice && existingMember) {
    cachedIds = { familyId: existingFamily, deviceId: existingDevice, memberId: existingMember };
    return cachedIds;
  }

  const fresh = isDemo()
    ? { familyId: demoFamilyId, deviceId: demoMeDeviceId, memberId: demoMeMemberId }
    : { familyId: uuidv7(), deviceId: uuidv7(), memberId: uuidv7() };
  const ids = {
    familyId: existingFamily ?? fresh.familyId,
    deviceId: existingDevice ?? fresh.deviceId,
    memberId: existingMember ?? fresh.memberId,
  };
  cachedIds = ids;

  // Nothing is written back when the READ failed: persisting a minted triple
  // over a database we could not question is how the previous identity is lost.
  if (!readFailed) {
    if (!existingFamily) await safe(() => t0ConfigRepo.set('familyId', ids.familyId), undefined);
    if (!existingDevice) await safe(() => t0ConfigRepo.set('deviceId', ids.deviceId), undefined);
    if (!existingMember) await safe(() => t0ConfigRepo.set('memberId', ids.memberId), undefined);
  }
  return ids;
}

/**
 * The control-plane bearer token (P-007: control plane ONLY — the SOS ingest
 * endpoints do not accept one, which is why an expired session cannot turn an
 * SOS into a 401).
 *
 * `setAuthToken` had no call site at all, so `authToken` was permanently null and
 * every control-plane write got a 401 → KV-1002 → backoff → parked for 24 h after
 * twelve attempts, with nothing on screen but a growing outbox number. There is
 * no passkey flow in this build to mint a token, so this restores one if a
 * previous session stored it and otherwise leaves the absence honest — the
 * diagnostics screen shows the outbox depth and the drain's last reason.
 */
async function restoreSession(): Promise<void> {
  const raw = await secureGet(STORAGE_KEYS.session);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (typeof parsed.token === 'string' && parsed.token.length > 0) {
      setAuthToken(parsed.token);
      return;
    }
  } catch {
    /* a v0 session blob was the bare token */
  }
  setAuthToken(raw);
}

/**
 * Persist and install a control-plane session token. Called by whatever
 * establishes the device session (docs/02 `/v1/auth/passkey/*`).
 */
export async function setSession(token: string | null): Promise<void> {
  setAuthToken(token);
  if (token === null) {
    await safe(() => SecureStore.deleteItemAsync(STORAGE_KEYS.session), undefined);
    return;
  }
  await secureSet(STORAGE_KEYS.session, JSON.stringify({ token, at: Date.now() }));
}

interface StoredKeypair {
  identitySecret: string;
  identityPublic: string;
  emergencySecret: string;
  emergencyPublic: string;
  boxSecret: string;
  boxPublic: string;
}

/**
 * The emergency signing key and the family group secret.
 *
 * ★ F-17 / crypto header: the emergency key is deliberately NOT biometric-gated
 * and NOT gated on the device being unlocked. An unconscious person cannot
 * provide a fingerprint, and a system that only works for conscious people
 * excludes exactly the people who need it most. `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
 * is as close as expo-secure-store gets, and it is what we ask for.
 */
async function loadKeyMaterial(): Promise<void> {
  const raw = await secureGet(STORAGE_KEYS.deviceKeypair);
  if (raw) {
    try {
      const s = JSON.parse(raw) as StoredKeypair;
      keypair = {
        identitySecret: base64ToBytes(s.identitySecret),
        identityPublic: base64ToBytes(s.identityPublic),
        emergencySecret: base64ToBytes(s.emergencySecret),
        emergencyPublic: base64ToBytes(s.emergencyPublic),
        boxSecret: base64ToBytes(s.boxSecret),
        boxPublic: base64ToBytes(s.boxPublic),
      };
    } catch {
      keypair = null; // corrupt blob — regenerate rather than run keyless
    }
  }
  if (!keypair) {
    keypair = generateDeviceKeypair();
    const stored: StoredKeypair = {
      identitySecret: bytesToBase64(keypair.identitySecret),
      identityPublic: bytesToBase64(keypair.identityPublic),
      emergencySecret: bytesToBase64(keypair.emergencySecret),
      emergencyPublic: bytesToBase64(keypair.emergencyPublic),
      boxSecret: bytesToBase64(keypair.boxSecret),
      boxPublic: bytesToBase64(keypair.boxPublic),
    };
    await secureSet(STORAGE_KEYS.deviceKeypair, JSON.stringify(stored));
  }

  // ★ F-17 / P-031: prefer a key the JS runtime cannot read. ★
  //
  // The @noble keypair above is bytes in this process for the life of the app,
  // and it is what proves an SOS came from this device. crypto/hardware.ts
  // adopts the AndroidKeyStore key instead when the native plane offers one, and
  // keeps the software key as the fallback it declares honestly rather than as a
  // secret substitute. The order matters: register the fallback FIRST, so a
  // keystore that refuses mid-prepare still leaves a signer standing.
  //
  // prepareKeys() never throws and never blocks the boot on the native side — a
  // missing key vault (Expo Go, iOS, a device whose keystore says no) resolves to
  // js_heap with the reason attached, which diagnostics.tsx renders verbatim.
  setSoftwareKeys(keypair);
  setHardwareKeyBackend(keyVault);
  await safe(() => prepareKeys(), []);

  const gs = await secureGet(STORAGE_KEYS.groupSecret);
  if (gs) {
    try {
      groupSecret = base64ToBytes(gs);
    } catch {
      groupSecret = null;
    }
  }
  if (!groupSecret || groupSecret.length !== 32) {
    // The founding device generates it; an enrolled device receives it sealed to
    // its box key (crypto.sealTo). Generating here means this device founds.
    groupSecret = randomBytes(32);
    await secureSet(STORAGE_KEYS.groupSecret, bytesToBase64(groupSecret));
  }

  // Demo PINs, only when nothing is enrolled. An unexercisable duress path is
  // worse than none: you find out it never worked during the emergency.
  if (isDemo()) {
    if (!(await secureGet(STORAGE_KEYS.cancelPin))) await secureSet(STORAGE_KEYS.cancelPin, DEMO_CANCEL_PIN);
    if (!(await secureGet(STORAGE_KEYS.duressPin))) await secureSet(STORAGE_KEYS.duressPin, DEMO_DURESS_PIN);
  }
}

async function seedIfEmpty(ids: { familyId: UUID; memberId: UUID }): Promise<void> {
  const existing = await safe(() => memberRepo.list(ids.familyId), []);
  if ((existing?.length ?? 0) > 0) return;
  if (!isDemo()) return; // a real install waits for onboarding; it invents nothing

  const seed = seedDemoData();

  // ★ One transaction, one commit. Dozens of individually-committed inserts on
  //   first launch is dozens of fsyncs in front of a blank entry screen. Each
  //   write keeps its own safe() so one bad row still lets the rest land —
  //   a half-seeded demo is fine, a boot that stalls on it is not.
  const seedAll = async (): Promise<void> => {
    await safe(() => memberRepo.upsertMany(seed.members), undefined);
    await safe(() => deviceRepo.upsertMany(seed.devices), undefined);
    for (const i of seed.incidents) await safe(() => incidentRepo.upsert(i), undefined);
    for (const rows of Object.values(seed.incidentEvents)) {
      for (const r of rows) {
        const { id: _rowId, ...rest } = r;
        await safe(() => incidentRepo.appendEvent(rest), 0);
      }
    }
    for (const p of Object.values(seed.presence)) await safe(() => presenceRepo.upsert(p), undefined);
    for (const g of seed.grants) await safe(() => consentRepo.upsert(g), undefined);
    for (const a of seed.accessLog) {
      const { id: _logId, ...rest } = a;
      await safe(() => consentRepo.addLogEntry(rest), 0);
    }
    for (const j of seed.journeys) await safe(() => journeyRepo.upsert(j), undefined);
    for (const f of seed.geofences) await safe(() => geofenceRepo.upsert(f), undefined);
    for (const v of seed.vault) await safe(() => vaultRepo.upsert(v), undefined);
    await safe(() => usageRepo.upsertMany(seed.usage), undefined);
    await safe(() => medicalRepo.save(seed.meMemberId, seed.familyId, seed.medical), undefined);
    for (const d of seed.drills) await safe(() => drillRepo.upsert(d), undefined);
    for (const e of seed.haEvents) await safe(() => haRepo.upsert(e), undefined);
    await safe(() => diagnosticsRepo.record(seed.diagnostics), undefined);

    // A last-known fix so the very first trigger has coordinates to seal, without
    // ever asking for a GNSS acquisition on the hot path.
    const home = seed.presence[seed.meMemberId]?.location;
    if (home) {
      await safe(
        () =>
          locationRepo.append({
            familyId: seed.familyId,
            memberId: seed.meMemberId,
            at: home.at,
            lat: home.lat,
            lon: home.lon,
            accuracyM: home.accuracyM,
            speed: 0,
            heading: null,
            batteryPct: 82,
            incidentId: null,
          }),
        0,
      );
    }
  };

  const db = await safe(() => requireDb(), null);
  if (db) await safe(() => db.withTransactionAsync(seedAll), undefined);
  else await seedAll();
}

/**
 * Every read the first frame needs.
 *
 * ★ IN PARALLEL, BECAUSE NONE OF THEM DEPEND ON EACH OTHER ★
 * These were nineteen `await`s in a row, each with its own bridge hop, and then
 * a loop of twenty more for the recent timelines — ~39 serialised round-trips
 * while `app/index.tsx` rendered nothing but a background-coloured View. They
 * all depend only on `ids`. Every one is `safe()`-wrapped, so no rejection can
 * escape the Promise.all and take the others with it.
 */
async function loadEverything(ids: { familyId: UUID; deviceId: UUID; memberId: UUID }): Promise<void> {
  const [
    membersRaw,
    devicesRaw,
    incidentsRaw,
    activeListRaw,
    presenceMapRaw,
    grantsRaw,
    accessLogRaw,
    journeysRaw,
    geofencesRaw,
    vaultRaw,
    usageRaw,
    medicalRaw,
    drillsRaw,
    haEventsRaw,
    diagnosticsRaw,
    depthRaw,
    canary,
    storedLocale,
  ] = await Promise.all([
    safe(() => memberRepo.list(ids.familyId), []),
    safe(() => deviceRepo.list(ids.familyId), []),
    safe(() => incidentRepo.list(100, ids.familyId), []),
    safe(() => incidentRepo.listActive(), []),
    safe(() => presenceRepo.map(), {}),
    safe(() => consentRepo.grants(ids.familyId), []),
    safe(() => consentRepo.log(200), []),
    safe(() => journeyRepo.list(50), []),
    safe(() => geofenceRepo.list(), []),
    safe(() => vaultRepo.list(ids.familyId), []),
    safe(() => usageRepo.list(), []),
    safe(() => medicalRepo.get(ids.memberId), null),
    safe(() => drillRepo.list(50), []),
    safe(() => haRepo.list(50), []),
    safe(() => diagnosticsRepo.latest(), null),
    safe(() => outboxRepo.depth(), 0),
    safe(() => drillRepo.lastOfKind('canary'), null),
    safe(() => t0ConfigRepo.get('locale'), null),
  ]);

  const members = membersRaw ?? [];
  const me = members.find((m) => m.id === ids.memberId) ?? null;
  const devices = devicesRaw ?? [];
  const incidents = incidentsRaw ?? [];
  const activeList = activeListRaw ?? [];
  const presenceMap = presenceMapRaw ?? {};
  const grants = grantsRaw ?? [];
  const accessLog = accessLogRaw ?? [];
  const journeys = journeysRaw ?? [];
  const geofences = geofencesRaw ?? [];
  const vault = vaultRaw ?? [];
  const usage = usageRaw ?? [];
  const medical = medicalRaw ?? EMPTY_MEDICAL;
  const drills = drillsRaw ?? [];
  const haEvents = haEventsRaw ?? [];
  const diagnostics = diagnosticsRaw ?? emptyReport();
  const depth = depthRaw ?? 0;

  const locale = (me?.locale ?? (storedLocale as Locale | null) ?? getLocale()) as Locale;
  setLocale(locale);

  // Only the recent timelines: an incident log is unbounded and the screens that
  // need an old one fetch it on demand. One query, grouped in JS.
  const events =
    (await safe(() => incidentRepo.eventsFor(incidents.slice(0, 20).map((i) => i.id)), {})) ?? {};

  useKavach.setState({
    members,
    me,
    devices,
    incidents,
    activeIncident: activeList[0] ?? null,
    incidentEvents: events,
    t0State: currentState(),
    presence: presenceMap,
    grants,
    accessLog,
    journeys,
    geofences,
    vault,
    usage,
    medical,
    drills,
    haEvents,
    diagnostics,
    locale,
    outboxDepth: depth,
    lastCanaryAt: canary?.startedAt ?? null,
    degradation: lastKnownDegradation(),
  });
}

/** Fill the synchronous caches T0 depends on before T0 can be started. */
async function primeCaches(memberId: UUID): Promise<void> {
  const last = await safe(() => locationRepo.latest(memberId), null);
  if (last) {
    cachedFix = {
      lat: last.lat,
      lon: last.lon,
      accuracyM: last.accuracyM,
      speed: last.speed ?? undefined,
      heading: last.heading ?? undefined,
      at: last.at,
    };
  }
  cachedBatteryPct = await readBatteryPct();
  await refreshRoaming();
}

/**
 * P-054. Roaming is derived from an MCC comparison that touches the database and
 * the cellular module, so it is cached exactly like the battery percentage: the
 * fan-out reads it synchronously and T0 may never await.
 */
async function refreshRoaming(): Promise<void> {
  cachedRoaming = (await safe(() => isRoaming(), false)) ?? false;
}

/**
 * Hand T0 everything it needs and let it run. Every provider below is a
 * SYNCHRONOUS read of a cache — T0's hot path may not await anything, and a
 * provider that could block is the one bug that would blow the whole budget.
 */
async function startT0(ids: { familyId: UUID; deviceId: UUID; memberId: UUID }): Promise<void> {
  // No key material means nothing can be signed and no envelope can be built.
  // Say so rather than returning quietly into a "ready" app.
  if (!keypair || !groupSecret) {
    bootFailures.push('t0: no key material; the alarm cannot sign an SOS');
    useKavach.setState({ t0Ready: false });
    return;
  }
  const s = useKavach.getState();
  const cancelPin = (await secureGet(STORAGE_KEYS.cancelPin)) ?? '';
  const duressPin = (await secureGet(STORAGE_KEYS.duressPin)) ?? '';

  const started = await safe(async () => {
    await initT0({
      familyId: ids.familyId,
      deviceId: ids.deviceId,
      memberId: ids.memberId,
      asciiShortName: s.me?.asciiShortName ?? 'Me',
      keypair: keypair as DeviceKeypair,
      groupSecret: groupSecret as Uint8Array,
      cancelPin,
      duressPin,
      policy,
      lastKnownLocation: () => cachedFix,
      batteryPct: () => cachedBatteryPct,
      risk: () => useKavach.getState().risk,
      degradation: () => useKavach.getState().degradation,
      // P-054, cached on the same timer as the battery: T0 may not await.
      roaming: () => cachedRoaming,
      smsRecipients: () =>
        useKavach
          .getState()
          .members.filter((m) => m.id !== ids.memberId && m.phoneE164)
          .map((m) => m.phoneE164 as string),
      medical: () => useKavach.getState().medical,
      falsePositiveStreak,
      onEvent: (e) => {
        // ★ The seam. Never awaited by T0; persistence is a T1 concern. The
        //   catch is not decoration: handleT0Event does database work, and an
        //   unhandled rejection here loses a timeline row mid-emergency with no
        //   log, because emit() in the router only guards the SYNCHRONOUS part.
        void handleT0Event(e).catch(() => {});
      },
    });
    return true;
  }, false);

  setPins(cancelPin, duressPin);
  useKavach.setState({ t0Ready: started === true });
  // The diagnostics screen asks this rather than assuming (P-031).
  setT0RunningProbe(() => useKavach.getState().t0Ready);
}

async function startSubscriptions(): Promise<void> {
  // ★ The T0 snapshot stream. This is what puts the countdown ring on screen.
  subscriptions.push(subscribeT0(onT0Snapshot));

  // Degradation level is global UI state — every screen shows the rung honestly.
  subscriptions.push(
    subscribeDegradation((level) => {
      const previous = useKavach.getState().degradation;
      useKavach.setState({ degradation: level });
      if (level <= DegradationLevel.SMS_ONLY && previous > level) {
        void safe(() => notifyDegraded(degradationReason(level)), undefined);
      }
      // Coming back onto a data path is the moment to re-dial the realtime leg,
      // to re-check the SIM, and to ask the server what we missed.
      void refreshPresenceTier();
      void refreshRoaming();
      if (level > previous && level >= DegradationLevel.HTTP_ONLY) void pullFromServer('reconnect');
    }),
  );

  // ★★★ THE RECEIVE HALF OF THE REALTIME PLANE ★★★
  //
  // `connectWs()` was dialled, the socket opened, frames were parsed — and
  // `deliver()` found no listeners every single time, so CRITICAL frames piled
  // into a 200-deep buffer and were then dropped forever. Concretely: a relative
  // fires an SOS, the server pushes incident.opened / incident.claimed /
  // incident.state_changed, this device receives every byte and throws it away.
  // `reactToRemoteState()` — the ONLY code that starts the alarm for someone
  // else's emergency — is reachable only through `applyEvent`, and `applyEvent`
  // was reachable only from actions the local user initiated. A responder's
  // phone was silent for a family member's emergency.
  subscriptions.push(onFrame((frame) => void handleWsFrame(frame)));

  // Leg 1 of the fan-out (§2.7.2): free when the socket is already open, skipped
  // entirely when it is not. `registerWarmSocket` had no call site, so `warmSend`
  // was permanently null and the WebSocket leg did not exist at runtime on any
  // device. Registered on open and cleared on anything else, so `isSocketWarm()`
  // stays truthful and the dispatcher never dials on the hot path.
  subscriptions.push(
    subscribeWsStatus((status) => {
      if (status === 'open') {
        registerWarmSocket((payload) =>
          sendFrame({ type: 'incident.open', priority: 'CRITICAL', payload }),
        );
      } else {
        clearWarmSocket();
      }
    }),
  );

  // The three notification actions become real here — see notifications.ts for
  // what each one silently did nothing about until this existed.
  subscriptions.push(
    subscribeNotificationResponses({
      claim: (id) => void useKavach.getState().claim(id),
      probeRespond: (id, ok) => void useKavach.getState().probeRespond(id, ok),
    }),
  );

  // ★ Location sampling follows STATE, never a fixed timer (P-006).
  // An incident promotes to a few seconds; elevated risk or a live journey to
  // the WATCH cadence; everything else falls back to significant-change only.
  // Subscribing to the store rather than polling means the radio is only ever
  // busy when something is actually happening.
  subscriptions.push(
    useKavach.subscribe((s, prev) => {
      if (
        s.t0State !== prev.t0State ||
        s.risk !== prev.risk ||
        s.journeys !== prev.journeys
      ) {
        void refreshPresenceTier();
      }
    }),
  );
  void safe(async () => {
    useKavach.setState({ degradation: await currentDegradation() });
  }, undefined);

  // The dispatcher keeps its outbox in memory so T0 never awaits SQLite. This is
  // the hand-off to durable storage, and the reason a fan-out that happened
  // while the app was being killed still reaches the server on the next launch.
  setOutboxSink((item) => {
    void (async () => {
      const signed = toSignedEnvelope(item.payload);
      if (signed) {
        const hlc = hlcOf(signed) ?? nowHlc().hex;
        // ★ The branch that was missing. Every fan-out was filed as an
        //   `incident_open`, so the PIN_CORRECT / PIN_DURESS envelope — built at
        //   the one moment the network is least likely to be there — deduplicated
        //   against the open the server already had. A duress entered in a
        //   basement with no signal was simply never delivered, even once she had
        //   bars again. `dispatch()`'s whole `incident_event` branch could not fire.
        await safe(
          () =>
            item.kind === 'incident_event'
              ? enqueueIncidentEvent(signed, hlc)
              : enqueueIncidentOpen(signed, hlc),
          0,
        );
      }
      pruneOutbox();
      await refreshOutboxDepth();
    })();
  });

  // FR-034: the watchdog owns the schedule, we own the network leg (its header —
  // T0 never awaits T1).
  setHeartbeatSender(() => {
    void sendHeartbeat();
  });
  setWatchdogSink((death) => {
    // Our own agent was dead for `gapMs`. That is exactly the failure the family
    // must be told about, and we are the only ones who can prove it happened.
    void safe(
      () =>
        enqueueGeneric(
          {
            method: 'POST',
            path: '/v1/devices/service-death',
            body: { gapMs: death.gapMs, expectedMs: death.expectedMs, at: death.at, source: death.source },
          },
          `death:${death.at}`,
        ),
      0,
    );
  });

  subscriptions.push(startOutboxDrain());

  const battery = setInterval(() => void refreshBattery(), 60_000);
  const heartbeat = setInterval(() => void sendHeartbeat(), CONFIG.heartbeatIntervalMs);
  const silentSweep = setInterval(() => void sweepSilentAgents(), CONFIG.watchdogIntervalMs);
  const quiesceSweep = setInterval(() => void sweepAutoQuiesce(), CONFIG.watchdogIntervalMs);
  const risk = setInterval(() => void refreshRisk(), 5 * 60_000);
  const roaming = setInterval(() => void refreshRoaming(), 10 * 60_000);
  subscriptions.push(() => {
    clearInterval(battery);
    clearInterval(heartbeat);
    clearInterval(silentSweep);
    clearInterval(quiesceSweep);
    clearInterval(risk);
    clearInterval(roaming);
  });
}

/** Release every subscription and timer. Used by tests and on sign-out. */
export function teardownStore(): void {
  for (const off of subscriptions.splice(0)) {
    try {
      off();
    } catch {
      /* a failing unsubscribe must not block the rest */
    }
  }
  for (const stop of demoStops.values()) stop();
  demoStops.clear();
  setOutboxSink(null);
  setHeartbeatSender(null);
  setWatchdogSink(null);
  setT0RunningProbe(null);
  clearWarmSocket();
  disconnectWs();

  // ★ Everything T0 holds on to. Without these, a sign-out left the sensor
  //   subscriptions, the location watch, the OS background task and both
  //   AudioPlayers (a native player plus a 118 KiB WAV each) running for a user
  //   who is no longer signed in — and a re-bootstrap leaked another set.
  shutdownT0();
  stopPresence();
  void unregisterWatchdog().catch(() => {});

  // Last: the drain, the cursor flush and every repository call are above this
  // line, so nothing is still holding a handle by the time it closes.
  void closeDb().catch(() => {});
  useKavach.setState({ t0Ready: false });
  cachedIds = null;
  bootPromise = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// T0 → store
// ═══════════════════════════════════════════════════════════════════════════════

/** The snapshot stream: the countdown, the current state, the live incident. */
function onT0Snapshot(snap: T0Snapshot): void {
  useKavach.setState({ t0State: snap.state, pendingUntil: snap.pendingUntil });
  if (snap.incidentId === null) return;
  const incident = findIncident(snap.incidentId);
  if (!incident) return;
  useKavach.setState({ activeIncident: isActive(snap.state) ? incident : null });
}

/**
 * Persist one T0 decision.
 *
 * Every branch is best-effort and none of them can fail back into T0. The order
 * matters: the store is updated synchronously where possible so the UI is
 * already correct, and the database write follows.
 */
async function handleT0Event(e: T0Event): Promise<void> {
  if (e.type === 'INCIDENT_OPEN') {
    await openIncidentRecord(e);
    return;
  }

  if (e.type === 'SUPPRESSED') {
    // A suppressed trigger is data the False Positive Ledger needs: it is the
    // evidence that the pocket suppressor is earning its place (P-002).
    await safe(
      () =>
        enqueueGeneric(
          { method: 'POST', path: '/v1/telemetry/suppressed', body: { at: e.at, ...e.detail } },
          `suppressed:${e.at}`,
        ),
      0,
    );
    return;
  }

  const incident = findIncident(e.incidentId) ?? (await safe(() => incidentRepo.get(e.incidentId), null));
  if (!incident) return;

  if (EVENT_SET.has(e.type)) {
    const event = e.type as IncidentEvent;
    await safe(() => incidentRepo.setState(e.incidentId, e.state, e.at), undefined);
    const updated: Incident = {
      ...incident,
      state: e.state,
      duress: event === 'PIN_DURESS' ? true : incident.duress,
      ...(isTerminal(e.state) ? { resolvedAt: incident.resolvedAt ?? e.at } : {}),
    };
    putIncident(updated);
    await appendRow(updated, event, { hlc: e.hlc, detail: e.detail, at: e.at });
    await reactToOwnState(updated, event);
    return;
  }

  // DISPATCHED / BLACKBOX_SEALED / LADDER — no state change, still part of the
  // record an after-action review has to be able to read.
  await appendRow(incident, e.type, { hlc: e.hlc, detail: e.detail, at: e.at });
  if (e.type === 'LADDER') {
    const tier = typeof e.detail?.tier === 'number' ? (e.detail.tier as 1 | 2 | 3) : 1;
    void safe(() => notifyIncident(incident, tier, subjectOf(incident)), undefined);
    if (incident.firstNotifiedAt === null) await markFirstNotified(incident);
  }
}

/** Build and persist the incident row the moment T0 opens one. */
async function openIncidentRecord(e: T0Event): Promise<void> {
  const s = useKavach.getState();
  const snap = currentSnapshot();
  const at = e.at;
  const trigger = (e.detail?.trigger as TriggerType | undefined) ?? snap.trigger ?? 'MANUAL';
  const confidencePct = (e.detail?.confidencePct as number | undefined) ?? snap.confidencePct;
  const isDrill = (e.detail?.isDrill as boolean | undefined) ?? snap.isDrill;
  const memberId = s.me?.id ?? s.deviceId;

  const sealed: IncidentSealedPayload | null = cachedFix
    ? {
        lat: cachedFix.lat,
        lon: cachedFix.lon,
        accuracyM: cachedFix.accuracyM,
        ...(cachedFix.speed !== undefined ? { speed: cachedFix.speed } : {}),
        ...(cachedFix.heading !== undefined ? { heading: cachedFix.heading } : {}),
        batteryPct: cachedBatteryPct,
        medical: s.medical,
      }
    : null;

  const incident: Incident = {
    id: e.incidentId,
    familyId: s.familyId,
    subjectMemberId: memberId,
    state: e.state,
    trigger,
    policyVersion: policy.version ?? DEFAULT_POLICY_VERSION,
    duress: false,
    isDrill,
    coarseH3R7: cachedFix ? coarseCell(cachedFix.lat, cachedFix.lon) : null,
    ownerMemberId: null,
    openedAt: snap.openedAt ?? at,
    firstNotifiedAt: null,
    firstAckAt: null,
    resolvedAt: null,
    outcome: null,
    outcomeNote: null,
    inc8: inc8(e.incidentId),
    syntheticFromSms: false,
    mergedIntoId: null,
    autoQuiesceAt: snap.autoQuiesceAt ?? at + CONFIG.autoQuiesceMs,
    confidencePct,
    riskContext: s.risk,
    sealed,
  };

  // ★ The store update is synchronous: the panic screen has the incident before
  //   the first await, which is what "no loading state, ever" actually means.
  putIncident(incident);
  useKavach.setState({ activeIncident: incident, t0State: e.state });

  await safe(() => incidentRepo.upsert(incident), undefined);
  await appendRow(incident, 'INCIDENT_OPEN', { hlc: e.hlc, detail: e.detail, at });
}

/**
 * What the store adds on top of T0's own state handling.
 *
 * ★ It does NOT touch the alarm for an incident T0 owns. ★ T0 already started or
 * stopped it inside onEnterState, and a second controller fighting it over the
 * siren is precisely the class of bug that ends with a silent panic button.
 * Notifications, outcomes and cleanup are ours.
 */
async function reactToOwnState(incident: Incident, event: IncidentEvent): Promise<void> {
  const subject = subjectOf(incident);

  switch (incident.state) {
    case 'PROBE':
      void safe(() => notifyProbe(incident), undefined);
      break;

    case 'ACTIVE_L1':
    case 'ACTIVE_L1_SILENT':
      await markFirstNotified(incident);
      void safe(() => notifyIncident(incident, 1, subject), undefined);
      break;

    case 'ACTIVE_L2':
      void safe(() => notifyIncident(incident, 2, subject), undefined);
      break;

    case 'ACTIVE_L3':
      void safe(() => notifyIncident(incident, 3, subject), undefined);
      break;

    case 'OWNED':
      // ★ P-030 / §5.2 Correction 1 — DO NOT FULLY SILENCE. T0 stops the siren;
      //   a persistent notification stays up, because full silence makes the
      //   other five people forget an emergency is in progress.
      //
      // ★ W10-d · 1.32 ★ It used to re-post the ALERT here, on the alarm channel,
      // still reading "NOBODY HAS RESPONDED YET" — while somebody demonstrably
      // had. It now says who (§2.6.4), through the same composer the push path
      // uses, so the family hears one story regardless of which transport
      // delivered it.
      void safe(() => notifyOwnership(incident, subject, ownerOf(incident)), undefined);
      break;

    case 'FALSE_ALARM':
      // A cancelled alarm takes its notification with it.
      void safe(() => clearIncidentNotification(incident.id), undefined);
      await safe(() => incidentRepo.setOutcome(incident.id, 'false_alarm', null), undefined);
      break;

    case 'RESOLVED':
    case 'DORMANT':
      void safe(() => clearIncidentNotification(incident.id), undefined);
      break;

    case 'IDLE':
      // USER_FINE out of PROBE lands here: nothing was wrong after all.
      void safe(() => clearIncidentNotification(incident.id), undefined);
      useKavach.setState({ activeIncident: null });
      break;

    default:
      break;
  }

  if (event === 'PIN_DURESS') {
    // The record says what happened; the SCREEN does not. Nothing about this
    // write is observable from the outside (F-01).
    await safe(() => incidentRepo.upsert({ ...incident, duress: true }), undefined);
    await safe(() => incidentRepo.setOutcome(incident.id, 'real', 'Duress PIN entered'), undefined);
  }

  if (isTerminal(incident.state)) {
    demoStops.get(incident.id)?.();
    demoStops.delete(incident.id);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Server → store
// ═══════════════════════════════════════════════════════════════════════════════

/** Frame payloads carry only Class B/C fields; precise location never arrives here. */
interface FramePayload {
  incidentId?: unknown;
  event?: unknown;
  state?: unknown;
  actorMemberId?: unknown;
  memberId?: unknown;
  incident?: unknown;
}

const asId = (v: unknown): UUID | null =>
  typeof v === 'string' && v.length > 0 ? (v as UUID) : null;

/**
 * One inbound realtime frame.
 *
 * Everything routes through `applyEvent`, which folds with the SAME generated
 * transition function the local path uses and appends to the same log — so a
 * remote CLAIM and a local CLAIM are indistinguishable downstream, and
 * `reactToRemoteState` gets its chance to start the alarm for someone else's
 * emergency. Unknown frame types are ignored, never thrown: a server that learns
 * a new frame type must not break an old client mid-incident (ADR-018).
 */
async function handleWsFrame(frame: WsFrame): Promise<void> {
  const payload = (frame.payload ?? {}) as FramePayload;
  const incidentId = asId(payload.incidentId);

  switch (frame.type) {
    case 'incident.opened': {
      if (!incidentId) return;
      // A relative's SOS. The row may already exist from an earlier frame or an
      // SMS-derived record; upsert and let the state machine do the rest.
      const incoming = payload.incident;
      if (incoming && typeof incoming === 'object') {
        const incident = incoming as Incident;
        if (isKnownState(incident.state)) {
          putIncident(incident);
          await safe(() => incidentRepo.upsert(incident), undefined);
          await reactToRemoteState(incident);
        }
        return;
      }
      // A bare notice with no body. Do not guess a row — go and read it, but only
      // when this is an incident we have never seen, so a stream of notices for
      // one live incident cannot turn into a stream of refetches.
      if (findIncident(incidentId) === null) await pullFromServer('reconnect');
      return;
    }

    case 'incident.state_changed':
    case 'incident.claimed':
    case 'incident.released':
    case 'incident.resolved':
    case 'escalation.tier_changed': {
      if (!incidentId) return;
      const event = typeof payload.event === 'string' ? payload.event : null;
      if (event === null || !EVENT_SET.has(event)) return;
      await driveEvent(incidentId, event as IncidentEvent, {
        actorMemberId: asId(payload.actorMemberId) ?? asId(payload.memberId),
      });
      return;
    }

    case 'policy.updated': {
      // ADR-013: server-authoritative and versioned. Refetch rather than trust
      // the frame's contents — the frame is a nudge, the endpoint is the record.
      await pullPolicy();
      return;
    }

    default:
      // location.update, presence.update, device.battery and friends are LOW
      // priority projections the presence layer owns; nothing here needs them.
      return;
  }
}

/**
 * Read what the server has that we do not.
 *
 * ★ Until this existed the device was WRITE-ONLY. ★ `getFamily`, `getIncidents`
 * and `getPolicy` all had zero call sites, so a member added on another phone
 * never appeared in `members` — and therefore never appeared in
 * `smsRecipients()` and was never SMSed during an emergency.
 *
 * `getAccessLog` is deliberately NOT pulled here: `consentRepo.addLogEntry` is a
 * bare INSERT with no dedupe key, so replaying the server's log would duplicate
 * every row on every reconnect. A consent ledger that grows a copy of itself
 * each time the network flaps is worse than one that only shows this device's
 * own accesses. That needs a repo change first.
 *
 * Every leg is behind `safe()`: a dead control plane changes nothing, which is
 * the whole point of §11.1's "the device is the source of truth".
 */
async function pullFromServer(reason: 'boot' | 'reconnect'): Promise<void> {
  await pullPolicy();

  const family = await safe(() => getFamily(), null);
  if (family?.ok && family.data) {
    const { members, devices } = family.data;
    if (members.length > 0) {
      await safe(() => memberRepo.upsertMany(members), undefined);
    }
    if (devices.length > 0) {
      await safe(() => deviceRepo.upsertMany(devices), undefined);
    }
    if (members.length > 0 || devices.length > 0) {
      const ids = cachedIds;
      if (ids) {
        const [freshMembers, freshDevices] = await Promise.all([
          safe(() => memberRepo.list(ids.familyId), []),
          safe(() => deviceRepo.list(ids.familyId), []),
        ]);
        useKavach.setState((prev) => ({
          members: freshMembers ?? prev.members,
          devices: freshDevices ?? prev.devices,
          me: (freshMembers ?? prev.members).find((m) => m.id === ids.memberId) ?? prev.me,
        }));
      }
    }
  }

  // Only on a reconnect: at boot the local database is already authoritative and
  // a full incident refetch would compete with the first frame for the bridge.
  if (reason === 'reconnect') {
    const since = await safe(() => cursorRepo.get('incident'), null);
    const remote = await safe(() => getIncidents(since ?? undefined), null);
    if (remote?.ok && remote.data) {
      for (const incident of remote.data) {
        if (!isKnownState(incident.state)) continue;
        await safe(() => incidentRepo.upsert(incident), undefined);
        putIncident(incident);
      }
    }
  }
}

async function pullPolicy(): Promise<void> {
  const res = await safe(() => getPolicy(), null);
  const next = res?.ok ? res.data : null;
  if (!next) return;
  // Never downgrade: an older version arriving late must not replace a newer one
  // the family is already being escalated under.
  if ((next.version ?? 0) <= (policy.version ?? 0)) return;
  await safe(() => policyRepo.save(next), undefined);
  policy = next;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Events for incidents T0 does not own (another member's emergency)
// ═══════════════════════════════════════════════════════════════════════════════

function isOwnIncident(id: UUID): boolean {
  return currentSnapshot().incidentId === id;
}

/**
 * Route an event to whoever owns the incident.
 *
 * Our own live incident goes through T0's machine so that its timers, alarm and
 * ladder stay consistent with the state; anything else — a relative's emergency
 * arriving over the WebSocket, a historical incident being classified — folds
 * locally. Two machines for one incident would be the bug; one machine per
 * incident is the rule.
 */
async function driveEvent(
  id: UUID,
  event: IncidentEvent,
  opts: { guards?: GuardSet; actorMemberId?: UUID | null } = {},
): Promise<boolean> {
  if (isOwnIncident(id)) return sendEvent(event, opts.guards ?? {});
  const applied = await applyEvent(id, event, opts);
  return applied !== null;
}

/**
 * The local fold, for incidents T0 does not own. Same generated transition
 * function, same append-only log — the projection is always recomputable.
 * Returns null when the event does not apply, which is not an error: unknown and
 * out-of-order events are ALWAYS ignored, never thrown.
 */
async function applyEvent(
  id: UUID,
  event: IncidentEvent,
  opts: { guards?: GuardSet; actorMemberId?: UUID | null; detail?: Record<string, unknown> } = {},
): Promise<IncidentState | null> {
  const incident = findIncident(id) ?? (await safe(() => incidentRepo.get(id), null));
  if (!incident) return null;

  const to = nextState(incident.state, event, opts.guards ?? {});
  if (to === null) return null;

  const at = Date.now();
  await safe(() => incidentRepo.setState(id, to, at), undefined);
  const updated: Incident = {
    ...incident,
    state: to,
    ...(event === 'CLAIM' && opts.actorMemberId
      ? { ownerMemberId: opts.actorMemberId, firstAckAt: incident.firstAckAt ?? at }
      : {}),
    ...(isTerminal(to) ? { resolvedAt: incident.resolvedAt ?? at } : {}),
  };
  putIncident(updated);
  await appendRow(updated, event, { detail: opts.detail, at });
  await reactToRemoteState(updated);
  return to;
}

/**
 * A family member's emergency on THIS phone. Here the store does own the alarm,
 * because T0's machine is not tracking this incident at all — and a responder's
 * phone that stays silent for someone else's emergency is the product failing.
 */
async function reactToRemoteState(incident: Incident): Promise<void> {
  const subject = subjectOf(incident);
  switch (incident.state) {
    case 'ACTIVE_L1':
    case 'ACTIVE_L1_SILENT':
      startAlarm();
      await markFirstNotified(incident);
      void safe(() => notifyIncident(incident, 1, subject), undefined);
      break;
    case 'ACTIVE_L2':
      startAlarm();
      void safe(() => notifyIncident(incident, 2, subject), undefined);
      break;
    case 'ACTIVE_L3':
      startAlarm();
      void safe(() => notifyIncident(incident, 3, subject), undefined);
      break;
    case 'OWNED':
      // Siren off, banner on. Never full silence (P-030). W10-d: the banner now
      // names the responder instead of repeating "nobody has responded yet".
      stopAlarm();
      playCue('ack');
      void safe(() => notifyOwnership(incident, subject, ownerOf(incident)), undefined);
      break;
    case 'RESOLVING':
      stopAlarm();
      break;
    case 'FALSE_ALARM':
    case 'RESOLVED':
    case 'DORMANT':
    case 'IDLE':
      stopAlarm();
      void safe(() => clearIncidentNotification(incident.id), undefined);
      demoStops.get(incident.id)?.();
      demoStops.delete(incident.id);
      break;
    default:
      break;
  }
}

/** Append one row to the incident log and mirror it into the store's timeline. */
async function appendRow(
  incident: Incident,
  eventType: IncidentEvent | string,
  opts: { hlc?: string; detail?: Record<string, unknown>; at?: number } = {},
): Promise<void> {
  const at = opts.at ?? Date.now();

  // Class A detail is sealed at rest exactly as it would be on the wire; the
  // decrypted copy rides alongside in `detail` for this device's own timeline.
  //
  // ★ The only unguarded I/O call in this file used to be right here. `opts.detail`
  //   is `e.detail` straight off a T0Event — an arbitrary Record<string, unknown>
  //   that a future emit() can put anything into. A cycle, a BigInt or an Error
  //   object makes sealJson throw, appendRow rejects, handleT0Event rejects, and
  //   the timeline silently loses a row DURING A LIVE EMERGENCY. Losing the
  //   sealed copy is survivable; losing the row is not.
  let sealedPayload: string | null = null;
  if (groupSecret && opts.detail) {
    try {
      sealedPayload = sealJson(incidentContentKey(groupSecret, incident.id), opts.detail, incident.id);
    } catch {
      sealedPayload = null;
    }
  }

  const row: Omit<IncidentEventRow, 'id'> = {
    incidentId: incident.id,
    familyId: incident.familyId,
    hlc: opts.hlc ?? nowHlc(at).hex,
    eventType,
    sealedPayload,
    sourceDeviceId: useKavach.getState().deviceId || null,
    sourceTransport: 'local',
    policyVersion: incident.policyVersion,
    serverReceivedAt: null,
    localCreatedAt: at,
    detail: opts.detail,
  };
  const rowId = (await safe(() => incidentRepo.appendEvent(row), 0)) ?? 0;
  const full: IncidentEventRow = { id: rowId, ...row };
  useKavach.setState((prev) => ({
    incidentEvents: {
      ...prev.incidentEvents,
      [incident.id]: [...(prev.incidentEvents[incident.id] ?? []), full],
    },
  }));
}

async function markFirstNotified(incident: Incident): Promise<void> {
  if (incident.firstNotifiedAt !== null) return;
  const at = Date.now();
  await safe(() => incidentRepo.setFirstNotified(incident.id, at), undefined);
  putIncident({ ...incident, firstNotifiedAt: at });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Demo responders
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Feed simulated responder traffic through EXACTLY the same path a real
 * WebSocket frame would take: state events go into the state machine, receipts
 * become log rows. Nothing downstream is special-cased, which is what makes demo
 * mode a test of the real machinery rather than a puppet show.
 */
function startDemoResponders(incidentId: UUID): void {
  demoStops.get(incidentId)?.();
  const stop = simulateResponders(incidentId, (e) => {
    void handleDemoEvent(e);
  });
  demoStops.set(incidentId, stop);
}

async function handleDemoEvent(e: DemoResponderEvent): Promise<void> {
  const incident = findIncident(e.incidentId);
  if (!incident || isTerminal(incident.state)) return;

  if (!EVENT_SET.has(e.eventType)) {
    // A receipt. It changes no state and is already "sent" by definition, so it
    // is logged and nothing more.
    await appendRow(incident, e.eventType, { detail: { ...e.detail, memberId: e.memberId }, at: e.atMs });
    if (e.eventType === 'DELIVERED' && incident.firstNotifiedAt === null) {
      await markFirstNotified(incident);
    }
    return;
  }

  const event = e.eventType as IncidentEvent;
  const applied = await driveEvent(e.incidentId, event, { actorMemberId: e.memberId });
  if (applied && event === 'CLAIM' && e.memberId) {
    await safe(() => incidentRepo.setOwner(e.incidentId, e.memberId as UUID), undefined);
    await refreshIncident(e.incidentId, { ownerMemberId: e.memberId, firstAckAt: Date.now() });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sync + sweeps
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ★ W10 · 1.35 — hand the server this phone's push address, and keep it fresh. ★
 *
 * Two halves, and the second is the one that rots silently:
 *   · acquire the current FCM token and register it, every boot;
 *   · stay subscribed, because FCM rolls tokens with no symptom other than
 *     delivery quietly stopping.
 *
 * `degradation` is deliberately NOT touched here. A phone with no push token is
 * not degraded in the P-046 sense — the socket, the alarm and SMS all still
 * work. What it is, is unreachable while its app is closed, and the place that
 * fact belongs is the family's delivery matrix on the server, which is exactly
 * where an empty token puts it (KV-NOTOKEN).
 */
async function registerForRemotePush(deviceId: UUID): Promise<void> {
  if (!deviceId) return;
  const token = await safe(() => acquireDevicePushToken(), null);

  // The empty string is sent on purpose when there is no token. Staying silent
  // would leave the server addressing a handset that can no longer be reached —
  // and a delivery matrix that says "sent" for an alert nobody could receive is
  // worse than one that says "unreachable".
  await safe(() => putDevicePushToken(deviceId, token ?? ''), null);

  pushTokenUnsubscribe?.();
  pushTokenUnsubscribe = subscribePushTokenChanges((rolled) => {
    void safe(() => putDevicePushToken(deviceId, rolled), null);
  });
}

let pushTokenUnsubscribe: (() => void) | null = null;

async function sendHeartbeat(): Promise<void> {
  const s = useKavach.getState();
  if (!s.deviceId) return;
  const at = Date.now();
  await refreshBattery();
  await safe(() => deviceRepo.setHeartbeat(s.deviceId, at, cachedBatteryPct, true), undefined);
  const input: HeartbeatInput = {
    deviceId: s.deviceId,
    at,
    batteryPct: cachedBatteryPct,
    agentHealthy: true,
    degradationLevel: s.degradation,
    outboxDepth: s.outboxDepth,
  };
  await safe(() => enqueueHeartbeat(input), 0);
  await refreshOutboxDepth();
}

/**
 * ★ PRD §16.3 — the yellow line, delivered to the phone.
 *   "a family member's agent silently dead for 19 hours — is worth more than
 *    every other metric in the system combined."
 * This is the local half of it: the device that notices tells the family.
 */
async function sweepSilentAgents(): Promise<void> {
  const s = useKavach.getState();
  const silent = (await safe(() => deviceRepo.silentSince(CONFIG.agentSilentAlertMs), [])) ?? [];
  const now = Date.now();
  for (const device of silent) {
    if (device.id === s.deviceId) continue; // we are demonstrably alive
    if (device.platform === 'ha') continue; // a bridge is not a person's agent
    const member = s.members.find((m) => m.id === device.memberId);
    if (!member) continue;
    // P-066: a deliberate pause is NOT a dead agent, and conflating the two is
    // how a family learns to ignore both.
    if (s.presence[member.id]?.monitoringPaused) continue;
    const hours = device.lastHeartbeatAt === null ? 24 : (now - device.lastHeartbeatAt) / 3_600_000;
    void safe(() => notifyAgentSilent(member, hours), undefined);
  }
}

/**
 * F-02: incidents nobody ever closed. T0 arms its own quiesce timer for the live
 * incident; this catches the ones that outlived the process that opened them.
 */
async function sweepAutoQuiesce(): Promise<void> {
  const due = (await safe(() => incidentRepo.autoQuiesceDue(), [])) ?? [];
  for (const incident of due) {
    await driveEvent(incident.id, 'AUTO_QUIESCE');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Risk context
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Recompute the opaque risk integer from what this device can actually observe.
 *
 * ★ Every input assembled here stays on this device. Only the 0–4 result is ever
 *   stored on an incident or placed in an envelope (PRD §13.5).
 */
async function refreshRisk(): Promise<void> {
  const s = useKavach.getState();
  const memberId = s.me?.id ?? s.deviceId;

  let locationClass: RiskContextInputs['locationClass'] = 'known';
  if (cachedFix) {
    const fix = { lat: cachedFix.lat, lon: cachedFix.lon };
    const inside = s.geofences.filter((f) => haversineM({ lat: f.lat, lon: f.lon }, fix) <= f.radiusM);
    locationClass = inside.some((f) => /home|ghar|ઘર|घर/i.test(f.label))
      ? 'home'
      : inside.length > 0
        ? 'known'
        : 'unknown';
  }

  // Derived from the last fix's own speed field rather than a separate activity
  // API: one sensor, one answer, no disagreement to reconcile.
  const speed = cachedFix?.speed ?? 0;
  const motionState: RiskContextInputs['motionState'] =
    speed < 0.3 ? 'still' : speed < 2 ? 'walking' : speed < 4 ? 'running' : speed < 8 ? 'cycling' : 'vehicle';

  // "Peers nearby" from evidence we actually hold: family members whose last
  // known position is within 200 m. A BLE scan supersedes this when it runs.
  const blePeersNearby = cachedFix
    ? Object.values(s.presence).filter(
        (p) => p.memberId !== memberId && p.location && haversineM(p.location, cachedFix as T0Location) <= 200,
      ).length
    : 0;

  const declared = (await safe(() => t0ConfigRepo.get('declaredVulnerable'), null)) === '1';

  const inputs: RiskContextInputs = {
    hourOfDay: new Date().getHours(),
    locationClass,
    motionState,
    blePeersNearby,
    // Honest null: there is no wearable integration in this build, and imputing
    // a heart rate would be inventing evidence.
    hrDeltaPct: null,
    // The IMD alert feed is a T2 concern; the field is wired and defaults false
    // rather than being quietly dropped from the model.
    weatherAlert: false,
    userDeclaredVulnerable: declared,
  };

  // The inputs are kept beside the result so a screen can say WHY the countdown
  // is the length it is (explainRisk / riskEffects). They stay on this device:
  // only the 0–4 integer is ever put in an envelope.
  useKavach.setState({ risk: computeRisk(inputs), riskInputs: inputs });
}

/**
 * P-017: repeated false alarms from this device LENGTHEN the cancel window
 * rather than getting the trigger switched off. Counted over the most recent
 * incidents, and only consecutive ones — one bad night is not a pattern.
 */
function falsePositiveStreak(): number {
  const incidents = useKavach.getState().incidents;
  let streak = 0;
  for (const i of incidents) {
    if (i.outcome === null) continue;
    if (i.outcome === 'false_alarm') streak++;
    else break;
  }
  return streak;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Location + battery caches
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Record a position fix. Called by the location layer; also the ONLY way the
 * cached fix T0 reads ever changes.
 *
 * ★ Precise coordinates are Class A: they go to the local database and the
 *   in-memory cache, and nowhere else. What reaches the server is the ≈1 km
 *   coarse cell, and only inside an incident (§10.2).
 */
export async function noteLocationFix(fix: T0Location): Promise<void> {
  cachedFix = fix;
  const s = useKavach.getState();
  const memberId = s.me?.id ?? s.deviceId;
  if (!memberId || !s.familyId) return;
  await safe(
    () =>
      locationRepo.append({
        familyId: s.familyId,
        memberId,
        at: fix.at,
        lat: fix.lat,
        lon: fix.lon,
        accuracyM: fix.accuracyM,
        speed: fix.speed ?? null,
        heading: fix.heading ?? null,
        batteryPct: cachedBatteryPct,
        incidentId: s.activeIncident?.id ?? null,
      }),
    0,
  );
}

/** The cached fix T0 will seal into the next envelope. */
export function lastKnownFix(): T0Location | null {
  return cachedFix;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Learned route history (FR-042)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Class A and local-only, so it lives in t0_config beside the other things that
 * must never leave: a route key is a pair of place names, and the durations
 * describe when a person is where. There is no repo and no sync path by design
 * (ADR-010).
 */
const routeHistoryKey = (memberId: UUID, key: string): string => `route:${memberId}:${key}`;

async function loadRouteHistory(memberId: UUID, key: string): Promise<RouteHistory> {
  const raw = await safe(() => t0ConfigRepo.get(routeHistoryKey(memberId, key)), null);
  if (!raw) return emptyRouteHistory(key);
  try {
    const parsed = JSON.parse(raw) as RouteHistory;
    return Array.isArray(parsed.samples) ? { ...parsed, routeKey: key } : emptyRouteHistory(key);
  } catch {
    return emptyRouteHistory(key);
  }
}

async function saveRouteHistory(memberId: UUID, history: RouteHistory): Promise<void> {
  await safe(
    () => t0ConfigRepo.set(routeHistoryKey(memberId, history.routeKey), JSON.stringify(history)),
    undefined,
  );
}

async function readBatteryPct(): Promise<number> {
  try {
    const level = await Battery.getBatteryLevelAsync();
    return level < 0 ? 100 : Math.round(level * 100);
  } catch {
    return 100;
  }
}

async function refreshBattery(): Promise<void> {
  cachedBatteryPct = await readBatteryPct();
}

// ═══════════════════════════════════════════════════════════════════════════════
// Small helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Run something that touches I/O and never let it reject into a caller. */
async function safe<T>(fn: () => Promise<T> | T, fallback: T): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function secureGet(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function secureSet(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value, {
      // See loadKeyMaterial(): the emergency path must not require biometrics.
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch {
    /* a device with no keystore still runs; it re-keys on the next launch */
  }
}

function findIncident(id: UUID): Incident | null {
  return useKavach.getState().incidents.find((i) => i.id === id) ?? null;
}

function subjectOf(incident: Incident): Member | null {
  return selectMember(useKavach.getState(), incident.subjectMemberId) ?? null;
}

/**
 * The member who claimed, if this device knows them. Null is a real answer — a
 * claim can arrive naming somebody whose record has not synced here yet — and
 * `notifyOwnership` degrades to "Someone is responding" rather than guessing.
 */
function ownerOf(incident: Incident): Member | null {
  return incident.ownerMemberId
    ? (selectMember(useKavach.getState(), incident.ownerMemberId) ?? null)
    : null;
}

function putIncident(incident: Incident): void {
  useKavach.setState((prev) => ({
    incidents: prev.incidents.some((i) => i.id === incident.id)
      ? prev.incidents.map((i) => (i.id === incident.id ? incident : i))
      : [incident, ...prev.incidents],
    activeIncident:
      prev.activeIncident?.id === incident.id
        ? isActive(incident.state)
          ? incident
          : null
        : prev.activeIncident,
  }));
}

async function refreshIncident(id: UUID, patch: Partial<Incident>): Promise<void> {
  const fresh = (await safe(() => incidentRepo.get(id), null)) ?? findIncident(id);
  if (!fresh) return;
  putIncident({ ...fresh, ...patch });
}

async function refreshOutboxDepth(): Promise<void> {
  const depth = (await safe(() => outboxRepo.depth(), 0)) ?? 0;
  useKavach.setState({ outboxDepth: depth });
}

function emptyPresence(memberId: UUID): MemberPresence {
  return {
    memberId,
    lastSeenAt: null,
    batteryPct: null,
    agentHealthy: true,
    degradationLevel: lastKnownDegradation(),
    location: null,
    room: null,
    monitoringPaused: false,
  };
}

/** Rebuild a SignedEnvelope from the dispatcher's flat outbox payload. */
function toSignedEnvelope(payload: string): SignedEnvelope | null {
  try {
    const p = JSON.parse(payload) as Partial<SignedEnvelope>;
    if (typeof p.body !== 'string' || typeof p.signature !== 'string') return null;
    if (typeof p.deviceId !== 'string' || typeof p.incidentId !== 'string') return null;
    return { body: p.body, signature: p.signature, deviceId: p.deviceId, incidentId: p.incidentId };
  } catch {
    return null;
  }
}

/** The envelope's own HLC, so the outbox dedupes on exactly what the server does. */
function hlcOf(signed: SignedEnvelope): string | null {
  try {
    const body = JSON.parse(signed.body) as { hlc?: unknown };
    return typeof body.hlc === 'string' ? body.hlc : null;
  } catch {
    return null;
  }
}

function degradationReason(level: DegradationLevel): string {
  switch (level) {
    case DegradationLevel.ZERO_INFRA:
      return t('panic.offline');
    case DegradationLevel.PEER_ONLY:
      // ★ This used to say "Family devices nearby can still relay." It is not
      //   true in this build: the BLE leg is SEND-ONLY. `t0/dispatcher.legBle`
      //   advertises, but `t0/native.ts` exposes no scan, nothing decodes an
      //   inbound SMS, and FLAG_RELAY is never set — so no peer ever picks the
      //   advert up and forwards it. Telling someone their last remaining
      //   transport works when it does not is the one lie this product cannot
      //   afford. Say what is actually true instead.
      return 'No network. The alarm sounds on this phone, and messages go out as soon as signal returns.';
    case DegradationLevel.SMS_ONLY:
      return 'Data is down. Emergencies will go by SMS.';
    default:
      return 'Connection limited.';
  }
}

/** Exposed for the ladder timeline UI: what happens next, and when (PRD §12.1). */
export function ladderSteps(trigger: TriggerType) {
  return ladderFor(policy, trigger);
}

/** The escalation policy currently in force. Read-only — devices never write it. */
export function currentPolicy(): EscalationPolicy {
  return policy;
}

/** Membership test used when mirroring a state that arrived from elsewhere. */
export function isKnownState(s: string): s is IncidentState {
  return (INCIDENT_STATES as readonly string[]).includes(s);
}
