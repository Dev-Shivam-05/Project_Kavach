/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ★ THE DEMO ENGINE ★
 *
 * With no backend reachable the app must still run: incidents open locally, the
 * state machine runs, the alarm sounds, the ladder advances on real timers, and
 * simulated family members claim. This file supplies the family and the
 * responders. It is what makes the build testable in Expo Go with zero infra.
 *
 * It is NOT a mock layer. Everything downstream of it — the state machine, the
 * envelope, the crypto, the outbox, the timers — is the real implementation
 * running against real data. That is exactly the L0 floor the PRD demands
 * ("Nothing works. Still helps.", docs/02 §2.7.1): the device is the source of
 * truth and the server is a replica (§11.1). Demo mode is that property, tested.
 *
 * The family is the PRD's own: a household in Navsari, Gujarat (constraint C2),
 * around 20.9463 N 72.9520 E.
 *
 * ★ ONE DEVICE IS DELIBERATELY SILENT FOR 19 HOURS ★
 * Mummy's phone last reported 19 hours ago with battery optimisation NOT exempt —
 * a textbook OEM background kill. PRD §16.3 on that single yellow line:
 *   "a family member's agent silently dead for 19 hours — is worth more than
 *    every other metric in the system combined."
 * If the Dashboard cannot show that, none of the rest matters, so the seed makes
 * certain there is always one to show. The quarterly drill four hours ago is
 * what caught it, and her scorecard row carries the reason.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { CONFIG } from '../core/config';
import { DEFAULT_POLICY_VERSION } from '../core/policy';
import { bytesToBase64, bytesToHex, coarseCell, inc8 } from '../core/ids';
import {
  DegradationLevel,
  type AccessLogEntry,
  type AppUsage,
  type ConsentGrant,
  type Device,
  type DiagnosticsReport,
  type DrillRun,
  type Geofence,
  type HaSafetyEvent,
  type Incident,
  type IncidentEventRow,
  type Journey,
  type MedicalCard,
  type Member,
  type MemberPresence,
  type TransportKind,
  type UUID,
  type VaultObject,
} from '../core/types';
import type { IncidentEvent } from '../t0/stateMachine.generated';

const enc = new TextEncoder();

/** Demo mode is the default (CONFIG.demoMode) precisely so the app is never dead. */
export function isDemo(): boolean {
  return CONFIG.demoMode;
}

// ── Stable identities ─────────────────────────────────────────────────────────
// Fixed UUIDv7-shaped literals. Seeding must be IDEMPOTENT: a second boot has to
// recognise the same family rather than clone it (P-053 — ids are client-owned).

export const demoFamilyId: UUID = '0192d4a0-0000-7000-8000-00000000fa11';

export const DEMO_IDS = {
  family: demoFamilyId,
  members: {
    papa: '0192d4a0-0001-7000-8000-000000000001',
    mummy: '0192d4a0-0001-7000-8000-000000000002',
    rohan: '0192d4a0-0001-7000-8000-000000000003',
    priya: '0192d4a0-0001-7000-8000-000000000004',
    dada: '0192d4a0-0001-7000-8000-000000000005',
    aarav: '0192d4a0-0001-7000-8000-000000000006',
  },
  devices: {
    papa: '0192d4a0-0002-7000-8000-000000000101',
    mummy: '0192d4a0-0002-7000-8000-000000000102',
    rohan: '0192d4a0-0002-7000-8000-000000000103',
    priya: '0192d4a0-0002-7000-8000-000000000104',
    dada: '0192d4a0-0002-7000-8000-000000000105',
    aarav: '0192d4a0-0002-7000-8000-000000000106',
    cctvNode: '0192d4a0-0002-7000-8000-000000000107',
    intercomNode: '0192d4a0-0002-7000-8000-000000000108',
    haBridge: '0192d4a0-0002-7000-8000-000000000109',
  },
  incidents: {
    crash: '0192d4a0-0003-7000-8000-000000000201',
    fall: '0192d4a0-0003-7000-8000-000000000202',
    drill: '0192d4a0-0003-7000-8000-000000000203',
  },
  geofences: {
    home: '0192d4a0-0004-7000-8000-000000000301',
    school: '0192d4a0-0004-7000-8000-000000000302',
    temple: '0192d4a0-0004-7000-8000-000000000303',
    office: '0192d4a0-0004-7000-8000-000000000304',
  },
} as const;

/** ★ "Me" in the demo is Rohan — the PRD's responder persona (§3.3, §13.6). */
export const demoMeMemberId: UUID = DEMO_IDS.members.rohan;
export const demoMeDeviceId: UUID = DEMO_IDS.devices.rohan;

/**
 * Demo PINs, seeded into secure storage on first boot so the cancel and duress
 * paths are actually exercisable without an onboarding flow. They are exported
 * so a settings screen can SHOW them — a PIN nobody knows is a cancel window
 * nobody can close, and an untestable duress path is worse than none at all.
 *
 * Real enrolment overwrites both. These values exist only when demoMode is on.
 */
export const DEMO_CANCEL_PIN = '1234';
export const DEMO_DURESS_PIN = '9119';

// ── Navsari geography ─────────────────────────────────────────────────────────
const HOME = { lat: 20.9463, lon: 72.952 };
const SCHOOL = { lat: 20.9531, lon: 72.9402 };
const OFFICE = { lat: 20.9377, lon: 72.9611 };
const TEMPLE = { lat: 20.9489, lon: 72.9553 };
/** The Navsari–Bilimora road, where the seeded crash happened (PRD §1.1). */
const CRASH_SITE = { lat: 20.9075, lon: 72.9711 };

/**
 * Real Ed25519 public keys derived from fixed labels, so the demo family has
 * keys of the correct shape and length rather than filler strings — anything
 * that fingerprints or renders a key gets a truthful value. The secret halves do
 * not exist anywhere, which is correct: no demo member can sign.
 */
function demoPubkey(label: string): string {
  return bytesToBase64(ed25519.getPublicKey(sha256(enc.encode(`kavach-demo-key:${label}`))));
}

// ── Time helpers ──────────────────────────────────────────────────────────────
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A wall-clock instant `daysAgo` days back, pinned to hh:mm local. */
function atClock(now: number, daysAgo: number, hh: number, mm: number): number {
  const d = new Date(now - daysAgo * DAY);
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

/**
 * A well-formed HLC for seeded history, byte-identical in layout to core/ids'
 * `nowHlc()`: 12 bytes of 48-bit physical ‖ 16-bit logical ‖ 32-bit node id.
 * Seeded rows are sorted and merged by the same comparator as live ones, so they
 * cannot carry a decorative hex blob — the timeline would order wrongly.
 */
const DEMO_HLC_NODE = [0xde, 0x30, 0x00, 0x01];

function demoHlc(atMs: number, logical: number): string {
  const b = new Uint8Array(12);
  b[0] = (atMs / 2 ** 40) & 0xff;
  b[1] = (atMs / 2 ** 32) & 0xff;
  b[2] = (atMs / 2 ** 24) & 0xff;
  b[3] = (atMs / 2 ** 16) & 0xff;
  b[4] = (atMs / 2 ** 8) & 0xff;
  b[5] = atMs & 0xff;
  b[6] = (logical >> 8) & 0xff;
  b[7] = logical & 0xff;
  b.set(DEMO_HLC_NODE, 8);
  return bytesToHex(b);
}

function diagnostics(over: Partial<DiagnosticsReport>, checkedAt: number): DiagnosticsReport {
  return {
    // Demo mode runs the real T0 machine and the real database, so these two are
    // true for the same reason the others are: they describe what is actually so.
    t0Running: true,
    dbHealthy: true,
    batteryOptimisationExempt: true,
    notBackgroundRestricted: true,
    exactAlarmsPermitted: true,
    notificationsEnabled: true,
    dndBypassGranted: true,
    bgLocationGranted: true,
    autoRevokeDisabled: true,
    t0SigningAvailablePredawn: true,
    // Honest for a managed Expo build: the native T0 module is a bare-workflow
    // artefact and simply is not present here (P-031 reports facts, not hopes).
    nativeT0Present: false,
    lastCheckedAt: checkedAt,
    ...over,
  };
}

// ── The seed ──────────────────────────────────────────────────────────────────

export interface DemoSeed {
  familyId: UUID;
  meMemberId: UUID;
  meDeviceId: UUID;
  members: Member[];
  devices: Device[];
  incidents: Incident[];
  incidentEvents: Record<UUID, IncidentEventRow[]>;
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
  diagnostics: DiagnosticsReport;
}

function seedMembers(now: number): Member[] {
  const M = DEMO_IDS.members;
  const base = { familyId: demoFamilyId, createdAt: now - 400 * DAY };
  return [
    {
      ...base,
      id: M.papa,
      displayName: 'Kirit Desai',
      asciiShortName: 'Papa',
      role: 'guardian',
      dob: '1968-03-14',
      locale: 'gu',
      identityPubkey: demoPubkey('papa'),
      phoneE164: '+919824100001',
      membershipExpiresAt: null,
      avatarColor: '#2F6FED',
    },
    {
      ...base,
      id: M.mummy,
      displayName: 'Bhavna Desai',
      asciiShortName: 'Mummy',
      role: 'adult',
      dob: '1972-07-02',
      locale: 'gu',
      identityPubkey: demoPubkey('mummy'),
      phoneE164: '+919824100002',
      membershipExpiresAt: null,
      avatarColor: '#C2410C',
    },
    {
      ...base,
      id: M.rohan,
      displayName: 'Rohan Desai',
      asciiShortName: 'Rohan',
      role: 'adult',
      dob: '1997-11-23',
      locale: 'en',
      identityPubkey: demoPubkey('rohan'),
      phoneE164: '+919824100003',
      membershipExpiresAt: null,
      avatarColor: '#047857',
    },
    {
      ...base,
      id: M.priya,
      displayName: 'Priya Desai',
      asciiShortName: 'Priya',
      role: 'adult',
      dob: '2000-05-09',
      locale: 'hi',
      identityPubkey: demoPubkey('priya'),
      phoneE164: '+919824100004',
      membershipExpiresAt: null,
      avatarColor: '#7C3AED',
    },
    {
      ...base,
      id: M.dada,
      displayName: 'Manubhai Desai',
      asciiShortName: 'Dada',
      role: 'elder',
      dob: '1945-01-26',
      locale: 'gu',
      identityPubkey: demoPubkey('dada'),
      phoneE164: '+919824100005',
      membershipExpiresAt: null,
      avatarColor: '#B45309',
    },
    {
      ...base,
      id: M.aarav,
      displayName: 'Aarav Desai',
      asciiShortName: 'Aarav',
      role: 'minor',
      dob: '2012-09-18',
      locale: 'en',
      identityPubkey: demoPubkey('aarav'),
      phoneE164: '+919824100006',
      membershipExpiresAt: null,
      avatarColor: '#0E7490',
    },
  ];
}

function seedDevices(now: number): Device[] {
  const M = DEMO_IDS.members;
  const D = DEMO_IDS.devices;
  const common = { familyId: demoFamilyId, isDeviceOwner: false, imei: null };
  return [
    {
      ...common,
      id: D.papa,
      memberId: M.papa,
      platform: 'android',
      model: 'Galaxy M34',
      manufacturer: 'Samsung',
      osVersion: '14',
      signingPubkey: demoPubkey('dev-papa'),
      lastHeartbeatAt: now - 3 * MIN,
      batteryPct: 68,
      batteryTempC: 31,
      batteryHealth: 'good',
      agentHealthy: true,
      diagnostics: diagnostics({}, now - 2 * DAY),
    },
    {
      // ★★★ THE YELLOW LINE (PRD §16.3). Silent 19 h. The diagnostics row below
      // is the cause, not a symptom: battery optimisation was never exempted, so
      // One UI's background manager killed the agent and nobody found out until
      // the drill. This is the single most important row in the seed.
      ...common,
      id: D.mummy,
      memberId: M.mummy,
      platform: 'android',
      model: 'Redmi Note 12',
      manufacturer: 'Xiaomi',
      osVersion: '13',
      signingPubkey: demoPubkey('dev-mummy'),
      lastHeartbeatAt: now - 19 * HOUR,
      batteryPct: 41,
      batteryTempC: 29,
      batteryHealth: 'good',
      agentHealthy: false,
      diagnostics: diagnostics(
        { batteryOptimisationExempt: false, notBackgroundRestricted: false, autoRevokeDisabled: false },
        now - 19 * HOUR,
      ),
    },
    {
      ...common,
      id: D.rohan,
      memberId: M.rohan,
      platform: 'android',
      model: 'Pixel 8a',
      manufacturer: 'Google',
      osVersion: '15',
      signingPubkey: demoPubkey('dev-rohan'),
      isDeviceOwner: true,
      lastHeartbeatAt: now - 40_000,
      batteryPct: 82,
      batteryTempC: 33,
      batteryHealth: 'good',
      agentHealthy: true,
      diagnostics: diagnostics({ dndBypassGranted: false, autoRevokeDisabled: false }, now - 2 * HOUR),
    },
    {
      ...common,
      id: D.priya,
      memberId: M.priya,
      platform: 'android',
      model: 'Galaxy A54',
      manufacturer: 'Samsung',
      osVersion: '14',
      signingPubkey: demoPubkey('dev-priya'),
      lastHeartbeatAt: now - 12 * MIN,
      batteryPct: 23,
      batteryTempC: 36,
      batteryHealth: 'good',
      agentHealthy: true,
      diagnostics: diagnostics({ bgLocationGranted: false }, now - 5 * DAY),
    },
    {
      ...common,
      id: D.dada,
      memberId: M.dada,
      platform: 'android',
      model: 'Galaxy A15',
      manufacturer: 'Samsung',
      osVersion: '14',
      signingPubkey: demoPubkey('dev-dada'),
      lastHeartbeatAt: now - 6 * MIN,
      batteryPct: 55,
      batteryTempC: 30,
      batteryHealth: 'good',
      agentHealthy: true,
      diagnostics: diagnostics({}, now - 6 * DAY),
    },
    {
      ...common,
      id: D.aarav,
      memberId: M.aarav,
      platform: 'android',
      model: 'Redmi 13C',
      manufacturer: 'Xiaomi',
      osVersion: '14',
      signingPubkey: demoPubkey('dev-aarav'),
      lastHeartbeatAt: now - 90_000,
      batteryPct: 12,
      batteryTempC: 38,
      batteryHealth: 'good',
      agentHealthy: true,
      diagnostics: diagnostics({ exactAlarmsPermitted: false }, now - 3 * DAY),
    },
    {
      // Repurposed old phones as fixed nodes (PRD §14). Mains-powered, so their
      // battery temperature and health are the numbers that matter (§16.3).
      ...common,
      id: D.cctvNode,
      memberId: M.papa,
      platform: 'node',
      model: 'Redmi 9 (CCTV node)',
      manufacturer: 'Xiaomi',
      osVersion: '11',
      signingPubkey: demoPubkey('dev-cctv'),
      lastHeartbeatAt: now - 60_000,
      batteryPct: 100,
      batteryTempC: 38,
      batteryHealth: 'good',
      agentHealthy: true,
      diagnostics: diagnostics({}, now - DAY),
    },
    {
      ...common,
      id: D.intercomNode,
      memberId: M.papa,
      platform: 'node',
      model: 'Moto G5 (intercom node)',
      manufacturer: 'Motorola',
      osVersion: '9',
      signingPubkey: demoPubkey('dev-intercom'),
      lastHeartbeatAt: now - 2 * MIN,
      batteryPct: 100,
      batteryTempC: 35,
      batteryHealth: 'fair',
      agentHealthy: true,
      diagnostics: diagnostics({}, now - DAY),
    },
    {
      ...common,
      id: D.haBridge,
      memberId: M.papa,
      platform: 'ha',
      model: 'Home Assistant bridge',
      manufacturer: 'self-hosted',
      osVersion: '2026.6',
      signingPubkey: demoPubkey('dev-ha'),
      lastHeartbeatAt: now - 2 * MIN,
      batteryPct: null,
      batteryTempC: null,
      batteryHealth: null,
      agentHealthy: true,
      diagnostics: diagnostics({}, now - DAY),
    },
  ];
}

interface RowSpec {
  offsetMs: number;
  eventType: IncidentEvent | string;
  transport: TransportKind;
  deviceId: UUID | null;
  detail: Record<string, unknown>;
}

function buildRows(incidentId: UUID, openedAt: number, specs: RowSpec[], idBase: number): IncidentEventRow[] {
  return specs.map((s, i) => ({
    id: idBase + i,
    incidentId,
    familyId: demoFamilyId,
    hlc: demoHlc(openedAt + s.offsetMs, i),
    eventType: s.eventType,
    // Seeded history is authored locally, so there is no ciphertext to carry;
    // `detail` is the already-decrypted view a real row would render after
    // openJson(). Live rows written by the store do carry sealedPayload.
    sealedPayload: null,
    sourceDeviceId: s.deviceId,
    sourceTransport: s.transport,
    policyVersion: DEFAULT_POLICY_VERSION,
    serverReceivedAt: openedAt + s.offsetMs + 90,
    localCreatedAt: openedAt + s.offsetMs,
    detail: s.detail,
  }));
}

/**
 * The seeded crash. A full, causally ordered event log so the timeline, the
 * after-action report and the Four Clocks histograms all have real content —
 * including the SMS leg that fired because Mummy's phone never acknowledged.
 */
function seedCrashIncident(now: number): { incident: Incident; rows: IncidentEventRow[] } {
  const M = DEMO_IDS.members;
  const D = DEMO_IDS.devices;
  const id = DEMO_IDS.incidents.crash;
  const openedAt = atClock(now, 3, 21, 44);

  const specs: RowSpec[] = [
    { offsetMs: 0, eventType: 'SENSOR_ANOMALY', transport: 'local', deviceId: D.priya, detail: { peakG: 6.2, source: 'accelerometer', gyroDegS: 410 } },
    { offsetMs: 260, eventType: 'CONFIDENCE', transport: 'local', deviceId: D.priya, detail: { confidencePct: 88, guard: 'confidenceHigh', fusion: 'impact+no-motion+speed-drop' } },
    { offsetMs: 410, eventType: 'TRANSMIT', transport: 'ws', deviceId: D.priya, detail: { clock: 't2', latencyMs: 142, legs: ['ws', 'http', 'http_direct', 'ble_relay'] } },
    { offsetMs: 20_000, eventType: 'CANCEL_WINDOW_EXPIRED', transport: 'local', deviceId: D.priya, detail: { cancelWindowS: 20, loudCancel: true } },
    { offsetMs: 20_600, eventType: 'DELIVERED', transport: 'push', deviceId: D.rohan, detail: { clock: 't3', memberId: M.rohan, tier: 1 } },
    { offsetMs: 21_100, eventType: 'DELIVERED', transport: 'ws', deviceId: D.papa, detail: { memberId: M.papa, tier: 1 } },
    { offsetMs: 34_000, eventType: 'CLAIM', transport: 'ws', deviceId: D.rohan, detail: { clock: 't4', memberId: M.rohan, distanceKm: 3.2 } },
    { offsetMs: 36_000, eventType: 'DELIVERY_FAILED', transport: 'push', deviceId: D.mummy, detail: { memberId: M.mummy, reason: 'no_heartbeat', fallback: 'sms' } },
    { offsetMs: 36_400, eventType: 'DELIVERED', transport: 'sms', deviceId: D.mummy, detail: { memberId: M.mummy, degradedPlaintext: true, chars: 148 } },
    { offsetMs: 47_000, eventType: 'LOCATION_UPDATE', transport: 'ws', deviceId: D.priya, detail: { accuracyM: 9, moved: false } },
    { offsetMs: 372_000, eventType: 'ON_SCENE', transport: 'ws', deviceId: D.rohan, detail: { memberId: M.rohan } },
    { offsetMs: 543_000, eventType: 'TWO_PARTY_CONFIRM', transport: 'ws', deviceId: D.rohan, detail: { confirmedBy: [M.rohan, M.papa] } },
    { offsetMs: 660_000, eventType: 'CLASSIFIED', transport: 'local', deviceId: D.rohan, detail: { outcome: 'real', note: 'Skidded on wet road. Grazes only. Bike recovered.' } },
  ];

  const incident: Incident = {
    id,
    familyId: demoFamilyId,
    subjectMemberId: M.priya,
    state: 'RESOLVED',
    trigger: 'CRASH',
    policyVersion: DEFAULT_POLICY_VERSION,
    duress: false,
    isDrill: false,
    coarseH3R7: coarseCell(CRASH_SITE.lat, CRASH_SITE.lon),
    ownerMemberId: M.rohan,
    openedAt,
    firstNotifiedAt: openedAt + 20_600,
    firstAckAt: openedAt + 34_000,
    resolvedAt: openedAt + 543_000,
    outcome: 'real',
    outcomeNote: 'Skidded on wet road near Bilimora. Grazes only. Bike recovered.',
    inc8: inc8(id),
    syntheticFromSms: false,
    mergedIntoId: null,
    autoQuiesceAt: null,
    confidencePct: 88,
    riskContext: 3,
    sealed: {
      lat: CRASH_SITE.lat,
      lon: CRASH_SITE.lon,
      accuracyM: 9,
      speed: 0,
      batteryPct: 44,
      note: 'Impact 6.2 g, no motion for 12 s afterwards.',
    },
  };

  return { incident, rows: buildRows(id, openedAt, specs, 1000) };
}

/** A false alarm. The False Positive Ledger (Dashboard 3) is a P0 metric — it
 *  needs real entries or the tuning loop it exists to drive never runs. */
function seedFallIncident(now: number): { incident: Incident; rows: IncidentEventRow[] } {
  const M = DEMO_IDS.members;
  const D = DEMO_IDS.devices;
  const id = DEMO_IDS.incidents.fall;
  const openedAt = atClock(now, 9, 6, 20);

  const specs: RowSpec[] = [
    { offsetMs: 0, eventType: 'SENSOR_ANOMALY', transport: 'local', deviceId: D.dada, detail: { peakG: 3.4, source: 'accelerometer' } },
    { offsetMs: 300, eventType: 'CONFIDENCE', transport: 'local', deviceId: D.dada, detail: { confidencePct: 71, guard: 'confidenceHigh' } },
    { offsetMs: 6_900, eventType: 'PIN_CORRECT', transport: 'local', deviceId: D.dada, detail: { withinCancelWindow: true, elapsedS: 6.9 } },
    { offsetMs: 8_000, eventType: 'CLASSIFIED', transport: 'local', deviceId: D.dada, detail: { outcome: 'false_alarm', note: 'Phone fell off the charging shelf.' } },
  ];

  const incident: Incident = {
    id,
    familyId: demoFamilyId,
    subjectMemberId: M.dada,
    state: 'FALSE_ALARM',
    trigger: 'FALL',
    policyVersion: DEFAULT_POLICY_VERSION,
    duress: false,
    isDrill: false,
    coarseH3R7: coarseCell(HOME.lat, HOME.lon),
    ownerMemberId: null,
    openedAt,
    firstNotifiedAt: null,
    firstAckAt: null,
    resolvedAt: openedAt + 6_900,
    outcome: 'false_alarm',
    outcomeNote: 'Phone fell off the charging shelf. Threshold raised for this device.',
    inc8: inc8(id),
    syntheticFromSms: false,
    mergedIntoId: null,
    autoQuiesceAt: null,
    confidencePct: 71,
    riskContext: 0,
    sealed: { lat: HOME.lat, lon: HOME.lon, accuracyM: 14, batteryPct: 61 },
  };

  return { incident, rows: buildRows(id, openedAt, specs, 2000) };
}

/** The quarterly drill that caught Mummy's dead agent. Four hours ago. */
function seedDrillIncident(now: number): { incident: Incident; rows: IncidentEventRow[]; startedAt: number } {
  const M = DEMO_IDS.members;
  const D = DEMO_IDS.devices;
  const id = DEMO_IDS.incidents.drill;
  const openedAt = now - 4 * HOUR;

  const specs: RowSpec[] = [
    { offsetMs: 0, eventType: 'MANUAL_TRIGGER', transport: 'local', deviceId: D.rohan, detail: { drill: true, kind: 'quarterly' } },
    { offsetMs: 10_000, eventType: 'CANCEL_WINDOW_EXPIRED', transport: 'local', deviceId: D.rohan, detail: { cancelWindowS: 10 } },
    { offsetMs: 10_800, eventType: 'DELIVERED', transport: 'push', deviceId: D.papa, detail: { memberId: M.papa, latencyMs: 800 } },
    { offsetMs: 11_400, eventType: 'DELIVERED', transport: 'ws', deviceId: D.priya, detail: { memberId: M.priya, latencyMs: 1400 } },
    { offsetMs: 12_900, eventType: 'DELIVERED', transport: 'push', deviceId: D.dada, detail: { memberId: M.dada, latencyMs: 2900 } },
    { offsetMs: 13_600, eventType: 'DELIVERED', transport: 'push', deviceId: D.aarav, detail: { memberId: M.aarav, latencyMs: 3600 } },
    {
      offsetMs: 30_000,
      eventType: 'DELIVERY_FAILED',
      transport: 'push',
      deviceId: D.mummy,
      detail: { memberId: M.mummy, reason: 'agent silent 15 h at drill time — battery optimisation not exempt' },
    },
    { offsetMs: 41_000, eventType: 'CLAIM', transport: 'ws', deviceId: D.papa, detail: { memberId: M.papa } },
    { offsetMs: 96_000, eventType: 'ON_SCENE', transport: 'ws', deviceId: D.papa, detail: { memberId: M.papa } },
    { offsetMs: 120_000, eventType: 'TWO_PARTY_CONFIRM', transport: 'ws', deviceId: D.papa, detail: { confirmedBy: [M.papa, M.rohan] } },
  ];

  const incident: Incident = {
    id,
    familyId: demoFamilyId,
    subjectMemberId: M.rohan,
    state: 'RESOLVED',
    trigger: 'DRILL',
    policyVersion: DEFAULT_POLICY_VERSION,
    duress: false,
    isDrill: true,
    coarseH3R7: coarseCell(HOME.lat, HOME.lon),
    ownerMemberId: M.papa,
    openedAt,
    firstNotifiedAt: openedAt + 10_800,
    firstAckAt: openedAt + 41_000,
    resolvedAt: openedAt + 120_000,
    outcome: 'drill',
    outcomeNote: '5 of 6 agents responded. Mummy’s phone did not receive the drill.',
    inc8: inc8(id),
    syntheticFromSms: false,
    mergedIntoId: null,
    autoQuiesceAt: null,
    confidencePct: 100,
    riskContext: 0,
    sealed: { lat: HOME.lat, lon: HOME.lon, accuracyM: 8, batteryPct: 84 },
  };

  return { incident, rows: buildRows(id, openedAt, specs, 3000), startedAt: openedAt };
}

function seedPresence(now: number): Record<UUID, MemberPresence> {
  const M = DEMO_IDS.members;
  return {
    [M.papa]: {
      memberId: M.papa,
      lastSeenAt: now - 3 * MIN,
      batteryPct: 68,
      agentHealthy: true,
      degradationLevel: DegradationLevel.FULL,
      location: null, // No grant from Papa to me. Absence here is the feature.
      room: null,
      monitoringPaused: false,
    },
    [M.mummy]: {
      // Silent 19 h. We report the LAST KNOWN degradation level, not a guess —
      // claiming FULL for a device we have not heard from would be a lie.
      memberId: M.mummy,
      lastSeenAt: now - 19 * HOUR,
      batteryPct: 41,
      agentHealthy: false,
      degradationLevel: DegradationLevel.ZERO_INFRA,
      location: null,
      room: null,
      monitoringPaused: false,
    },
    [M.rohan]: {
      memberId: M.rohan,
      lastSeenAt: now - 40_000,
      batteryPct: 82,
      agentHealthy: true,
      degradationLevel: DegradationLevel.FULL,
      location: { lat: HOME.lat, lon: HOME.lon, accuracyM: 8, at: now - 40_000 },
      room: null,
      monitoringPaused: false,
    },
    [M.priya]: {
      // P-066: she turned monitoring off after the crash. That is her right, and
      // it must be VISIBLE rather than silently indistinguishable from failure.
      memberId: M.priya,
      lastSeenAt: now - 12 * MIN,
      batteryPct: 23,
      agentHealthy: true,
      degradationLevel: DegradationLevel.SMS_ONLY,
      location: null,
      room: null,
      monitoringPaused: true,
    },
    [M.dada]: {
      memberId: M.dada,
      lastSeenAt: now - 6 * MIN,
      batteryPct: 55,
      agentHealthy: true,
      degradationLevel: DegradationLevel.FULL,
      location: { lat: HOME.lat, lon: HOME.lon, accuracyM: 22, at: now - 6 * MIN },
      // P-028: room-level indoor position beats a GPS pin on the roof.
      room: 'Prayer room',
      monitoringPaused: false,
    },
    [M.aarav]: {
      memberId: M.aarav,
      lastSeenAt: now - 90_000,
      batteryPct: 12,
      agentHealthy: true,
      degradationLevel: DegradationLevel.FULL,
      location: { lat: 20.9502, lon: 72.9455, accuracyM: 15, at: now - 90_000 },
      room: null,
      monitoringPaused: false,
    },
  };
}

function seedGrants(now: number): ConsentGrant[] {
  const M = DEMO_IDS.members;
  const base = { familyId: demoFamilyId, keyRotationPending: false };
  return [
    {
      ...base,
      id: '0192d4a0-0005-7000-8000-000000000401',
      grantorMemberId: M.aarav,
      granteeMemberId: M.rohan,
      scope: 'live_location',
      purpose: 'safety',
      grantedAt: now - 30 * DAY,
      expiresAt: now + 14 * DAY,
      revokedAt: null,
      grantedVia: 'guardian_policy',
    },
    {
      ...base,
      id: '0192d4a0-0005-7000-8000-000000000402',
      grantorMemberId: M.dada,
      granteeMemberId: M.rohan,
      scope: 'vitals',
      purpose: 'care',
      grantedAt: now - 90 * DAY,
      expiresAt: now + 60 * DAY,
      revokedAt: null,
      grantedVia: 'self',
    },
    {
      // ★ F-14 made visible. Layer 1 revoked instantly three days ago; Layer 2 —
      // the location stream key ratchet — is still pending because Priya's phone
      // has not been online since. The ledger must say so and not pretend.
      ...base,
      id: '0192d4a0-0005-7000-8000-000000000403',
      grantorMemberId: M.priya,
      granteeMemberId: M.rohan,
      scope: 'live_location',
      purpose: 'incident_only',
      grantedAt: now - 3 * DAY - 2 * HOUR,
      expiresAt: now + 3 * HOUR,
      revokedAt: now - 2 * DAY,
      grantedVia: 'self',
      keyRotationPending: true,
    },
    {
      ...base,
      id: '0192d4a0-0005-7000-8000-000000000404',
      grantorMemberId: M.rohan,
      granteeMemberId: M.papa,
      scope: 'history',
      purpose: 'safety',
      grantedAt: now - 12 * DAY,
      expiresAt: now + 2 * DAY,
      revokedAt: null,
      grantedVia: 'self',
    },
    {
      ...base,
      id: '0192d4a0-0005-7000-8000-000000000405',
      grantorMemberId: M.aarav,
      granteeMemberId: M.papa,
      scope: 'screen_time',
      purpose: 'care',
      grantedAt: now - 200 * DAY,
      // The autonomy ramp is data: this one expires on his 16th birthday.
      expiresAt: now + 300 * DAY,
      revokedAt: null,
      grantedVia: 'autonomy_ramp',
    },
  ];
}

function seedAccessLog(now: number): AccessLogEntry[] {
  const M = DEMO_IDS.members;
  return [
    {
      id: 1,
      familyId: demoFamilyId,
      grantId: '0192d4a0-0005-7000-8000-000000000404',
      accessorMemberId: M.papa,
      subjectMemberId: M.rohan,
      what: 'history',
      context: 'routine',
      at: now - 2 * DAY,
      surfacedToSubject: true,
    },
    {
      id: 2,
      familyId: demoFamilyId,
      grantId: '0192d4a0-0005-7000-8000-000000000401',
      accessorMemberId: M.rohan,
      subjectMemberId: M.aarav,
      what: 'live_location',
      context: 'routine',
      at: now - 20 * MIN,
      surfacedToSubject: true,
    },
    {
      // ★ F-10 / Class A′. Her precise coordinates went out over SMS in the
      // clear because that was the only leg that worked. The disclosure is
      // logged and surfaced to HER — that is the price of using the transport.
      id: 3,
      familyId: demoFamilyId,
      grantId: null,
      accessorMemberId: M.rohan,
      subjectMemberId: M.priya,
      what: 'precise_location',
      context: DEMO_IDS.incidents.crash,
      at: atClock(now, 3, 21, 44) + 36_400,
      surfacedToSubject: true,
      degradedPlaintext: true,
    },
    {
      id: 4,
      familyId: demoFamilyId,
      grantId: '0192d4a0-0005-7000-8000-000000000402',
      accessorMemberId: M.rohan,
      subjectMemberId: M.dada,
      what: 'vitals',
      context: 'routine',
      at: now - 5 * HOUR,
      surfacedToSubject: true,
    },
  ];
}

function seedJourneys(now: number): Journey[] {
  const M = DEMO_IDS.members;
  return [
    {
      id: '0192d4a0-0006-7000-8000-000000000501',
      familyId: demoFamilyId,
      memberId: M.aarav,
      label: 'School to home',
      startedAt: now - 14 * MIN,
      etaAt: now + 9 * MIN,
      arrivedAt: null,
      originName: 'Aarav school',
      destName: 'Home',
      // Class A. Never synced (ADR-010) — this polyline is the family's routine.
      corridorPoints: [
        SCHOOL,
        { lat: 20.9518, lon: 72.9431 },
        { lat: 20.9502, lon: 72.9455 },
        { lat: 20.9481, lon: 72.949 },
        HOME,
      ],
      state: 'active',
      checkInIntervalS: null,
      lastCheckInAt: null,
    },
    {
      id: '0192d4a0-0006-7000-8000-000000000502',
      familyId: demoFamilyId,
      memberId: M.priya,
      label: 'Bilimora to home',
      startedAt: atClock(now, 3, 21, 20),
      etaAt: atClock(now, 3, 22, 5),
      arrivedAt: atClock(now, 3, 22, 39),
      originName: 'Bilimora office',
      destName: 'Home',
      corridorPoints: [
        CRASH_SITE,
        { lat: 20.9201, lon: 72.9648 },
        { lat: 20.9318, lon: 72.9585 },
        OFFICE,
        HOME,
      ],
      state: 'arrived',
      checkInIntervalS: 1800,
      lastCheckInAt: atClock(now, 3, 21, 40),
    },
  ];
}

function seedGeofences(): Geofence[] {
  const M = DEMO_IDS.members;
  const G = DEMO_IDS.geofences;
  return [
    {
      id: G.home,
      label: 'Home',
      lat: HOME.lat,
      lon: HOME.lon,
      radiusM: 150,
      notifyOnEnter: true,
      notifyOnExit: false,
      dwellS: null,
      memberIds: [M.aarav, M.dada],
    },
    {
      id: G.school,
      label: 'Aarav’s school',
      lat: SCHOOL.lat,
      lon: SCHOOL.lon,
      radiusM: 200,
      notifyOnEnter: true,
      notifyOnExit: true,
      dwellS: null,
      memberIds: [M.aarav],
    },
    {
      // Dwell, not exit: if Dada is still at the temple after an hour something
      // may have happened. GEOFENCE policy is the slowest and quietest we have.
      id: G.temple,
      label: 'Temple',
      lat: TEMPLE.lat,
      lon: TEMPLE.lon,
      radiusM: 120,
      notifyOnEnter: false,
      notifyOnExit: false,
      dwellS: 3600,
      memberIds: [M.dada],
    },
    {
      id: G.office,
      label: 'Office',
      lat: OFFICE.lat,
      lon: OFFICE.lon,
      radiusM: 180,
      notifyOnEnter: false,
      notifyOnExit: true,
      dwellS: null,
      memberIds: [M.rohan],
    },
  ];
}

function seedVault(now: number): VaultObject[] {
  const base = { familyId: demoFamilyId };
  return [
    {
      ...base,
      id: '0192d4a0-0007-7000-8000-000000000601',
      title: 'Aadhaar & PAN (all members)',
      kind: 'identity',
      sizeBytes: 2_412_544,
      createdAt: now - 300 * DAY,
      quorumRequired: true,
      ciphertextRef: 'vault/01-identity.bin',
    },
    {
      ...base,
      id: '0192d4a0-0007-7000-8000-000000000602',
      title: 'Health insurance policy',
      kind: 'insurance',
      sizeBytes: 1_148_000,
      createdAt: now - 210 * DAY,
      quorumRequired: false,
      ciphertextRef: 'vault/02-insurance.bin',
    },
    {
      ...base,
      id: '0192d4a0-0007-7000-8000-000000000603',
      title: 'Dada — cardiology reports',
      kind: 'medical',
      sizeBytes: 8_612_000,
      createdAt: now - 45 * DAY,
      quorumRequired: true,
      ciphertextRef: 'vault/03-cardiology.bin',
    },
    {
      ...base,
      id: '0192d4a0-0007-7000-8000-000000000604',
      title: 'House papers',
      kind: 'document',
      sizeBytes: 5_204_000,
      createdAt: now - 380 * DAY,
      quorumRequired: true,
      ciphertextRef: 'vault/04-house.bin',
    },
  ];
}

function seedUsage(): AppUsage[] {
  return [
    { packageName: 'com.google.android.youtube', label: 'YouTube', minutesToday: 142, limitMinutes: 120, suspended: true },
    { packageName: 'com.instagram.android', label: 'Instagram', minutesToday: 63, limitMinutes: 60, suspended: true },
    { packageName: 'com.whatsapp', label: 'WhatsApp', minutesToday: 47, limitMinutes: null, suspended: false },
    { packageName: 'com.supercell.clashofclans', label: 'Clash of Clans', minutesToday: 38, limitMinutes: 45, suspended: false },
    { packageName: 'com.android.chrome', label: 'Chrome', minutesToday: 21, limitMinutes: null, suspended: false },
  ];
}

function seedMedical(): MedicalCard {
  return {
    bloodGroup: 'B+',
    allergies: ['Sulfa drugs', 'Dust mites'],
    medications: ['Salbutamol inhaler'],
    conditions: ['Asthma'],
    iceContacts: [
      { name: 'Kirit Desai (Papa)', phone: '+919824100001' },
      { name: 'Priya Desai', phone: '+919824100004' },
    ],
    organDonor: true,
    notes: 'Inhaler is in the left pocket of the riding jacket.',
  };
}

function seedDrills(now: number, drillStartedAt: number): DrillRun[] {
  const M = DEMO_IDS.members;
  const D = DEMO_IDS.devices;
  return [
    {
      id: '0192d4a0-0008-7000-8000-000000000701',
      familyId: demoFamilyId,
      kind: 'quarterly',
      notifiesFamily: true,
      audienceDeviceIds: [D.papa, D.mummy, D.rohan, D.priya, D.dada, D.aarav],
      startedAt: drillStartedAt,
      scorecard: {
        perMember: [
          { memberId: M.papa, received: true, latencyMs: 800, acknowledged: true },
          {
            // ★ The drill is what found it. A drill that cannot fail is theatre.
            memberId: M.mummy,
            received: false,
            latencyMs: null,
            acknowledged: false,
            failureReason: 'Agent silent 15 h — battery optimisation not exempt (OEM background kill)',
          },
          { memberId: M.rohan, received: true, latencyMs: 610, acknowledged: true },
          { memberId: M.priya, received: true, latencyMs: 1400, acknowledged: false },
          { memberId: M.dada, received: true, latencyMs: 2900, acknowledged: true },
          { memberId: M.aarav, received: true, latencyMs: 3600, acknowledged: false },
        ],
        firstClaimMemberId: M.papa,
        firstClaimMs: 41_000,
        clocks: {
          t0TriggerAt: drillStartedAt,
          t1ConfirmedAt: drillStartedAt + 10_000,
          t2FirstTransmitAt: drillStartedAt + 10_138,
          t3FirstNotifiedAt: drillStartedAt + 10_800,
          t4FirstAckAt: drillStartedAt + 41_000,
        },
      },
    },
    {
      id: '0192d4a0-0008-7000-8000-000000000702',
      familyId: demoFamilyId,
      kind: 'canary',
      // F-02: the canary must never notify the family or it freezes deploys.
      notifiesFamily: false,
      audienceDeviceIds: [DEMO_IDS.devices.cctvNode],
      startedAt: now - 4 * MIN,
      scorecard: {
        perMember: [],
        firstClaimMemberId: null,
        firstClaimMs: null,
        clocks: {
          t0TriggerAt: now - 4 * MIN,
          t1ConfirmedAt: now - 4 * MIN,
          t2FirstTransmitAt: now - 4 * MIN + 118,
          t3FirstNotifiedAt: now - 4 * MIN + 2_800,
          t4FirstAckAt: null,
        },
      },
    },
  ];
}

function seedHaEvents(now: number): HaSafetyEvent[] {
  return [
    {
      id: '0192d4a0-0009-7000-8000-000000000801',
      entity: 'binary_sensor.kitchen_smoke',
      kind: 'smoke',
      severity: 'info',
      at: now - 2 * DAY,
      suggestedActions: ['Weekly self-test passed'],
    },
    {
      id: '0192d4a0-0009-7000-8000-000000000802',
      entity: 'binary_sensor.bathroom_leak',
      kind: 'water',
      severity: 'warn',
      at: now - 8 * HOUR,
      suggestedActions: ['Close the main valve', 'Check the geyser inlet', 'Ask Papa to look'],
    },
    {
      id: '0192d4a0-0009-7000-8000-000000000803',
      entity: 'lock.front_door',
      kind: 'lock',
      severity: 'info',
      at: now - 14 * HOUR,
      suggestedActions: ['Front door was unlocked at 22:10'],
    },
  ];
}

/**
 * Build the whole demo family. Pure and deterministic given `now` — no I/O, no
 * randomness, stable ids — so a second call after a reinstall reproduces exactly
 * the same family and the store can seed idempotently.
 */
export function seedDemoData(now: number = Date.now()): DemoSeed {
  const crash = seedCrashIncident(now);
  const fall = seedFallIncident(now);
  const drill = seedDrillIncident(now);

  return {
    familyId: demoFamilyId,
    meMemberId: demoMeMemberId,
    meDeviceId: demoMeDeviceId,
    members: seedMembers(now),
    devices: seedDevices(now),
    // Newest first — the incident list renders in this order.
    incidents: [drill.incident, crash.incident, fall.incident],
    incidentEvents: {
      [crash.incident.id]: crash.rows,
      [fall.incident.id]: fall.rows,
      [drill.incident.id]: drill.rows,
    },
    presence: seedPresence(now),
    grants: seedGrants(now),
    accessLog: seedAccessLog(now),
    journeys: seedJourneys(now),
    geofences: seedGeofences(),
    vault: seedVault(now),
    usage: seedUsage(),
    medical: seedMedical(),
    drills: seedDrills(now, drill.startedAt),
    haEvents: seedHaEvents(now),
    diagnostics: diagnostics({ dndBypassGranted: false, autoRevokeDisabled: false }, now - 2 * HOUR),
  };
}

// ── Simulated responders ──────────────────────────────────────────────────────

/**
 * What the simulation emits. `eventType` is either a real state-machine event —
 * which the store folds through nextState() exactly as it would a WebSocket
 * frame — or a receipt kind that carries no state change.
 */
export interface DemoResponderEvent {
  incidentId: UUID;
  eventType: IncidentEvent | 'DELIVERED' | 'DELIVERY_FAILED' | 'TRANSMIT' | 'LOCATION_UPDATE';
  memberId: UUID | null;
  deviceId: UUID | null;
  transport: TransportKind;
  detail: Record<string, unknown>;
  atMs: number;
}

export interface SimulateOptions {
  /** Who picks up. Defaults to Papa — the guardian is usually awake first. */
  claimMemberId?: UUID;
  claimAfterMs?: number;
  onSceneAfterMs?: number;
  /**
   * Duress incidents are silent to the SUBJECT, never to the family.
   *
   * ★ Deliberately does not alter a single step below. ACTIVE_L1_SILENT differs
   * only in what the subject's own phone renders; the responder timeline, the
   * receipts and the ladder are byte-for-byte identical to ACTIVE_L1. That IS
   * the constant-time duress property (F-01) — a demo that made duress look
   * different here would be simulating the bug the design exists to prevent.
   */
  silent?: boolean;
}

interface Step {
  delay: number;
  make: (now: number) => DemoResponderEvent;
}

/**
 * Drive a live demo incident: delivery receipts land in the first two seconds, a
 * responder CLAIMs after a realistic pause, and ON_SCENE follows.
 *
 * Deliberately stops at RESOLVING. TWO_PARTY_CONFIRM stays a human act — the
 * whole point of two-party resolution is that a machine cannot close an incident
 * on the family's behalf.
 *
 * The NO_ACK escalation is scheduled at the real L2 boundary even though the
 * claim normally beats it. If it does fire, the store's fold() ignores it from
 * OWNED (there is no OWNED→NO_ACK transition), which is the ladder and the state
 * machine agreeing without either one special-casing the other.
 *
 * Returns a cancel function. The store MUST call it when the incident leaves an
 * active state, or a cancelled incident will keep getting claimed.
 */
export function simulateResponders(
  incidentId: UUID,
  onEvent: (e: DemoResponderEvent) => void,
  options: SimulateOptions = {},
): () => void {
  const M = DEMO_IDS.members;
  const D = DEMO_IDS.devices;
  const claimBy = options.claimMemberId ?? M.papa;
  const claimAfterMs = options.claimAfterMs ?? 9_200;
  const onSceneAfterMs = options.onSceneAfterMs ?? 174_000;

  const ev = (
    eventType: DemoResponderEvent['eventType'],
    memberId: UUID | null,
    deviceId: UUID | null,
    transport: TransportKind,
    detail: Record<string, unknown>,
  ) => (now: number): DemoResponderEvent => ({ incidentId, eventType, memberId, deviceId, transport, detail, atMs: now });

  const steps: Step[] = [
    { delay: 120, make: ev('TRANSMIT', null, D.rohan, 'ws', { clock: 't2', legs: ['ws', 'http', 'http_direct', 'ble_relay'] }) },
    { delay: 420, make: ev('DELIVERED', M.papa, D.papa, 'push', { clock: 't3', tier: 1 }) },
    { delay: 780, make: ev('DELIVERED', M.priya, D.priya, 'ws', { tier: 1 }) },
    { delay: 1_350, make: ev('DELIVERED', M.dada, D.dada, 'push', { tier: 1 }) },
    { delay: 1_900, make: ev('DELIVERED', M.aarav, D.aarav, 'push', { tier: 1 }) },
    // Mummy's phone is dead. The family finds out here, in the receipt line,
    // rather than after the emergency — which is the entire reliability thesis.
    {
      delay: CONFIG.ackWaitBeforeSmsMs,
      make: ev('DELIVERY_FAILED', M.mummy, D.mummy, 'push', {
        reason: 'agent silent 19 h',
        fallback: 'sms',
      }),
    },
    { delay: CONFIG.ackWaitBeforeSmsMs + 400, make: ev('DELIVERED', M.mummy, D.mummy, 'sms', { degradedPlaintext: true }) },
    { delay: claimAfterMs, make: ev('CLAIM', claimBy, D.papa, 'ws', { distanceKm: 1.1 }) },
    { delay: claimAfterMs + 17_000, make: ev('LOCATION_UPDATE', claimBy, D.papa, 'ws', { responderMoving: true }) },
    { delay: 90_000, make: ev('NO_ACK', null, null, 'local', { ladderTier: 2, reason: 'L2 boundary reached' }) },
    { delay: onSceneAfterMs, make: ev('ON_SCENE', claimBy, D.papa, 'ws', {}) },
  ];

  const timers = steps.map((s) =>
    setTimeout(() => {
      try {
        onEvent(s.make(Date.now()));
      } catch {
        // A throw inside a demo timer must never take the app down mid-incident.
      }
    }, s.delay),
  );

  // `options.silent` is intentionally not consulted — see SimulateOptions.silent.

  return () => {
    for (const t of timers) clearTimeout(t);
  };
}
