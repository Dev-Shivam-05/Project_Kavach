/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * REPOSITORIES — the only place SQL and the domain model meet
 *
 * Rules that hold for every method in this file:
 *   1. Parameterised. Always. No value is ever concatenated into SQL. Where a
 *      variable-length IN (…) list is needed, only the `?` placeholders are
 *      generated (from an array length we control); the values are still bound.
 *   2. Async, and they open the database on demand via requireDb(). A repository
 *      call made before bootstrap() finishes works instead of throwing into the
 *      UI (hard rule 8).
 *   3. Writes are local-first and unconditional. §2.10.4 — the device is the
 *      source of truth; nothing here waits on the network.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { requireDb } from './index';
import { DEFAULT_POLICY, DEFAULT_POLICY_VERSION } from '../core/policy';
import { TERMINAL_STATES } from '../t0/stateMachine.generated';
import type { IncidentState } from '../t0/stateMachine.generated';
import {
  DegradationLevel,
  type AccessLogEntry,
  type AppUsage,
  type ConsentGrant,
  type ConsentPurpose,
  type ConsentScope,
  type Device,
  type DevicePlatform,
  type DiagnosticsReport,
  type DrillRun,
  type DrillScorecard,
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
  type MemberRole,
  type OutboxItem,
  type RiskLevel,
  type TransportKind,
  type TriggerType,
  type UUID,
  type VaultObject,
} from '../core/types';

// ── shared helpers ────────────────────────────────────────────────────────────

const bit = (v: boolean | null | undefined): number => (v ? 1 : 0);
const bool = (v: number | null | undefined): boolean => v === 1;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw) as T;
    return v === null || v === undefined ? fallback : v;
  } catch {
    // A corrupt cell must never take down a screen. Degrade to the default and
    // keep going — the row is a cache of something the server can resend.
    return fallback;
  }
}

/** `?, ?, ?` for a list whose LENGTH we control. Values are still bound. */
const placeholders = (n: number): string => new Array(n).fill('?').join(', ');

const DEFAULT_DIAGNOSTICS: DiagnosticsReport = {
  t0Running: false,
  dbHealthy: false,
  batteryOptimisationExempt: false,
  notBackgroundRestricted: false,
  exactAlarmsPermitted: false,
  notificationsEnabled: false,
  dndBypassGranted: false,
  bgLocationGranted: false,
  autoRevokeDisabled: false,
  t0SigningAvailablePredawn: false,
  nativeT0Present: false,
  lastCheckedAt: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// INCIDENTS
// ═══════════════════════════════════════════════════════════════════════════════

interface IncidentRow {
  id: string;
  family_id: string;
  subject_member_id: string;
  state: string;
  trigger_type: string;
  policy_version: number;
  duress: number;
  is_drill: number;
  coarse_h3_r7: string | null;
  owner_member_id: string | null;
  opened_at: number;
  first_notified_at: number | null;
  first_ack_at: number | null;
  resolved_at: number | null;
  outcome: string | null;
  outcome_note: string | null;
  inc8: string;
  synthetic_from_sms: number;
  merged_into_id: string | null;
  auto_quiesce_at: number | null;
  confidence_pct: number;
  risk_context: number;
  sealed_json: string | null;
}

function toIncident(r: IncidentRow): Incident {
  return {
    id: r.id,
    familyId: r.family_id,
    subjectMemberId: r.subject_member_id,
    state: r.state as IncidentState,
    trigger: r.trigger_type as TriggerType,
    policyVersion: r.policy_version,
    duress: bool(r.duress),
    isDrill: bool(r.is_drill),
    coarseH3R7: r.coarse_h3_r7,
    ownerMemberId: r.owner_member_id,
    openedAt: r.opened_at,
    firstNotifiedAt: r.first_notified_at,
    firstAckAt: r.first_ack_at,
    resolvedAt: r.resolved_at,
    outcome: (r.outcome as IncidentOutcome | null) ?? null,
    outcomeNote: r.outcome_note,
    inc8: r.inc8,
    syntheticFromSms: bool(r.synthetic_from_sms),
    mergedIntoId: r.merged_into_id,
    autoQuiesceAt: r.auto_quiesce_at,
    confidencePct: r.confidence_pct,
    riskContext: (r.risk_context as RiskLevel) ?? 0,
    sealed: parseJson<IncidentSealedPayload | null>(r.sealed_json, null),
  };
}

interface EventRow {
  id: number;
  incident_id: string;
  family_id: string;
  hlc: string;
  event_type: string;
  sealed_payload: string | null;
  source_device_id: string | null;
  source_transport: string;
  policy_version: number;
  server_received_at: number | null;
  local_created_at: number;
  detail_json: string | null;
}

function toEvent(r: EventRow): IncidentEventRow {
  const detail = parseJson<Record<string, unknown> | null>(r.detail_json, null);
  const row: IncidentEventRow = {
    id: r.id,
    incidentId: r.incident_id,
    familyId: r.family_id,
    hlc: r.hlc,
    eventType: r.event_type,
    sealedPayload: r.sealed_payload,
    sourceDeviceId: r.source_device_id,
    sourceTransport: r.source_transport as TransportKind,
    policyVersion: r.policy_version,
    serverReceivedAt: r.server_received_at,
    localCreatedAt: r.local_created_at,
  };
  if (detail) row.detail = detail;
  return row;
}

const INCIDENT_COLUMNS = `id, family_id, subject_member_id, state, trigger_type, policy_version,
  duress, is_drill, coarse_h3_r7, owner_member_id, opened_at, first_notified_at, first_ack_at,
  resolved_at, outcome, outcome_note, inc8, synthetic_from_sms, merged_into_id, auto_quiesce_at,
  confidence_pct, risk_context, sealed_json`;

export const incidentRepo = {
  /**
   * Upsert the materialised projection. `state` here is a cache of fold(events);
   * the event log in incident_event remains the authority (§2.5.5).
   */
  async upsert(i: Incident): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO incident (${INCIDENT_COLUMNS}, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         policy_version = excluded.policy_version,
         duress = excluded.duress,
         coarse_h3_r7 = excluded.coarse_h3_r7,
         owner_member_id = excluded.owner_member_id,
         first_notified_at = COALESCE(incident.first_notified_at, excluded.first_notified_at),
         first_ack_at = COALESCE(incident.first_ack_at, excluded.first_ack_at),
         resolved_at = excluded.resolved_at,
         outcome = excluded.outcome,
         outcome_note = excluded.outcome_note,
         merged_into_id = excluded.merged_into_id,
         auto_quiesce_at = excluded.auto_quiesce_at,
         confidence_pct = excluded.confidence_pct,
         risk_context = excluded.risk_context,
         sealed_json = COALESCE(excluded.sealed_json, incident.sealed_json),
         updated_at = excluded.updated_at`,
      [
        i.id,
        i.familyId,
        i.subjectMemberId,
        i.state,
        i.trigger,
        i.policyVersion,
        bit(i.duress),
        bit(i.isDrill),
        i.coarseH3R7,
        i.ownerMemberId,
        i.openedAt,
        i.firstNotifiedAt,
        i.firstAckAt,
        i.resolvedAt,
        i.outcome,
        i.outcomeNote,
        i.inc8,
        bit(i.syntheticFromSms),
        i.mergedIntoId,
        i.autoQuiesceAt,
        Math.round(i.confidencePct),
        i.riskContext,
        i.sealed ? JSON.stringify(i.sealed) : null,
        Date.now(),
      ],
    );
  },

  async get(id: UUID): Promise<Incident | null> {
    const db = await requireDb();
    const row = await db.getFirstAsync<IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS} FROM incident WHERE id = ?`,
      [id],
    );
    return row ? toIncident(row) : null;
  },

  /** F-09: resolve the 8-char base36 prefix carried by an inbound SMS. */
  async findByInc8(familyId: UUID, prefix: string): Promise<Incident[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS} FROM incident
       WHERE family_id = ? AND inc8 = ? AND merged_into_id IS NULL
       ORDER BY opened_at DESC`,
      [familyId, prefix],
    );
    return rows.map(toIncident);
  },

  async list(limit = 100, familyId?: UUID): Promise<Incident[]> {
    const db = await requireDb();
    const rows = familyId
      ? await db.getAllAsync<IncidentRow>(
          `SELECT ${INCIDENT_COLUMNS} FROM incident
           WHERE family_id = ? ORDER BY opened_at DESC LIMIT ?`,
          [familyId, limit],
        )
      : await db.getAllAsync<IncidentRow>(
          `SELECT ${INCIDENT_COLUMNS} FROM incident ORDER BY opened_at DESC LIMIT ?`,
          [limit],
        );
    return rows.map(toIncident);
  },

  /**
   * F-02: everything that is NOT terminal and NOT merged away. Drills are included
   * here because the UI must show them; the deploy-freeze query on the server is
   * the one that excludes them.
   */
  async listActive(): Promise<Incident[]> {
    const db = await requireDb();
    const terminals = [...TERMINAL_STATES];
    const rows = await db.getAllAsync<IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS} FROM incident
       WHERE state NOT IN (${placeholders(terminals.length)})
         AND merged_into_id IS NULL
       ORDER BY opened_at DESC`,
      terminals,
    );
    return rows.map(toIncident);
  },

  /**
   * Append to the immutable log. INSERT OR IGNORE, never REPLACE: the append-only
   * trigger fires on the implicit DELETE that REPLACE performs, and the unique
   * (incident_id, hlc) index is what makes the same event arriving over five
   * transports collapse to one row (P-053).
   */
  async appendEvent(e: Omit<IncidentEventRow, 'id'>): Promise<number> {
    const db = await requireDb();
    const res = await db.runAsync(
      `INSERT OR IGNORE INTO incident_event
         (incident_id, family_id, hlc, event_type, sealed_payload, source_device_id,
          source_transport, policy_version, server_received_at, local_created_at, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.incidentId,
        e.familyId,
        e.hlc,
        e.eventType,
        e.sealedPayload,
        e.sourceDeviceId,
        e.sourceTransport,
        e.policyVersion,
        e.serverReceivedAt,
        e.localCreatedAt,
        e.detail ? JSON.stringify(e.detail) : null,
      ],
    );
    if (res.changes > 0) return res.lastInsertRowId;
    const existing = await db.getFirstAsync<{ id: number }>(
      'SELECT id FROM incident_event WHERE incident_id = ? AND hlc = ?',
      [e.incidentId, e.hlc],
    );
    return existing?.id ?? 0;
  },

  /** HLC order, never wall-clock order (§2.10.5). */
  async events(incidentId: UUID): Promise<IncidentEventRow[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<EventRow>(
      `SELECT id, incident_id, family_id, hlc, event_type, sealed_payload, source_device_id,
              source_transport, policy_version, server_received_at, local_created_at, detail_json
       FROM incident_event WHERE incident_id = ? ORDER BY hlc ASC, id ASC`,
      [incidentId],
    );
    return rows.map(toEvent);
  },

  /**
   * The same rows for many incidents, in ONE query.
   *
   * Bootstrap needs the timelines of the twenty most recent incidents before the
   * entry route stops rendering a blank view. Twenty awaited `events()` calls is
   * twenty serialised round-trips across the bridge for data that has no
   * ordering dependency on each other — the grouping is a JS loop, and the
   * grouping is the cheap part.
   */
  async eventsFor(incidentIds: readonly UUID[]): Promise<Record<UUID, IncidentEventRow[]>> {
    const out: Record<UUID, IncidentEventRow[]> = {};
    if (incidentIds.length === 0) return out;
    for (const id of incidentIds) out[id] = [];

    const db = await requireDb();
    // Placeholders, never interpolation: these are ids we generated, but a repo
    // that string-builds SQL once is a repo that string-builds SQL again.
    const holes = incidentIds.map(() => '?').join(',');
    const rows = await db.getAllAsync<EventRow>(
      `SELECT id, incident_id, family_id, hlc, event_type, sealed_payload, source_device_id,
              source_transport, policy_version, server_received_at, local_created_at, detail_json
       FROM incident_event WHERE incident_id IN (${holes}) ORDER BY hlc ASC, id ASC`,
      [...incidentIds],
    );
    for (const row of rows) {
      const event = toEvent(row);
      (out[event.incidentId] ??= []).push(event);
    }
    return out;
  },

  async setState(id: UUID, state: IncidentState, at = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `UPDATE incident
       SET state = ?,
           resolved_at = CASE WHEN ? = 1 THEN COALESCE(resolved_at, ?) ELSE resolved_at END,
           updated_at = ?
       WHERE id = ?`,
      [state, bit(TERMINAL_STATES.has(state)), at, at, id],
    );
  },

  /** P-003/P-030 responsibility transfer. Passing null is a RELEASE. */
  async setOwner(id: UUID, memberId: UUID | null, at = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `UPDATE incident
       SET owner_member_id = ?,
           first_ack_at = CASE WHEN ? IS NULL THEN first_ack_at ELSE COALESCE(first_ack_at, ?) END,
           updated_at = ?
       WHERE id = ?`,
      [memberId, memberId, at, at, id],
    );
  },

  async setOutcome(
    id: UUID,
    outcome: IncidentOutcome,
    note: string | null = null,
    at = Date.now(),
  ): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      'UPDATE incident SET outcome = ?, outcome_note = ?, updated_at = ? WHERE id = ?',
      [outcome, note, at, id],
    );
  },

  /** F-09: the SMS-synthesised twin folds into the real incident, not the reverse. */
  async mergeInto(id: UUID, targetId: UUID, at = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.runAsync('UPDATE incident SET merged_into_id = ?, updated_at = ? WHERE id = ?', [
      targetId,
      at,
      id,
    ]);
  },

  async setFirstNotified(id: UUID, at: number): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      'UPDATE incident SET first_notified_at = COALESCE(first_notified_at, ?), updated_at = ? WHERE id = ?',
      [at, Date.now(), id],
    );
  },

  /**
   * F-02: incidents nobody ever closed. An alert that stays "active" for a week
   * teaches the family to ignore the product, so the sweep quiesces them.
   */
  async autoQuiesceDue(now = Date.now()): Promise<Incident[]> {
    const db = await requireDb();
    const terminals = [...TERMINAL_STATES];
    const rows = await db.getAllAsync<IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS} FROM incident
       WHERE auto_quiesce_at IS NOT NULL
         AND auto_quiesce_at <= ?
         AND merged_into_id IS NULL
         AND state NOT IN (${placeholders(terminals.length)})
       ORDER BY auto_quiesce_at ASC`,
      [now, ...terminals],
    );
    return rows.map(toIncident);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// MEMBERS & DEVICES
// ═══════════════════════════════════════════════════════════════════════════════

interface MemberRow {
  id: string;
  family_id: string;
  display_name: string;
  ascii_short_name: string;
  role: string;
  dob: string | null;
  locale: string;
  identity_pubkey: string;
  phone_e164: string | null;
  membership_expires_at: number | null;
  created_at: number;
  avatar_color: string;
}

const toMember = (r: MemberRow): Member => ({
  id: r.id,
  familyId: r.family_id,
  displayName: r.display_name,
  asciiShortName: r.ascii_short_name,
  role: r.role as MemberRole,
  dob: r.dob,
  locale: r.locale as Locale,
  identityPubkey: r.identity_pubkey,
  phoneE164: r.phone_e164,
  membershipExpiresAt: r.membership_expires_at,
  createdAt: r.created_at,
  avatarColor: r.avatar_color,
});

const MEMBER_COLUMNS = `id, family_id, display_name, ascii_short_name, role, dob, locale,
  identity_pubkey, phone_e164, membership_expires_at, created_at, avatar_color`;

export const memberRepo = {
  async upsert(m: Member): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO member (${MEMBER_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         ascii_short_name = excluded.ascii_short_name,
         role = excluded.role,
         dob = excluded.dob,
         locale = excluded.locale,
         identity_pubkey = excluded.identity_pubkey,
         phone_e164 = excluded.phone_e164,
         membership_expires_at = excluded.membership_expires_at,
         avatar_color = excluded.avatar_color`,
      [
        m.id,
        m.familyId,
        m.displayName,
        m.asciiShortName,
        m.role,
        m.dob,
        m.locale,
        m.identityPubkey,
        m.phoneE164,
        m.membershipExpiresAt,
        m.createdAt,
        m.avatarColor,
      ],
    );
  },

  async upsertMany(list: Member[]): Promise<void> {
    for (const m of list) await memberRepo.upsert(m);
  },

  async get(id: UUID): Promise<Member | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM member WHERE id = ?`,
      [id],
    );
    return r ? toMember(r) : null;
  },

  /** F-18: the SMS short name is the lookup key a responder actually has. */
  async byShortName(familyId: UUID, shortName: string): Promise<Member | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM member
       WHERE family_id = ? AND lower(ascii_short_name) = lower(?)`,
      [familyId, shortName],
    );
    return r ? toMember(r) : null;
  },

  async list(familyId?: UUID): Promise<Member[]> {
    const db = await requireDb();
    const rows = familyId
      ? await db.getAllAsync<MemberRow>(
          `SELECT ${MEMBER_COLUMNS} FROM member WHERE family_id = ? ORDER BY created_at ASC`,
          [familyId],
        )
      : await db.getAllAsync<MemberRow>(
          `SELECT ${MEMBER_COLUMNS} FROM member ORDER BY created_at ASC`,
          [],
        );
    return rows.map(toMember);
  },

  /** Temporary members expire; a lapsed neighbour must stop receiving alerts. */
  async listActive(familyId: UUID, now = Date.now()): Promise<Member[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM member
       WHERE family_id = ?
         AND (membership_expires_at IS NULL OR membership_expires_at > ?)
       ORDER BY created_at ASC`,
      [familyId, now],
    );
    return rows.map(toMember);
  },

  async remove(id: UUID): Promise<void> {
    const db = await requireDb();
    await db.runAsync('DELETE FROM member WHERE id = ?', [id]);
  },
};

interface DeviceRow {
  id: string;
  family_id: string;
  member_id: string;
  platform: string;
  model: string | null;
  manufacturer: string | null;
  os_version: string | null;
  signing_pubkey: string;
  is_device_owner: number;
  imei: string | null;
  last_heartbeat_at: number | null;
  battery_pct: number | null;
  battery_temp_c: number | null;
  battery_health: string | null;
  agent_healthy: number;
  diagnostics_json: string;
}

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  familyId: r.family_id,
  memberId: r.member_id,
  platform: r.platform as DevicePlatform,
  model: r.model,
  manufacturer: r.manufacturer,
  osVersion: r.os_version,
  signingPubkey: r.signing_pubkey,
  isDeviceOwner: bool(r.is_device_owner),
  imei: r.imei,
  lastHeartbeatAt: r.last_heartbeat_at,
  batteryPct: r.battery_pct,
  batteryTempC: r.battery_temp_c,
  batteryHealth: r.battery_health,
  agentHealthy: bool(r.agent_healthy),
  diagnostics: { ...DEFAULT_DIAGNOSTICS, ...parseJson<Partial<DiagnosticsReport>>(r.diagnostics_json, {}) },
});

const DEVICE_COLUMNS = `id, family_id, member_id, platform, model, manufacturer, os_version,
  signing_pubkey, is_device_owner, imei, last_heartbeat_at, battery_pct, battery_temp_c,
  battery_health, agent_healthy, diagnostics_json`;

export const deviceRepo = {
  async upsert(d: Device): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO device (${DEVICE_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         member_id = excluded.member_id,
         platform = excluded.platform,
         model = excluded.model,
         manufacturer = excluded.manufacturer,
         os_version = excluded.os_version,
         signing_pubkey = excluded.signing_pubkey,
         is_device_owner = excluded.is_device_owner,
         imei = excluded.imei,
         last_heartbeat_at = MAX(COALESCE(device.last_heartbeat_at, 0), COALESCE(excluded.last_heartbeat_at, 0)),
         battery_pct = excluded.battery_pct,
         battery_temp_c = excluded.battery_temp_c,
         battery_health = excluded.battery_health,
         agent_healthy = excluded.agent_healthy,
         diagnostics_json = excluded.diagnostics_json`,
      [
        d.id,
        d.familyId,
        d.memberId,
        d.platform,
        d.model,
        d.manufacturer,
        d.osVersion,
        d.signingPubkey,
        bit(d.isDeviceOwner),
        d.imei,
        d.lastHeartbeatAt,
        d.batteryPct,
        d.batteryTempC,
        d.batteryHealth,
        bit(d.agentHealthy),
        JSON.stringify(d.diagnostics),
      ],
    );
  },

  async upsertMany(list: Device[]): Promise<void> {
    for (const d of list) await deviceRepo.upsert(d);
  },

  async get(id: UUID): Promise<Device | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM device WHERE id = ?`,
      [id],
    );
    return r ? toDevice(r) : null;
  },

  async list(familyId?: UUID): Promise<Device[]> {
    const db = await requireDb();
    const rows = familyId
      ? await db.getAllAsync<DeviceRow>(
          `SELECT ${DEVICE_COLUMNS} FROM device WHERE family_id = ?`,
          [familyId],
        )
      : await db.getAllAsync<DeviceRow>(`SELECT ${DEVICE_COLUMNS} FROM device`, []);
    return rows.map(toDevice);
  },

  async setHeartbeat(
    id: UUID,
    at: number,
    batteryPct: number | null,
    agentHealthy: boolean,
  ): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      'UPDATE device SET last_heartbeat_at = ?, battery_pct = ?, agent_healthy = ? WHERE id = ?',
      [at, batteryPct, bit(agentHealthy), id],
    );
  },

  /**
   * FR-034 / P-036: a device that has not spoken in `silentMs` is a silent
   * failure the family must be told about — force-stopped, battery-optimised,
   * or simply dead. Detecting the gap is the only mitigation that exists.
   */
  async silentSince(silentMs: number, now = Date.now()): Promise<Device[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<DeviceRow>(
      `SELECT ${DEVICE_COLUMNS} FROM device
       WHERE last_heartbeat_at IS NULL OR last_heartbeat_at < ?`,
      [now - silentMs],
    );
    return rows.map(toDevice);
  },

  async remove(id: UUID): Promise<void> {
    const db = await requireDb();
    await db.runAsync('DELETE FROM device WHERE id = ?', [id]);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONSENT — grants + the access log that makes them accountable
// ═══════════════════════════════════════════════════════════════════════════════

interface GrantRow {
  id: string;
  family_id: string;
  grantor_member_id: string;
  grantee_member_id: string;
  scope: string;
  purpose: string;
  granted_at: number;
  expires_at: number;
  revoked_at: number | null;
  granted_via: string;
  key_rotation_pending: number;
}

const toGrant = (r: GrantRow): ConsentGrant => ({
  id: r.id,
  familyId: r.family_id,
  grantorMemberId: r.grantor_member_id,
  granteeMemberId: r.grantee_member_id,
  scope: r.scope as ConsentScope,
  purpose: r.purpose as ConsentPurpose,
  grantedAt: r.granted_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  grantedVia: r.granted_via as ConsentGrant['grantedVia'],
  keyRotationPending: bool(r.key_rotation_pending),
});

interface AccessRow {
  id: number;
  family_id: string;
  grant_id: string | null;
  accessor_member_id: string;
  subject_member_id: string;
  what: string;
  context: string;
  at: number;
  surfaced_to_subject: number;
  degraded_plaintext: number;
}

const toAccess = (r: AccessRow): AccessLogEntry => ({
  id: r.id,
  familyId: r.family_id,
  grantId: r.grant_id,
  accessorMemberId: r.accessor_member_id,
  subjectMemberId: r.subject_member_id,
  what: r.what,
  context: r.context,
  at: r.at,
  surfacedToSubject: bool(r.surfaced_to_subject),
  degradedPlaintext: bool(r.degraded_plaintext),
});

const GRANT_COLUMNS = `id, family_id, grantor_member_id, grantee_member_id, scope, purpose,
  granted_at, expires_at, revoked_at, granted_via, key_rotation_pending`;

const ACCESS_COLUMNS = `id, family_id, grant_id, accessor_member_id, subject_member_id, what,
  context, at, surfaced_to_subject, degraded_plaintext`;

export const consentRepo = {
  /** P-008: expiresAt is mandatory in the type AND checked here. No permanent grant. */
  async upsert(g: ConsentGrant): Promise<void> {
    if (!Number.isFinite(g.expiresAt) || g.expiresAt <= 0) {
      throw new Error('consent grant must expire (P-008)');
    }
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO consent_grant (${GRANT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         expires_at = excluded.expires_at,
         revoked_at = COALESCE(consent_grant.revoked_at, excluded.revoked_at),
         key_rotation_pending = excluded.key_rotation_pending`,
      [
        g.id,
        g.familyId,
        g.grantorMemberId,
        g.granteeMemberId,
        g.scope,
        g.purpose,
        g.grantedAt,
        g.expiresAt,
        g.revokedAt,
        g.grantedVia,
        bit(g.keyRotationPending),
      ],
    );
  },

  async grants(familyId?: UUID): Promise<ConsentGrant[]> {
    const db = await requireDb();
    const rows = familyId
      ? await db.getAllAsync<GrantRow>(
          `SELECT ${GRANT_COLUMNS} FROM consent_grant WHERE family_id = ? ORDER BY granted_at DESC`,
          [familyId],
        )
      : await db.getAllAsync<GrantRow>(
          `SELECT ${GRANT_COLUMNS} FROM consent_grant ORDER BY granted_at DESC`,
          [],
        );
    return rows.map(toGrant);
  },

  /** The only query authorisation may consult: unrevoked AND unexpired. */
  async active(now = Date.now(), granteeMemberId?: UUID): Promise<ConsentGrant[]> {
    const db = await requireDb();
    const rows = granteeMemberId
      ? await db.getAllAsync<GrantRow>(
          `SELECT ${GRANT_COLUMNS} FROM consent_grant
           WHERE revoked_at IS NULL AND expires_at > ? AND grantee_member_id = ?
           ORDER BY expires_at ASC`,
          [now, granteeMemberId],
        )
      : await db.getAllAsync<GrantRow>(
          `SELECT ${GRANT_COLUMNS} FROM consent_grant
           WHERE revoked_at IS NULL AND expires_at > ? ORDER BY expires_at ASC`,
          [now],
        );
    return rows.map(toGrant);
  },

  /**
   * F-14 layer 1: revocation is instant and local. The key ratchet (layer 2) may
   * lag by an epoch, which is why keyRotationPending exists and is shown.
   */
  async revoke(id: UUID, at = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      'UPDATE consent_grant SET revoked_at = COALESCE(revoked_at, ?), key_rotation_pending = 1 WHERE id = ?',
      [at, id],
    );
  },

  async clearRotationPending(id: UUID): Promise<void> {
    const db = await requireDb();
    await db.runAsync('UPDATE consent_grant SET key_rotation_pending = 0 WHERE id = ?', [id]);
  },

  async log(limit = 200, subjectMemberId?: UUID): Promise<AccessLogEntry[]> {
    const db = await requireDb();
    const rows = subjectMemberId
      ? await db.getAllAsync<AccessRow>(
          `SELECT ${ACCESS_COLUMNS} FROM access_log
           WHERE subject_member_id = ? ORDER BY at DESC LIMIT ?`,
          [subjectMemberId, limit],
        )
      : await db.getAllAsync<AccessRow>(
          `SELECT ${ACCESS_COLUMNS} FROM access_log ORDER BY at DESC LIMIT ?`,
          [limit],
        );
    return rows.map(toAccess);
  },

  async addLogEntry(e: Omit<AccessLogEntry, 'id'>): Promise<number> {
    const db = await requireDb();
    const res = await db.runAsync(
      `INSERT INTO access_log
         (family_id, grant_id, accessor_member_id, subject_member_id, what, context, at,
          surfaced_to_subject, degraded_plaintext)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.familyId,
        e.grantId,
        e.accessorMemberId,
        e.subjectMemberId,
        e.what,
        e.context,
        e.at,
        bit(e.surfacedToSubject),
        bit(e.degradedPlaintext),
      ],
    );
    return res.lastInsertRowId;
  },

  /** Drives the surfacing job. An access log nobody reads is theatre. */
  async unsurfaced(limit = 50, subjectMemberId?: UUID): Promise<AccessLogEntry[]> {
    const db = await requireDb();
    const rows = subjectMemberId
      ? await db.getAllAsync<AccessRow>(
          `SELECT ${ACCESS_COLUMNS} FROM access_log
           WHERE surfaced_to_subject = 0 AND subject_member_id = ?
           ORDER BY at DESC LIMIT ?`,
          [subjectMemberId, limit],
        )
      : await db.getAllAsync<AccessRow>(
          `SELECT ${ACCESS_COLUMNS} FROM access_log
           WHERE surfaced_to_subject = 0 ORDER BY at DESC LIMIT ?`,
          [limit],
        );
    return rows.map(toAccess);
  },

  async markSurfaced(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await requireDb();
    await db.runAsync(
      `UPDATE access_log SET surfaced_to_subject = 1 WHERE id IN (${placeholders(ids.length)})`,
      ids,
    );
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// JOURNEYS
// ═══════════════════════════════════════════════════════════════════════════════

interface JourneyRow {
  id: string;
  family_id: string;
  member_id: string;
  label: string;
  started_at: number;
  eta_at: number | null;
  arrived_at: number | null;
  origin_name: string;
  dest_name: string;
  corridor_json: string;
  state: string;
  check_in_interval_s: number | null;
  last_check_in_at: number | null;
}

const toJourney = (r: JourneyRow): Journey => ({
  id: r.id,
  familyId: r.family_id,
  memberId: r.member_id,
  label: r.label,
  startedAt: r.started_at,
  etaAt: r.eta_at,
  arrivedAt: r.arrived_at,
  originName: r.origin_name,
  destName: r.dest_name,
  corridorPoints: parseJson<{ lat: number; lon: number }[]>(r.corridor_json, []),
  state: r.state as Journey['state'],
  checkInIntervalS: r.check_in_interval_s,
  lastCheckInAt: r.last_check_in_at,
});

const JOURNEY_COLUMNS = `id, family_id, member_id, label, started_at, eta_at, arrived_at,
  origin_name, dest_name, corridor_json, state, check_in_interval_s, last_check_in_at`;

export const journeyRepo = {
  async upsert(j: Journey): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO journey (${JOURNEY_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         eta_at = excluded.eta_at,
         arrived_at = excluded.arrived_at,
         dest_name = excluded.dest_name,
         corridor_json = excluded.corridor_json,
         state = excluded.state,
         check_in_interval_s = excluded.check_in_interval_s,
         last_check_in_at = excluded.last_check_in_at`,
      [
        j.id,
        j.familyId,
        j.memberId,
        j.label,
        j.startedAt,
        j.etaAt,
        j.arrivedAt,
        j.originName,
        j.destName,
        // Class A: this column stays on the device (ADR-010). Nothing reads it
        // into a request body.
        JSON.stringify(j.corridorPoints),
        j.state,
        j.checkInIntervalS,
        j.lastCheckInAt,
      ],
    );
  },

  async get(id: UUID): Promise<Journey | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<JourneyRow>(
      `SELECT ${JOURNEY_COLUMNS} FROM journey WHERE id = ?`,
      [id],
    );
    return r ? toJourney(r) : null;
  },

  async list(limit = 50): Promise<Journey[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<JourneyRow>(
      `SELECT ${JOURNEY_COLUMNS} FROM journey ORDER BY started_at DESC LIMIT ?`,
      [limit],
    );
    return rows.map(toJourney);
  },

  async active(): Promise<Journey[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<JourneyRow>(
      `SELECT ${JOURNEY_COLUMNS} FROM journey WHERE state = 'active' ORDER BY started_at DESC`,
      [],
    );
    return rows.map(toJourney);
  },

  /** The dead-man path: an ETA that passes without an arrival is a DEADMAN trigger. */
  async overdue(now = Date.now()): Promise<Journey[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<JourneyRow>(
      `SELECT ${JOURNEY_COLUMNS} FROM journey
       WHERE state = 'active' AND arrived_at IS NULL AND eta_at IS NOT NULL AND eta_at <= ?
       ORDER BY eta_at ASC`,
      [now],
    );
    return rows.map(toJourney);
  },

  async arrive(id: UUID, at = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      "UPDATE journey SET arrived_at = COALESCE(arrived_at, ?), state = 'arrived' WHERE id = ?",
      [at, id],
    );
  },

  async setState(id: UUID, state: Journey['state']): Promise<void> {
    const db = await requireDb();
    await db.runAsync('UPDATE journey SET state = ? WHERE id = ?', [state, id]);
  },

  async checkIn(id: UUID, at = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.runAsync('UPDATE journey SET last_check_in_at = ? WHERE id = ?', [at, id]);
  },

  async remove(id: UUID): Promise<void> {
    const db = await requireDb();
    await db.runAsync('DELETE FROM journey WHERE id = ?', [id]);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ★ GEOFENCES — precise coordinates, evaluated on-device, NEVER SYNCED (ADR-010)
// ═══════════════════════════════════════════════════════════════════════════════

interface GeofenceRow {
  id: string;
  label: string;
  lat: number;
  lon: number;
  radius_m: number;
  notify_on_enter: number;
  notify_on_exit: number;
  dwell_s: number | null;
  member_ids: string;
}

const toGeofence = (r: GeofenceRow): Geofence => ({
  id: r.id,
  label: r.label,
  lat: r.lat,
  lon: r.lon,
  radiusM: r.radius_m,
  notifyOnEnter: bool(r.notify_on_enter),
  notifyOnExit: bool(r.notify_on_exit),
  dwellS: r.dwell_s,
  memberIds: parseJson<UUID[]>(r.member_ids, []),
});

export const geofenceRepo = {
  /**
   * ★ Writes precise lat/lon to local_geofence and nowhere else. There is no
   * corresponding outbox enqueue and there must never be one: the centre point of
   * a geofence is a home address (ADR-010).
   */
  async upsert(g: Geofence): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO local_geofence
         (id, label, lat, lon, radius_m, notify_on_enter, notify_on_exit, dwell_s, member_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         lat = excluded.lat,
         lon = excluded.lon,
         radius_m = excluded.radius_m,
         notify_on_enter = excluded.notify_on_enter,
         notify_on_exit = excluded.notify_on_exit,
         dwell_s = excluded.dwell_s,
         member_ids = excluded.member_ids`,
      [
        g.id,
        g.label,
        g.lat,
        g.lon,
        g.radiusM,
        bit(g.notifyOnEnter),
        bit(g.notifyOnExit),
        g.dwellS,
        JSON.stringify(g.memberIds),
        Date.now(),
      ],
    );
  },

  async get(id: UUID): Promise<Geofence | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<GeofenceRow>(
      `SELECT id, label, lat, lon, radius_m, notify_on_enter, notify_on_exit, dwell_s, member_ids
       FROM local_geofence WHERE id = ?`,
      [id],
    );
    return r ? toGeofence(r) : null;
  },

  async list(): Promise<Geofence[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<GeofenceRow>(
      `SELECT id, label, lat, lon, radius_m, notify_on_enter, notify_on_exit, dwell_s, member_ids
       FROM local_geofence ORDER BY created_at ASC`,
      [],
    );
    return rows.map(toGeofence);
  },

  /** Only the fences that apply to this member are evaluated on each fix. */
  async listFor(memberId: UUID): Promise<Geofence[]> {
    const all = await geofenceRepo.list();
    return all.filter((g) => g.memberIds.length === 0 || g.memberIds.includes(memberId));
  },

  async remove(id: UUID): Promise<void> {
    const db = await requireDb();
    await db.runAsync('DELETE FROM local_geofence WHERE id = ?', [id]);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// VAULT · MEDICAL · SCREEN TIME · DRILLS · HOME ASSISTANT
// ═══════════════════════════════════════════════════════════════════════════════

interface VaultRow {
  id: string;
  family_id: string;
  title: string;
  kind: string;
  size_bytes: number;
  created_at: number;
  quorum_required: number;
  ciphertext_ref: string;
}

const toVault = (r: VaultRow): VaultObject => ({
  id: r.id,
  familyId: r.family_id,
  title: r.title,
  kind: r.kind as VaultObject['kind'],
  sizeBytes: r.size_bytes,
  createdAt: r.created_at,
  quorumRequired: bool(r.quorum_required),
  ciphertextRef: r.ciphertext_ref,
});

export const vaultRepo = {
  async upsert(v: VaultObject): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO vault_object (id, family_id, title, kind, size_bytes, created_at, quorum_required, ciphertext_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         kind = excluded.kind,
         size_bytes = excluded.size_bytes,
         quorum_required = excluded.quorum_required,
         ciphertext_ref = excluded.ciphertext_ref`,
      [
        v.id,
        v.familyId,
        v.title,
        v.kind,
        v.sizeBytes,
        v.createdAt,
        bit(v.quorumRequired),
        v.ciphertextRef,
      ],
    );
  },

  async get(id: UUID): Promise<VaultObject | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<VaultRow>(
      `SELECT id, family_id, title, kind, size_bytes, created_at, quorum_required, ciphertext_ref
       FROM vault_object WHERE id = ?`,
      [id],
    );
    return r ? toVault(r) : null;
  },

  async list(familyId?: UUID): Promise<VaultObject[]> {
    const db = await requireDb();
    const sql = `SELECT id, family_id, title, kind, size_bytes, created_at, quorum_required, ciphertext_ref
                 FROM vault_object`;
    const rows = familyId
      ? await db.getAllAsync<VaultRow>(`${sql} WHERE family_id = ? ORDER BY created_at DESC`, [
          familyId,
        ])
      : await db.getAllAsync<VaultRow>(`${sql} ORDER BY created_at DESC`, []);
    return rows.map(toVault);
  },

  /**
   * F-15: erasure is crypto-shredding. Dropping the index row here is only
   * correct once the content key is gone; the caller does that first.
   */
  async remove(id: UUID): Promise<void> {
    const db = await requireDb();
    await db.runAsync('DELETE FROM vault_object WHERE id = ?', [id]);
  },
};

const EMPTY_MEDICAL: MedicalCard = {
  bloodGroup: '',
  allergies: [],
  medications: [],
  conditions: [],
  iceContacts: [],
  organDonor: false,
  notes: '',
};

export const medicalRepo = {
  async get(memberId: UUID): Promise<MedicalCard | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<{ card_json: string }>(
      'SELECT card_json FROM medical_card WHERE member_id = ?',
      [memberId],
    );
    if (!r) return null;
    return { ...EMPTY_MEDICAL, ...parseJson<Partial<MedicalCard>>(r.card_json, {}) };
  },

  async save(memberId: UUID, familyId: UUID, card: MedicalCard): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO medical_card (member_id, family_id, card_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         card_json = excluded.card_json,
         updated_at = excluded.updated_at`,
      [memberId, familyId, JSON.stringify(card), Date.now()],
    );
  },

  empty(): MedicalCard {
    return { ...EMPTY_MEDICAL, allergies: [], medications: [], conditions: [], iceContacts: [] };
  },
};

interface UsageRow {
  package_name: string;
  label: string;
  minutes_today: number;
  limit_minutes: number | null;
  suspended: number;
}

const toUsage = (r: UsageRow): AppUsage => ({
  packageName: r.package_name,
  label: r.label,
  minutesToday: r.minutes_today,
  limitMinutes: r.limit_minutes,
  suspended: bool(r.suspended),
});

/** Device-local calendar day. Screen time is a local concept, never UTC. */
export function usageDay(at = Date.now()): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const usageRepo = {
  /** Minute counts are replaced, but a limit the person set is never clobbered. */
  async upsertMany(rows: AppUsage[], day = usageDay()): Promise<void> {
    const db = await requireDb();
    for (const u of rows) {
      await db.runAsync(
        `INSERT INTO app_usage (package_name, day, label, minutes_today, limit_minutes, suspended)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(package_name, day) DO UPDATE SET
           label = excluded.label,
           minutes_today = excluded.minutes_today,
           limit_minutes = COALESCE(excluded.limit_minutes, app_usage.limit_minutes),
           suspended = excluded.suspended`,
        [u.packageName, day, u.label, Math.round(u.minutesToday), u.limitMinutes, bit(u.suspended)],
      );
    }
  },

  async list(day = usageDay()): Promise<AppUsage[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<UsageRow>(
      `SELECT package_name, label, minutes_today, limit_minutes, suspended
       FROM app_usage WHERE day = ? ORDER BY minutes_today DESC`,
      [day],
    );
    return rows.map(toUsage);
  },

  async setLimit(packageName: string, minutes: number | null, day = usageDay()): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO app_usage (package_name, day, label, minutes_today, limit_minutes, suspended)
       VALUES (?, ?, ?, 0, ?, 0)
       ON CONFLICT(package_name, day) DO UPDATE SET limit_minutes = excluded.limit_minutes`,
      [packageName, day, packageName, minutes],
    );
  },

  async setSuspended(packageName: string, suspended: boolean, day = usageDay()): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      'UPDATE app_usage SET suspended = ? WHERE package_name = ? AND day = ?',
      [bit(suspended), packageName, day],
    );
  },

  /** §2.8.6: 90 days, and the person themself decides. */
  async prune(beforeDay: string): Promise<number> {
    const db = await requireDb();
    const res = await db.runAsync('DELETE FROM app_usage WHERE day < ?', [beforeDay]);
    return res.changes;
  },
};

interface DrillRow {
  id: string;
  family_id: string;
  kind: string;
  notifies_family: number;
  audience_device_ids: string;
  started_at: number;
  scorecard_json: string | null;
}

const toDrill = (r: DrillRow): DrillRun => ({
  id: r.id,
  familyId: r.family_id,
  kind: r.kind as DrillRun['kind'],
  notifiesFamily: bool(r.notifies_family),
  audienceDeviceIds: parseJson<UUID[]>(r.audience_device_ids, []),
  startedAt: r.started_at,
  scorecard: parseJson<DrillScorecard | null>(r.scorecard_json, null),
});

export const drillRepo = {
  /** F-03: audienceDeviceIds is what keeps a 03:00 canary off the family's phones. */
  async upsert(d: DrillRun): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO drill_run (id, family_id, kind, notifies_family, audience_device_ids, started_at, scorecard_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         notifies_family = excluded.notifies_family,
         audience_device_ids = excluded.audience_device_ids,
         scorecard_json = COALESCE(excluded.scorecard_json, drill_run.scorecard_json)`,
      [
        d.id,
        d.familyId,
        d.kind,
        bit(d.notifiesFamily),
        JSON.stringify(d.audienceDeviceIds),
        d.startedAt,
        d.scorecard ? JSON.stringify(d.scorecard) : null,
      ],
    );
  },

  async get(id: UUID): Promise<DrillRun | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<DrillRow>(
      `SELECT id, family_id, kind, notifies_family, audience_device_ids, started_at, scorecard_json
       FROM drill_run WHERE id = ?`,
      [id],
    );
    return r ? toDrill(r) : null;
  },

  async list(limit = 50): Promise<DrillRun[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<DrillRow>(
      `SELECT id, family_id, kind, notifies_family, audience_device_ids, started_at, scorecard_json
       FROM drill_run ORDER BY started_at DESC LIMIT ?`,
      [limit],
    );
    return rows.map(toDrill);
  },

  async setScorecard(id: UUID, scorecard: DrillScorecard): Promise<void> {
    const db = await requireDb();
    await db.runAsync('UPDATE drill_run SET scorecard_json = ? WHERE id = ?', [
      JSON.stringify(scorecard),
      id,
    ]);
  },

  /** §2.11.2: the canary is only meaningful as a trend. */
  async lastOfKind(kind: DrillRun['kind']): Promise<DrillRun | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<DrillRow>(
      `SELECT id, family_id, kind, notifies_family, audience_device_ids, started_at, scorecard_json
       FROM drill_run WHERE kind = ? ORDER BY started_at DESC LIMIT 1`,
      [kind],
    );
    return r ? toDrill(r) : null;
  },
};

interface HaRow {
  id: string;
  entity: string;
  kind: string;
  severity: string;
  at: number;
  suggested_actions: string;
}

const toHa = (r: HaRow): HaSafetyEvent => ({
  id: r.id,
  entity: r.entity,
  kind: r.kind as HaSafetyEvent['kind'],
  severity: r.severity as HaSafetyEvent['severity'],
  at: r.at,
  suggestedActions: parseJson<string[]>(r.suggested_actions, []),
});

export const haRepo = {
  async upsert(e: HaSafetyEvent): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO ha_event (id, entity, kind, severity, at, suggested_actions)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         severity = excluded.severity,
         suggested_actions = excluded.suggested_actions`,
      [e.id, e.entity, e.kind, e.severity, e.at, JSON.stringify(e.suggestedActions)],
    );
  },

  async list(limit = 50): Promise<HaSafetyEvent[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<HaRow>(
      `SELECT id, entity, kind, severity, at, suggested_actions
       FROM ha_event ORDER BY at DESC LIMIT ?`,
      [limit],
    );
    return rows.map(toHa);
  },

  async acknowledge(id: UUID, at = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.runAsync('UPDATE ha_event SET acknowledged_at = ? WHERE id = ?', [at, id]);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// PRESENCE
// ═══════════════════════════════════════════════════════════════════════════════

interface PresenceRow {
  member_id: string;
  last_seen_at: number | null;
  battery_pct: number | null;
  agent_healthy: number;
  degradation_level: number;
  loc_lat: number | null;
  loc_lon: number | null;
  loc_accuracy_m: number | null;
  loc_at: number | null;
  room: string | null;
  monitoring_paused: number;
}

const toPresence = (r: PresenceRow): MemberPresence => ({
  memberId: r.member_id,
  lastSeenAt: r.last_seen_at,
  batteryPct: r.battery_pct,
  agentHealthy: bool(r.agent_healthy),
  degradationLevel: r.degradation_level as DegradationLevel,
  location:
    r.loc_lat !== null && r.loc_lon !== null && r.loc_at !== null
      ? { lat: r.loc_lat, lon: r.loc_lon, accuracyM: r.loc_accuracy_m ?? 0, at: r.loc_at }
      : null,
  room: r.room,
  monitoringPaused: bool(r.monitoring_paused),
});

const PRESENCE_COLUMNS = `member_id, last_seen_at, battery_pct, agent_healthy, degradation_level,
  loc_lat, loc_lon, loc_accuracy_m, loc_at, room, monitoring_paused`;

export const presenceRepo = {
  /**
   * `location` is only ever non-null when a live grant permitted it upstream —
   * this repository stores what it is given and never infers a right to it.
   */
  async upsert(p: MemberPresence): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO presence (${PRESENCE_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET
         last_seen_at = MAX(COALESCE(presence.last_seen_at, 0), COALESCE(excluded.last_seen_at, 0)),
         battery_pct = excluded.battery_pct,
         agent_healthy = excluded.agent_healthy,
         degradation_level = excluded.degradation_level,
         loc_lat = excluded.loc_lat,
         loc_lon = excluded.loc_lon,
         loc_accuracy_m = excluded.loc_accuracy_m,
         loc_at = excluded.loc_at,
         room = excluded.room,
         monitoring_paused = excluded.monitoring_paused`,
      [
        p.memberId,
        p.lastSeenAt,
        p.batteryPct,
        bit(p.agentHealthy),
        p.degradationLevel,
        p.location?.lat ?? null,
        p.location?.lon ?? null,
        p.location?.accuracyM ?? null,
        p.location?.at ?? null,
        p.room,
        bit(p.monitoringPaused),
      ],
    );
  },

  async get(memberId: UUID): Promise<MemberPresence | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<PresenceRow>(
      `SELECT ${PRESENCE_COLUMNS} FROM presence WHERE member_id = ?`,
      [memberId],
    );
    return r ? toPresence(r) : null;
  },

  async list(): Promise<MemberPresence[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<PresenceRow>(`SELECT ${PRESENCE_COLUMNS} FROM presence`, []);
    return rows.map(toPresence);
  },

  async map(): Promise<Record<UUID, MemberPresence>> {
    const all = await presenceRepo.list();
    const out: Record<UUID, MemberPresence> = {};
    for (const p of all) out[p.memberId] = p;
    return out;
  },

  /** P-066: pausing is a member's right and must be stated, not hidden. */
  async setPaused(memberId: UUID, paused: boolean): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO presence (member_id, degradation_level, monitoring_paused, agent_healthy)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(member_id) DO UPDATE SET monitoring_paused = excluded.monitoring_paused`,
      [memberId, DegradationLevel.FULL, bit(paused)],
    );
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// POLICY CACHE — server-authoritative, never written by the device (ADR-013)
// ═══════════════════════════════════════════════════════════════════════════════

export const policyRepo = {
  /**
   * Store a version the SERVER issued. Two divergent escalation policies is an
   * unrecoverable bug class, so this is only ever called with a fetched policy.
   */
  async save(policy: EscalationPolicy, fetchedAt = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.withTransactionAsync(async () => {
      await db.runAsync('UPDATE policy_cache SET active = 0 WHERE active = 1', []);
      await db.runAsync(
        `INSERT INTO policy_cache (version, policy_json, fetched_at, active)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(version) DO UPDATE SET
           policy_json = excluded.policy_json,
           fetched_at = excluded.fetched_at,
           active = 1`,
        [policy.version, JSON.stringify(policy), fetchedAt],
      );
    });
  },

  /**
   * The escalation ladder must work with no network, so a missing cache falls
   * back to the compiled-in default rather than failing (PRD §4.4 L0).
   */
  async current(): Promise<EscalationPolicy> {
    const db = await requireDb();
    const r = await db.getFirstAsync<{ policy_json: string }>(
      'SELECT policy_json FROM policy_cache WHERE active = 1 ORDER BY version DESC LIMIT 1',
      [],
    );
    if (!r) return DEFAULT_POLICY;
    const parsed = parseJson<EscalationPolicy | null>(r.policy_json, null);
    return parsed && parsed.scenarios ? parsed : DEFAULT_POLICY;
  },

  async version(): Promise<number> {
    const db = await requireDb();
    const r = await db.getFirstAsync<{ version: number }>(
      'SELECT version FROM policy_cache WHERE active = 1 ORDER BY version DESC LIMIT 1',
      [],
    );
    return r?.version ?? DEFAULT_POLICY_VERSION;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// LOCATION POINTS — Class A, precise, 90-day local retention (§2.8.6)
// ═══════════════════════════════════════════════════════════════════════════════

export interface LocationPoint {
  id: number;
  familyId: UUID;
  memberId: UUID;
  at: number;
  lat: number;
  lon: number;
  accuracyM: number;
  speed: number | null;
  heading: number | null;
  batteryPct: number | null;
  incidentId: UUID | null;
  synced: boolean;
}

interface LocationRow {
  id: number;
  family_id: string;
  member_id: string;
  at: number;
  lat: number;
  lon: number;
  accuracy_m: number;
  speed: number | null;
  heading: number | null;
  battery_pct: number | null;
  incident_id: string | null;
  synced: number;
}

const toLocation = (r: LocationRow): LocationPoint => ({
  id: r.id,
  familyId: r.family_id,
  memberId: r.member_id,
  at: r.at,
  lat: r.lat,
  lon: r.lon,
  accuracyM: r.accuracy_m,
  speed: r.speed,
  heading: r.heading,
  batteryPct: r.battery_pct,
  incidentId: r.incident_id,
  synced: bool(r.synced),
});

const LOCATION_COLUMNS = `id, family_id, member_id, at, lat, lon, accuracy_m, speed, heading,
  battery_pct, incident_id, synced`;

export const locationRepo = {
  async append(p: Omit<LocationPoint, 'id' | 'synced'>): Promise<number> {
    const db = await requireDb();
    const res = await db.runAsync(
      `INSERT INTO location_point
         (family_id, member_id, at, lat, lon, accuracy_m, speed, heading, battery_pct, incident_id, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        p.familyId,
        p.memberId,
        p.at,
        p.lat,
        p.lon,
        p.accuracyM,
        p.speed,
        p.heading,
        p.batteryPct,
        p.incidentId,
      ],
    );
    return res.lastInsertRowId;
  },

  async latest(memberId: UUID): Promise<LocationPoint | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<LocationRow>(
      `SELECT ${LOCATION_COLUMNS} FROM location_point WHERE member_id = ? ORDER BY at DESC LIMIT 1`,
      [memberId],
    );
    return r ? toLocation(r) : null;
  },

  async recent(memberId: UUID, limit = 200): Promise<LocationPoint[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<LocationRow>(
      `SELECT ${LOCATION_COLUMNS} FROM location_point
       WHERE member_id = ? ORDER BY at DESC LIMIT ?`,
      [memberId, limit],
    );
    return rows.map(toLocation);
  },

  async forIncident(incidentId: UUID): Promise<LocationPoint[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<LocationRow>(
      `SELECT ${LOCATION_COLUMNS} FROM location_point WHERE incident_id = ? ORDER BY at ASC`,
      [incidentId],
    );
    return rows.map(toLocation);
  },

  async unsynced(limit = 200): Promise<LocationPoint[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<LocationRow>(
      `SELECT ${LOCATION_COLUMNS} FROM location_point WHERE synced = 0 ORDER BY at ASC LIMIT ?`,
      [limit],
    );
    return rows.map(toLocation);
  },

  async markSynced(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await requireDb();
    await db.runAsync(
      `UPDATE location_point SET synced = 1 WHERE id IN (${placeholders(ids.length)})`,
      ids,
    );
  },

  /** §2.8.6: 90 days by default, and each member may shorten it for their own data. */
  async prune(olderThanMs = 90 * 24 * 60 * 60_000, now = Date.now()): Promise<number> {
    const db = await requireDb();
    const res = await db.runAsync(
      'DELETE FROM location_point WHERE at < ? AND incident_id IS NULL',
      [now - olderThanMs],
    );
    return res.changes;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// OUTBOX — every unsent mutation
// ═══════════════════════════════════════════════════════════════════════════════

interface OutboxRow {
  id: number;
  kind: string;
  payload: string;
  incident_id: string | null;
  created_at: number;
  attempts: number;
  last_attempt_at: number | null;
  transport_attempts: string;
  delivered: number;
}

const toOutbox = (r: OutboxRow): OutboxItem => ({
  id: r.id,
  kind: r.kind as OutboxItem['kind'],
  payload: r.payload,
  incidentId: r.incident_id,
  createdAt: r.created_at,
  attempts: r.attempts,
  lastAttemptAt: r.last_attempt_at,
  transportAttempts: parseJson<Partial<Record<TransportKind, number>>>(r.transport_attempts, {}),
  delivered: bool(r.delivered),
});

const OUTBOX_COLUMNS = `id, kind, payload, incident_id, created_at, attempts, last_attempt_at,
  transport_attempts, delivered`;

export interface EnqueueInput {
  kind: OutboxItem['kind'];
  payload: string;
  incidentId?: UUID | null;
  /** incident_id ‖ hlc. Present ⇒ enqueuing twice is a no-op (§2.10.5). */
  dedupeKey?: string | null;
  /** Defaults to "now" — the drain fires immediately on the next tick. */
  notBefore?: number;
}

export const outboxRepo = {
  async enqueue(input: EnqueueInput): Promise<number> {
    const db = await requireDb();
    const now = Date.now();
    const dedupe = input.dedupeKey ?? null;
    const res = await db.runAsync(
      `INSERT OR IGNORE INTO outbox
         (kind, payload, incident_id, created_at, attempts, last_attempt_at, next_attempt_at,
          transport_attempts, delivered, dedupe_key)
       VALUES (?, ?, ?, ?, 0, NULL, ?, '{}', 0, ?)`,
      [input.kind, input.payload, input.incidentId ?? null, now, input.notBefore ?? now, dedupe],
    );
    if (res.changes > 0) return res.lastInsertRowId;
    if (dedupe) {
      const existing = await db.getFirstAsync<{ id: number }>(
        'SELECT id FROM outbox WHERE dedupe_key = ?',
        [dedupe],
      );
      if (existing) return existing.id;
    }
    return 0;
  },

  async pending(limit = 25, now = Date.now()): Promise<OutboxItem[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox
       WHERE delivered = 0 AND next_attempt_at <= ?
       ORDER BY created_at ASC LIMIT ?`,
      [now, limit],
    );
    return rows.map(toOutbox);
  },

  async get(id: number): Promise<OutboxItem | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<OutboxRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE id = ?`,
      [id],
    );
    return r ? toOutbox(r) : null;
  },

  /**
   * Per-transport counters, because "attempts = 9" tells you nothing about WHICH
   * leg is dead. A blocked WebSocket must not make the HTTP leg look exhausted.
   */
  async markAttempt(
    id: number,
    transport: TransportKind,
    nextAttemptAt: number,
    error: string | null = null,
    at = Date.now(),
  ): Promise<void> {
    const db = await requireDb();
    const row = await db.getFirstAsync<{ transport_attempts: string }>(
      'SELECT transport_attempts FROM outbox WHERE id = ?',
      [id],
    );
    const counters = parseJson<Partial<Record<TransportKind, number>>>(
      row?.transport_attempts ?? null,
      {},
    );
    counters[transport] = (counters[transport] ?? 0) + 1;
    await db.runAsync(
      `UPDATE outbox
       SET attempts = attempts + 1,
           last_attempt_at = ?,
           next_attempt_at = ?,
           transport_attempts = ?,
           last_error = ?
       WHERE id = ?`,
      [at, nextAttemptAt, JSON.stringify(counters), error, id],
    );
  },

  async markDelivered(id: number, at = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      'UPDATE outbox SET delivered = 1, delivered_at = ?, last_error = NULL WHERE id = ?',
      [at, id],
    );
  },

  /** Surfaced in the UI: a growing outbox is the honest signal that sync is stuck. */
  async depth(): Promise<number> {
    const db = await requireDb();
    const r = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM outbox WHERE delivered = 0',
      [],
    );
    return r?.n ?? 0;
  },

  /** Delivered rows are kept briefly so a late duplicate still hits dedupe_key. */
  async purgeDelivered(olderThanMs = 24 * 60 * 60_000, now = Date.now()): Promise<number> {
    const db = await requireDb();
    const res = await db.runAsync(
      'DELETE FROM outbox WHERE delivered = 1 AND COALESCE(delivered_at, created_at) < ?',
      [now - olderThanMs],
    );
    return res.changes;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC CURSOR · PEER KEYS · T0 CONFIG · DIAGNOSTICS · BLACK BOX
// ═══════════════════════════════════════════════════════════════════════════════

export const cursorRepo = {
  /** §2.5.2: the WebSocket resumes from here, so a reconnect replays nothing twice. */
  async get(stream: string): Promise<string | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<{ cursor_hlc: string }>(
      'SELECT cursor_hlc FROM inbox_cursor WHERE stream = ?',
      [stream],
    );
    return r?.cursor_hlc ?? null;
  },

  /**
   * Monotonic in HLC order. A frame arriving out of order must never rewind the
   * cursor, or the next reconnect replays events the UI has already folded in.
   */
  async advance(stream: string, cursorHlc: string, at = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO inbox_cursor (stream, cursor_hlc, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(stream) DO UPDATE SET
         cursor_hlc = CASE WHEN excluded.cursor_hlc > inbox_cursor.cursor_hlc
                           THEN excluded.cursor_hlc ELSE inbox_cursor.cursor_hlc END,
         updated_at = excluded.updated_at`,
      [stream, cursorHlc, at],
    );
  },

  async reset(stream: string): Promise<void> {
    const db = await requireDb();
    await db.runAsync('DELETE FROM inbox_cursor WHERE stream = ?', [stream]);
  },
};

export interface PeerKey {
  deviceId: UUID;
  familyId: UUID;
  memberId: UUID;
  signingPubkey: string;
  boxPubkey: string | null;
  fingerprint: string;
  verifiedAt: number | null;
  updatedAt: number;
}

export const peerKeyRepo = {
  /** Cached so BLE HMAC verification works with zero infrastructure (§2.10.3). */
  async upsert(k: PeerKey): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO peer_keys (device_id, family_id, member_id, signing_pubkey, box_pubkey, fingerprint, verified_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         signing_pubkey = excluded.signing_pubkey,
         box_pubkey = excluded.box_pubkey,
         fingerprint = excluded.fingerprint,
         verified_at = COALESCE(peer_keys.verified_at, excluded.verified_at),
         updated_at = excluded.updated_at`,
      [
        k.deviceId,
        k.familyId,
        k.memberId,
        k.signingPubkey,
        k.boxPubkey,
        k.fingerprint,
        k.verifiedAt,
        k.updatedAt,
      ],
    );
  },

  async get(deviceId: UUID): Promise<PeerKey | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<{
      device_id: string;
      family_id: string;
      member_id: string;
      signing_pubkey: string;
      box_pubkey: string | null;
      fingerprint: string;
      verified_at: number | null;
      updated_at: number;
    }>(
      `SELECT device_id, family_id, member_id, signing_pubkey, box_pubkey, fingerprint, verified_at, updated_at
       FROM peer_keys WHERE device_id = ?`,
      [deviceId],
    );
    return r
      ? {
          deviceId: r.device_id,
          familyId: r.family_id,
          memberId: r.member_id,
          signingPubkey: r.signing_pubkey,
          boxPubkey: r.box_pubkey,
          fingerprint: r.fingerprint,
          verifiedAt: r.verified_at,
          updatedAt: r.updated_at,
        }
      : null;
  },

  async list(familyId: UUID): Promise<PeerKey[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<{
      device_id: string;
      family_id: string;
      member_id: string;
      signing_pubkey: string;
      box_pubkey: string | null;
      fingerprint: string;
      verified_at: number | null;
      updated_at: number;
    }>(
      `SELECT device_id, family_id, member_id, signing_pubkey, box_pubkey, fingerprint, verified_at, updated_at
       FROM peer_keys WHERE family_id = ?`,
      [familyId],
    );
    return rows.map((r) => ({
      deviceId: r.device_id,
      familyId: r.family_id,
      memberId: r.member_id,
      signingPubkey: r.signing_pubkey,
      boxPubkey: r.box_pubkey,
      fingerprint: r.fingerprint,
      verifiedAt: r.verified_at,
      updatedAt: r.updated_at,
    }));
  },

  async markVerified(deviceId: UUID, at = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.runAsync('UPDATE peer_keys SET verified_at = ? WHERE device_id = ?', [at, deviceId]);
  },
};

export const t0ConfigRepo = {
  /** P-035: the minimal config T0 needs before the first unlock after a reboot. */
  async get(key: string): Promise<string | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM t0_config WHERE key = ?',
      [key],
    );
    return r?.value ?? null;
  },

  async set(key: string, value: string, at = Date.now()): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO t0_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, at],
    );
  },

  async all(): Promise<Record<string, string>> {
    const db = await requireDb();
    const rows = await db.getAllAsync<{ key: string; value: string }>(
      'SELECT key, value FROM t0_config',
      [],
    );
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  },
};

export const diagnosticsRepo = {
  /** P-031: history, because one green check proves nothing about last Tuesday. */
  async record(report: DiagnosticsReport): Promise<void> {
    const db = await requireDb();
    const green = (Object.keys(report) as (keyof DiagnosticsReport)[])
      .filter((k) => k !== 'lastCheckedAt')
      .every((k) => report[k] === true);
    await db.runAsync(
      'INSERT INTO diagnostics_history (checked_at, report_json, all_green) VALUES (?, ?, ?)',
      [report.lastCheckedAt || Date.now(), JSON.stringify(report), bit(green)],
    );
  },

  async latest(): Promise<DiagnosticsReport | null> {
    const db = await requireDb();
    const r = await db.getFirstAsync<{ report_json: string }>(
      'SELECT report_json FROM diagnostics_history ORDER BY checked_at DESC LIMIT 1',
      [],
    );
    if (!r) return null;
    return { ...DEFAULT_DIAGNOSTICS, ...parseJson<Partial<DiagnosticsReport>>(r.report_json, {}) };
  },

  async history(limit = 30): Promise<DiagnosticsReport[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<{ report_json: string }>(
      'SELECT report_json FROM diagnostics_history ORDER BY checked_at DESC LIMIT ?',
      [limit],
    );
    return rows.map((r) => ({
      ...DEFAULT_DIAGNOSTICS,
      ...parseJson<Partial<DiagnosticsReport>>(r.report_json, {}),
    }));
  },
};

export interface BlackBoxMeta {
  ref: string;
  incidentId: UUID | null;
  startedAt: number;
  endedAt: number | null;
  sampleHz: number;
  windowMs: number;
  bytes: number;
  fileRef: string;
  sealed: boolean;
}

export const blackBoxRepo = {
  async upsert(m: BlackBoxMeta): Promise<void> {
    const db = await requireDb();
    await db.runAsync(
      `INSERT INTO blackbox_meta (ref, incident_id, started_at, ended_at, sample_hz, window_ms, bytes, file_ref, sealed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         incident_id = excluded.incident_id,
         ended_at = excluded.ended_at,
         bytes = excluded.bytes,
         sealed = excluded.sealed`,
      [
        m.ref,
        m.incidentId,
        m.startedAt,
        m.endedAt,
        m.sampleHz,
        m.windowMs,
        m.bytes,
        m.fileRef,
        bit(m.sealed),
      ],
    );
  },

  async forIncident(incidentId: UUID): Promise<BlackBoxMeta[]> {
    const db = await requireDb();
    const rows = await db.getAllAsync<{
      ref: string;
      incident_id: string | null;
      started_at: number;
      ended_at: number | null;
      sample_hz: number;
      window_ms: number;
      bytes: number;
      file_ref: string;
      sealed: number;
    }>(
      `SELECT ref, incident_id, started_at, ended_at, sample_hz, window_ms, bytes, file_ref, sealed
       FROM blackbox_meta WHERE incident_id = ? ORDER BY started_at ASC`,
      [incidentId],
    );
    return rows.map((r) => ({
      ref: r.ref,
      incidentId: r.incident_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      sampleHz: r.sample_hz,
      windowMs: r.window_ms,
      bytes: r.bytes,
      fileRef: r.file_ref,
      sealed: bool(r.sealed),
    }));
  },

  /** P-043: unsealed windows older than the ring are dead weight on a full disk. */
  async pruneUnsealed(olderThanMs = 24 * 60 * 60_000, now = Date.now()): Promise<number> {
    const db = await requireDb();
    const res = await db.runAsync(
      'DELETE FROM blackbox_meta WHERE sealed = 0 AND started_at < ?',
      [now - olderThanMs],
    );
    return res.changes;
  },
};

export type { SQLiteDatabase } from 'expo-sqlite';
