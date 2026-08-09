/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * OUTBOX DRAIN
 *
 * §2.10.4 — every mutation executes locally first and lands in the outbox. This
 * is the thing that eventually gets it to the server. Three properties matter:
 *
 *   ★ PARALLEL, NOT SEQUENTIAL. A queue drained one item at a time behind a slow
 *     request is how a family comes back into coverage and still waits ninety
 *     seconds for their timeline. Items are independent; they go out together.
 *
 *   ★ IDEMPOTENT. The server deduplicates on (incident_id, hlc) — P-053, §2.10.5 —
 *     so replaying an item the server already has is free and correct. That is
 *     what makes "mark delivered only after a confirmed success" safe: the worst
 *     case is a duplicate, and a duplicate is a no-op.
 *
 *   ★ TRIGGERED BY CONNECTIVITY, NOT ONLY BY A TIMER. Coming back onto a network
 *     is the single most valuable moment to drain, and waiting out an interval
 *     there would waste the whole window.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { CONFIG } from '../core/config';
import { DegradationLevel, type OutboxItem, type TransportKind, type UUID } from '../core/types';
import { outboxRepo } from '../db/repos';
import type { SignedEnvelope } from '../t0/envelope';
import {
  controlRequest,
  postCheckIn,
  postConsent,
  postHeartbeat,
  postIncidentAppend,
  postIncidentOpen,
  deleteConsent,
  type ApiResponse,
  type CheckInInput,
  type ConsentInput,
  type HeartbeatInput,
} from './api';
import { currentDegradation, subscribeDegradation } from './connectivity';

/** Batch size per pass. Large enough to catch up, small enough to stay responsive. */
const BATCH = 40;
/** Parallel legs. Beyond this the radio, not the server, becomes the bottleneck. */
const CONCURRENCY = 6;
const DRAIN_INTERVAL_MS = 30_000;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60_000;
/**
 * After this many failures an item is parked for a day. It stays in the outbox and
 * keeps counting towards the depth the UI shows, because pretending a stuck
 * mutation was delivered is exactly the dishonesty this product exists to avoid.
 */
const MAX_ATTEMPTS = 12;
const PARKED_MS = 24 * 60 * 60_000;

// ── payload shapes (the contract between the store and this drain) ────────────

export interface OutboxEnvelopePayload {
  signed: SignedEnvelope;
}

export interface OutboxConsentPayload {
  op: 'grant' | 'revoke';
  grant?: ConsentInput;
  id?: UUID;
}

export interface OutboxGenericPayload {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

// ── enqueue helpers ───────────────────────────────────────────────────────────

/**
 * The T0 path writes the incident locally, fans out over every live transport,
 * AND enqueues here. The fan-out is the fast path; this is the guarantee.
 */
export function enqueueIncidentOpen(signed: SignedEnvelope, hlc: string): Promise<number> {
  return outboxRepo.enqueue({
    kind: 'incident_open',
    payload: JSON.stringify({ signed } satisfies OutboxEnvelopePayload),
    incidentId: signed.incidentId,
    dedupeKey: `open:${signed.incidentId}:${hlc}`,
  });
}

export function enqueueIncidentEvent(signed: SignedEnvelope, hlc: string): Promise<number> {
  return outboxRepo.enqueue({
    kind: 'incident_event',
    payload: JSON.stringify({ signed } satisfies OutboxEnvelopePayload),
    incidentId: signed.incidentId,
    dedupeKey: `event:${signed.incidentId}:${hlc}`,
  });
}

export function enqueueCheckIn(input: CheckInInput): Promise<number> {
  return outboxRepo.enqueue({
    kind: 'checkin',
    payload: JSON.stringify(input),
    dedupeKey: `checkin:${input.memberId}:${input.at}`,
  });
}

export function enqueueHeartbeat(input: HeartbeatInput): Promise<number> {
  return outboxRepo.enqueue({
    kind: 'heartbeat',
    payload: JSON.stringify(input),
    dedupeKey: `hb:${input.deviceId}:${input.at}`,
  });
}

export function enqueueConsentGrant(grant: ConsentInput): Promise<number> {
  return outboxRepo.enqueue({
    kind: 'consent',
    payload: JSON.stringify({ op: 'grant', grant } satisfies OutboxConsentPayload),
    dedupeKey: `consent:grant:${grant.id}`,
  });
}

/** F-14: already revoked locally by the time this is queued. This only tells the server. */
export function enqueueConsentRevoke(id: UUID): Promise<number> {
  return outboxRepo.enqueue({
    kind: 'consent',
    payload: JSON.stringify({ op: 'revoke', id } satisfies OutboxConsentPayload),
    dedupeKey: `consent:revoke:${id}`,
  });
}

export function enqueueGeneric(
  payload: OutboxGenericPayload,
  dedupeKey?: string,
): Promise<number> {
  return outboxRepo.enqueue({
    kind: 'generic',
    payload: JSON.stringify(payload),
    dedupeKey: dedupeKey ?? null,
  });
}

// ── dispatch ──────────────────────────────────────────────────────────────────

function parse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

interface Attempted {
  ok: boolean;
  code: string | null;
  via: TransportKind;
  message: string | null;
}

const asAttempt = (r: ApiResponse<unknown>): Attempted => ({
  ok: r.ok,
  code: r.code,
  via: r.via,
  message: r.message,
});

async function dispatch(item: OutboxItem): Promise<Attempted> {
  switch (item.kind) {
    case 'incident_open': {
      const p = parse<OutboxEnvelopePayload>(item.payload);
      if (!p?.signed) return { ok: false, code: 'KV-1001', via: 'http', message: 'unparseable' };
      const res = await postIncidentOpen(p.signed);
      return asAttempt(res);
    }
    case 'incident_event': {
      const p = parse<OutboxEnvelopePayload>(item.payload);
      if (!p?.signed) return { ok: false, code: 'KV-1001', via: 'http', message: 'unparseable' };
      const res = await postIncidentAppend(p.signed);
      return asAttempt(res);
    }
    case 'checkin': {
      const p = parse<CheckInInput>(item.payload);
      if (!p) return { ok: false, code: 'KV-1001', via: 'http', message: 'unparseable' };
      return asAttempt(await postCheckIn(p));
    }
    case 'heartbeat': {
      const p = parse<HeartbeatInput>(item.payload);
      if (!p) return { ok: false, code: 'KV-1001', via: 'http', message: 'unparseable' };
      return asAttempt(await postHeartbeat(p));
    }
    case 'consent': {
      const p = parse<OutboxConsentPayload>(item.payload);
      if (!p) return { ok: false, code: 'KV-1001', via: 'http', message: 'unparseable' };
      if (p.op === 'revoke' && p.id) return asAttempt(await deleteConsent(p.id));
      if (p.op === 'grant' && p.grant) return asAttempt(await postConsent(p.grant));
      return { ok: false, code: 'KV-1001', via: 'http', message: 'incomplete consent item' };
    }
    default: {
      const p = parse<OutboxGenericPayload>(item.payload);
      if (!p?.path) return { ok: false, code: 'KV-1001', via: 'http', message: 'unparseable' };
      return asAttempt(
        await controlRequest(p.path, {
          method: p.method,
          body: p.body,
          idempotencyKey: p.idempotencyKey,
        }),
      );
    }
  }
}

/** Exponential with jitter, so a family's five devices do not retry in lockstep. */
function nextAttemptAt(item: OutboxItem, now: number): number {
  if (item.attempts + 1 >= MAX_ATTEMPTS) return now + PARKED_MS;
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, item.attempts));
  return now + Math.round(base * (0.7 + Math.random() * 0.6));
}

// ── the loop ──────────────────────────────────────────────────────────────────

export interface DrainResult {
  attempted: number;
  delivered: number;
  failed: number;
  skipped: boolean;
  reason: string;
}

let draining = false;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribeDegradation: (() => void) | null = null;
let lastResult: DrainResult | null = null;
let lastRunAt = 0;

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        for (;;) {
          const index = cursor++;
          if (index >= items.length) return;
          await fn(items[index]);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

/**
 * One pass. Never throws — it is called from timers, from connectivity callbacks
 * and from app-state transitions, none of which have anywhere to put an error.
 */
export async function drainOnce(reason = 'manual'): Promise<DrainResult> {
  if (draining) {
    return { attempted: 0, delivered: 0, failed: 0, skipped: true, reason: 'already draining' };
  }
  draining = true;
  try {
    // Demo mode delivers locally and synthetically, so connectivity is irrelevant
    // — the queue must still drain or the outbox depth grows forever (hard rule 8).
    if (!CONFIG.demoMode) {
      const level = await currentDegradation();
      if (level < DegradationLevel.HTTP_ONLY) {
        // No data path. SMS and BLE are the T0 dispatcher's job, not the outbox's;
        // retrying HTTP into a dead network only burns battery.
        lastResult = {
          attempted: 0,
          delivered: 0,
          failed: 0,
          skipped: true,
          reason: `no data path (L${level})`,
        };
        return lastResult;
      }
    }

    const now = Date.now();
    const pending = await outboxRepo.pending(BATCH, now);
    if (pending.length === 0) {
      lastResult = { attempted: 0, delivered: 0, failed: 0, skipped: false, reason };
      lastRunAt = now;
      return lastResult;
    }

    let delivered = 0;
    let failed = 0;

    await runPool(pending, CONCURRENCY, async (item) => {
      let outcome: Attempted;
      try {
        outcome = await dispatch(item);
      } catch (e) {
        outcome = {
          ok: false,
          code: 'KV-0000',
          via: 'http',
          message: e instanceof Error ? e.message : 'dispatch threw',
        };
      }
      try {
        if (outcome.ok) {
          await outboxRepo.markDelivered(item.id);
          delivered += 1;
        } else {
          await outboxRepo.markAttempt(
            item.id,
            outcome.via,
            nextAttemptAt(item, Date.now()),
            outcome.code ? `${outcome.code}${outcome.message ? `: ${outcome.message}` : ''}` : outcome.message,
          );
          failed += 1;
        }
      } catch {
        // A database write failing here means the item simply gets retried on the
        // next pass. Nothing is lost; the queue is the durable part.
        failed += 1;
      }
    });

    // Keep delivered rows around long enough for a late duplicate to hit
    // dedupe_key, then reclaim the space (P-043: storage is finite).
    await outboxRepo.purgeDelivered().catch(() => 0);

    lastRunAt = Date.now();
    lastResult = { attempted: pending.length, delivered, failed, skipped: false, reason };
    return lastResult;
  } catch (e) {
    lastResult = {
      attempted: 0,
      delivered: 0,
      failed: 0,
      skipped: true,
      reason: e instanceof Error ? e.message : 'drain failed',
    };
    return lastResult;
  } finally {
    draining = false;
  }
}

/**
 * Start draining: on an interval, and — far more importantly — the instant the
 * degradation level rises. Idempotent; calling it twice does not double the work.
 */
export function startOutboxDrain(): () => void {
  if (!timer) {
    timer = setInterval(() => {
      void drainOnce('interval');
    }, DRAIN_INTERVAL_MS);
  }
  if (!unsubscribeDegradation) {
    let previous: DegradationLevel | null = null;
    unsubscribeDegradation = subscribeDegradation((level) => {
      const rose = previous !== null && level > previous;
      previous = level;
      // Coming back onto a network is the moment that matters. Drain now.
      if (rose && level >= DegradationLevel.HTTP_ONLY) void drainOnce('connectivity');
    });
  }
  void drainOnce('start');
  return stopOutboxDrain;
}

export function stopOutboxDrain(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribeDegradation?.();
  unsubscribeDegradation = null;
}

export interface OutboxDrainStatus {
  running: boolean;
  draining: boolean;
  lastRunAt: number;
  last: DrainResult | null;
  depth: number;
}

export async function outboxDrainStatus(): Promise<OutboxDrainStatus> {
  let depth = 0;
  try {
    depth = await outboxRepo.depth();
  } catch {
    depth = 0;
  }
  return { running: timer !== null, draining, lastRunAt, last: lastResult, depth };
}
