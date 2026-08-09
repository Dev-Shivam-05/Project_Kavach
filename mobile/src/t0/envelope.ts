/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · THE SIGNED EMERGENCY ENVELOPE
 *
 * PRD P-007: the SOS ingest endpoint does NOT accept bearer tokens at all. The
 * access token expiring and the endpoint returning 401 is a real, common,
 * entirely preventable bug that has killed people in production systems.
 * Instead the body is signed with a hardware-backed Ed25519 key that is
 * deliberately NOT biometric-gated.
 *
 * ★ FINDING F-01 — THE CONSTANT-SIZE FIX ★
 * The PRD asserts the duress flag is "ALWAYS present, ALWAYS same wire size".
 * That is false for a plain proto3 `bool`: a `false` value is omitted from the
 * wire entirely, so a duress envelope would be strictly larger. The whole
 * constant-size argument — the mitigation for threat T4, an attacker with
 * physical access watching the network — rested on a false premise.
 *
 * Here the envelope is JSON, and we enforce the property directly and testably:
 *   1. `duress` is ALWAYS serialised, both values.
 *   2. The envelope is padded to a FIXED total byte length after serialisation.
 *   3. The padding assertion FAILS CLOSED — a mis-padded envelope would silently
 *      leak the duress bit, so we would rather refuse to build it and fall back
 *      to a transport that does not carry the flag at all.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import type { RiskLevel, TriggerType, UUID } from '../core/types';
import { bytesToBase64, signEmergency, type DeviceKeypair } from '../crypto';
import { nowHlc } from '../core/ids';

/** Every IncidentOpen envelope is padded to exactly this many bytes. */
export const FIXED_ENVELOPE_SIZE = 1024;

export interface IncidentEnvelope {
  v: 1;
  incidentId: UUID;
  familyId: UUID;
  deviceId: UUID;
  memberId: UUID;
  clientTsMs: number;
  hlc: string;
  trigger: TriggerType;
  confidencePct: number;
  riskContext: RiskLevel;
  /** ★ ALWAYS present, both values. Never omitted. (F-01) */
  duress: boolean;
  isDrill: boolean;
  policyVersion: number;
  /** ≈1 km cell. Server-readable, routing only. */
  coarseCell: string;
  batteryPct: number;
  /** Class A: MLS/GroupBox ciphertext. The server routes it; it cannot read it. */
  sealedPayload: string;
  flags: number;
  /** Pad to FIXED_ENVELOPE_SIZE. Computed after a trial serialisation. */
  pad: string;
}

export const FLAG_UNVERIFIED = 1 << 0;
export const FLAG_RELAY = 1 << 1;
export const FLAG_SMS_ORIGIN = 1 << 2;
export const FLAG_UNVERIFIED_FLOOD = 1 << 3;

export interface SignedEnvelope {
  body: string; // canonical JSON, exactly FIXED_ENVELOPE_SIZE bytes
  signature: string; // base64 Ed25519 over the body bytes
  deviceId: UUID;
  incidentId: UUID;
}

// ── The wire contract (docs/02-System-Architecture.md §2.9.2) ─────────────────

/**
 * ★ THE PATHS AND HEADERS LIVE HERE, NOT IN THE TWO CALLERS. ★
 *
 * `t0/dispatcher` fires the two hot-path HTTP legs and `net/api` fires the outbox
 * replay, and they drifted: the dispatcher posted to `/v1/incident` with
 * `x-kavach-*` headers while the contract and the outbox both used
 * `/v1/incident/open` with `X-Device-Id`/`X-Sig`. Both F-05 legs — the whole
 * point of the dual-endpoint design and the two legs the 150 ms t2 budget is
 * spent on — 404'd on every single SOS, and the incident only reached the server
 * up to 30 s later on the outbox drain. Nothing surfaced it: the 404 was recorded
 * into a `dispatchStats()` no screen reads, and the fan-out reported success.
 *
 * One definition, imported by both, so they cannot disagree again.
 */
export const INCIDENT_OPEN_PATH = '/v1/incident/open';
export const INCIDENT_APPEND_PATH = '/v1/incident/append';
export const INCIDENT_RELAY_PATH = '/v1/incident/relay';

/**
 * The envelope goes on the wire AS ITS OWN BODY — exactly FIXED_ENVELOPE_SIZE
 * bytes, signature in a header. Wrapping it in an outer JSON object would make
 * the request length depend on the signature's base64 length and quietly destroy
 * the constant-size property that F-01 exists to guarantee.
 *
 * P-007: no bearer token, ever. The body is signed with the non-biometric
 * emergency key, so an expired session cannot turn an SOS into a 401.
 */
export function envelopeHeaders(signed: SignedEnvelope, extraFlags = 0): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/kavach-envelope+json',
    'X-Device-Id': signed.deviceId,
    'X-Sig': signed.signature,
    'X-Incident-Id': signed.incidentId,
  };
  if (extraFlags) headers['X-Kavach-Flags'] = String(extraFlags);
  return headers;
}

/** Deterministic key order — the server must reproduce these bytes to verify. */
const KEY_ORDER: (keyof IncidentEnvelope)[] = [
  'v', 'incidentId', 'familyId', 'deviceId', 'memberId', 'clientTsMs', 'hlc',
  'trigger', 'confidencePct', 'riskContext', 'duress', 'isDrill', 'policyVersion',
  'coarseCell', 'batteryPct', 'sealedPayload', 'flags', 'pad',
];

export function canonicalise(env: IncidentEnvelope): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) ordered[k] = env[k];
  return JSON.stringify(ordered);
}

const byteLen = (s: string) => new TextEncoder().encode(s).length;

/**
 * Pad to exactly FIXED_ENVELOPE_SIZE.
 *
 * Returns null when the payload cannot fit — the caller MUST then drop the
 * sealed payload and retry minimal rather than emit a variable-size envelope.
 * Failing closed here is deliberate: silently emitting a short envelope is a
 * side channel that reveals duress.
 */
export function padEnvelope(env: IncidentEnvelope): IncidentEnvelope | null {
  const trial = { ...env, pad: '' };
  const base = byteLen(canonicalise(trial));
  const needed = FIXED_ENVELOPE_SIZE - base;
  if (needed < 0) return null;
  return { ...env, pad: '.'.repeat(needed) };
}

export interface BuildEnvelopeInput {
  incidentId: UUID;
  familyId: UUID;
  deviceId: UUID;
  memberId: UUID;
  trigger: TriggerType;
  confidencePct: number;
  riskContext: RiskLevel;
  duress: boolean;
  isDrill: boolean;
  policyVersion: number;
  coarseCell: string;
  batteryPct: number;
  sealedPayload: string;
  flags?: number;
}

export class EnvelopeSizeError extends Error {
  constructor(actual: number) {
    super(`envelope is ${actual} bytes, expected exactly ${FIXED_ENVELOPE_SIZE}`);
    this.name = 'EnvelopeSizeError';
  }
}

/**
 * Build and sign. Throws EnvelopeSizeError if the fixed-size property cannot be
 * met — callers catch this and fall back to a minimal envelope (KV-1004
 * semantics), never to a variable-size one.
 */
export function buildSignedEnvelope(
  input: BuildEnvelopeInput,
  keypair: DeviceKeypair,
): SignedEnvelope {
  const draft: IncidentEnvelope = {
    v: 1,
    incidentId: input.incidentId,
    familyId: input.familyId,
    deviceId: input.deviceId,
    memberId: input.memberId,
    clientTsMs: Date.now(),
    hlc: nowHlc().hex,
    trigger: input.trigger,
    confidencePct: Math.round(input.confidencePct),
    riskContext: input.riskContext,
    duress: input.duress,
    isDrill: input.isDrill,
    policyVersion: input.policyVersion,
    coarseCell: input.coarseCell,
    batteryPct: Math.round(input.batteryPct),
    sealedPayload: input.sealedPayload,
    flags: input.flags ?? 0,
    pad: '',
  };

  const padded = padEnvelope(draft);
  if (!padded) throw new EnvelopeSizeError(byteLen(canonicalise(draft)));

  const body = canonicalise(padded);
  const actual = byteLen(body);
  // Fail closed. A mis-padded envelope leaks the duress bit.
  if (actual !== FIXED_ENVELOPE_SIZE) throw new EnvelopeSizeError(actual);

  const sig = signEmergency(new TextEncoder().encode(body), keypair);
  return {
    body,
    signature: bytesToBase64(sig),
    deviceId: input.deviceId,
    incidentId: input.incidentId,
  };
}

/**
 * The minimal fallback envelope: no sealed payload, still fixed-size, still
 * signed. Used when the black box or medical record would blow the budget
 * (PRD KV-1004: "strip the black box; retry with a minimal payload").
 */
export function buildMinimalEnvelope(
  input: BuildEnvelopeInput,
  keypair: DeviceKeypair,
): SignedEnvelope {
  return buildSignedEnvelope({ ...input, sealedPayload: '' }, keypair);
}
