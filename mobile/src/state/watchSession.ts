/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FAMILY WATCH — the session plane (6-D-7 · spec D1–D5, E1–E4)
 *
 * ★ WHAT THIS IS, AND WHAT IT IS NOT ★
 * This file owns everything about a Camera or Listen session EXCEPT the media:
 * who invited whom, whether the watched phone's own grant list still allows it,
 * the mandatory indicator's on/off state (D2), the 5-minute Listen budget and
 * its "+5 min" (E2), the viewer-driven front/back flip (D3), either party's
 * End (D4), and the two `AccessLogEntry` rows (D5/E4).
 *
 * The media itself — `react-native-webrtc`, a peer connection, a TURN relay —
 * is 6-D-7b and is NOT in this build. It plugs in behind `setWatchMedia()`, the
 * same seam `crypto/hardware.ts` already uses for its key backend: a module
 * with a null default that a later phase fills. Until it is filled, nothing in
 * `app/` starts a session, so no indicator ever lights and no access-log row is
 * ever written — the Watch tab's honest "isn't built yet" alert (D-034) still
 * stands. **This module has no UI call site on purpose**, in the same
 * deliberate way `grantFamilyMembershipScopes` shipped without one in 6-D-4:
 * the alternative is a session that opens, tells someone "X is viewing your
 * camera", and carries no camera.
 *
 * ★ WHY THE SESSION IS NOT ALLOWED TO EXIST WITHOUT THE INDICATOR ★
 * GLOSSARY.md: "This pairing — instant for the viewer, always visible to the
 * watched — is what the spec calls the line between a consented family feature
 * and stalkerware. Do not build one half without the other." The indicator
 * state is therefore part of the session record here (`role: 'watched'` IS the
 * banner's source), not a separate thing a screen may forget to render, and
 * `accept` writes the access-log row BEFORE it answers — D2 pins the timing at
 * "before the viewer's first frame renders, not after", and the only way to
 * guarantee that ordering is to make the answer depend on it.
 *
 * ★ WHY IT TAKES A CONTEXT INSTEAD OF READING THE STORE ★
 * `store.ts` imports this file (to route inbound `watch.signal` frames), so
 * this file may not import `store.ts` back at the value level — the same
 * circular-value-import trap 6-D-6's `readLocationRefreshFields` was split out
 * to avoid. Everything store-shaped arrives as an explicit `WatchContext`,
 * which also makes the whole plane drivable from a test with no store, no
 * socket and no database.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import type { AccessLogEntry, UUID } from '../core/types';
import { uuidv7 } from '../core/ids';
import { openJson, sealJson, watchSessionKey } from '../crypto';

/** Which of the two capabilities is in play. Maps 1:1 onto the `ConsentScope`. */
export type WatchKind = 'camera' | 'audio';

/** 'viewer' is the person watching; 'watched' is the person whose phone is on. */
export type WatchRole = 'viewer' | 'watched';

export type WatchPhase = 'inviting' | 'live' | 'ended';

/** E2: "5 minutes, shown as a countdown ring around the End button." */
export const LISTEN_SESSION_MS = 5 * 60_000;

/** E2: "a +5 min button extends it once tapped, repeatable with no cap." */
export const LISTEN_EXTEND_MS = 5 * 60_000;

export interface WatchSession {
  id: string;
  kind: WatchKind;
  role: WatchRole;
  peerMemberId: UUID;
  startedAt: number;
  /**
   * E2 for audio; `null` for camera, because D4 is explicit that a camera
   * session has NO fixed timer and stays open until a party ends it.
   */
  expiresAt: number | null;
  /** D3: which of the watched device's cameras the VIEWER has asked for. */
  facing: 'front' | 'back';
  phase: WatchPhase;
  /** Null while live. 'timeout' is E2's auto-end at 0:00. */
  endedBy: WatchRole | 'timeout' | null;
  /** Set only when an invite was refused; the honest reason to show the viewer. */
  declinedReason: string | null;
}

/**
 * The sealed body of a `watch.signal` frame. realtime-gw sees none of this —
 * it relays the ciphertext and two cleartext routing fields (§10.2).
 */
export type WatchSignal =
  | { t: 'invite'; kind: WatchKind; at: number }
  | { t: 'accept'; at: number; expiresAt: number | null }
  | { t: 'decline'; reason: string }
  | { t: 'sdp'; sdpType: 'offer' | 'answer'; sdp: string }
  | { t: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { t: 'flip'; facing: 'front' | 'back' }
  | { t: 'extend'; expiresAt: number }
  | { t: 'end'; by: WatchRole | 'timeout' };

/** The cleartext routing envelope, as it appears on `frame.payload`. */
export interface WatchSignalPayload {
  sessionId: string;
  fromMemberId: UUID;
  toMemberId: UUID;
  sealed: string;
}

/**
 * Everything this module needs from the app, passed in rather than imported.
 * `send` returns whether the frame went out on the wire right now; a queued
 * signalling frame is not an error (`net/ws.ts` will flush it on reconnect),
 * it just means the session is not live yet.
 */
export interface WatchContext {
  meId: UUID;
  familyId: UUID;
  groupSecret: Uint8Array;
  send: (frame: { type: string; priority: 'HIGH'; payload: WatchSignalPayload }) => boolean;
  /**
   * D2/F1's authoritative gate, evaluated on the WATCHED phone against its own
   * grants: null to allow, or the honest reason to decline. `store.ts` supplies
   * `outboundGrantStatusFor` + `disabledReasonFor`; keeping it a callback keeps
   * consent policy in `domain/consentStatus.ts` and out of this file.
   */
  mayBeWatchedBy: (peerMemberId: UUID, kind: WatchKind) => string | null;
  /**
   * D5/E4's two rows. Persistence lives with the caller, not here, for two
   * reasons: `db/repos.ts` cannot be imported under the Node test shim at all
   * (it reaches `t0/stateMachine.generated`, whose `.generated` reads as a file
   * extension to `resolveExtensionless`), and the store keeps its own
   * in-memory `accessLog` that the Privacy screen renders — a write that went
   * straight to SQLite would leave that list stale until the next reload, the
   * way `findPhone` already avoids by doing both.
   */
  writeAccessLog: (entry: Omit<AccessLogEntry, 'id'>) => Promise<void>;
  now?: () => number;
}

/**
 * The media transport, filled by 6-D-7b. Every method is allowed to be slow or
 * to fail; none of them may throw into this module, so every call site wraps.
 */
export interface WatchMedia {
  /** Open the local peer connection. `emit` publishes SDP/ICE back to the peer. */
  start: (session: WatchSession, emit: (signal: WatchSignal) => void) => Promise<void>;
  /** Apply one inbound SDP or ICE signal. */
  applySignal: (session: WatchSession, signal: WatchSignal) => Promise<void>;
  /** D3, on the watched device: switch which camera is streaming. */
  setFacing: (facing: 'front' | 'back') => Promise<void>;
  stop: () => Promise<void>;
}

// ── module state ──────────────────────────────────────────────────────────────

let media: WatchMedia | null = null;
let session: WatchSession | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(s: WatchSession | null) => void>();

/**
 * Install the media transport. Null (the default, and this build's only state)
 * means signalling works and no bytes of audio or video move — which is exactly
 * why nothing in `app/` may open a session yet.
 */
export function setWatchMedia(next: WatchMedia | null): void {
  media = next;
}

export function watchMediaAvailable(): boolean {
  return media !== null;
}

export function currentWatchSession(): WatchSession | null {
  return session;
}

export function subscribeWatchSession(fn: (s: WatchSession | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function publish(): void {
  for (const fn of [...listeners]) {
    try {
      fn(session);
    } catch {
      // A subscriber that throws must not take the session down with it —
      // nothing throws into the UI, and nothing throws out of it either.
    }
  }
}

function clock(ctx: WatchContext): number {
  return (ctx.now ?? Date.now)();
}

// ── signalling ────────────────────────────────────────────────────────────────

function emit(ctx: WatchContext, sessionId: string, toMemberId: UUID, signal: WatchSignal): void {
  try {
    ctx.send({
      type: 'watch.signal',
      priority: 'HIGH',
      payload: {
        sessionId,
        fromMemberId: ctx.meId,
        toMemberId,
        // The AAD binds this ciphertext to the session id a second time, so a
        // relayed signal cannot be replayed into another session even though
        // both sessions live inside one family group secret.
        sealed: sealJson(watchSessionKey(ctx.groupSecret, sessionId), signal, sessionId),
      },
    });
  } catch {
    // Sealing or sending failed. The session simply does not progress; there is
    // nothing honest to show beyond the state it is already in.
  }
}

// ── access log (D5 / E4) ──────────────────────────────────────────────────────

/**
 * D5/E4's exact `what` values. The spec also names a `durationS` on the end
 * row; `AccessLogEntry` has no such column and `db/schema.ts` still carries
 * exactly one migration (the baseline), so the duration is left DERIVABLE —
 * `ended.at − started.at` for the same pair — rather than made the reason for
 * this app's first-ever schema migration. See DECISIONS.md D-036.
 */
function accessWhat(kind: WatchKind, edge: 'started' | 'ended'): string {
  return kind === 'camera' ? `camera_view_${edge}` : `listen_${edge}`;
}

async function writeAccessRow(
  ctx: WatchContext,
  s: WatchSession,
  edge: 'started' | 'ended',
): Promise<void> {
  const entry: Omit<AccessLogEntry, 'id'> = {
    familyId: ctx.familyId,
    grantId: null,
    accessorMemberId: s.role === 'viewer' ? ctx.meId : s.peerMemberId,
    subjectMemberId: s.role === 'viewer' ? s.peerMemberId : ctx.meId,
    what: accessWhat(s.kind, edge),
    context: 'routine',
    at: clock(ctx),
    // D2's indicator IS the surfacing, and it is on the watched device by
    // construction at the same instant this row is written — so there is
    // nothing left for the surfacing sweep to do. `findPhone` sets this the
    // same way for the same reason.
    surfacedToSubject: true,
  };
  try {
    await ctx.writeAccessLog(entry);
  } catch {
    // A full disk must not keep a session from ending. The row is the record,
    // not the mechanism.
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

function clearExpiry(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

function armExpiry(ctx: WatchContext): void {
  clearExpiry();
  if (session === null || session.expiresAt === null) return;
  const remaining = session.expiresAt - clock(ctx);
  // E2: "auto-ends at 0:00 unless extended."
  expiryTimer = setTimeout(() => void endWatchSession('timeout', ctx), Math.max(0, remaining));
}

/**
 * D1/E1, viewer side: "opens immediately — no approval dialog on the viewer's
 * side." The invite goes out at once; the session is `inviting` until the
 * watched phone's own grant check answers.
 *
 * Returns null when a session is already open — 1↔1 is a locked constraint
 * (prior lock's OUT OF SCOPE), so a second one is refused rather than queued.
 */
export function startWatchSession(
  kind: WatchKind,
  peerMemberId: UUID,
  ctx: WatchContext,
): WatchSession | null {
  if (session !== null && session.phase !== 'ended') return null;
  const at = clock(ctx);
  session = {
    id: uuidv7(at),
    kind,
    role: 'viewer',
    peerMemberId,
    startedAt: at,
    // The viewer proposes nothing about the budget: the watched phone's accept
    // carries the authoritative `expiresAt`, so E2's ceiling cannot be widened
    // by whoever is doing the watching.
    expiresAt: null,
    facing: 'back',
    phase: 'inviting',
    endedBy: null,
    declinedReason: null,
  };
  emit(ctx, session.id, peerMemberId, { t: 'invite', kind, at });
  publish();
  return session;
}

/**
 * D4/D5 (prior lock): either party ends it, and the watched party always can.
 *
 * `notifyPeer` is false on exactly one path — an `end` that ARRIVED from the
 * peer. Echoing it back would be a frame answering itself, and both sides run
 * their own E2 timer, so a timeout genuinely does fire twice.
 */
export async function endWatchSession(
  by: WatchRole | 'timeout',
  ctx: WatchContext,
  notifyPeer = true,
): Promise<void> {
  const s = session;
  if (s === null || s.phase === 'ended') return;
  clearExpiry();

  const wasLive = s.phase === 'live';
  session = { ...s, phase: 'ended', endedBy: by };
  publish();

  // Tell the peer before tearing the local transport down: the acceptance
  // criterion is "closes both sides' screens within 1s", and a stopped
  // transport that has not yet signalled leaves the other side staring at a
  // frozen frame until its own timeout.
  if (notifyPeer) emit(ctx, s.id, s.peerMemberId, { t: 'end', by });

  if (media !== null) {
    try {
      await media.stop();
    } catch {
      /* a transport that will not close still must not keep the session open */
    }
  }
  // Only a session that actually opened gets an end row — an invite that was
  // declined or never answered accessed nothing (the same rule 6-D-5's
  // honest-alert followed).
  if (wasLive) await writeAccessRow(ctx, s, 'ended');
}

/** D3: the flip control lives on the VIEWER's screen and asks the watched phone. */
export function flipWatchCamera(ctx: WatchContext): void {
  const s = session;
  if (s === null || s.phase !== 'live' || s.kind !== 'camera' || s.role !== 'viewer') return;
  const facing = s.facing === 'back' ? 'front' : 'back';
  session = { ...s, facing };
  emit(ctx, s.id, s.peerMemberId, { t: 'flip', facing });
  publish();
}

/**
 * E2's "+5 min", repeatable with no cap. Extending from the CURRENT expiry
 * rather than from now, so tapping it early cannot silently shorten a session.
 */
export function extendWatchSession(ctx: WatchContext): void {
  const s = session;
  if (s === null || s.phase !== 'live' || s.expiresAt === null) return;
  const expiresAt = Math.max(s.expiresAt, clock(ctx)) + LISTEN_EXTEND_MS;
  session = { ...s, expiresAt };
  emit(ctx, s.id, s.peerMemberId, { t: 'extend', expiresAt });
  armExpiry(ctx);
  publish();
}

// ── inbound ───────────────────────────────────────────────────────────────────

/**
 * One inbound `watch.signal` frame, routed here by `store.ts handleWsFrame`.
 *
 * Everything is dropped silently unless it belongs to this device: the frame
 * rides the whole family's stream (realtime-gw fans out per family, not per
 * member), so every member's phone sees every signal and only the addressee may
 * act on one. The seal is the second half of that check — a signal for another
 * session will not open under this session's key at all.
 */
export async function handleWatchSignal(payload: WatchSignalPayload, ctx: WatchContext): Promise<void> {
  if (payload.toMemberId !== ctx.meId) return;
  if (payload.fromMemberId === ctx.meId) return; // my own signal, echoed back on the family stream

  const signal = openJson<WatchSignal>(
    watchSessionKey(ctx.groupSecret, payload.sessionId),
    payload.sealed,
    payload.sessionId,
  );
  if (signal === null) return; // wrong key, wrong session, or corrupt — say nothing rather than guess

  if (signal.t === 'invite') {
    await onInvite(payload, signal, ctx);
    return;
  }

  // Every other signal must belong to the session this device already has.
  const s = session;
  if (s === null || s.id !== payload.sessionId || s.phase === 'ended') return;
  if (payload.fromMemberId !== s.peerMemberId) return;

  switch (signal.t) {
    case 'accept': {
      if (s.role !== 'viewer' || s.phase !== 'inviting') return;
      const live: WatchSession = { ...s, phase: 'live', expiresAt: signal.expiresAt };
      session = live;
      armExpiry(ctx);
      await writeAccessRow(ctx, live, 'started');
      publish();
      await startMedia(ctx);
      return;
    }

    case 'decline':
      if (s.role !== 'viewer') return;
      clearExpiry();
      session = { ...s, phase: 'ended', endedBy: 'watched', declinedReason: signal.reason };
      publish();
      return;

    case 'sdp':
    case 'ice':
      if (media === null) return;
      try {
        await media.applySignal(s, signal);
      } catch {
        /* a rejected candidate degrades the connection; it does not end the session */
      }
      return;

    case 'flip':
      // D3: only the watched device acts on it, and its own indicator wording
      // deliberately does not change — still just "X is viewing your camera."
      if (s.role !== 'watched' || s.kind !== 'camera') return;
      session = { ...s, facing: signal.facing };
      if (media !== null) {
        try {
          await media.setFacing(signal.facing);
        } catch {
          /* the camera refused to flip; the session continues on the one it has */
        }
      }
      publish();
      return;

    case 'extend':
      // E2: the watched phone owns the budget, so the viewer accepts what it is
      // told — but never a shorter one, which is the shape a replayed or
      // reordered extend would take.
      if (s.expiresAt !== null && signal.expiresAt <= s.expiresAt) return;
      session = { ...s, expiresAt: signal.expiresAt };
      armExpiry(ctx);
      publish();
      return;

    case 'end':
      await endWatchSession(signal.by, ctx, false);
      return;

    default:
      return;
  }
}

/**
 * D1/D2, watched side. Auto-accept is the whole point ("auto-allow within the
 * family, frictionless") — but only against THIS phone's own grant list, and
 * only after the access-log row is on disk, because D2 pins the indicator at
 * "before the viewer's first frame renders, not after."
 */
async function onInvite(
  payload: WatchSignalPayload,
  signal: Extract<WatchSignal, { t: 'invite' }>,
  ctx: WatchContext,
): Promise<void> {
  if (session !== null && session.phase !== 'ended') {
    emit(ctx, payload.sessionId, payload.fromMemberId, {
      t: 'decline',
      reason: 'They are already in another session.',
    });
    return;
  }

  const refusal = ctx.mayBeWatchedBy(payload.fromMemberId, signal.kind);
  if (refusal !== null) {
    emit(ctx, payload.sessionId, payload.fromMemberId, { t: 'decline', reason: refusal });
    return;
  }

  const at = clock(ctx);
  const expiresAt = signal.kind === 'audio' ? at + LISTEN_SESSION_MS : null;
  const live: WatchSession = {
    id: payload.sessionId,
    kind: signal.kind,
    role: 'watched',
    peerMemberId: payload.fromMemberId,
    startedAt: at,
    expiresAt,
    facing: 'back',
    phase: 'live',
    endedBy: null,
    declinedReason: null,
  };
  session = live;
  armExpiry(ctx);
  // Ordering is the promise, not an implementation detail: the row (and the
  // indicator that reads this session) exists before the accept goes out.
  await writeAccessRow(ctx, live, 'started');
  publish();
  emit(ctx, payload.sessionId, payload.fromMemberId, { t: 'accept', at, expiresAt });
  await startMedia(ctx);
}

async function startMedia(ctx: WatchContext): Promise<void> {
  const s = session;
  if (s === null || media === null) return;
  try {
    await media.start(s, (signal) => emit(ctx, s.id, s.peerMemberId, signal));
  } catch {
    /* 6-D-7b's problem; the session stays open and simply carries nothing */
  }
}

/** Tests only — module state is a singleton by design (`net/ws.ts` is the same). */
export function __resetWatchSessionForTest(): void {
  clearExpiry();
  session = null;
  media = null;
  listeners.clear();
}
