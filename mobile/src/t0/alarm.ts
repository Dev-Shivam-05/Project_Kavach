/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · LOCAL ALARM CONTROLLER
 *
 * The L0 floor of the degradation ladder (§4.4): "Nothing works. Still helps."
 * No network, no server, no family — a 100 dB siren, a torch strobe and a haptic
 * pattern still summon whoever is within earshot. This is the last thing in the
 * system that keeps working, so it must never depend on anything else.
 *
 * ★ P-065 — AUDIO FOCUS ★
 * The user may be on a live call to 112 while this is sounding. Android's
 * `doNotMix` requests EXCLUSIVE audio focus, which pauses/ducks that call. The
 * PRD is unambiguous: the T0 alarm uses the alarm stream and does NOT take audio
 * focus. We therefore set `interruptionMode: 'mixWithOthers'` — on Android that
 * means no audio-focus request at all. Loudness comes from raising STREAM_ALARM
 * through the native module, not from stealing focus from an emergency call.
 *
 * ★ NO BINARY ASSET ★
 * The siren is synthesised here as 16-bit PCM and materialised at runtime. A
 * missing/corrupt .wav in the bundle is a silent single point of failure for the
 * one feature that has to work at 2 a.m., so there is no asset to lose. The
 * base64 data URI is kept as a second source for the same reason.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { InteractionManager } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { Directory, File, Paths } from 'expo-file-system';
import { bytesToBase64 } from '../core/ids';
import { setTorch } from './native';
import * as native from './native';

const SAMPLE_RATE = 44_100;
const TORCH_STROBE_MS = 500;
const HAPTIC_BURST_MS = 900;

// ── PCM synthesis ─────────────────────────────────────────────────────────────

interface ToneSegment {
  /** Fundamental in Hz. Chosen so each segment holds a whole number of cycles. */
  freq: number;
  ms: number;
  /** Odd-harmonic mix. A pure sine is easy to ignore; this is not meant to be. */
  harmonics?: number[];
  /** Attack/release in ms. 0 is safe only when the segment ends at zero phase. */
  fadeMs?: number;
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/** Canonical 44-byte RIFF/WAVE header, mono 16-bit PCM at SAMPLE_RATE. */
function wavFromSamples(samples: Int16Array): Uint8Array {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return new Uint8Array(buf);
}

function renderSegments(segments: ToneSegment[], peak: number): Int16Array {
  let total = 0;
  for (const s of segments) total += Math.round((s.ms / 1000) * SAMPLE_RATE);
  const out = new Int16Array(total);
  let cursor = 0;

  for (const seg of segments) {
    const n = Math.round((seg.ms / 1000) * SAMPLE_RATE);
    const harmonics = seg.harmonics ?? [1];
    const raw = new Float32Array(n);
    let maxAbs = 0;

    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      let v = 0;
      for (let k = 0; k < harmonics.length; k++) {
        // Odd harmonics only: 1f, 3f, 5f — a square-ish timbre that carries
        // through a closed door far better than a sine of the same RMS.
        v += harmonics[k] * Math.sin(2 * Math.PI * seg.freq * (2 * k + 1) * t);
      }
      raw[i] = v;
      const a = v < 0 ? -v : v;
      if (a > maxAbs) maxAbs = a;
    }

    // ★ Normalise to the segment's TRUE peak, not to the sum of the harmonic
    // weights. The harmonics do not peak together, so dividing by their sum
    // throws away ~4 dB — and this is the one sound in the app whose entire
    // purpose is to be heard through a wall.
    const scale = maxAbs > 0 ? (peak * 32767) / maxAbs : 0;
    const fade = Math.round(((seg.fadeMs ?? 0) / 1000) * SAMPLE_RATE);
    for (let i = 0; i < n; i++) {
      let v = raw[i] * scale;
      if (fade > 0) {
        if (i < fade) v *= i / fade;
        else if (i > n - fade) v *= (n - i) / fade;
      }
      out[cursor + i] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
    cursor += n;
  }
  return out;
}

/**
 * The siren: 800 Hz / 1000 Hz alternating every 250 ms, exactly 1.000 s long.
 * Both tones complete a whole number of cycles in 250 ms (200 and 250), so the
 * waveform crosses zero at every segment boundary AND at the loop point — no
 * click, no discontinuity, gapless looping from a one-second file.
 */
function buildSirenWav(): Uint8Array {
  const harmonics = [1, 0.42, 0.2];
  return wavFromSamples(
    renderSegments(
      [
        { freq: 800, ms: 250, harmonics },
        { freq: 1000, ms: 250, harmonics },
        { freq: 800, ms: 250, harmonics },
        { freq: 1000, ms: 250, harmonics },
      ],
      0.97,
    ),
  );
}

export type CueKind = 'state' | 'ack' | 'resolve' | 'probe';

const CUE_SEGMENTS: Record<CueKind, ToneSegment[]> = {
  // Neutral tick — the incident moved to a new state.
  state: [{ freq: 660, ms: 110, harmonics: [1, 0.15], fadeMs: 8 }],
  // Rising third — someone is coming. The single most important sound here.
  ack: [
    { freq: 880, ms: 100, harmonics: [1, 0.2], fadeMs: 8 },
    { freq: 1320, ms: 140, harmonics: [1, 0.2], fadeMs: 8 },
  ],
  // Falling third — it is over.
  resolve: [
    { freq: 880, ms: 110, harmonics: [1, 0.15], fadeMs: 8 },
    { freq: 587, ms: 180, harmonics: [1, 0.15], fadeMs: 10 },
  ],
  // Insistent double beep — "are you all right?" needs an answer.
  probe: [
    { freq: 990, ms: 90, harmonics: [1, 0.3], fadeMs: 6 },
    { freq: 0, ms: 70 },
    { freq: 990, ms: 90, harmonics: [1, 0.3], fadeMs: 6 },
  ],
};

// ── Materialisation ───────────────────────────────────────────────────────────

let sirenBytes: Uint8Array | null = null;
let sirenDataUri: string | null = null;
let sirenUri: string | null = null;
const cueUris = new Map<CueKind, string>();

function toneDir(): Directory {
  const dir = new Directory(Paths.cache, 'kavach-tones');
  try {
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  } catch {
    // A cache directory we cannot create just means we fall back to the data URI.
  }
  return dir;
}

function materialise(name: string, bytes: Uint8Array): string | null {
  try {
    const file = new File(toneDir(), name);
    // Rewrite every launch: a truncated file from a crash mid-write would be a
    // silent alarm, which is the worst failure this module has.
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(bytes);
    return file.uri;
  } catch {
    return null;
  }
}

/** The siren as a `data:audio/wav;base64,…` URI. Generated lazily; ~118 KB. */
export function alarmWavDataUri(): string {
  if (!sirenBytes) sirenBytes = buildSirenWav();
  if (!sirenDataUri) sirenDataUri = `data:audio/wav;base64,${bytesToBase64(sirenBytes)}`;
  return sirenDataUri;
}

/**
 * A `file://` URI is the primary source: iOS AVPlayer does not load `data:`
 * URIs, and ExoPlayer streams a file with far less memory pressure than a
 * 118 KB base64 string. The data URI stays as the fallback for the case where
 * the cache directory is unwritable (P-043, storage full).
 */
function sirenSource(): string {
  if (sirenUri) return sirenUri;
  if (!sirenBytes) sirenBytes = buildSirenWav();
  sirenUri = materialise('kavach-siren.wav', sirenBytes);
  return sirenUri ?? alarmWavDataUri();
}

function cueSource(kind: CueKind): string {
  const cached = cueUris.get(kind);
  if (cached) return cached;
  const bytes = wavFromSamples(renderSegments(CUE_SEGMENTS[kind], 0.85));
  const uri = materialise(`kavach-cue-${kind}.wav`, bytes) ?? `data:audio/wav;base64,${bytesToBase64(bytes)}`;
  cueUris.set(kind, uri);
  return uri;
}

// ── Player lifecycle ──────────────────────────────────────────────────────────

let sirenPlayer: AudioPlayer | null = null;
let cuePlayer: AudioPlayer | null = null;
let alarmActive = false;
let strobeTimer: ReturnType<typeof setInterval> | null = null;
let strobeOn = false;
let hapticTimer: ReturnType<typeof setInterval> | null = null;
/** The two follow-up pulses inside one haptic burst. See `startAlarm`. */
let burstTimers: ReturnType<typeof setTimeout>[] = [];
let countdownTimer: ReturnType<typeof setTimeout> | null = null;
let restoreVolume: (() => Promise<void>) | null = null;

async function applyAudioMode(): Promise<void> {
  try {
    await setAudioModeAsync({
      // The phone is in a bag on silent. That is the normal case, not the edge case.
      playsInSilentMode: true,
      // The alarm must survive the screen locking and the app backgrounding.
      shouldPlayInBackground: true,
      // ★ P-065: never take audio focus away from a live 112 call.
      interruptionMode: 'mixWithOthers',
      allowsRecording: false,
      shouldRouteThroughEarpiece: false,
    });
  } catch {
    // Audio session configuration failing must not stop us trying to play.
  }
}

/**
 * Synthesise the siren and hand it to a player, so that `startAlarm()` is a
 * `play()` call and nothing more.
 *
 * This is the expensive half: 44 100 samples through three `Math.sin` calls each,
 * a normalisation pass, 44 100 `setInt16`s and an 88 KiB write. It must never sit
 * on the boot path — `app/index.tsx` renders a blank view until the store is
 * ready, and cold start is on the panic path.
 */
async function warmSiren(): Promise<void> {
  if (sirenPlayer) return;
  try {
    const player = createAudioPlayer(sirenSource(), { updateInterval: 1000 });
    player.loop = true;
    player.volume = 1;
    sirenPlayer = player;
  } catch {
    sirenPlayer = null;
  }
}

/**
 * §2.3 budget: the trigger path allocates ≤20 ms to "prime". Only the audio
 * SESSION is configured here — that call is cheap and must be settled before any
 * sound is asked for. The synthesis is scheduled after interactions; a trigger
 * that beats the warm-up still gets a siren because `startAlarm` falls back to
 * `warmSiren()` and simply pays the cost then, which is the case that fallback
 * exists for.
 */
export async function primeAlarm(): Promise<void> {
  await applyAudioMode();
  if (sirenPlayer) return;
  InteractionManager.runAfterInteractions(() => {
    void warmSiren();
  });
}

export function isAlarmActive(): boolean {
  return alarmActive;
}

export interface StartAlarmOptions {
  /** ACTIVE_L1_SILENT (duress) sounds nothing but still keeps the incident live. */
  silent?: boolean;
  strobe?: boolean;
  haptics?: boolean;
}

/**
 * Sound, light and vibration, in that order of usefulness. Each leg is
 * independent: no torch must never mean no siren.
 */
export function startAlarm(options: StartAlarmOptions = {}): void {
  const { silent = false, strobe = true, haptics = true } = options;
  alarmActive = true;

  if (!silent) {
    void (async () => {
      try {
        await applyAudioMode();
        if (!sirenPlayer) await warmSiren();
        if (sirenPlayer) {
          sirenPlayer.loop = true;
          sirenPlayer.volume = 1;
          sirenPlayer.seekTo(0).catch(() => {});
          sirenPlayer.play();
        }
      } catch {
        // Fall through to strobe + haptics; partial is much better than none.
      }
      try {
        // Only capture the restore point once. A second call while the alarm is
        // already sounding would capture the ALREADY-MAXED volume and we would
        // hand the user back 100% instead of what they had (P-021 courtesy).
        if (!restoreVolume) restoreVolume = await native.maxAlarmVolume();
      } catch {
        restoreVolume = null;
      }
    })();
  }

  if (strobe && strobeTimer === null) {
    strobeOn = false;
    strobeTimer = setInterval(() => {
      strobeOn = !strobeOn;
      void setTorch(strobeOn);
    }, TORCH_STROBE_MS);
  }

  if (haptics && hapticTimer === null) {
    const burst = () => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      // ★ Held, not fired and forgotten. `stopAlarm()` clears the interval, and
      //   without these handles the two follow-up pulses still land up to 240 ms
      //   after a cancel PIN is accepted. app/panic.tsx is written so that a
      //   cancel and a duress are byte-identical to an observer; a stray buzz
      //   after one of them is exactly the residual signal that defeats it.
      burstTimers.push(
        setTimeout(() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
        }, 120),
        setTimeout(() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
        }, 240),
      );
      // The interval re-arms every 900 ms; drop handles that have already fired
      // so the array cannot grow for the length of an incident.
      if (burstTimers.length > 4) burstTimers.splice(0, burstTimers.length - 4);
    };
    burst();
    hapticTimer = setInterval(burst, HAPTIC_BURST_MS);
  }
}

export function stopAlarm(): void {
  alarmActive = false;
  try {
    sirenPlayer?.pause();
  } catch {
    // The player may already have been released by the OS.
  }
  if (strobeTimer !== null) {
    clearInterval(strobeTimer);
    strobeTimer = null;
  }
  strobeOn = false;
  void setTorch(false);
  if (hapticTimer !== null) {
    clearInterval(hapticTimer);
    hapticTimer = null;
  }
  for (const t of burstTimers) clearTimeout(t);
  burstTimers = [];
  const restore = restoreVolume;
  restoreVolume = null;
  if (restore) void restore().catch(() => {});
}

// ── Cancel-window haptics ─────────────────────────────────────────────────────

/**
 * PRD §2.2: the ONLY animation in the panic UI is the cancel countdown ring, and
 * it is accompanied by an accelerating haptic. The acceleration is the point —
 * it communicates "time is running out" to someone who cannot look at the screen,
 * including in a pocket, in the dark, or with the phone face-down.
 */
export function startCountdownHaptics(ms: number): void {
  stopCountdownHaptics();
  if (!Number.isFinite(ms) || ms <= 0) return;
  const endsAt = Date.now() + ms;

  const tick = () => {
    const remaining = endsAt - Date.now();
    if (remaining <= 0) {
      countdownTimer = null;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }
    const fraction = Math.max(0, Math.min(1, remaining / ms));
    const style =
      fraction > 0.6
        ? Haptics.ImpactFeedbackStyle.Light
        : fraction > 0.25
          ? Haptics.ImpactFeedbackStyle.Medium
          : Haptics.ImpactFeedbackStyle.Heavy;
    void Haptics.impactAsync(style).catch(() => {});
    // 900 ms at the start, 90 ms in the final moments.
    const interval = 90 + 810 * fraction;
    countdownTimer = setTimeout(tick, Math.min(interval, Math.max(30, remaining)));
  };

  tick();
}

export function stopCountdownHaptics(): void {
  if (countdownTimer !== null) {
    clearTimeout(countdownTimer);
    countdownTimer = null;
  }
}

// ── Cues ──────────────────────────────────────────────────────────────────────

const CUE_HAPTIC: Record<CueKind, () => Promise<void>> = {
  state: () => Haptics.selectionAsync(),
  ack: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  resolve: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  probe: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
};

/**
 * Short non-speech confirmations. Deliberately audible AND haptic: the responder
 * may be riding a motorbike towards the incident and cannot look at the screen.
 * Cues never interrupt the siren — they use a separate player.
 */
export function playCue(kind: CueKind): void {
  void CUE_HAPTIC[kind]().catch(() => {});
  void (async () => {
    try {
      await applyAudioMode();
      if (!cuePlayer) {
        cuePlayer = createAudioPlayer(cueSource(kind), { updateInterval: 1000 });
        cuePlayer.volume = 1;
      } else {
        cuePlayer.replace(cueSource(kind));
      }
      cuePlayer.loop = false;
      await cuePlayer.seekTo(0).catch(() => {});
      cuePlayer.play();
    } catch {
      // The haptic already fired; a missing cue tone is cosmetic.
    }
  })();
}

/** Release both players. Called on teardown; the alarm is stopped first. */
export function releaseAlarm(): void {
  stopAlarm();
  stopCountdownHaptics();
  try {
    sirenPlayer?.remove();
  } catch {
    // Already released.
  }
  try {
    cuePlayer?.remove();
  } catch {
    // Already released.
  }
  sirenPlayer = null;
  cuePlayer = null;
}
