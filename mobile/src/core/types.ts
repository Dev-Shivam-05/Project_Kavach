/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * KAVACH — CORE DOMAIN TYPES
 * The single shared vocabulary. Every module imports from here.
 * Mirrors the PostgreSQL schema in docs/02-System-Architecture.md §2.8.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import type { IncidentState, IncidentEvent } from '../t0/stateMachine.generated';

export type { IncidentState, IncidentEvent };

// ── Identity ──────────────────────────────────────────────────────────────────
export type UUID = string;

export type MemberRole =
  | 'guardian'
  | 'adult'
  | 'minor'
  | 'elder'
  | 'relative'
  | 'neighbour'
  | 'staff'
  | 'guest';

export type Locale = 'en' | 'hi' | 'gu';

export interface Member {
  id: UUID;
  familyId: UUID;
  displayName: string;
  /** ★ ASCII only, ≤8 chars, UNIQUE per family (finding F-18). Used in the SMS payload. */
  asciiShortName: string;
  role: MemberRole;
  dob: string | null;
  locale: Locale;
  identityPubkey: string; // base64
  phoneE164: string | null;
  membershipExpiresAt: number | null; // epoch ms; null = permanent
  createdAt: number;
  /** Denormalised for the family glance view. */
  avatarColor: string;
}

export type DevicePlatform = 'android' | 'ios' | 'node' | 'fob' | 'ha';

export interface Device {
  id: UUID;
  familyId: UUID;
  memberId: UUID;
  platform: DevicePlatform;
  model: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  signingPubkey: string;
  isDeviceOwner: boolean;
  imei: string | null;
  lastHeartbeatAt: number | null;
  batteryPct: number | null;
  batteryTempC: number | null;
  batteryHealth: string | null;
  agentHealthy: boolean;
  diagnostics: DiagnosticsReport;
}

// ── Incidents ─────────────────────────────────────────────────────────────────
export type TriggerType =
  | 'MANUAL'
  | 'FALL'
  | 'CRASH'
  | 'NO_MOTION'
  | 'DEADMAN'
  | 'GEOFENCE'
  | 'SENSOR_HOME'
  | 'DEVICE_SILENCED'
  | 'BLE_FOB'
  | 'VOICE_PHRASE'
  | 'RELAY'
  | 'DRILL';

export type TransportKind = 'ws' | 'http' | 'http_direct' | 'sms' | 'ble_relay' | 'push' | 'local';

export type IncidentOutcome = 'real' | 'false_alarm' | 'drill' | 'unknown';

export interface Incident {
  id: UUID; // UUIDv7, CLIENT-generated (P-053)
  familyId: UUID;
  subjectMemberId: UUID;
  state: IncidentState; // materialised projection — recomputable via fold()
  trigger: TriggerType;
  policyVersion: number;
  duress: boolean;
  isDrill: boolean;
  /** ≈1 km H3 cell. The ONLY plaintext location the server holds (§10.2). */
  coarseH3R7: string | null;
  ownerMemberId: UUID | null;
  openedAt: number; // t0
  firstNotifiedAt: number | null; // t3
  firstAckAt: number | null; // t4
  resolvedAt: number | null;
  outcome: IncidentOutcome | null;
  outcomeNote: string | null;
  /** F-09: base36 prefix used to reconcile SMS-originated incidents. */
  inc8: string;
  syntheticFromSms: boolean;
  mergedIntoId: UUID | null;
  autoQuiesceAt: number | null;
  confidencePct: number;
  riskContext: RiskLevel;
  /** Decrypted client-side only. Never leaves the device in plaintext. */
  sealed: IncidentSealedPayload | null;
}

/** Class A. Encrypted with the Incident Content Key; the server sees ciphertext. */
export interface IncidentSealedPayload {
  lat: number;
  lon: number;
  accuracyM: number;
  altitude?: number;
  speed?: number;
  heading?: number;
  batteryPct: number;
  note?: string;
  medical?: MedicalCard;
  blackBoxRef?: string;
}

export interface IncidentEventRow {
  id: number;
  incidentId: UUID;
  familyId: UUID;
  hlc: string; // 12-byte HLC, hex
  eventType: IncidentEvent | string;
  sealedPayload: string | null; // base64 ciphertext
  sourceDeviceId: UUID | null;
  sourceTransport: TransportKind;
  policyVersion: number;
  serverReceivedAt: number | null;
  localCreatedAt: number;
  /** Rendered, already-decrypted detail for the timeline. */
  detail?: Record<string, unknown>;
}

// ── Escalation ────────────────────────────────────────────────────────────────
export interface EscalationPolicy {
  version: number;
  scenarios: Record<TriggerType, ScenarioPolicy>;
}

export interface ScenarioPolicy {
  /** Cancel-window seconds at risk context 0. Shortened as risk rises. */
  cancelWindowS: number;
  l1AudienceRoles: MemberRole[];
  l2AfterS: number;
  l3AfterS: number;
  repeatL1AfterS: number;
  smsTierAfterS: number;
  /** Child geofence breach never reaches neighbours (PRD §7.5). */
  allowNeighbours: boolean;
  audioByDefault: boolean;
  loudCancel: boolean;
  label: string;
}

// ── Risk & degradation ────────────────────────────────────────────────────────
export type RiskLevel = 0 | 1 | 2 | 3 | 4;

/** §4.4 degradation ladder. Higher = more capability. */
export enum DegradationLevel {
  ZERO_INFRA = 0,
  PEER_ONLY = 1,
  SMS_ONLY = 2,
  PUSH_ONLY = 3,
  HTTP_ONLY = 4,
  FULL = 5,
}

export const DEGRADATION_LABELS: Record<DegradationLevel, string> = {
  [DegradationLevel.ZERO_INFRA]: 'Offline — alarm only',
  [DegradationLevel.PEER_ONLY]: 'Peer only',
  [DegradationLevel.SMS_ONLY]: 'SMS only',
  [DegradationLevel.PUSH_ONLY]: 'Push only',
  [DegradationLevel.HTTP_ONLY]: 'Limited connection',
  [DegradationLevel.FULL]: 'Fully connected',
};

export interface RiskContextInputs {
  hourOfDay: number;
  locationClass: 'home' | 'known' | 'unknown';
  motionState: 'still' | 'walking' | 'running' | 'vehicle' | 'cycling';
  blePeersNearby: number;
  hrDeltaPct: number | null;
  weatherAlert: boolean;
  userDeclaredVulnerable: boolean;
}

// ── Consent (the anti-stalkerware machinery) ──────────────────────────────────
export type ConsentScope =
  | 'live_location'
  | 'history'
  | 'vitals'
  | 'audio'
  | 'documents'
  | 'screen_time';

export type ConsentPurpose = 'safety' | 'incident_only' | 'routine' | 'care';

export interface ConsentGrant {
  id: UUID;
  familyId: UUID;
  grantorMemberId: UUID;
  granteeMemberId: UUID;
  scope: ConsentScope;
  purpose: ConsentPurpose;
  grantedAt: number;
  /** ★ NEVER null. There is no permanent grant (PRD P-008). */
  expiresAt: number;
  revokedAt: number | null;
  grantedVia: 'self' | 'guardian_policy' | 'autonomy_ramp';
  /** F-14: Layer-1 revocation is instant; Layer-2 (key ratchet) may lag. */
  keyRotationPending: boolean;
}

export interface AccessLogEntry {
  id: number;
  familyId: UUID;
  grantId: UUID | null;
  accessorMemberId: UUID;
  subjectMemberId: UUID;
  what: string;
  context: string; // incident id, or 'routine'
  at: number;
  surfacedToSubject: boolean;
  /** F-10: marks a Class A′ disclosure (precise location sent unencrypted by SMS). */
  degradedPlaintext?: boolean;
}

// ── Medical / vault ───────────────────────────────────────────────────────────
export interface MedicalCard {
  bloodGroup: string;
  allergies: string[]; // top 3
  medications: string[]; // top 3
  conditions: string[];
  iceContacts: { name: string; phone: string }[]; // 2
  organDonor: boolean;
  notes: string;
}

export interface VaultObject {
  id: UUID;
  familyId: UUID;
  title: string;
  kind: 'document' | 'medical' | 'identity' | 'insurance' | 'credential';
  sizeBytes: number;
  createdAt: number;
  /** Requires Shamir 2-of-3 guardian reconstruction to open. */
  quorumRequired: boolean;
  ciphertextRef: string;
}

// ── Journeys ──────────────────────────────────────────────────────────────────
export interface Journey {
  id: UUID;
  familyId: UUID;
  memberId: UUID;
  label: string;
  startedAt: number;
  etaAt: number | null;
  arrivedAt: number | null;
  originName: string;
  destName: string;
  /** Class A — never synced (ADR-010). */
  corridorPoints: { lat: number; lon: number }[];
  state: 'active' | 'arrived' | 'overdue' | 'cancelled';
  checkInIntervalS: number | null;
  lastCheckInAt: number | null;
}

// ── Geofence (Class A — evaluated on-device, NEVER synced) ─────────────────────
export interface Geofence {
  id: UUID;
  label: string;
  lat: number;
  lon: number;
  radiusM: number;
  notifyOnEnter: boolean;
  notifyOnExit: boolean;
  dwellS: number | null;
  memberIds: UUID[];
}

// ── Diagnostics (P-031) ───────────────────────────────────────────────────────
export interface DiagnosticsReport {
  batteryOptimisationExempt: boolean;
  notBackgroundRestricted: boolean;
  exactAlarmsPermitted: boolean;
  notificationsEnabled: boolean;
  dndBypassGranted: boolean;
  bgLocationGranted: boolean;
  autoRevokeDisabled: boolean;
  /** F-17: is the emergency signing key reachable before first unlock? */
  t0SigningAvailablePredawn: boolean;
  nativeT0Present: boolean;
  /**
   * Is the T0 incident machine actually running on this phone?
   *
   * A bootstrap stage that failed early — a corrupt database, a full disk — used
   * to skip `startT0` and every line after it, and the app still came up saying
   * "All clear" with a panic button that did nothing at all. Nine permission
   * checks could not see it, because nothing asked.
   */
  t0Running: boolean;
  /** Is the on-device store openable, at the right schema, and not corrupt? */
  dbHealthy: boolean;
  lastCheckedAt: number;
}

export type DiagnosticKey = Exclude<keyof DiagnosticsReport, 'lastCheckedAt'>;

// ── Family health / presence ──────────────────────────────────────────────────
export interface MemberPresence {
  memberId: UUID;
  lastSeenAt: number | null;
  batteryPct: number | null;
  agentHealthy: boolean;
  degradationLevel: DegradationLevel;
  /** Only present when a live grant permits it. */
  location: { lat: number; lon: number; accuracyM: number; at: number } | null;
  /** Room-level indoor position, when beacons are deployed (P-028). */
  room: string | null;
  /** P-066: honest, not alarming. */
  monitoringPaused: boolean;
}

// ── Notification ladder ───────────────────────────────────────────────────────
export interface LadderStep {
  atS: number;
  tier: 1 | 2 | 3;
  label: string;
  channels: string[];
}

// ── Drills ────────────────────────────────────────────────────────────────────
export interface DrillRun {
  id: UUID;
  familyId: UUID;
  kind: 'canary' | 'quarterly' | 'annual_full';
  notifiesFamily: boolean;
  audienceDeviceIds: UUID[];
  startedAt: number;
  scorecard: DrillScorecard | null;
}

export interface DrillScorecard {
  perMember: {
    memberId: UUID;
    received: boolean;
    latencyMs: number | null;
    acknowledged: boolean;
    failureReason?: string;
  }[];
  firstClaimMemberId: UUID | null;
  firstClaimMs: number | null;
  clocks: FourClocks;
}

/** PRD §1.6 — formalised in docs/01 §1.6. */
export interface FourClocks {
  t0TriggerAt: number;
  t1ConfirmedAt: number | null;
  t2FirstTransmitAt: number | null;
  t3FirstNotifiedAt: number | null;
  t4FirstAckAt: number | null;
}

// ── Screen time (P-026) ───────────────────────────────────────────────────────
export interface AppUsage {
  packageName: string;
  label: string;
  minutesToday: number;
  limitMinutes: number | null;
  suspended: boolean;
}

// ── Outbox (offline-first sync) ───────────────────────────────────────────────
export interface OutboxItem {
  id: number;
  kind: 'incident_open' | 'incident_event' | 'checkin' | 'heartbeat' | 'consent' | 'generic';
  payload: string;
  incidentId: UUID | null;
  createdAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  /** Per-transport attempt counters, so a failing leg doesn't block the others. */
  transportAttempts: Partial<Record<TransportKind, number>>;
  delivered: boolean;
}

// ── Home Assistant bridge ─────────────────────────────────────────────────────
export interface HaSafetyEvent {
  id: UUID;
  entity: string;
  kind: 'smoke' | 'gas' | 'water' | 'door' | 'motion' | 'lock' | 'plug';
  severity: 'info' | 'warn' | 'critical';
  at: number;
  suggestedActions: string[];
}
