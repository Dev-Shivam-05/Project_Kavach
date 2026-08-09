/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · THE PARALLEL TRANSPORT FAN-OUT   (PRD §4.4, docs/02 §2.7.2, I-9, F-05)
 *
 * ★ THE RULE ★
 *   "L1–L4 fire IN PARALLEL, not in sequence. Server deduplicates by incident
 *    UUID. Five redundant messages cost ₹1.20. Sequential fallback costs 45
 *    seconds. You are racing a clock."
 *
 * Do the arithmetic once and it never has to be argued again. A sequential
 * ladder that tries WebSocket (5 s timeout) → HTTPS (10 s) → direct (10 s) →
 * BLE (5 s) → SMS spends up to 45 seconds discovering what it could have
 * discovered in parallel in 300 ms. Forty-five seconds is the difference
 * between a survivable head injury and a fatal one. The redundant traffic costs
 * one duplicate HTTP request (free) and, at worst, four extra SMS at ~₹0.30 —
 * ₹1.20 per incident, for a family that has perhaps two incidents a year.
 * There is no cost side to this trade.
 *
 * ★ fanOut RETURNS void. ★ Nothing awaits it. Every leg is launched
 * synchronously before any of them can resolve, so it is STRUCTURALLY
 * impossible to accidentally sequence them (invariant I-9, R3). The function
 * body must never contain an `await` between two leg launches.
 *
 * ★ F-05, THE CLOUDFLARE-BYPASS LEG ★
 * The architecture survives loss of the control plane, Postgres, NATS, the
 * region and the provider — but not of the CDN in front of it. So we pin TWO
 * ingest endpoints with two DNS names, two TLS chains, two pinned key sets, and
 * fire both. The server deduplicates on the client-generated incident_id
 * (P-053), so the duplicate is free.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { CONFIG } from '../core/config';
import { DegradationLevel, type OutboxItem, type TransportKind, type UUID } from '../core/types';
import { envelopeHeaders, INCIDENT_OPEN_PATH, type SignedEnvelope } from './envelope';
import { bleAdvertise, sendSmsDirect } from './native';

const HTTP_TIMEOUT_MS = 15_000;
const BLE_TTL_MS = 120_000;
const OUTBOX_LIMIT = 500;

export interface FanOutContext {
  /** Current ladder position (§4.4). Determines whether SMS fires immediately. */
  degradation: DegradationLevel;
  familyId: UUID;
  /** Pure-ASCII ≤160 char payload from smsPayload.encodeSms(). */
  smsText: string;
  /** Every family number AND the aggregator inbound number (docs/02 §2.7.5). */
  smsRecipients: string[];
  /** Base64 BLE distress advertisement body, already HMAC-tagged (F-12). */
  bleAdvert?: string;
  /**
   * Which outbox row this fan-out becomes. Everything used to be recorded as
   * `incident_open`, so the cancel/duress envelope — the one thing that MUST
   * survive a basement with no signal — was enqueued as a duplicate open the
   * server deduplicates away, and the duress bit was simply never delivered.
   * Defaults to 'open' so an omitted field cannot silently change the wire.
   */
  kind?: 'open' | 'event';
  /**
   * P-054. A roaming SIM can have its SMS leg silently barred by the visited
   * network, so an "attempted" SMS is weaker evidence than it looks. Read from a
   * cache, never awaited — this is the hot path.
   */
  roaming?: boolean;
  isDrill: boolean;
  /**
   * ★ I-7: duress changes NOTHING about the fan-out. Same legs, same schedule,
   * same fixed-size envelope. Carried only so the outbox record is complete.
   */
  duress: boolean;
}

export interface TransportOutcome {
  transport: TransportKind;
  attempts: number;
  successes: number;
  failures: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
}

export interface IncidentDispatch {
  incidentId: UUID;
  startedAt: number;
  /** t2 — first byte confirmed to have left the device on any transport. */
  firstTransmitAt: number | null;
  firstTransport: TransportKind | null;
  ackedAt: number | null;
  smsSentAt: number | null;
  smsScheduledFor: number | null;
  legs: TransportKind[];
  /** P-054: the SMS leg's "sent" is worth less when this is true. */
  roaming: boolean;
}

const TRANSPORTS: TransportKind[] = ['ws', 'http', 'http_direct', 'sms', 'ble_relay', 'push', 'local'];

const outcomes = new Map<TransportKind, TransportOutcome>();
for (const t of TRANSPORTS) {
  outcomes.set(t, {
    transport: t,
    attempts: 0,
    successes: 0,
    failures: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastLatencyMs: null,
    lastError: null,
  });
}

const dispatches = new Map<UUID, IncidentDispatch>();
const smsTimers = new Map<UUID, ReturnType<typeof setTimeout>>();
const outbox: OutboxItem[] = [];
let outboxSeq = 1;
let outboxSink: ((item: OutboxItem) => void) | null = null;
let fanOutCount = 0;

// ── Warm socket registry ──────────────────────────────────────────────────────

type WarmSend = (payload: string) => boolean;
let warmSend: WarmSend | null = null;

/**
 * ★ Never dial on the hot path. ★ A TCP+TLS+WebSocket handshake is 200–800 ms on
 * Indian mobile data and can block behind DNS for far longer. The socket is
 * opened by the T1 realtime plane when risk context rises (§13.5 pre-warms it);
 * if it is not already open when the trigger fires, we simply skip this leg and
 * let HTTP do the work.
 */
export function registerWarmSocket(send: WarmSend): void {
  warmSend = send;
}

export function clearWarmSocket(): void {
  warmSend = null;
}

export function isSocketWarm(): boolean {
  return warmSend !== null;
}

// ── Outbox ────────────────────────────────────────────────────────────────────

export function setOutboxSink(sink: ((item: OutboxItem) => void) | null): void {
  outboxSink = sink;
}

function emitOutbox(item: OutboxItem): void {
  try {
    outboxSink?.(item);
  } catch {
    // Persistence failing must not affect the transports.
  }
}

function newOutboxItem(env: SignedEnvelope, ctx: FanOutContext): OutboxItem {
  const item: OutboxItem = {
    id: outboxSeq++,
    kind: ctx.kind === 'event' ? 'incident_event' : 'incident_open',
    payload: JSON.stringify({
      body: env.body,
      signature: env.signature,
      deviceId: env.deviceId,
      incidentId: env.incidentId,
      familyId: ctx.familyId,
      duress: ctx.duress,
      isDrill: ctx.isDrill,
    }),
    incidentId: env.incidentId,
    createdAt: Date.now(),
    attempts: 0,
    lastAttemptAt: null,
    transportAttempts: {},
    delivered: false,
  };
  outbox.push(item);
  if (outbox.length > OUTBOX_LIMIT) outbox.splice(0, outbox.length - OUTBOX_LIMIT);
  emitOutbox(item);
  return item;
}

function record(
  item: OutboxItem,
  incidentId: UUID,
  transport: TransportKind,
  ok: boolean,
  startedAt: number,
  error?: string,
): void {
  const now = Date.now();
  const o = outcomes.get(transport);
  if (o) {
    o.attempts++;
    o.lastAttemptAt = now;
    o.lastLatencyMs = now - startedAt;
    if (ok) {
      o.successes++;
      o.lastSuccessAt = now;
      o.lastError = null;
    } else {
      o.failures++;
      o.lastError = error ?? 'failed';
    }
  }

  item.attempts++;
  item.lastAttemptAt = now;
  item.transportAttempts[transport] = (item.transportAttempts[transport] ?? 0) + 1;
  if (ok) item.delivered = true;
  emitOutbox(item);

  const d = dispatches.get(incidentId);
  if (d && ok && d.firstTransmitAt === null) {
    d.firstTransmitAt = now;
    d.firstTransport = transport;
  }
}

// ── Legs ──────────────────────────────────────────────────────────────────────

function legWebSocket(env: SignedEnvelope, item: OutboxItem): boolean {
  const send = warmSend;
  if (!send) return false;
  const startedAt = Date.now();
  try {
    const ok = send(
      JSON.stringify({ t: 'incident_open', body: env.body, signature: env.signature, deviceId: env.deviceId }),
    );
    record(item, env.incidentId, 'ws', ok, startedAt, ok ? undefined : 'socket refused');
    return ok;
  } catch (e) {
    record(item, env.incidentId, 'ws', false, startedAt, String(e));
    return false;
  }
}

function legHttp(
  base: string,
  transport: TransportKind,
  env: SignedEnvelope,
  item: OutboxItem,
): void {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  // ★ Path and headers come from t0/envelope, which net/api.ts also imports. This
  //   leg does NOT go through net/api: that module short-circuits on demo mode
  //   and synthesises an ack, and the hot path must put real bytes on the wire or
  //   record a real failure. The shared constants are what stop the two drifting.
  void fetch(`${base}${INCIDENT_OPEN_PATH}`, {
    method: 'POST',
    headers: envelopeHeaders(env),
    body: env.body,
    signal: controller.signal,
  })
    .then((res) => {
      clearTimeout(timer);
      record(item, env.incidentId, transport, res.ok, startedAt, res.ok ? undefined : `HTTP ${res.status}`);
    })
    .catch((e: unknown) => {
      clearTimeout(timer);
      // Demo mode / airplane mode / dead server all land here. Failing soft is
      // the whole point: the alarm, the SMS and the BLE advert are unaffected.
      record(item, env.incidentId, transport, false, startedAt, String(e));
    });
}

function legBle(env: SignedEnvelope, ctx: FanOutContext, item: OutboxItem): void {
  const startedAt = Date.now();
  const advert = ctx.bleAdvert;
  if (!advert) {
    record(item, env.incidentId, 'ble_relay', false, startedAt, 'no advert body');
    return;
  }
  void bleAdvertise(advert, BLE_TTL_MS)
    .then((ok) => {
      // Without the native module this is false: the intent is recorded in the
      // outbox so the peer plane can replay it when BLE becomes available.
      record(item, env.incidentId, 'ble_relay', ok, startedAt, ok ? undefined : 'ble unavailable');
    })
    .catch((e: unknown) => {
      record(item, env.incidentId, 'ble_relay', false, startedAt, String(e));
    });
}

function legSms(env: SignedEnvelope, ctx: FanOutContext, item: OutboxItem): void {
  const startedAt = Date.now();
  const d = dispatches.get(env.incidentId);
  if (d) d.smsSentAt = startedAt;
  void sendSmsDirect(ctx.smsRecipients, ctx.smsText)
    .then(({ sent, failed }) => {
      // P-054: on a visited network the SMS leg can be barred without an error,
      // so a failure while roaming has a likely cause worth naming. The roaming
      // state itself rides on IncidentDispatch for the success case.
      record(
        item,
        env.incidentId,
        'sms',
        sent.length > 0,
        startedAt,
        failed.length > 0
          ? `${failed.length} recipient(s) failed${ctx.roaming === true ? '; roaming, the visited network may be barring SMS' : ''}`
          : undefined,
      );
    })
    .catch((e: unknown) => {
      record(item, env.incidentId, 'sms', false, startedAt, String(e));
    });
}

// ── fanOut ────────────────────────────────────────────────────────────────────

/**
 * Fire every available transport at once and return immediately.
 *
 * ★ Do not add an `await` to this function. ★ Every leg below is launched
 * without awaiting the previous one; the promises are deliberately dangling and
 * every one of them catches its own errors.
 */
export function fanOut(env: SignedEnvelope, ctx: FanOutContext): void {
  fanOutCount++;
  const item = newOutboxItem(env, ctx);
  const now = Date.now();

  const dispatch: IncidentDispatch = {
    incidentId: env.incidentId,
    startedAt: now,
    firstTransmitAt: null,
    firstTransport: null,
    ackedAt: null,
    smsSentAt: null,
    smsScheduledFor: null,
    legs: [],
    roaming: ctx.roaming === true,
  };
  dispatches.set(env.incidentId, dispatch);

  // 1. WebSocket — free when already open, skipped entirely when not.
  if (warmSend !== null) {
    dispatch.legs.push('ws');
    legWebSocket(env, item);
  }

  // 2 + 3. Both ingest endpoints, always, in parallel (F-05).
  dispatch.legs.push('http');
  legHttp(CONFIG.apiBase, 'http', env, item);
  dispatch.legs.push('http_direct');
  legHttp(CONFIG.apiDirect, 'http_direct', env, item);

  // 4. BLE distress advertisement — costs nothing and works with zero towers.
  dispatch.legs.push('ble_relay');
  legBle(env, ctx, item);

  // 5. SMS. Immediate when data is already known to be gone; otherwise after a
  //    short ack wait, because an SMS the family reads twenty seconds after the
  //    push they already answered is noise that trains people to ignore it.
  if (ctx.smsRecipients.length > 0) {
    dispatch.legs.push('sms');
    if (ctx.degradation <= DegradationLevel.SMS_ONLY) {
      legSms(env, ctx, item);
    } else {
      dispatch.smsScheduledFor = now + CONFIG.ackWaitBeforeSmsMs;
      const timer = setTimeout(() => {
        smsTimers.delete(env.incidentId);
        const d = dispatches.get(env.incidentId);
        if (d && d.ackedAt !== null) return; // someone is already on it
        legSms(env, ctx, item);
      }, CONFIG.ackWaitBeforeSmsMs);
      smsTimers.set(env.incidentId, timer);
    }
  }
}

/**
 * t4. Cancels a pending SMS leg — but never one already sent, and never the
 * transports that have already fired. An ack is information, not a rollback.
 */
export function noteAck(incidentId: UUID, at: number = Date.now()): void {
  const d = dispatches.get(incidentId);
  if (d && d.ackedAt === null) d.ackedAt = at;
  const timer = smsTimers.get(incidentId);
  if (timer !== undefined) {
    clearTimeout(timer);
    smsTimers.delete(incidentId);
    if (d) d.smsScheduledFor = null;
  }
}

/** Force the SMS tier early — the escalation ladder's `smsTierAfterS` step. */
export function forceSms(env: SignedEnvelope, ctx: FanOutContext): void {
  const timer = smsTimers.get(env.incidentId);
  if (timer !== undefined) {
    clearTimeout(timer);
    smsTimers.delete(env.incidentId);
  }
  if (ctx.smsRecipients.length === 0) return;
  const item = newOutboxItem(env, ctx);
  legSms(env, ctx, item);
}

/** Stop the pending SMS for a cancelled incident (FALSE_ALARM only). */
export function cancelPendingSms(incidentId: UUID): void {
  const timer = smsTimers.get(incidentId);
  if (timer !== undefined) {
    clearTimeout(timer);
    smsTimers.delete(incidentId);
  }
  const d = dispatches.get(incidentId);
  if (d) d.smsScheduledFor = null;
}

export interface DispatchStats {
  fanOutCount: number;
  socketWarm: boolean;
  outboxDepth: number;
  undeliveredDepth: number;
  byTransport: TransportOutcome[];
  incidents: IncidentDispatch[];
  /** t0→t2 for the most recent incident, ms. Budget is 500 ms (§2.3). */
  lastFirstTransmitMs: number | null;
}

export function dispatchStats(): DispatchStats {
  const incidents = Array.from(dispatches.values()).sort((a, b) => b.startedAt - a.startedAt);
  const latest = incidents[0];
  return {
    fanOutCount,
    socketWarm: warmSend !== null,
    outboxDepth: outbox.length,
    undeliveredDepth: outbox.filter((o) => !o.delivered).length,
    byTransport: Array.from(outcomes.values()).map((o) => ({ ...o })),
    incidents,
    lastFirstTransmitMs:
      latest && latest.firstTransmitAt !== null ? latest.firstTransmitAt - latest.startedAt : null,
  };
}

export function outboxItems(): readonly OutboxItem[] {
  return outbox;
}

export function outboxDepth(): number {
  return outbox.filter((o) => !o.delivered).length;
}

/** Drop delivered records once the persistence layer has them. */
export function pruneOutbox(): void {
  for (let i = outbox.length - 1; i >= 0; i--) {
    if (outbox[i].delivered) outbox.splice(i, 1);
  }
}
