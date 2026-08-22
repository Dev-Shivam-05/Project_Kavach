/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * API CLIENT
 *
 * Two rules govern this file, and they are not negotiable.
 *
 * ★ F-05 — THE DUAL ENDPOINT ★
 * The critical path fires CONFIG.apiBase AND CONFIG.apiDirect **concurrently** and
 * resolves on the FIRST success. Two DNS names, two TLS chains, two pinned key
 * sets — because the architecture survives the loss of the control plane, of
 * Postgres, of NATS, of the region and of the provider, but not of the CDN sitting
 * in front of it. One duplicate request per incident costs nothing; the server
 * deduplicates on incident_id (P-053). Sequential fallback costs 45 seconds, and
 * you are racing a clock.
 *
 * ★ ADR-018 / P-007 — NOTHING HERE MAY BLOCK AN SOS ★
 * No function in this file rejects. Every failure is returned as data. An expired
 * token, a 401, a 413, a DNS failure — none of them are permitted to become an
 * exception that reaches the caller, because the caller is the T0 dispatcher and
 * its next line is "fan out over the remaining transports".
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { CONFIG } from '../core/config';
import { DEFAULT_POLICY } from '../core/policy';
import { uuidv7 } from '../core/ids';
import {
  canonicalise,
  envelopeHeaders,
  FIXED_ENVELOPE_SIZE,
  FLAG_UNVERIFIED,
  INCIDENT_APPEND_PATH,
  INCIDENT_OPEN_PATH,
  INCIDENT_RELAY_PATH,
  padEnvelope,
  type IncidentEnvelope,
  type SignedEnvelope,
} from '../t0/envelope';
import type {
  AccessLogEntry,
  ConsentGrant,
  ConsentPurpose,
  ConsentScope,
  Device,
  DrillRun,
  EscalationPolicy,
  Incident,
  IncidentOutcome,
  Journey,
  Member,
  TransportKind,
  UUID,
} from '../core/types';

// ── error codes (§2.9.3) ──────────────────────────────────────────────────────

export type KvCode =
  | 'KV-1001' // 400 malformed        → do not retry; fall back to SMS
  | 'KV-1002' // 401 bad signature    → RETRY ANYWAY, unverified
  | 'KV-1003' // 409 duplicate        → success
  | 'KV-1004' // 413 too large        → strip the black box, retry minimal
  | 'KV-1005' // 429 rate limited     → backoff
  | 'KV-2001' // 403 grant expired
  | 'KV-2002' // 403 purpose mismatch
  | 'KV-2003' // 409 MLS epoch conflict
  | 'KV-5001' // 503 downstream down  → escalate to the next transport tier
  | 'KV-0000'; // transport failure, no HTTP response at all

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  code: KvCode | null;
  data: T | null;
  /** ★ KV-5001: the caller must immediately escalate to the next transport tier. */
  escalate: boolean;
  /** Which leg answered. 'local' means demo mode synthesised it. */
  via: TransportKind;
  message: string | null;
}

export interface IngestAck {
  incidentId: UUID;
  serverTsMs: number;
  verified: boolean;
}

export interface IngestResult extends ApiResponse<IngestAck> {
  /** False when the envelope was accepted under FLAG_UNVERIFIED (ADR-018). */
  verified: boolean;
  retriedUnverified: boolean;
  retriedMinimal: boolean;
}

const INGEST_TIMEOUT_MS = 10_000;
const CONTROL_TIMEOUT_MS = 15_000;

// ── session ───────────────────────────────────────────────────────────────────

let authToken: string | null = null;
let deviceId: UUID = '';
let familyId: UUID = '';

/**
 * The bearer token is for the CONTROL PLANE ONLY. The SOS ingest endpoints do not
 * accept bearer tokens at all — that is the whole point of P-007. If you ever find
 * yourself adding an Authorization header to postIncidentOpen, stop.
 */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

export function setIdentity(ids: { deviceId: UUID; familyId: UUID }): void {
  deviceId = ids.deviceId;
  familyId = ids.familyId;
}

// ── plumbing ──────────────────────────────────────────────────────────────────

function ok<T>(data: T, via: TransportKind = 'http', status = 200): ApiResponse<T> {
  return { ok: true, status, code: null, data, escalate: false, via, message: null };
}

function fail<T>(
  status: number,
  code: KvCode,
  via: TransportKind,
  message: string | null = null,
): ApiResponse<T> {
  return {
    ok: false,
    status,
    code,
    data: null,
    escalate: code === 'KV-5001' || code === 'KV-0000' || code === 'KV-1001',
    via,
    message,
  };
}

/** §2.9.3, plus a code carried in the RFC 7807 body when the server supplies one. */
function codeFor(status: number, bodyCode?: string | null): KvCode {
  if (bodyCode && /^KV-\d{4}$/.test(bodyCode)) return bodyCode as KvCode;
  switch (status) {
    case 400:
      return 'KV-1001';
    case 401:
    case 403:
      return status === 401 ? 'KV-1002' : 'KV-2001';
    case 409:
      return 'KV-1003';
    case 413:
      return 'KV-1004';
    case 429:
      return 'KV-1005';
    case 502:
    case 503:
    case 504:
      return 'KV-5001';
    default:
      return status >= 500 ? 'KV-5001' : 'KV-0000';
  }
}

async function readProblem(res: Response): Promise<{ code: string | null; message: string | null }> {
  try {
    const text = await res.text();
    if (!text) return { code: null, message: null };
    const parsed = JSON.parse(text) as { code?: string; detail?: string; title?: string };
    return {
      code: parsed.code ?? null,
      message: parsed.detail ?? parsed.title ?? null,
    };
  } catch {
    return { code: null, message: null };
  }
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ADR-010 defence in depth. Precise coordinates travel exactly one way: sealed,
 * inside the incident envelope, on the ingest path. No control-plane body has any
 * business carrying them, so they are removed here rather than trusted not to
 * appear. A journey's corridor and a geofence's centre are the two that would
 * otherwise leak by accident.
 */
const CLASS_A_KEYS = new Set(['lat', 'lon', 'corridorPoints', 'corridor', 'points', 'geofences']);

function stripClassA<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripClassA(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CLASS_A_KEYS.has(k)) continue;
      out[k] = stripClassA(v);
    }
    return out as unknown as T;
  }
  return value;
}

interface ControlOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Mutating endpoints all take one (§2.9.2 conventions). */
  idempotencyKey?: string;
  timeoutMs?: number;
}

/**
 * One control-plane request. Never throws; a dead network is 'KV-0000'.
 * The control plane is NOT the critical path — it is allowed to be unavailable,
 * and every caller here degrades to the local database when it is.
 */
async function control<T>(path: string, opts: ControlOptions = {}): Promise<ApiResponse<T>> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (deviceId) headers['X-Device-Id'] = deviceId;
  if (method !== 'GET') {
    headers['Idempotency-Key'] = opts.idempotencyKey ?? uuidv7();
  }
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(stripClassA(opts.body));
  }

  try {
    const res = await timedFetch(
      `${CONFIG.controlBase}${path}`,
      { method, headers, body: payload },
      opts.timeoutMs ?? CONTROL_TIMEOUT_MS,
    );
    if (res.status === 204) return ok(null as T, 'http', 204);
    if (!res.ok) {
      const problem = await readProblem(res);
      return fail<T>(res.status, codeFor(res.status, problem.code), 'http', problem.message);
    }
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T) : (null as T);
    return ok(data, 'http', res.status);
  } catch (e) {
    return fail<T>(0, 'KV-0000', 'http', e instanceof Error ? e.message : 'network error');
  }
}

/**
 * Escape hatch for the outbox drain, which replays arbitrary control-plane
 * mutations recorded while the device was offline. Same guarantees as every other
 * call here: it never throws, and a dead network is data, not an exception.
 */
export function controlRequest<T>(path: string, opts: ControlOptions = {}): Promise<ApiResponse<T>> {
  return control<T>(path, opts);
}

export type { ControlOptions };

// ── the critical path ─────────────────────────────────────────────────────────

async function postEnvelopeOnce(
  base: string,
  path: string,
  signed: SignedEnvelope,
  via: TransportKind,
  extraFlags = 0,
): Promise<ApiResponse<IngestAck>> {
  try {
    const res = await timedFetch(
      `${base}${path}`,
      { method: 'POST', headers: envelopeHeaders(signed, extraFlags), body: signed.body },
      INGEST_TIMEOUT_MS,
    );

    if (res.ok || res.status === 204) {
      let serverTsMs = Date.now();
      let verified = extraFlags === 0;
      try {
        const text = res.status === 204 ? '' : await res.text();
        if (text) {
          const ack = JSON.parse(text) as { serverTsMs?: number; verified?: boolean };
          if (typeof ack.serverTsMs === 'number') serverTsMs = ack.serverTsMs;
          if (typeof ack.verified === 'boolean') verified = ack.verified;
        }
      } catch {
        // An ack we cannot parse is still an ack: the server took the incident.
      }
      return ok({ incidentId: signed.incidentId, serverTsMs, verified }, via, res.status);
    }

    const problem = await readProblem(res);
    const code = codeFor(res.status, problem.code);

    // ★ KV-1003 — duplicate. This is the dual-endpoint design working exactly as
    //   intended: the other leg got there first. It is a SUCCESS (§2.9.3).
    if (code === 'KV-1003') {
      return ok(
        { incidentId: signed.incidentId, serverTsMs: Date.now(), verified: extraFlags === 0 },
        via,
        res.status,
      );
    }
    return fail<IngestAck>(res.status, code, via, problem.message);
  } catch (e) {
    return fail<IngestAck>(0, 'KV-0000', via, e instanceof Error ? e.message : 'network error');
  }
}

/** The failure we surface when every leg failed: the most actionable one. */
function worst(results: ApiResponse<IngestAck>[]): ApiResponse<IngestAck> {
  const rank: Record<KvCode, number> = {
    'KV-1004': 6, // recoverable by stripping the payload — try that first
    'KV-1002': 5, // recoverable by retrying unverified
    'KV-5001': 4, // escalate transport
    'KV-1005': 3,
    'KV-1001': 2,
    'KV-2001': 1,
    'KV-2002': 1,
    'KV-2003': 1,
    'KV-1003': 0,
    'KV-0000': 0,
  };
  let best = results[0];
  for (const r of results) {
    if ((rank[r.code ?? 'KV-0000'] ?? 0) > (rank[best.code ?? 'KV-0000'] ?? 0)) best = r;
  }
  return best;
}

/**
 * ★ The dual-endpoint fan-out. ★
 * Both legs are launched before either is awaited. We resolve the moment the FIRST
 * one succeeds; Promise.allSettled then supplies the aggregate only if every leg
 * failed. The losing leg is left to finish on its own — it costs one duplicate
 * request, which the server deduplicates, and cancelling it would buy nothing.
 */
async function dualPostEnvelope(
  path: string,
  signed: SignedEnvelope,
  extraFlags = 0,
): Promise<ApiResponse<IngestAck>> {
  const legs: Promise<ApiResponse<IngestAck>>[] = [
    postEnvelopeOnce(CONFIG.apiBase, path, signed, 'http', extraFlags),
    postEnvelopeOnce(CONFIG.apiDirect, path, signed, 'http_direct', extraFlags),
  ];

  const firstSuccess = await new Promise<ApiResponse<IngestAck> | null>((resolve) => {
    let outstanding = legs.length;
    for (const leg of legs) {
      leg.then(
        (r) => {
          if (r.ok) resolve(r);
          else if (--outstanding === 0) resolve(null);
        },
        () => {
          if (--outstanding === 0) resolve(null);
        },
      );
    }
  });
  if (firstSuccess) return firstSuccess;

  const settled = await Promise.allSettled(legs);
  const results = settled
    .map((s) =>
      s.status === 'fulfilled'
        ? s.value
        : fail<IngestAck>(0, 'KV-0000', 'http', 'leg rejected'),
    )
    .filter((r): r is ApiResponse<IngestAck> => Boolean(r));
  return results.length > 0 ? worst(results) : fail<IngestAck>(0, 'KV-0000', 'http', 'no legs');
}

/**
 * KV-1004 recovery. Strip the sealed payload, re-pad to exactly
 * FIXED_ENVELOPE_SIZE and set FLAG_UNVERIFIED in the body.
 *
 * The signature no longer covers these bytes — we cannot re-sign here, because the
 * emergency key deliberately lives behind ../crypto and is held by the T0
 * dispatcher, not by the network layer. That is why callers may pass `rebuild`:
 * when they do, we send a properly signed minimal envelope. When they do not, we
 * send this one flagged unverified and let the server fail open into a known
 * family (§2.9.2). A degraded alert beats no alert (ADR-018).
 */
export function minimalise(signed: SignedEnvelope): SignedEnvelope | null {
  try {
    const env = JSON.parse(signed.body) as IncidentEnvelope;
    const padded = padEnvelope({
      ...env,
      sealedPayload: '',
      flags: (env.flags | FLAG_UNVERIFIED) >>> 0,
      pad: '',
    });
    if (!padded) return null;
    const body = canonicalise(padded);
    // Fail closed on the size property: a short envelope leaks the duress bit (F-01).
    if (new TextEncoder().encode(body).length !== FIXED_ENVELOPE_SIZE) return null;
    return { ...signed, body };
  } catch {
    return null;
  }
}

export interface IngestOptions {
  /**
   * Supplied by the T0 dispatcher, which holds the emergency key. Called with the
   * flags to set so the retry can be properly SIGNED instead of merely flagged.
   */
  rebuild?: (flags: number) => SignedEnvelope | null;
}


async function ingest(
  path: string,
  signed: SignedEnvelope,
  opts: IngestOptions,
): Promise<IngestResult> {
  // Hard rule 8: with no backend the app is still fully functional. The incident
  // is already committed to the local database by the caller; this acknowledges
  // it so nothing upstream waits on a server that was never meant to be running.

  let retriedUnverified = false;
  let retriedMinimal = false;

  let result = await dualPostEnvelope(path, signed);

  // ★ KV-1002 — bad signature. RETRY ANYWAY. ★
  // A token or a key that the server will not verify is not a reason to drop an
  // emergency. Clock skew, a key rotation the server has not seen yet, a device
  // re-enrolled ten seconds ago — all of these produce a 401, and all of them are
  // survivable. The server fails open into a known family and marks the incident
  // unverified (P-007, ADR-018).
  if (!result.ok && result.code === 'KV-1002') {
    const resigned = opts.rebuild?.(FLAG_UNVERIFIED) ?? null;
    retriedUnverified = true;
    result = resigned
      ? await dualPostEnvelope(path, resigned)
      : await dualPostEnvelope(path, signed, FLAG_UNVERIFIED);
  }

  // ★ KV-1004 — too large. Strip the black box and retry minimal. ★
  if (!result.ok && result.code === 'KV-1004') {
    const minimal = opts.rebuild?.(0) ?? minimalise(signed);
    if (minimal) {
      retriedMinimal = true;
      result = await dualPostEnvelope(path, minimal, opts.rebuild ? 0 : FLAG_UNVERIFIED);
    }
  }

  const verified = result.ok ? (result.data?.verified ?? !retriedUnverified) : false;
  return {
    ...result,
    // ★ KV-5001 — downstream unavailable. Tell the caller to climb the transport
    //   ladder NOW rather than retrying HTTP into a hole (§2.9.3).
    escalate: result.escalate || result.code === 'KV-5001',
    verified,
    retriedUnverified,
    retriedMinimal,
  };
}

/** Dual endpoint, first success wins, never rejects. Path from t0/envelope. */
export function postIncidentOpen(
  signed: SignedEnvelope,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  return ingest(INCIDENT_OPEN_PATH, signed, opts);
}

/** The same guarantees; every event is idempotent on hlc. */
export function postIncidentAppend(
  signed: SignedEnvelope,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  return ingest(INCIDENT_APPEND_PATH, signed, opts);
}

/**
 * A peer's ORIGINAL signature and HLC, forwarded intact (§4.4 L1).
 *
 * ★ Nothing calls this, and that is a real gap, not an oversight in the audit. ★
 * The PEER_ONLY rung is currently SEND-ONLY: `t0/dispatcher.legBle` advertises,
 * but `t0/native.ts` exposes no BLE scan, so no peer advertisement is ever
 * received, `t0/smsPayload.decodeSms` is never handed an inbound message, and
 * FLAG_RELAY is never set. Building the receive half needs a native scanner that
 * does not exist in this build. Until it does, the honest thing is that the
 * user-facing copy does not promise a relay — see `degradationReason` in
 * state/store.ts.
 */
export function postIncidentRelay(
  signed: SignedEnvelope,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  return ingest(INCIDENT_RELAY_PATH, signed, opts);
}

// ── control plane ─────────────────────────────────────────────────────────────

export interface ClaimAck {
  incidentId: UUID;
  ownerMemberId: UUID | null;
  at: number;
}

/** P-003/P-030: exactly one owner, and everyone sees who it is. */
export async function postClaim(
  incidentId: UUID,
  memberId: UUID,
): Promise<ApiResponse<ClaimAck>> {
  return control<ClaimAck>(`/v1/incidents/${encodeURIComponent(incidentId)}/claim`, {
    method: 'POST',
    body: { memberId },
    idempotencyKey: `claim:${incidentId}:${memberId}`,
  });
}

/** Releasing must be as easy as claiming, or nobody ever claims (P-030). */
export async function postRelease(
  incidentId: UUID,
  memberId: UUID,
): Promise<ApiResponse<ClaimAck>> {
  return control<ClaimAck>(`/v1/incidents/${encodeURIComponent(incidentId)}/release`, {
    method: 'POST',
    body: { memberId },
    idempotencyKey: `release:${incidentId}:${memberId}:${Date.now()}`,
  });
}

export async function postResolve(
  incidentId: UUID,
  memberId: UUID,
  note: string | null = null,
): Promise<ApiResponse<{ incidentId: UUID; at: number }>> {
  return control(`/v1/incidents/${encodeURIComponent(incidentId)}/resolve`, {
    method: 'POST',
    body: { memberId, note },
    idempotencyKey: `resolve:${incidentId}`,
  });
}

/**
 * The after-action classification. A false alarm that is never labelled a false
 * alarm poisons every threshold the system learns from (P-017).
 */
export async function postClassify(
  incidentId: UUID,
  outcome: IncidentOutcome,
  note: string | null = null,
): Promise<ApiResponse<{ incidentId: UUID; outcome: IncidentOutcome }>> {
  return control(`/v1/incidents/${encodeURIComponent(incidentId)}/classify`, {
    method: 'POST',
    body: { outcome, note },
    idempotencyKey: `classify:${incidentId}:${outcome}`,
  });
}

export interface CheckInInput {
  memberId: UUID;
  at: number;
  journeyId?: UUID | null;
  coarseCell?: string | null;
  note?: string | null;
}

/** "I'm fine." The cheapest, most-used write in the product. */
export async function postCheckIn(input: CheckInInput): Promise<ApiResponse<{ at: number }>> {
  return control('/v1/checkins', {
    method: 'POST',
    body: input,
    idempotencyKey: `checkin:${input.memberId}:${input.at}`,
  });
}

export interface HeartbeatInput {
  deviceId: UUID;
  at: number;
  batteryPct: number | null;
  batteryTempC?: number | null;
  agentHealthy: boolean;
  degradationLevel: number;
  outboxDepth: number;
  diagnostics?: Record<string, boolean | number>;
}

/**
 * FR-034: the heartbeat is how a force-stopped or battery-optimised device is
 * detected at all (P-036). Its absence is the alert, so it is fire-and-forget and
 * failure here is expected and harmless.
 */
export async function postHeartbeat(
  input: HeartbeatInput,
): Promise<ApiResponse<{ at: number }>> {
  return control(`/v1/devices/${encodeURIComponent(input.deviceId)}/heartbeat`, {
    method: 'POST',
    body: input,
    idempotencyKey: `hb:${input.deviceId}:${input.at}`,
    timeoutMs: 8000,
  });
}

/**
 * ★ W10 · 1.35 — the one call that makes this phone reachable with the app closed. ★
 *
 * Until it existed, the server had no address for this handset: an incident
 * reached it only while its WebSocket was alive, so with the app killed the last
 * working leg to another human was SMS.
 *
 * `token` is the FCM registration token — an opaque routing address issued by
 * Google, not a secret and not Class A. The empty string is a MEANINGFUL value,
 * not a skipped call: it is what this device sends when notification permission
 * is revoked, and recording it is what makes the family's delivery matrix say
 * "unreachable by push" instead of the server retrying a dead address forever.
 *
 * Sent on every boot rather than once at enrolment, because FCM rolls tokens on
 * reinstall, restore-from-backup and (rarely) at runtime. A stale token is
 * indistinguishable from a working one until the night it matters.
 */
export async function putDevicePushToken(
  deviceId: UUID,
  token: string,
): Promise<ApiResponse<Device>> {
  return control<Device>(`/v1/devices/${encodeURIComponent(deviceId)}`, {
    method: 'PATCH',
    body: { pushTokenFcm: token },
    // Keyed on the token, so re-sending an unchanged token on every boot is one
    // logical write rather than a new one each time.
    idempotencyKey: `push:${deviceId}:${token}`,
    timeoutMs: 8000,
  });
}

export interface FamilyPayload {
  members: Member[];
  devices: Device[];
}

export async function getFamily(): Promise<ApiResponse<FamilyPayload>> {
  // Demo mode owns no family data — the store seeds and holds it locally. An
  // empty, successful response means "nothing new from the server", which is
  // exactly right and leaves the local roster untouched.
  return control<FamilyPayload>('/v1/family');
}

/** The identity fields POST /v1/family returns (snake_case, straight from the
 *  server row). */
export interface FamilyIdentity {
  id: UUID;
  display_name: string;
  max_members: number;
}

/**
 * ★ Spec E1 — name a family and set its size, server-side. The founding phone
 * already holds `familyId` (store.identity()), so it is sent as `id`: the server
 * row, the enrolment bus and sos-ingest's gate all key on the SAME id the phone
 * uses, and a retry over a second transport is idempotent on it. The SAS pairing
 * still admits devices (E6); this only names and sizes the family. Fail-soft like
 * every call here — a dead network is data, not an exception.
 */
export async function createFamily(
  displayName: string,
  maxMembers: number,
): Promise<ApiResponse<FamilyIdentity>> {
  return control<FamilyIdentity>('/v1/family', {
    method: 'POST',
    body: { id: familyId, displayName, maxMembers },
    idempotencyKey: `family:${familyId}`,
  });
}

export async function getIncidents(
  sinceHlc?: string,
  limit = 50,
): Promise<ApiResponse<Incident[]>> {
  // An HLC is a clock reading, not personal data — safe in a query string.
  // (React Native's URLSearchParams is a partial stub; build the query by hand.)
  const parts = [`limit=${encodeURIComponent(limit)}`];
  if (sinceHlc) parts.push(`since=${encodeURIComponent(sinceHlc)}`);
  return control<Incident[]>(`/v1/incidents?${parts.join('&')}`);
}

/**
 * ADR-013: the policy is server-authoritative and versioned. The device caches it
 * and never writes one, because two divergent escalation policies is an
 * unrecoverable bug class.
 */
export async function getPolicy(): Promise<ApiResponse<EscalationPolicy>> {
  return control<EscalationPolicy>('/v1/policies/current');
}

export interface ConsentInput {
  id: UUID;
  grantorMemberId: UUID;
  granteeMemberId: UUID;
  scope: ConsentScope;
  purpose: ConsentPurpose;
  expiresAt: number;
}

export async function postConsent(input: ConsentInput): Promise<ApiResponse<ConsentGrant>> {
  return control<ConsentGrant>('/v1/consents', {
    method: 'POST',
    body: input,
    idempotencyKey: `consent:${input.id}`,
  });
}

/**
 * F-14 layer 1. Revocation is instant and MUST NOT depend on the server being up —
 * the caller has already revoked locally before this is ever called.
 */
export async function deleteConsent(id: UUID): Promise<ApiResponse<null>> {
  return control<null>(`/v1/consents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    idempotencyKey: `consent:revoke:${id}`,
  });
}

export async function getAccessLog(limit = 100): Promise<ApiResponse<AccessLogEntry[]>> {
  return control<AccessLogEntry[]>(`/v1/consents/access-log?limit=${encodeURIComponent(limit)}`);
}

/**
 * Ring a family device at full volume. This is a consent-bearing action — it is
 * logged to the access log by the caller, not silently performed.
 */
export async function postFindPhone(
  targetDeviceId: UUID,
): Promise<ApiResponse<{ deviceId: UUID; at: number }>> {
  return control(`/v1/find-phone/${encodeURIComponent(targetDeviceId)}`, {
    method: 'POST',
    body: {},
    idempotencyKey: `findphone:${targetDeviceId}:${Date.now()}`,
  });
}

/** F-03: audienceDeviceIds is what stops a canary waking the family at 03:00. */
export async function postDrill(drill: DrillRun): Promise<ApiResponse<DrillRun>> {
  return control<DrillRun>('/v1/drills', {
    method: 'POST',
    body: drill,
    idempotencyKey: `drill:${drill.id}`,
  });
}

/**
 * The corridor points are stripped by stripClassA before this leaves the device
 * (ADR-010): the server learns that a journey exists and when it is due, never
 * the route it follows.
 */
export async function postJourney(journey: Journey): Promise<ApiResponse<Journey>> {
  return control<Journey>('/v1/journeys', {
    method: 'POST',
    body: journey,
    idempotencyKey: `journey:${journey.id}`,
  });
}

export interface RtTicket {
  ticket: string;
  expiresIn: number;
}

/**
 * F-16: a single-use, 60 s, device-bound connect ticket. It exists so that nothing
 * sensitive ever enters a URL — see ./ws.ts, which puts it in the
 * Sec-WebSocket-Protocol slot and never in the query string (I-6).
 */
export async function postRtTicket(): Promise<ApiResponse<RtTicket>> {
  return control<RtTicket>('/v1/rt/ticket', { method: 'POST', body: {}, timeoutMs: 8000 });
}
