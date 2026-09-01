/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FAMILY WATCH — the media transport (6-D-7b · spec D1, E1)
 *
 * ★ THIS IS THE HALF 6-D-7a DELIBERATELY LEFT OUT ★
 * `watchSession.ts` owns who may watch whom, the indicator, the access log and
 * the timers, and calls into a `WatchMedia` it does not know the shape of. This
 * file is that `WatchMedia`, implemented over `react-native-webrtc`. The split
 * is load-bearing: every consent decision is tested off-device (22 tests in
 * `test/watch-session.test.ts`), and only the parts that genuinely need a radio
 * and a camera live here.
 *
 * ★ NONE OF THIS HAS EVER RUN ★
 * `react-native-webrtc` is a native module and there is no Android SDK on the
 * machine this was written on (D-021). It compiles under `tsc` and it is wired
 * end to end, but no frame of video has ever been carried by it. Anyone reading
 * this after the first device build should treat a failure here as expected
 * work, not as a regression.
 *
 * ★ WHO OFFERS ★
 * The VIEWER offers. It is the party that pressed a button, so it is the party
 * whose peer connection exists first; the watched device answers when the offer
 * arrives. Both sides trickle ICE as candidates appear rather than waiting for
 * gathering to finish — D1 promises the view "opens immediately", and
 * non-trickle ICE spends several seconds gathering before anything is sent.
 *
 * ★ WHAT FLOWS WHICH WAY ★
 * One direction only. The watched device captures and sends; the viewer
 * receives and renders. The viewer's own camera and microphone are never
 * opened — there is no product reason for the watcher to be captured, and a
 * transport that opens both is one bug away from being a two-way call nobody
 * consented to.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import {
  MediaStream,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
} from 'react-native-webrtc';

import { CONFIG } from '../core/config';
import type { WatchMedia, WatchSession, WatchSignal } from './watchSession';

/**
 * D1: "TURN relay for across-city." STUN is free and gets most pairs connected;
 * TURN is infrastructure somebody has to run, so it is included only when it is
 * actually configured. `iceTransportPolicy` stays 'all' either way — forcing
 * 'relay' would make every session depend on a relay that may not exist.
 */
function iceServers(): RTCConfiguration['iceServers'] {
  const servers: NonNullable<RTCConfiguration['iceServers']> = [];
  if (CONFIG.iceServers.length > 0) servers.push({ urls: CONFIG.iceServers });
  if (CONFIG.turnUrl.length > 0) {
    servers.push({
      urls: CONFIG.turnUrl,
      username: CONFIG.turnUsername,
      credential: CONFIG.turnCredential,
    });
  }
  return servers;
}

/** True once a relay is configured — the honest input to "will this work across cities?" */
export function turnConfigured(): boolean {
  return CONFIG.turnUrl.length > 0;
}

/**
 * ★ A TYPINGS GAP, NOT A TYPE ESCAPE HATCH ★
 * `RTCPeerConnection` extends the package's vendored `event-target-shim`, and
 * that shim's declarations are NOT emitted into `lib/typescript/` — so the base
 * class resolves to nothing and `addEventListener` is invisible to `tsc` even
 * though it is the documented API and exists at runtime. Rather than cast the
 * connection to `any` (which would also hide a genuine mistake in the two calls
 * below), the exact surface used here is written out. If a future version ships
 * complete typings, delete this and the two casts and `tsc` will say so.
 */
interface IceCandidateEvent {
  candidate: RTCIceCandidate | null;
}
interface TrackEvent {
  streams: MediaStream[];
}
interface PeerEvents {
  addEventListener(type: 'icecandidate', fn: (e: IceCandidateEvent) => void): void;
  addEventListener(type: 'track', fn: (e: TrackEvent) => void): void;
}

interface Live {
  pc: RTCPeerConnection;
  local: MediaStream | null;
  remote: MediaStream | null;
  /** Which camera the watched device is actually on, so a flip request is a no-op when it already matches. */
  facing: 'front' | 'back';
  /**
   * Candidates that arrived before the remote description was set. Applying one
   * early throws, and a dropped candidate is a session that connects over a
   * worse path — or not at all — for no visible reason.
   */
  pending: RTCIceCandidate[];
}

let live: Live | null = null;
const streamListeners = new Set<(url: string | null) => void>();

/**
 * The viewer's screen renders whatever this reports. A stream URL rather than
 * the stream itself, because that is what `RTCView` takes.
 */
export function subscribeRemoteStream(fn: (url: string | null) => void): () => void {
  streamListeners.add(fn);
  fn(live?.remote?.toURL() ?? null);
  return () => {
    streamListeners.delete(fn);
  };
}

function publishStream(): void {
  const url = live?.remote?.toURL() ?? null;
  for (const fn of [...streamListeners]) {
    try {
      fn(url);
    } catch {
      /* a subscriber that throws must not tear the call down */
    }
  }
}

export function remoteStreamUrl(): string | null {
  return live?.remote?.toURL() ?? null;
}

/**
 * What the watched device captures. Audio in both cases: a camera view with no
 * sound is half a room. E1's session is audio-only in the other direction.
 */
async function capture(kind: WatchSession['kind'], facing: 'front' | 'back'): Promise<MediaStream> {
  return (await mediaDevices.getUserMedia({
    audio: true,
    video:
      kind === 'audio'
        ? false
        : { facingMode: facing === 'front' ? 'user' : 'environment' },
  })) as MediaStream;
}

async function drainPending(l: Live): Promise<void> {
  const queued = l.pending.splice(0, l.pending.length);
  for (const c of queued) {
    try {
      await l.pc.addIceCandidate(c);
    } catch {
      /* one unusable candidate is not a failed session */
    }
  }
}

export const webrtcWatchMedia: WatchMedia = {
  async start(session: WatchSession, emit: (signal: WatchSignal) => void): Promise<void> {
    await this.stop();

    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const l: Live = { pc, local: null, remote: null, facing: session.facing, pending: [] };
    live = l;

    // Trickle ICE. Every candidate goes out as it is found; `sdpMid`/
    // `sdpMLineIndex` ride along because the far side needs them to know which
    // media section a candidate belongs to.
    const events = pc as unknown as PeerEvents;
    events.addEventListener('icecandidate', (e) => {
      const c = e.candidate;
      if (!c) return; // null marks end-of-gathering, not a candidate
      emit({
        t: 'ice',
        candidate: c.candidate,
        sdpMid: c.sdpMid ?? null,
        sdpMLineIndex: c.sdpMLineIndex ?? null,
      });
    });

    events.addEventListener('track', (e) => {
      if (e.streams.length === 0 || live !== l) return;
      l.remote = e.streams[0];
      publishStream();
    });

    if (session.role === 'watched') {
      // The watched device is the only one that captures. Tracks must be added
      // BEFORE the answer is created or the SDP describes no media at all.
      const stream = await capture(session.kind, l.facing);
      l.local = stream;
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      return; // the offer is already on its way; applySignal answers it
    }

    // The viewer receives only. Declaring the directions explicitly is what
    // makes "recvonly" true in the SDP rather than merely true in practice.
    pc.addTransceiver('audio', { direction: 'recvonly' });
    if (session.kind === 'camera') pc.addTransceiver('video', { direction: 'recvonly' });

    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    emit({ t: 'sdp', sdpType: 'offer', sdp: offer.sdp ?? '' });
  },

  async applySignal(
    session: WatchSession,
    signal: WatchSignal,
    emit: (signal: WatchSignal) => void,
  ): Promise<void> {
    const l = live;
    if (l === null) return;

    if (signal.t === 'ice') {
      const candidate = new RTCIceCandidate({
        candidate: signal.candidate,
        sdpMid: signal.sdpMid ?? undefined,
        sdpMLineIndex: signal.sdpMLineIndex ?? undefined,
      });
      // Before the remote description exists there is nothing to attach a
      // candidate to; queue instead of throwing it away.
      if (l.pc.remoteDescription === null) {
        l.pending.push(candidate);
        return;
      }
      await l.pc.addIceCandidate(candidate);
      return;
    }

    if (signal.t !== 'sdp') return;

    await l.pc.setRemoteDescription(
      new RTCSessionDescription({ type: signal.sdpType, sdp: signal.sdp }),
    );
    await drainPending(l);

    if (signal.sdpType !== 'offer') return; // an answer completes the handshake
    if (session.role !== 'watched') return; // only the capturing side answers
    const answer = await l.pc.createAnswer();
    await l.pc.setLocalDescription(answer);
    emit({ t: 'sdp', sdpType: 'answer', sdp: answer.sdp ?? '' });
  },

  /**
   * D3, on the watched device. `_switchCamera()` is a toggle rather than a
   * setter, so it is called only when the current camera is not the one the
   * viewer asked for — otherwise a duplicate or reordered flip signal would
   * turn the camera around twice.
   */
  async setFacing(facing: 'front' | 'back'): Promise<void> {
    const l = live;
    if (l === null || l.local === null || l.facing === facing) return;
    for (const track of l.local.getVideoTracks()) track._switchCamera();
    l.facing = facing;
  },

  async stop(): Promise<void> {
    const l = live;
    live = null;
    if (l === null) return;
    // Stop the tracks before closing the connection: closing a peer connection
    // does NOT release the camera, and a camera light that stays on after a
    // session ends is the single worst bug this feature could ship.
    for (const track of l.local?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
    try {
      l.local?.release();
    } catch {
      /* older releases do not expose release() */
    }
    try {
      l.pc.close();
    } catch {
      /* already closed */
    }
    publishStream();
  },
};
