/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FAMILY WATCH — the session plane (6-D-7 · spec D1–D5, E1–E4)
 *
 * The media transport is 6-D-7b and cannot be built or run on this machine
 * (no Android SDK — D-021), so what is pinned here is everything that decides
 * whether a session is ALLOWED to exist and what the watched person is told
 * about it. GLOSSARY.md calls that pairing "the line between a consented family
 * feature and stalkerware", which makes these the tests that matter most:
 *
 *   · the watched phone's own grant list is the authority, not the viewer's
 *   · the access-log row exists BEFORE the accept goes out (D2's ordering)
 *   · a declined or unanswered invite writes no row at all
 *   · a signal for someone else, or for another session, does nothing
 *
 * `watchSession.ts` holds module state (one session per device, like
 * `net/ws.ts` holds one socket), so each test resets it and drives ONE side of
 * the conversation, hand-sealing whatever the peer would have sent.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { AccessLogEntry } from '../src/core/types';
import { openJson, sealJson, watchSessionKey } from '../src/crypto';
import {
  LISTEN_EXTEND_MS,
  LISTEN_SESSION_MS,
  currentWatchSession,
  endWatchSession,
  extendWatchSession,
  flipWatchCamera,
  handleWatchSignal,
  setWatchMedia,
  startWatchSession,
  __resetWatchSessionForTest,
  type WatchContext,
  type WatchKind,
  type WatchSignal,
  type WatchSignalPayload,
} from '../src/state/watchSession';

const GROUP_SECRET = new Uint8Array(32).fill(7);
const ME = 'mem-me';
const PEER = 'mem-peer';

interface Harness {
  ctx: WatchContext;
  /** Everything this device did, in order — the assertion surface for D2's timing. */
  events: string[];
  sent: WatchSignalPayload[];
  rows: Omit<AccessLogEntry, 'id'>[];
  setNow: (at: number) => void;
  /** The harness clock. Every expiry in a test must be built from THIS, never
   *  Date.now(): mixing the two makes `remaining` a multi-year setTimeout that
   *  Node silently clamps to 1ms, and a timeout test then passes because the
   *  timer fired instantly rather than because the budget ran out. */
  now: () => number;
  /** What the peer sent us: sealed the same way realtime-gw would have relayed it. */
  inbound: (from: string, to: string, sessionId: string, signal: WatchSignal) => WatchSignalPayload;
}

function harness(refusal: string | null = null): Harness {
  const events: string[] = [];
  const sent: WatchSignalPayload[] = [];
  const rows: Omit<AccessLogEntry, 'id'>[] = [];
  let now = 1_700_000_000_000;

  const ctx: WatchContext = {
    meId: ME,
    familyId: 'fam-1',
    groupSecret: GROUP_SECRET,
    send: (frame) => {
      sent.push(frame.payload);
      const signal = openJson<WatchSignal>(
        watchSessionKey(GROUP_SECRET, frame.payload.sessionId),
        frame.payload.sealed,
        frame.payload.sessionId,
      );
      events.push(`send:${signal?.t ?? 'unopenable'}`);
      return true;
    },
    mayBeWatchedBy: () => refusal,
    writeAccessLog: async (entry) => {
      rows.push(entry);
      events.push(`log:${entry.what}`);
    },
    now: () => now,
  };

  return {
    ctx,
    events,
    sent,
    rows,
    setNow: (at) => {
      now = at;
    },
    now: () => now,
    inbound: (from, to, sessionId, signal) => ({
      sessionId,
      fromMemberId: from,
      toMemberId: to,
      sealed: sealJson(watchSessionKey(GROUP_SECRET, sessionId), signal, sessionId),
    }),
  };
}

/** Reads back what this device actually put on the wire, decrypting it as the peer would. */
function sentSignal(h: Harness, i: number): WatchSignal | null {
  const p = h.sent[i];
  return openJson<WatchSignal>(watchSessionKey(GROUP_SECRET, p.sessionId), p.sealed, p.sessionId);
}

beforeEach(() => {
  __resetWatchSessionForTest();
});

// Not belt-and-braces: an audio session arms a real 5-minute setTimeout, and a
// test that leaves one live holds Node's event loop open for the full five
// minutes after the last assertion has passed. `npm test` looks hung, not
// failed.
afterEach(() => {
  __resetWatchSessionForTest();
});

// ── viewer side ───────────────────────────────────────────────────────────────

test('D1: starting a session emits one sealed invite addressed to the peer, and opens as inviting', () => {
  const h = harness();
  const session = startWatchSession('camera', PEER, h.ctx);

  assert.ok(session);
  assert.equal(session.role, 'viewer');
  assert.equal(session.phase, 'inviting');
  assert.equal(session.expiresAt, null, 'the viewer must not propose a budget — E2 is the watched phone’s to set');

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].toMemberId, PEER);
  assert.equal(h.sent[0].fromMemberId, ME);
  assert.deepEqual(sentSignal(h, 0), { t: 'invite', kind: 'camera', at: 1_700_000_000_000 });

  assert.equal(h.rows.length, 0, 'an invite that has not been answered has accessed nothing yet');
});

test('the invite ciphertext is bound to its own session id — it will not open under another', () => {
  const h = harness();
  startWatchSession('camera', PEER, h.ctx);
  const p = h.sent[0];

  const wrongAad = openJson(watchSessionKey(GROUP_SECRET, p.sessionId), p.sealed, 'other-session');
  assert.equal(wrongAad, null, 'the AAD must bind the signal to its session');
  const wrongKey = openJson(watchSessionKey(GROUP_SECRET, 'other-session'), p.sealed, p.sessionId);
  assert.equal(wrongKey, null, 'two sessions in one family must not share key material');
});

test('1↔1 is enforced: a second start while one is open is refused, not queued', () => {
  const h = harness();
  assert.ok(startWatchSession('camera', PEER, h.ctx));
  assert.equal(startWatchSession('audio', 'mem-third', h.ctx), null);
  assert.equal(h.sent.length, 1);
});

test('D5: the viewer writes its started row only once the watched phone accepts', async () => {
  const h = harness();
  const s = startWatchSession('camera', PEER, h.ctx);
  assert.ok(s);

  await handleWatchSignal(h.inbound(PEER, ME, s.id, { t: 'accept', at: 1, expiresAt: null }), h.ctx);

  assert.equal(currentWatchSession()?.phase, 'live');
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].what, 'camera_view_started');
  assert.equal(h.rows[0].accessorMemberId, ME, 'on the viewer’s phone I am the accessor');
  assert.equal(h.rows[0].subjectMemberId, PEER);
  assert.equal(h.rows[0].context, 'routine', 'a watch session is not an incident — consent.tsx renders any other context as one');
});

test('a decline ends the session with the watched person’s own reason, and writes no row', async () => {
  const h = harness();
  const s = startWatchSession('audio', PEER, h.ctx);
  assert.ok(s);

  await handleWatchSignal(
    h.inbound(PEER, ME, s.id, { t: 'decline', reason: 'Asha has turned this off.' }),
    h.ctx,
  );

  const after = currentWatchSession();
  assert.equal(after?.phase, 'ended');
  assert.equal(after?.declinedReason, 'Asha has turned this off.');
  assert.equal(h.rows.length, 0, 'nothing was accessed, so nothing may be logged (D-034)');
});

// ── watched side ──────────────────────────────────────────────────────────────

test('D1/D2: an invite with a live grant auto-accepts, and the access-log row precedes the accept', async () => {
  const h = harness(null);

  await handleWatchSignal(h.inbound(PEER, ME, 'sess-cam', { t: 'invite', kind: 'camera', at: 1 }), h.ctx);

  const s = currentWatchSession();
  assert.equal(s?.role, 'watched');
  assert.equal(s?.phase, 'live');
  assert.equal(s?.peerMemberId, PEER);

  // D2 pins the timing: the indicator (which reads this session) and its record
  // exist BEFORE the viewer is told it may render a frame, never after.
  assert.deepEqual(h.events, ['log:camera_view_started', 'send:accept']);
  assert.equal(h.rows[0].accessorMemberId, PEER, 'on the watched phone the VIEWER is the accessor');
  assert.equal(h.rows[0].subjectMemberId, ME);
  assert.equal(h.rows[0].surfacedToSubject, true, 'the banner is the surfacing; nothing is left for the sweep');
});

test('F1/F4: a revoked grant declines on the WATCHED phone, whatever the viewer’s copy says', async () => {
  const h = harness('Asha has turned this off.');

  await handleWatchSignal(h.inbound(PEER, ME, 'sess-cam', { t: 'invite', kind: 'camera', at: 1 }), h.ctx);

  assert.equal(currentWatchSession(), null, 'no session may exist for a refused invite');
  assert.deepEqual(h.events, ['send:decline']);
  assert.deepEqual(sentSignal(h, 0), { t: 'decline', reason: 'Asha has turned this off.' });
  assert.equal(h.rows.length, 0);
});

test('E2/D4: Listen gets a 5-minute budget, Camera gets none', async () => {
  const h = harness();
  h.setNow(1_000_000);
  await handleWatchSignal(h.inbound(PEER, ME, 'sess-mic', { t: 'invite', kind: 'audio', at: 1 }), h.ctx);
  assert.equal(currentWatchSession()?.expiresAt, 1_000_000 + LISTEN_SESSION_MS);
  await endWatchSession('watched', h.ctx);

  __resetWatchSessionForTest();
  const h2 = harness();
  await handleWatchSignal(h2.inbound(PEER, ME, 'sess-cam', { t: 'invite', kind: 'camera', at: 1 }), h2.ctx);
  assert.equal(currentWatchSession()?.expiresAt, null, 'D4: a camera session has no fixed timer');
});

test('an invite while a session is already open is declined, not silently swapped', async () => {
  const h = harness();
  await handleWatchSignal(h.inbound(PEER, ME, 'sess-1', { t: 'invite', kind: 'camera', at: 1 }), h.ctx);
  h.events.length = 0;

  await handleWatchSignal(
    h.inbound('mem-third', ME, 'sess-2', { t: 'invite', kind: 'audio', at: 2 }),
    h.ctx,
  );

  assert.equal(currentWatchSession()?.id, 'sess-1');
  assert.deepEqual(h.events, ['send:decline']);
});

// ── routing and isolation ─────────────────────────────────────────────────────

test('a signal addressed to another member is ignored — the frame rides the whole family stream', async () => {
  const h = harness();
  await handleWatchSignal(
    h.inbound(PEER, 'mem-someone-else', 'sess-x', { t: 'invite', kind: 'camera', at: 1 }),
    h.ctx,
  );
  assert.equal(currentWatchSession(), null);
  assert.equal(h.sent.length, 0);
});

test('a signal for a session this device does not have is dropped', async () => {
  const h = harness();
  const s = startWatchSession('camera', PEER, h.ctx);
  assert.ok(s);

  await handleWatchSignal(h.inbound(PEER, ME, 'some-other-session', { t: 'accept', at: 1, expiresAt: null }), h.ctx);
  assert.equal(currentWatchSession()?.phase, 'inviting');
});

test('a signal from someone who is not the peer cannot steer this session', async () => {
  const h = harness();
  const s = startWatchSession('camera', PEER, h.ctx);
  assert.ok(s);

  await handleWatchSignal(h.inbound('mem-intruder', ME, s.id, { t: 'end', by: 'watched' }), h.ctx);
  assert.equal(currentWatchSession()?.phase, 'inviting');
});

test('an unopenable seal changes nothing — no guess, no partial state', async () => {
  const h = harness();
  const s = startWatchSession('camera', PEER, h.ctx);
  assert.ok(s);

  await handleWatchSignal(
    { sessionId: s.id, fromMemberId: PEER, toMemberId: ME, sealed: 'not-base64-ciphertext' },
    h.ctx,
  );
  assert.equal(currentWatchSession()?.phase, 'inviting');
});

// ── in-session controls ───────────────────────────────────────────────────────

test('D3: the flip control is the viewer’s, and it asks rather than acts locally', async () => {
  const h = harness();
  const s = startWatchSession('camera', PEER, h.ctx);
  assert.ok(s);
  await handleWatchSignal(h.inbound(PEER, ME, s.id, { t: 'accept', at: 1, expiresAt: null }), h.ctx);

  flipWatchCamera(h.ctx);
  assert.equal(currentWatchSession()?.facing, 'front');
  assert.deepEqual(sentSignal(h, h.sent.length - 1), { t: 'flip', facing: 'front' });

  flipWatchCamera(h.ctx);
  assert.equal(currentWatchSession()?.facing, 'back', 'the toggle is a toggle, not a one-way switch');
});

test('D3: the watched device acts on a flip by switching cameras, and says nothing new about it', async () => {
  const h = harness();
  const facings: ('front' | 'back')[] = [];
  setWatchMedia({
    start: async () => {},
    applySignal: async () => {},
    setFacing: async (f) => {
      facings.push(f);
    },
    stop: async () => {},
  });

  await handleWatchSignal(h.inbound(PEER, ME, 'sess-cam', { t: 'invite', kind: 'camera', at: 1 }), h.ctx);
  h.events.length = 0;
  await handleWatchSignal(h.inbound(PEER, ME, 'sess-cam', { t: 'flip', facing: 'front' }), h.ctx);

  assert.deepEqual(facings, ['front']);
  assert.equal(currentWatchSession()?.facing, 'front');
  assert.deepEqual(h.events, [], 'the watched phone does not answer a flip — D3: the wording does not change');
});

test('E2: "+5 min" extends from the current expiry, never from now, and tells the peer', async () => {
  const h = harness();
  h.setNow(1_000_000);
  await handleWatchSignal(h.inbound(PEER, ME, 'sess-mic', { t: 'invite', kind: 'audio', at: 1 }), h.ctx);
  const first = currentWatchSession()?.expiresAt;
  assert.equal(first, 1_000_000 + LISTEN_SESSION_MS);

  // Tapping it a minute in must add five minutes to the END, not reset the
  // clock to now+5 — which would silently SHORTEN the session by four minutes.
  h.setNow(1_060_000);
  extendWatchSession(h.ctx);
  assert.equal(currentWatchSession()?.expiresAt, (first as number) + LISTEN_EXTEND_MS);
  assert.deepEqual(sentSignal(h, h.sent.length - 1), {
    t: 'extend',
    expiresAt: (first as number) + LISTEN_EXTEND_MS,
  });
});

test('E2: the viewer accepts a longer budget from the watched phone but never a shorter one', async () => {
  const h = harness();
  const s = startWatchSession('audio', PEER, h.ctx);
  assert.ok(s);
  const far = h.now() + 10 * 60_000;
  await handleWatchSignal(h.inbound(PEER, ME, s.id, { t: 'accept', at: 1, expiresAt: far }), h.ctx);
  assert.equal(currentWatchSession()?.expiresAt, far);

  await handleWatchSignal(h.inbound(PEER, ME, s.id, { t: 'extend', expiresAt: far - 60_000 }), h.ctx);
  assert.equal(currentWatchSession()?.expiresAt, far, 'a reordered or replayed extend must not cut the session short');
});

// ── ending ────────────────────────────────────────────────────────────────────

test('D4/D5: ending locally tells the peer and writes the ended row', async () => {
  const h = harness();
  await handleWatchSignal(h.inbound(PEER, ME, 'sess-cam', { t: 'invite', kind: 'camera', at: 1 }), h.ctx);
  h.events.length = 0;

  await endWatchSession('watched', h.ctx);

  const s = currentWatchSession();
  assert.equal(s?.phase, 'ended');
  assert.equal(s?.endedBy, 'watched');
  assert.deepEqual(h.events, ['send:end', 'log:camera_view_ended']);
  assert.equal(h.rows.length, 2, 'one row per session start and end');
});

test('an end that ARRIVED from the peer is not echoed back at it', async () => {
  const h = harness();
  await handleWatchSignal(h.inbound(PEER, ME, 'sess-mic', { t: 'invite', kind: 'audio', at: 1 }), h.ctx);
  h.events.length = 0;

  await handleWatchSignal(h.inbound(PEER, ME, 'sess-mic', { t: 'end', by: 'viewer' }), h.ctx);

  assert.equal(currentWatchSession()?.phase, 'ended');
  assert.deepEqual(h.events, ['log:listen_ended'], 'a frame that answers itself is a loop, not a protocol');
});

test('E2: the budget expiring auto-ends the session and closes it on both sides', async () => {
  const h = harness();
  const s = startWatchSession('audio', PEER, h.ctx);
  assert.ok(s);

  // The accept carries the authoritative expiry; a near-immediate one is how
  // 0:00 is reached here without waiting out E2's real five minutes.
  await handleWatchSignal(
    h.inbound(PEER, ME, s.id, { t: 'accept', at: 1, expiresAt: h.now() + 25 }),
    h.ctx,
  );
  assert.equal(currentWatchSession()?.phase, 'live');

  await new Promise((resolve) => setTimeout(resolve, 120));

  const after = currentWatchSession();
  assert.equal(after?.phase, 'ended');
  assert.equal(after?.endedBy, 'timeout');
  assert.deepEqual(h.events.slice(-2), ['send:end', 'log:listen_ended']);
});

test('ending twice is a no-op — no second row, no second frame', async () => {
  const h = harness();
  await handleWatchSignal(h.inbound(PEER, ME, 'sess-cam', { t: 'invite', kind: 'camera', at: 1 }), h.ctx);
  await endWatchSession('watched', h.ctx);
  const events = [...h.events];

  await endWatchSession('viewer', h.ctx);
  assert.deepEqual(h.events, events);
});

test('the media transport is absent in this build, and the plane works without it', async () => {
  const h = harness();
  const kinds: WatchKind[] = ['camera', 'audio'];
  for (const kind of kinds) {
    __resetWatchSessionForTest();
    await handleWatchSignal(h.inbound(PEER, ME, `sess-${kind}`, { t: 'invite', kind, at: 1 }), h.ctx);
    assert.equal(currentWatchSession()?.phase, 'live', `${kind} session did not open without media`);
  }
});
