/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * REALTIME CLIENT
 *
 * ★ F-16 — THE TOKEN NEVER GOES IN THE QUERY STRING ★
 * URLs end up in access logs, proxy logs, crash reports, Sentry breadcrumbs and
 * the browser history of anyone who ever debugs this. A `?token=…` WebSocket URL
 * is a credential printed onto every one of those surfaces (I-6).
 * Instead: POST /v1/rt/ticket returns a single-use, 60 s, device-bound opaque
 * ticket, and it travels in the Sec-WebSocket-Protocol subprotocol slot —
 * a header, not a URL.
 *
 * ★ BACKPRESSURE PRIORITY IS A CORRECTNESS RULE, NOT A PERFORMANCE ONE (§2.5.2) ★
 * CRITICAL frames — a state transition, a CLAIM, a RELEASE, a tier change — are
 * NEVER dropped and never coalesced. A dropped CLAIM means a second responder's
 * phone still shows the incident as unowned, and two people each assume the other
 * is going. LOW frames — location, presence, battery — coalesce by key, because a
 * client forty frames behind wants the newest position, not a replay of a
 * forty-second-old track.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { CONFIG } from '../core/config';
import { observeHlc } from '../core/ids';
import { cursorRepo } from '../db/repos';
import { postRtTicket } from './api';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'backoff' | 'disabled';

export type WsPriority = 'CRITICAL' | 'HIGH' | 'LOW';

export interface WsFrame {
  type: string;
  /** Hybrid logical clock. Drives the resumable cursor and the merge order. */
  hlc?: string;
  /** Coalescing key for LOW frames. Defaults to the frame type. */
  key?: string;
  payload?: unknown;
  priority?: WsPriority;
}

type FrameListener = (frame: WsFrame) => void;

/** The stream name for the resumable cursor (§2.5.2). */
const CURSOR_STREAM = 'incident';

/**
 * ★ Never dropped, never coalesced. ★ Everything the responder's understanding of
 * "who is going" depends on.
 */
const CRITICAL_TYPES = new Set([
  'incident.opened',
  'incident.state_changed',
  'incident.claimed',
  'incident.released',
  'incident.resolved',
  'incident.merged',
  'escalation.tier_changed',
  'session.revoke',
  'policy.updated',
]);

/** Safe to coalesce: only the newest value per key has any meaning. */
const LOW_TYPES = new Set([
  'location.update',
  // ★ 6-D-7d — the OUTBOUND twin. Ambient fixes leave every ~10s while the app
  // is foregrounded; without this they default to HIGH, which neither coalesces
  // nor drops, so a flaky socket would flush a whole track of stale positions
  // on reconnect instead of the one that is still true.
  'location.report',
  'presence.update',
  'device.battery',
  'device.heartbeat',
  'typing',
]);

function priorityOf(frame: WsFrame): WsPriority {
  if (frame.priority) return frame.priority;
  if (CRITICAL_TYPES.has(frame.type)) return 'CRITICAL';
  if (LOW_TYPES.has(frame.type)) return 'LOW';
  return 'HIGH';
}

const coalesceKey = (frame: WsFrame): string => frame.key ?? frame.type;

// ── module state ──────────────────────────────────────────────────────────────

let socket: WebSocket | null = null;
let status: WsStatus = 'idle';
let wantConnection = false;
let attempt = 0;

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let lowFlushTimer: ReturnType<typeof setTimeout> | null = null;
let cursorFlushTimer: ReturnType<typeof setTimeout> | null = null;

let lastInboundAt = 0;
let cursorHlc: string | null = null;
let cursorDirty = false;

const listeners = new Set<FrameListener>();

/** Outbound, while the socket is down. CRITICAL is never discarded. */
const outCritical: WsFrame[] = [];
const outHigh: WsFrame[] = [];
const outLow = new Map<string, WsFrame>();

/** Inbound, before the first listener attaches (bootstrap race). */
const pendingInbound: WsFrame[] = [];
const inLow = new Map<string, WsFrame>();

const HIGH_QUEUE_MAX = 200;
const CRITICAL_QUEUE_MAX = 1000;
const PENDING_INBOUND_MAX = 200;
const LOW_FLUSH_MS = 250;
const HEARTBEAT_MS = 20_000;
/** No frame at all within the presence TTL means the connection is a corpse. */
const WATCHDOG_MS = CONFIG.presenceTtlMs;

/**
 * Set when a CRITICAL frame could not be queued or the queue overflowed. §2.5.2:
 * the correct recovery is a full resync, not a silent drop — so the next connect
 * deliberately rewinds the cursor and replays.
 */
let needsResync = false;

// ── status ────────────────────────────────────────────────────────────────────

export function wsStatus(): WsStatus {
  return status;
}

const statusListeners = new Set<(s: WsStatus) => void>();

/**
 * Notified on every status change, immediately with the current one.
 *
 * This is what lets the T0 dispatcher hold a WARM socket rather than a hopeful
 * one: `registerWarmSocket` is only meaningful while the socket is actually open,
 * and the fan-out's leg-1 shortcut is written to be skipped entirely when it is
 * not (`t0/dispatcher.registerWarmSocket`). Without this the store had no moment
 * at which to register, so leg 1 never existed at runtime on any device.
 */
export function subscribeWsStatus(fn: (s: WsStatus) => void): () => void {
  statusListeners.add(fn);
  try {
    fn(status);
  } catch {
    /* see deliver() */
  }
  return () => {
    statusListeners.delete(fn);
  };
}

function setStatus(next: WsStatus): void {
  if (status === next) return;
  status = next;
  for (const fn of statusListeners) {
    try {
      fn(next);
    } catch {
      // A subscriber that throws must not take the socket down with it.
    }
  }
}

// ── inbound dispatch ──────────────────────────────────────────────────────────

function deliver(frame: WsFrame): void {
  if (listeners.size === 0) {
    // A state transition that arrives one tick before the store subscribes must
    // not evaporate. LOW frames are allowed to; CRITICAL ones are not.
    if (priorityOf(frame) === 'CRITICAL' && pendingInbound.length < PENDING_INBOUND_MAX) {
      pendingInbound.push(frame);
    }
    return;
  }
  for (const fn of listeners) {
    try {
      fn(frame);
    } catch {
      // One bad listener must not stop the rest of the family's UI updating.
    }
  }
}

function flushLowInbound(): void {
  // Clear rather than merely forget: this is also called directly on teardown,
  // and a surviving handle would fire into a module that has been shut down.
  if (lowFlushTimer) clearTimeout(lowFlushTimer);
  lowFlushTimer = null;
  if (inLow.size === 0) return;
  const batch = [...inLow.values()];
  inLow.clear();
  for (const frame of batch) deliver(frame);
}

function scheduleLowFlush(): void {
  if (lowFlushTimer) return;
  lowFlushTimer = setTimeout(flushLowInbound, LOW_FLUSH_MS);
}

function onFrameReceived(frame: WsFrame): void {
  lastInboundAt = Date.now();

  if (frame.hlc) {
    // P-052: merge the peer's clock so our own HLC never falls behind someone we
    // have demonstrably heard from.
    observeHlc(frame.hlc);
    if (!cursorHlc || frame.hlc > cursorHlc) {
      cursorHlc = frame.hlc;
      cursorDirty = true;
      scheduleCursorFlush();
    }
  }

  if (priorityOf(frame) === 'LOW') {
    // ★ Coalesce. Keep only the LATEST per key.
    inLow.set(coalesceKey(frame), frame);
    scheduleLowFlush();
    return;
  }

  // CRITICAL and HIGH go straight through — no queue, no delay.
  deliver(frame);
}

// ── cursor persistence ────────────────────────────────────────────────────────

function scheduleCursorFlush(): void {
  if (cursorFlushTimer) return;
  cursorFlushTimer = setTimeout(() => {
    cursorFlushTimer = null;
    void flushCursor();
  }, 2000);
}

async function flushCursor(): Promise<void> {
  if (!cursorDirty || !cursorHlc) return;
  cursorDirty = false;
  try {
    await cursorRepo.advance(CURSOR_STREAM, cursorHlc);
  } catch {
    // The cursor is an optimisation: losing it costs a replay, never data.
    cursorDirty = true;
  }
}

// ── outbound ──────────────────────────────────────────────────────────────────

function rawSend(frame: WsFrame): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

function enqueueOutbound(frame: WsFrame): void {
  switch (priorityOf(frame)) {
    case 'CRITICAL':
      if (outCritical.length >= CRITICAL_QUEUE_MAX) {
        // We are so far behind that the queue itself is the problem. Do not drop
        // silently — force a resync so the server re-establishes the truth.
        needsResync = true;
        outCritical.shift();
      }
      outCritical.push(frame);
      return;
    case 'HIGH':
      if (outHigh.length >= HIGH_QUEUE_MAX) outHigh.shift();
      outHigh.push(frame);
      return;
    default:
      outLow.set(coalesceKey(frame), frame);
  }
}

function flushOutbound(): void {
  while (outCritical.length > 0) {
    const frame = outCritical[0];
    if (!rawSend(frame)) return;
    outCritical.shift();
  }
  while (outHigh.length > 0) {
    const frame = outHigh[0];
    if (!rawSend(frame)) return;
    outHigh.shift();
  }
  for (const [key, frame] of [...outLow.entries()]) {
    if (!rawSend(frame)) return;
    outLow.delete(key);
  }
}

/**
 * Send, or queue for the next open socket. Returns true only if the frame went
 * out on the wire right now; queued CRITICAL frames still return false, and the
 * caller is expected to have already written them to the outbox — the WebSocket
 * is a fast path, never the record of truth (§2.10.4).
 */
export function sendFrame(frame: WsFrame): boolean {
  if (rawSend(frame)) return true;
  enqueueOutbound(frame);
  return false;
}

// ── connection lifecycle ──────────────────────────────────────────────────────

/** Exponential backoff with jitter — a synchronised herd is a self-inflicted DDoS. */
function backoffDelayMs(): number {
  const base = Math.min(30_000, 500 * Math.pow(1.8, attempt));
  const jitter = 0.7 + Math.random() * 0.6;
  return Math.round(base * jitter);
}

/**
 * Every timer this module owns except the reconnect one, which is deliberately
 * allowed to outlive a socket.
 *
 * `cursorFlushTimer` used to be missing here and from `disconnectWs`, so a
 * two-second-old cursor write still fired after teardown — into a `cursorRepo`
 * whose database the caller may have just closed.
 */
function clearTimers(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
  if (cursorFlushTimer) clearTimeout(cursorFlushTimer);
  cursorFlushTimer = null;
}

function scheduleReconnect(): void {
  if (!wantConnection || reconnectTimer) return;
  setStatus('backoff');
  const delay = backoffDelayMs();
  attempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void openSocket();
  }, delay);
}

function teardownSocket(): void {
  // Hand over what has already arrived before the timers go. A coalesced LOW
  // batch dropped here is a position the map silently never shows.
  flushLowInbound();
  clearTimers();
  const s = socket;
  socket = null;
  if (!s) return;
  s.onopen = null;
  s.onmessage = null;
  s.onerror = null;
  s.onclose = null;
  try {
    s.close();
  } catch {
    // Closing an already-dead socket throws on some platforms. Nothing to do.
  }
}

async function openSocket(): Promise<void> {
  if (!wantConnection) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setStatus('connecting');

  // F-16: fetch the connect ticket first. If the control plane is down we cannot
  // get one — that is not an error worth surfacing, it is simply a lower rung of
  // the ladder, and the outbox keeps working over plain HTTP meanwhile.
  const ticketRes = await postRtTicket();
  if (!ticketRes.ok || !ticketRes.data?.ticket) {
    scheduleReconnect();
    return;
  }

  if (cursorHlc === null) {
    try {
      cursorHlc = await cursorRepo.get(CURSOR_STREAM);
    } catch {
      cursorHlc = null;
    }
  }

  // A forced resync deliberately abandons the cursor so the server replays from
  // its own snapshot instead of trusting a position we know is wrong.
  const resume = needsResync ? null : cursorHlc;
  const url = resume
    ? `${CONFIG.wsBase}/v1/stream?cursor=${encodeURIComponent(resume)}`
    : `${CONFIG.wsBase}/v1/stream`;

  let s: WebSocket;
  try {
    // ★ The ticket rides in the subprotocol slot — a header, never the URL (I-6).
    s = new WebSocket(url, ['kavach.v1', `ticket.${ticketRes.data.ticket}`]);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = s;

  s.onopen = () => {
    if (socket !== s) return;
    attempt = 0;
    needsResync = false;
    setStatus('open');
    lastInboundAt = Date.now();
    flushOutbound();
    startHeartbeat();
  };

  s.onmessage = (event) => {
    if (socket !== s) return;
    const raw: string | null = typeof event.data === 'string' ? event.data : null;
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as WsFrame | WsFrame[];
      if (Array.isArray(parsed)) {
        for (const f of parsed) if (f && typeof f.type === 'string') onFrameReceived(f);
      } else if (parsed && typeof parsed.type === 'string') {
        onFrameReceived(parsed);
      }
    } catch {
      // A frame we cannot parse is a server bug, not a reason to drop the socket.
    }
  };

  s.onerror = () => {
    if (socket !== s) return;
    // onclose always follows; reconnect is handled there so it happens once.
  };

  s.onclose = () => {
    if (socket !== s) return;
    socket = null;
    clearTimers();
    void flushCursor();
    if (wantConnection) scheduleReconnect();
    else setStatus('idle');
  };
}

function startHeartbeat(): void {
  clearTimers();
  heartbeatTimer = setInterval(() => {
    // Presence is a 45 s TTL in Valkey, refreshed by exactly this (§2.5.2).
    rawSend({ type: 'ping', priority: 'LOW', payload: { at: Date.now() } });
  }, HEARTBEAT_MS);

  watchdogTimer = setInterval(() => {
    // A TCP connection can stay "open" for minutes after the network has gone —
    // a half-open socket that silently swallows every alert is the worst possible
    // failure mode for this product, so we prove liveness rather than assume it.
    if (Date.now() - lastInboundAt > WATCHDOG_MS * 2) {
      needsResync = true;
      teardownSocket();
      scheduleReconnect();
    }
  }, WATCHDOG_MS);
}

/**
 * Connect, and keep reconnecting until disconnectWs(). Safe to call repeatedly.
 * Idempotent: a call while already connected or connecting is a no-op.
 */
export function connectWs(): void {
  wantConnection = true;
  if (socket || reconnectTimer) return;
  attempt = 0;
  void openSocket();
}

export function disconnectWs(): void {
  wantConnection = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  // teardownSocket flushes the LOW batch and clears the scheduled cursor write;
  // this is the deliberate final cursor flush, awaited by nobody.
  teardownSocket();
  void flushCursor();
  setStatus('idle');
}

/**
 * Subscribe to inbound frames. The first subscriber immediately receives any
 * CRITICAL frames that arrived before it existed — a claim landing during app
 * start is precisely when this matters.
 */
export function onFrame(fn: FrameListener): () => void {
  listeners.add(fn);
  if (pendingInbound.length > 0) {
    const backlog = pendingInbound.splice(0, pendingInbound.length);
    for (const frame of backlog) {
      try {
        fn(frame);
      } catch {
        /* see deliver() */
      }
    }
  }
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Push a frame to every local listener without touching the network. This is how
 * demo mode (and the local T0 path, which must work at L0 with no gateway at all)
 * drives the same UI code path as a real server frame.
 */
export function emitLocalFrame(frame: WsFrame): void {
  onFrameReceived(frame);
}

/** Depth of what has not made it onto the wire — surfaced in diagnostics. */
export function wsQueueDepth(): { critical: number; high: number; low: number } {
  return { critical: outCritical.length, high: outHigh.length, low: outLow.size };
}

/** Force a full replay on the next connect (§2.5.2 blockOrResync). */
export function requestResync(): void {
  needsResync = true;
  if (status === 'open') {
    teardownSocket();
    scheduleReconnect();
  }
}
