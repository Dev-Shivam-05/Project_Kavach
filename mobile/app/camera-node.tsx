/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CAMERA NODE — this phone becomes a monitoring camera (PRD P-024 / FR-046)
 *
 * ★★★ THE THING THIS SCREEN IS ACTUALLY FOR ★★★
 * A family has a drawer with a three-year-old phone in it. Pointed at the front
 * door of a house that is empty on weekdays, that phone is a burglar alarm that
 * cost nothing. That is the whole feature — and it is also, without care, the
 * single most invasive thing this product could ever ship, because a camera
 * inside a home does not distinguish between a stranger at the door and a
 * teenager on the sofa.
 *
 * So the screen is built around the refusals, not around the camera:
 *   · it will not arm without a placement that survives `checkPlacement`
 *     (IT Act s.66E — no bedroom, no bathroom, ever);
 *   · it will not arm if the app cannot tell when somebody comes home, because
 *     auto-disable would be a promise it could not keep;
 *   · it will not arm if snapshots cannot be sealed;
 *   · it stops the instant any family member is detected home;
 *   · it stops the instant the battery passes 45 °C (P-032);
 *   · it stops the instant anybody, anywhere in the family, hits the kill switch
 *     on the viewer screen — and only this phone, physically, can restart it.
 *
 * ★★★ IT DOES NOT RECORD. ★★★
 * There is no `recordAsync` in this file. The camera takes a still every 300 ms
 * to a second, the still is reduced to a 160×120 greyscale frame, the frame is
 * compared with a rolling background model, and the original is deleted from the
 * cache before the next one is taken. Only when three consecutive frames show
 * motion — and no more than once every 30 seconds — is a sealed thumbnail kept.
 *
 * ★★★ HONEST LIMITATION ★★★
 * expo-camera's preview is bound to a mounted React view, so the node works
 * while this screen is open and the screen is on. A camera that survives the
 * screen going off needs a native foreground service (the same shape as the T0
 * agent in P-035) and is not in this phase. The screen says so rather than
 * letting somebody discover it after a burglary. Brightness is dropped to the
 * floor while live, because an unattended phone at full brightness is both wasted
 * power and wasted heat budget (P-032).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type AppStateStatus,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import * as Brightness from 'expo-brightness';
import { useKeepAwake } from 'expo-keep-awake';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { base64ToBytes } from '../src/core/ids';
import {
  ARM_EXIT_DELAY_MS,
  BLOCK_COUNT,
  SNAPSHOT_RETENTION_DAYS,
  captureIntervalMs,
  checkPlacement,
  createMotionModel,
  decodeJpegLumaDc,
  describeDecodeFailure,
  describeSightings,
  formatCelsius,
  membersDetectedHome,
  pickHomeFence,
  pickPictureSize,
  powerAdvisory,
  resampleGrey,
  stepMotion,
  thermalDecision,
  type MotionModel,
  type ThermalSample,
  type ThermalTier,
} from '../src/domain/cctv';
import { useKavach } from '../src/state/store';
import { isActive } from '../src/t0/stateMachine.generated';
import {
  describeRuntime,
  readThermalSample,
  selfNode,
  sinceLabel,
  useNodes,
  type NodeRuntime,
} from '../src/state/nodeStore';
import { Button, Card, Pill, PressableScale, Section, Toggle } from '../src/ui/components';
import { MIN_TOUCH_TARGET, colors, font, radius, space, tracking, weight } from '../src/ui/theme';

/** Dim, not black: somebody walking past must still see the recording banner. */
const LIVE_BRIGHTNESS = 0.02;

/**
 * ★ HOW MUCH OF THE FRAME PERIOD THE DECODE IS ALLOWED TO OWN ★
 *
 * `decodeJpegLumaDc` is a hand-written baseline Huffman decoder walking the
 * entropy-coded segment bit by bit, on the JS thread, and `base64ToBytes` is a
 * per-character loop over the whole picture before it. This phone is still a
 * Kavach safety agent: a trigger that arrives mid-decode waits the decode out,
 * and the 500 ms t0→t2 budget has no room to give away.
 *
 * So the capture rate is clamped by what the decode ACTUALLY costs on the device
 * it is running on, not by what the thermal policy would like. Above 30 % duty
 * the JS thread stops being available often enough for that to be safe.
 */
const DECODE_DUTY = 0.3;
/** Rounded to this so a wobbling median cannot restart the capture loop. */
const DECODE_FLOOR_STEP_MS = 250;
/** Median over the last N decodes — long enough to be stable, short enough to react. */
const DECODE_SAMPLES = 24;

const NO_THERMAL: ThermalSample = { celsius: null, batteryPct: null, charging: false, at: 0 };

interface FrameStats {
  frames: number;
  hot: number;
  peak: number;
  consecutive: number;
  cooldownMs: number;
  warmingUp: boolean;
  lightingChange: boolean;
}

const NO_STATS: FrameStats = {
  frames: 0,
  hot: 0,
  peak: 0,
  consecutive: 0,
  cooldownMs: 0,
  warmingUp: true,
  lightingChange: false,
};

/**
 * What one captured frame produced, held OUTSIDE React until the 1 Hz tick
 * picks it up.
 *
 * `grabFrame` used to fire three state updates per frame — the note, the stats
 * and `publishSelf`, which rebuilds the whole nodes array — at up to 3 Hz, on a
 * screen carrying a mounted CameraView, fifteen Stat rows and several Cards.
 * Nothing any of them feeds is read faster than once a second, and the 1 Hz
 * heartbeat this screen already runs is that reader.
 */
interface PendingFrame {
  stats: FrameStats;
  note: string | null;
  temperatureC: number | null;
  batteryPct: number | null;
  charging: boolean;
  thermalTier: ThermalTier;
  /** Nothing is published until a frame (or a mount error) has written here. */
  dirty: boolean;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export default function CameraNodeScreen() {
  const insets = useSafeAreaInsets();
  useKeepAwake();

  const [permission, requestPermission] = useCameraPermissions();

  // ── stores ────────────────────────────────────────────────────────────────
  const ready = useNodes((s) => s.ready);
  const hydrate = useNodes((s) => s.hydrate);
  const consentAcceptedAt = useNodes((s) => s.consentAcceptedAt);
  const placement = useNodes((s) => s.placement);
  const sealBlocked = useNodes((s) => s.sealBlocked);
  const self = useNodes(selfNode);
  const acceptPlacement = useNodes((s) => s.acceptPlacement);
  const publishSelf = useNodes((s) => s.publishSelf);
  const setSelfRuntime = useNodes((s) => s.setSelfRuntime);
  const recordMotion = useNodes((s) => s.recordMotion);
  const resumeSelf = useNodes((s) => s.resumeSelf);
  const revokeSetup = useNodes((s) => s.revokeSetup);
  const purgeSnapshots = useNodes((s) => s.purgeSnapshots);
  const selfNodeId = useNodes((s) => s.selfNodeId);

  const members = useKavach((s) => s.members);
  const presence = useKavach((s) => s.presence);
  const geofences = useKavach((s) => s.geofences);
  const me = useKavach((s) => s.me);
  /**
   * ★ THE SAFETY PLANE OUTRANKS THE CAMERA ★
   *
   * This handset is a Kavach agent first and a burglar alarm second. Once T0 is
   * evaluating or running an incident, the JS thread belongs to the emergency —
   * and a hand-written JPEG decoder that owns that thread for a couple of
   * hundred milliseconds at a time is competing with the one thing on this phone
   * that must never wait. A camera that stops for eight seconds costs nothing;
   * an SOS that arrives eight seconds late costs everything.
   *
   * ★ NOT `!== 'IDLE'`. ★ WATCH is CONTEXT_ELEVATED — night, an unfamiliar area —
   * and it can last for hours. Pausing there would switch the burglar alarm off
   * for exactly the hours somebody bought a spare phone to cover. Only the
   * states where something is actually being decided pause capture.
   */
  const t0State = useKavach((s) => s.t0State);
  const t0Busy = isActive(t0State) || t0State === 'SUSPECT' || t0State === 'PROBE';

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // A 1 Hz heartbeat: the exit-delay countdown, the freshness of every presence
  // fix, the blink of the recording indicator, and — see PendingFrame — every
  // number the capture loop produces. One timer, one render per second.
  const [now, setNow] = useState(() => Date.now());

  // ── thermal (P-032) ───────────────────────────────────────────────────────
  const [thermal, setThermal] = useState<ThermalSample>(NO_THERMAL);
  const [prevTier, setPrevTier] = useState<ThermalTier>('nominal');
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const sample = await readThermalSample();
      if (!cancelled) setThermal(sample);
    };
    void poll();
    const handle = setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  const decision = useMemo(() => thermalDecision(thermal, prevTier), [thermal, prevTier]);
  useEffect(() => {
    // Converges in one step: the tier the policy just produced is by definition
    // a fixed point of the hysteresis rule for the same reading.
    if (decision.tier !== prevTier) setPrevTier(decision.tier);
  }, [decision.tier, prevTier]);

  // Memoised because `powerAdvisory` builds a fresh string each call; without
  // this the runtime-publishing effect below re-fires on every single render.
  const powerNote = useMemo(
    () => decision.maintenance ?? powerAdvisory(thermal),
    [decision.maintenance, thermal],
  );

  // ── auto-disable: is anybody home? (P-024) ────────────────────────────────
  const home = useMemo(() => pickHomeFence(geofences), [geofences]);
  const sightings = useMemo(
    () => membersDetectedHome(members, presence, home, now),
    [members, presence, home, now],
  );

  // ── arming ────────────────────────────────────────────────────────────────
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [previewOn, setPreviewOn] = useState(false);
  const killed = self !== null && self.runtime === 'disabled-by-family';

  const runtime: NodeRuntime = useMemo(() => {
    if (sealBlocked !== null) return 'no-seal-key';
    if (killed) return 'disabled-by-family';
    if (home === null) return 'no-home-fence';
    if (armedAt === null) return 'off';
    if (!decision.capture) return 'suspended-thermal';
    if (now - armedAt < ARM_EXIT_DELAY_MS) return 'exit-delay';
    if (sightings.length > 0) return 'paused-family-home';
    return 'live';
  }, [sealBlocked, killed, home, armedAt, decision.capture, now, sightings.length]);

  // A kill from the viewer must actually stop this phone, not just relabel it.
  useEffect(() => {
    if (killed) setArmedAt(null);
  }, [killed]);

  /**
   * ★★★ THE INDICATOR AND THE CAMERA ARE ONE OBJECT (P-024) ★★★
   * The unmissable red banner lives on this screen. If this screen is not the
   * one on display — the viewer was pushed over it, the app went to the
   * background, the phone was locked — then nobody standing in the room can see
   * that banner, and a camera running without a visible indicator is precisely
   * the thing this feature promised never to be.
   *
   * So losing focus does not pause the node, it STOPS it. Coming back means
   * pressing Start again and serving the two-minute exit delay again, which also
   * means the person who just picked the phone up is never the first thing it
   * captures.
   */
  const stopNode = useCallback(() => {
    setArmedAt(null);
    setPreviewOn(false);
  }, []);

  useFocusEffect(useCallback(() => () => stopNode(), [stopNode]));

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next !== 'active') stopNode();
    });
    return () => sub.remove();
  }, [stopNode]);

  const live = runtime === 'live';
  /**
   * Armed, allowed, and actually taking pictures. Everything that claims the
   * camera is watching keys off THIS and not off `live`: the red banner, the
   * capture loop and the brightness drop. A banner reading "THIS ROOM IS BEING
   * WATCHED" while the loop is suspended would be the one lie this feature
   * cannot afford, in either direction.
   */
  const capturing = live && !t0Busy;

  /**
   * `maintenance` is the one channel the family's viewer screen renders for a
   * node, so the emergency pause is announced there rather than being a silent
   * gap in the frame counter.
   */
  const maintenance = t0Busy && armedAt !== null
    ? 'Paused: this phone is dealing with an emergency. Watching starts again by itself.'
    : powerNote;

  useEffect(() => {
    void setSelfRuntime(runtime, maintenance);
  }, [runtime, maintenance, setSelfRuntime]);

  // ── capture ───────────────────────────────────────────────────────────────
  const camRef = useRef<CameraView | null>(null);
  const busyRef = useRef(false);
  const modelRef = useRef<MotionModel>(createMotionModel());
  const [camReady, setCamReady] = useState(false);
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);
  const [stats, setStats] = useState<FrameStats>(NO_STATS);
  const [frameNote, setFrameNote] = useState<string | null>(null);
  const [decodeMs, setDecodeMs] = useState(0);
  /** Quantised, so it settles once and then stops restarting the capture loop. */
  const [decodeFloorMs, setDecodeFloorMs] = useState(0);

  const pendingRef = useRef<PendingFrame>({
    stats: NO_STATS,
    note: null,
    temperatureC: null,
    batteryPct: null,
    charging: false,
    thermalTier: 'unknown',
    dirty: false,
  });
  const decodeSamplesRef = useRef<number[]>([]);
  const decodeFloorRef = useRef(0);

  /**
   * ★ WHY THESE ARE REFS AND NOT DEPENDENCIES ★
   * The thermal poll builds a brand-new `ThermalSample` every ten seconds. When
   * `grabFrame` closed over it, its identity changed on that schedule, which
   * changed the capture effect's deps, which tore down and rebuilt the entire
   * self-rescheduling chain — cancelling the pending timeout, orphaning any
   * decode in flight and restarting from zero. `busyRef` was papering over
   * exactly that. Read through a ref and `grabFrame` is stable, so the loop
   * restarts only when the frame rate genuinely changes.
   */
  const thermalRef = useRef(thermal);
  const tierRef = useRef(decision.tier);
  useEffect(() => {
    thermalRef.current = thermal;
    tierRef.current = decision.tier;
  }, [thermal, decision.tier]);

  const cameraMounted = previewOn || runtime === 'exit-delay' || live;

  const onCameraReady = useCallback(() => {
    setCamReady(true);
    const cam = camRef.current;
    if (cam === null) return;
    cam
      .getAvailablePictureSizesAsync()
      .then((sizes) => {
        const chosen = pickPictureSize(sizes);
        if (chosen !== null) setPictureSize(chosen);
      })
      .catch(() => {
        // Leaving pictureSize undefined means the device default, which the
        // decoder may reject as 'too-large'. That is reported, not hidden.
      });
  }, []);

  /** One place that marks the pending frame dirty, so nothing is written twice. */
  const noteFrame = useCallback((note: string | null) => {
    pendingRef.current.note = note;
    pendingRef.current.dirty = true;
  }, []);

  const grabFrame = useCallback(async () => {
    const cam = camRef.current;
    if (cam === null) return;
    // The loop is torn down and rebuilt whenever the thermal poll changes the
    // frame rate. Without this, a capture already in flight can overlap the
    // first capture of the new loop, and two concurrent takePictureAsync calls
    // on the same CameraView throw on Android.
    if (busyRef.current) return;
    busyRef.current = true;
    let capturedUri: string | null = null;
    try {
      const picture = await cam.takePictureAsync({
        base64: true,
        quality: 0.4,
        exif: false,
        // A node that clicks every 300 ms would be unusable, and a silent
        // shutter here is not a covert-recording feature: the on-screen banner
        // and the viewer screen both announce it continuously.
        shutterSound: false,
        skipProcessing: true,
      });
      capturedUri = picture.uri;
      const b64 = picture.base64;
      if (b64 === undefined || b64.length === 0) {
        noteFrame(describeDecodeFailure('no-frame'));
        return;
      }

      // ★ The measured window. Everything between these two marks is pure JS on
      //   the same thread T0 needs, and `decodeFloorMs` below is derived from it.
      const decodeStart = Date.now();
      const decoded = decodeJpegLumaDc(base64ToBytes(b64));
      if (!decoded.ok) {
        noteFrame(describeDecodeFailure(decoded.reason));
        return;
      }
      const frame = resampleGrey(decoded.plane);
      const decodeCost = Date.now() - decodeStart;
      const samples = decodeSamplesRef.current;
      samples.push(decodeCost);
      if (samples.length > DECODE_SAMPLES) samples.shift();

      if (frame === null) {
        noteFrame(describeDecodeFailure('no-frame'));
        return;
      }

      const at = Date.now();
      const result = stepMotion(modelRef.current, frame, at);
      const sample = thermalRef.current;
      pendingRef.current = {
        stats: {
          frames: modelRef.current.framesSeen,
          hot: result.hotCount,
          peak: Math.round(result.peakMad * 10) / 10,
          consecutive: result.consecutive,
          cooldownMs: result.cooldownRemainingMs,
          warmingUp: result.warmingUp,
          lightingChange: result.lightingChange,
        },
        note: null,
        temperatureC: sample.celsius,
        batteryPct: sample.batteryPct,
        charging: sample.charging,
        thermalTier: tierRef.current,
        dirty: true,
      };
      if (result.event) await recordMotion(at, result.hotCount, result.peakMad, frame);
    } catch {
      noteFrame('The camera did not return a frame.');
    } finally {
      /**
       * ★ takePictureAsync ALWAYS writes the full-resolution JPEG into the app
       *   cache. Leaving it there would mean a directory full of unencrypted,
       *   recognisable photographs of somebody's home — which would make the
       *   sealing of the thumbnails pointless (§10.2). It goes immediately.
       */
      if (capturedUri !== null) {
        try {
          new File(capturedUri).delete();
        } catch {
          /* already collected by the OS */
        }
      }
      busyRef.current = false;
    }
  }, [noteFrame, recordMotion]);

  /**
   * ★ THE 1 Hz DRAIN ★
   * The heartbeat and the frame flush share one callback so both land in a
   * single render. `setNow` alone already re-rendered this screen once a second;
   * a frame now costs nothing on top of that, instead of three renders per
   * frame at up to 3 Hz.
   */
  useEffect(() => {
    const handle = setInterval(() => {
      setNow(Date.now());

      const cost = median(decodeSamplesRef.current);
      setDecodeMs(cost);
      // Quantised and only republished when the step changes: a median that
      // wobbles by a millisecond must not restart the capture chain.
      const floor =
        cost === 0
          ? 0
          : Math.min(2000, Math.ceil(cost / DECODE_DUTY / DECODE_FLOOR_STEP_MS) * DECODE_FLOOR_STEP_MS);
      if (floor !== decodeFloorRef.current) {
        decodeFloorRef.current = floor;
        setDecodeFloorMs(floor);
      }

      const pending = pendingRef.current;
      if (!pending.dirty) return;
      pending.dirty = false;
      setStats(pending.stats);
      setFrameNote(pending.note);
      publishSelf({
        framesAnalysed: pending.stats.frames,
        temperatureC: pending.temperatureC,
        batteryPct: pending.batteryPct,
        charging: pending.charging,
        thermalTier: pending.thermalTier,
      });
    }, 1000);
    return () => clearInterval(handle);
  }, [publishSelf]);

  /**
   * The thermal policy proposes a rate; the measured decode disposes. Whichever
   * is slower wins, so a cheap phone that cannot decode a frame in 300 ms simply
   * runs slower rather than starving the JS thread it shares with T0.
   */
  const baseIntervalMs = captureIntervalMs(decision.fps);
  // A zero from the policy means SUSPENDED and must stay zero — the floor slows
  // capture down, it must never be able to start it.
  const intervalMs = baseIntervalMs <= 0 ? 0 : Math.max(baseIntervalMs, decodeFloorMs);

  useEffect(() => {
    if (!capturing || !camReady || intervalMs <= 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      const startedAt = Date.now();
      await grabFrame();
      if (cancelled) return;
      // Self-rescheduling rather than setInterval: a decode that overruns the
      // frame period must not queue a backlog on a phone we are trying to keep
      // cool. A slow device simply runs slower.
      const wait = Math.max(0, intervalMs - (Date.now() - startedAt));
      timer = setTimeout(() => void tick(), wait);
    };
    timer = setTimeout(() => void tick(), 0);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [capturing, camReady, intervalMs, grabFrame]);

  // The background model belongs to one continuous watch. Re-arming after a
  // pause must start clean: the room may have changed while the camera was off.
  useEffect(() => {
    if (armedAt === null) {
      modelRef.current = createMotionModel();
      setStats(NO_STATS);
      pendingRef.current = { ...pendingRef.current, stats: NO_STATS, note: null, dirty: false };
      decodeSamplesRef.current = [];
    }
  }, [armedAt]);

  useEffect(() => {
    if (!cameraMounted) setCamReady(false);
  }, [cameraMounted]);

  // Dim while capturing (P-032 — an unattended phone at full brightness is
  // wasted power and wasted heat budget). Restored whenever the node stops, and
  // that includes the emergency pause: a screen dimmed to 2 % is the last thing
  // somebody picking this phone up during an incident needs.
  useEffect(() => {
    const apply = async () => {
      try {
        if (capturing) await Brightness.setBrightnessAsync(LIVE_BRIGHTNESS);
        else await Brightness.restoreSystemBrightnessAsync();
      } catch {
        /* brightness control is a comfort here, never a requirement */
      }
    };
    void apply();
  }, [capturing]);

  // Leaving the screen must always hand the brightness back, including on the
  // path where the component unmounts while still live.
  useEffect(
    () => () => {
      void Brightness.restoreSystemBrightnessAsync().catch(() => undefined);
    },
    [],
  );

  // ── setup form ────────────────────────────────────────────────────────────
  const [draftPlacement, setDraftPlacement] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const submitSetup = useCallback(() => {
    const check = checkPlacement(draftPlacement);
    if (!check.ok) {
      setSetupError(check.reason);
      return;
    }
    setSetupError(null);
    void acceptPlacement(draftPlacement, me?.displayName ?? 'This phone', me?.id ?? null);
  }, [draftPlacement, acceptPlacement, me]);

  const confirmTearDown = useCallback(() => {
    Alert.alert(
      'Stop being a camera?',
      `This switches the camera off, deletes every snapshot on this phone, and forgets the setup.`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Stop and delete',
          style: 'destructive',
          onPress: () => {
            stopNode();
            void revokeSetup();
          },
        },
      ],
    );
  }, [revokeSetup, stopNode]);

  const confirmPurge = useCallback(() => {
    Alert.alert('Delete every snapshot?', 'The camera keeps running. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => void purgeSnapshots(selfNodeId),
      },
    ]);
  }, [purgeSnapshots, selfNodeId]);

  // ── render ────────────────────────────────────────────────────────────────
  const pad = { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xl };
  const blink = Math.floor(now / 1000) % 2 === 0;

  if (!ready) {
    /**
     * ★ A LOADING SCREEN WITH NO WAY OUT IS A DEAD END. ★
     * This used to be a bare centred line with no header. camera-node is not in
     * the root Stack's screen list, so there is no native back arrow either — if
     * `hydrate()` never resolved, the only exit on iOS was killing the app. The
     * header goes above every state of this screen, including this one.
     */
    return (
      <View style={[styles.screen, pad]}>
        <View style={styles.content}>
          <Header title="This phone as a camera" />
          <Card>
            <Text style={styles.h2}>Reading this phone’s camera settings…</Text>
            <Text style={styles.body}>
              Everything this screen needs is stored on this phone. Nothing is being fetched from a
              server, so this should take a moment, not a minute.
            </Text>
            <Text style={styles.dim}>
              If it stays here, go back and open it again — nothing is armed while this is showing.
            </Text>
          </Card>
        </View>
      </View>
    );
  }

  if (consentAcceptedAt === null) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={[styles.content, pad]}>
        <Header title="Turn this phone into a camera" />

        <Card tone="danger">
          <Text style={styles.h2}>Where this camera may never point</Text>
          {/* ★ The statute, before the feature. Not in a settings sub-page. */}
          <Text style={styles.body}>
            Not a bedroom. Not a bathroom. Not a changing room. Capturing images of a person in
            those places without their consent is an offence under section 66E of the Information
            Technology Act, 2000 — and nobody in this family can give that consent on behalf of
            everyone else who uses the room.
          </Text>
          <Text style={styles.body}>
            Tell the people who live here that this phone is a camera, and where it points, before
            you switch it on.
          </Text>
        </Card>

        <Section title="What this camera does">
          <Card>
            <Rule glyph="●" text="It never records video. It takes a small picture a few times a second, compares it with the last one, and throws it away." />
            <Rule glyph="◼" text="It shows an unmissable red banner on this screen the whole time it is on." />
            <Rule icon="home" text="It switches itself off automatically the moment anyone in the family is detected at home." />
            <Rule glyph="⚿" text="The few snapshots it keeps are encrypted with your family key and deleted after 7 days." />
            <Rule glyph="✕" text="Any family member can switch it off from their own phone, at any time, without asking you." />
          </Card>
        </Section>

        <Section title="Where does it point?">
          <Card>
            <TextInput
              value={draftPlacement}
              onChangeText={(v) => {
                setDraftPlacement(v);
                setSetupError(null);
              }}
              placeholder="Hall, facing the main door"
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              accessibilityLabel="Where this camera points"
              multiline
            />
            {setupError === null ? null : (
              <Text style={styles.error} accessibilityLiveRegion="polite">
                {setupError}
              </Text>
            )}
            <Toggle
              value={acknowledged}
              onChange={setAcknowledged}
              label="I have read where this camera may not be placed"
              hint="Section 66E, Information Technology Act, 2000"
            />
          </Card>
        </Section>

        <Button
          label="Set this phone up as a camera"
          onPress={submitSetup}
          variant="primary"
          size="lg"
          disabled={!acknowledged || draftPlacement.trim().length < 4}
        />
        <Button label="See the family's cameras" onPress={() => router.push('/camera-view')} variant="ghost" />
      </ScrollView>
    );
  }

  if (permission === null || !permission.granted) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={[styles.content, pad]}>
        <Header title="Camera access" />
        <Card tone="warn">
          <Text style={styles.body}>
            Kavach needs permission to use this phone&apos;s camera before it can watch{' '}
            {placement.trim().length > 0 ? placement : 'the room'}.
          </Text>
          {permission !== null && !permission.canAskAgain ? (
            <Text style={styles.dim}>
              Permission was refused permanently. Grant it in Android Settings → Apps → Kavach →
              Permissions.
            </Text>
          ) : null}
        </Card>
        <Button label="Allow camera" onPress={() => void requestPermission()} variant="primary" size="lg" />
        <Button label="Not now" onPress={() => router.back()} variant="ghost" />
      </ScrollView>
    );
  }

  const runtimeLabel = describeRuntime(
    self ?? {
      id: selfNodeId,
      placement,
      ownerName: me?.displayName ?? '',
      ownerMemberId: me?.id ?? null,
      isSelf: true,
      runtime,
      lastHeardAt: now,
      armedAt,
      lastMotionAt: null,
      lastMotionBlocks: 0,
      motionEvents24h: 0,
      framesAnalysed: 0,
      thermalTier: decision.tier,
      temperatureC: thermal.celsius,
      batteryPct: thermal.batteryPct,
      charging: thermal.charging,
      snapshotCount: 0,
      maintenance,
      disabledBy: null,
      purgeRequestedAt: null,
    },
  );

  const exitLeftS =
    runtime === 'exit-delay' && armedAt !== null
      ? Math.max(0, Math.ceil((armedAt + ARM_EXIT_DELAY_MS - now) / 1000))
      : 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, pad]}>
      {/* ★★★ THE RECORDING INDICATOR (P-024) ★★★
          Top of the screen, full width, red, blinking, and present in every
          state the camera is actually capturing in. It is not a badge in a
          corner: somebody walking into the room must be able to tell from the
          doorway that they are on camera. */}
      {capturing ? (
        <View
          style={styles.recBanner}
          accessible
          accessibilityRole="alert"
          accessibilityLabel="This camera is on and watching this room"
        >
          <Text style={[styles.recDot, { opacity: blink ? 1 : 0.25 }]} allowFontScaling={false}>
            ●
          </Text>
          <Text style={styles.recText}>CAMERA ON — THIS ROOM IS BEING WATCHED</Text>
        </View>
      ) : live ? (
        /* Armed but not capturing. The banner must not claim the room is being
           watched when it is not — the promise runs in both directions. */
        <View
          style={styles.holdBanner}
          accessible
          accessibilityRole="alert"
          accessibilityLabel="This camera is paused while the phone deals with an emergency"
        >
          <Text style={styles.holdGlyph} allowFontScaling={false}>
            ‖
          </Text>
          <Text style={styles.holdText}>PAUSED — NOTHING IS BEING WATCHED</Text>
        </View>
      ) : null}

      <Header title="This phone as a camera" />

      <Card tone={runtimeLabel.tone === 'neutral' ? undefined : runtimeLabel.tone}>
        <View style={styles.row}>
          <Pill label={runtimeLabel.label} tone={runtimeLabel.tone} />
          <Text style={styles.dim}>{placement}</Text>
        </View>
        <Text style={styles.body}>{runtimeLabel.detail}</Text>

        {runtime === 'exit-delay' ? (
          <Text style={styles.warn}>
            Leave the room. Capture starts in {exitLeftS}s — nothing is being analysed or stored
            until then.
          </Text>
        ) : null}

        {runtime === 'paused-family-home' ? (
          <Text style={styles.ok}>{describeSightings(sightings)}. The camera stays off.</Text>
        ) : null}

        {live && t0Busy ? (
          <Text style={styles.warn} accessibilityLiveRegion="polite">
            Paused. This phone is dealing with an emergency and that comes first. Watching starts
            again on its own the moment it is over.
          </Text>
        ) : null}

        {runtime === 'no-home-fence' ? (
          <Text style={styles.danger}>
            Set a &quot;Home&quot; area on the map screen first. Without it this camera cannot tell
            when somebody comes home, so it cannot switch itself off for them — and a camera that
            cannot do that is not allowed to run.
          </Text>
        ) : null}

        {sealBlocked === null ? null : <Text style={styles.danger}>{sealBlocked}</Text>}

        {maintenance === null ? null : (
          <Text style={styles.warn} accessibilityLiveRegion="polite">
            {maintenance}
          </Text>
        )}
      </Card>

      {cameraMounted ? (
        <View style={styles.previewBox}>
          <CameraView
            ref={camRef}
            style={StyleSheet.absoluteFill}
            facing="back"
            mode="picture"
            mute
            animateShutter={false}
            pictureSize={pictureSize}
            onCameraReady={onCameraReady}
            onMountError={() => noteFrame('The camera could not be started.')}
          />
          {capturing ? null : (
            <View style={styles.previewTag}>
              <Text style={styles.previewTagText}>Framing only — nothing is analysed or kept</Text>
            </View>
          )}
        </View>
      ) : null}

      <Section title="Watching">
        <Card>
          <Stat label="Frames analysed" value={String(stats.frames)} />
          <Stat label="Blocks changed" value={`${stats.hot} of ${BLOCK_COUNT}`} />
          <Stat label="Strongest change" value={`${stats.peak} levels`} />
          <Stat
            label="Consecutive moving frames"
            value={`${stats.consecutive} of 3 needed`}
          />
          <Stat
            label="Cooldown"
            value={stats.cooldownMs > 0 ? `${Math.ceil(stats.cooldownMs / 1000)}s left` : 'ready'}
          />
          <Stat label="Snapshots kept" value={`${self?.snapshotCount ?? 0} · ${SNAPSHOT_RETENTION_DAYS}-day limit`} />
          <Stat label="Last motion" value={sinceLabel(self?.lastMotionAt ?? null, now)} />
          {/* ★ The cost of one frame, measured on THIS phone. It is here because
              it is the number that decides the capture rate — see DECODE_DUTY.
              A phone that takes 400 ms to read a picture is told so rather than
              being quietly throttled. */}
          <Stat
            label="Reading one picture"
            value={decodeMs === 0 ? 'not measured yet' : `${decodeMs} ms typical`}
          />
          {decodeFloorMs > baseIntervalMs && baseIntervalMs > 0 ? (
            <Text style={styles.dim}>
              This phone is slow at reading pictures, so the camera is taking them further apart —
              one every {Math.round(intervalMs / 100) / 10}s. That keeps the phone free to raise an
              alarm, which matters more than a faster camera.
            </Text>
          ) : null}
          {stats.warmingUp && capturing ? (
            <Text style={styles.dim}>
              Learning what this room looks like when it is empty. Detection starts after three
              frames.
            </Text>
          ) : null}
          {stats.lightingChange ? (
            <Text style={styles.dim}>
              The whole scene changed at once — a light, not a person. Ignored.
            </Text>
          ) : null}
          {frameNote === null ? null : <Text style={styles.warn}>{frameNote}</Text>}
        </Card>
      </Section>

      <Section title="This phone">
        <Card>
          <Stat label="Battery temperature" value={formatCelsius(thermal.celsius)} />
          <Stat
            label="Battery"
            value={
              thermal.batteryPct === null
                ? 'unknown'
                : `${thermal.batteryPct}%${thermal.charging ? ' · charging' : ''}`
            }
          />
          <Stat label="Capture rate" value={decision.fps > 0 ? `${decision.fps}/s` : 'suspended'} />
          <Text style={styles.dim}>
            Keep this screen on and the phone plugged in. The camera stops when the screen sleeps or
            you leave this screen — running with the screen off needs a background camera service
            that is not built yet, and pretending otherwise would leave a house unwatched without
            anyone knowing.
          </Text>
        </Card>
      </Section>

      <Section title="Controls">
        <View style={styles.controls}>
          {killed ? (
            <>
              <Text style={styles.body}>
                {self?.disabledBy === null || self?.disabledBy === undefined
                  ? 'A family member switched this camera off.'
                  : `${self.disabledBy.name} switched this camera off ${sinceLabel(self.disabledBy.at, now)}.`}{' '}
                It can only be restarted here, on this phone.
              </Text>
              <Button label="Restart this camera" onPress={() => void resumeSelf()} variant="primary" size="lg" />
            </>
          ) : armedAt === null ? (
            <>
              <Button
                label={previewOn ? 'Hide preview' : 'Show preview to aim it'}
                onPress={() => setPreviewOn((v) => !v)}
                variant="ghost"
              />
              <Button
                label="Start watching"
                onPress={() => {
                  setPreviewOn(false);
                  setArmedAt(Date.now());
                }}
                variant="primary"
                size="lg"
                disabled={home === null || sealBlocked !== null}
              />
            </>
          ) : (
            <Button label="Stop watching" onPress={stopNode} variant="danger" size="lg" />
          )}

          {armedAt === null ? null : (
            <Text style={styles.dim}>
              Leaving this screen or locking the phone stops the camera — the red banner has to stay
              visible for it to keep running.
            </Text>
          )}

          <Button label="See the family's cameras" onPress={() => router.push('/camera-view')} variant="ghost" />
          <Button label="Delete every snapshot" onPress={confirmPurge} variant="quiet" />
          <Button label="Stop being a camera" onPress={confirmTearDown} variant="quiet" />
        </View>
      </Section>

      <Text style={styles.legal}>
        Set up {sinceLabel(consentAcceptedAt, now)} by {me?.displayName ?? 'this phone'}. Snapshots
        are encrypted with the family key, kept for {SNAPSHOT_RETENTION_DAYS} days and then deleted.
        Section 66E, Information Technology Act, 2000 applies to where this camera points.
      </Text>
    </ScrollView>
  );
}

function Header({ title }: { title: string }) {
  return (
    <View style={styles.header}>
      <PressableScale
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/home'))}
        accessibilityLabel="Back"
        style={styles.back}
        hitSlop={space.sm}
        highlightColor={colors.borderStrong}
        highlightRadius={radius.md}
      >
        <Text style={styles.backGlyph} allowFontScaling={false}>
          ‹
        </Text>
      </PressableScale>
      <Text accessibilityRole="header" style={styles.h1} numberOfLines={2}>
        {title}
      </Text>
    </View>
  );
}

function Rule({
  glyph,
  icon,
  text,
}: {
  glyph?: string;
  /** Wins over `glyph` if both are given. */
  icon?: keyof typeof Feather.glyphMap;
  text: string;
}) {
  return (
    <View style={styles.rule}>
      {icon !== undefined ? (
        <View style={styles.ruleIconSlot}>
          <Feather name={icon} size={font.body} color={colors.infoText} />
        </View>
      ) : (
        <Text style={styles.ruleGlyph} allowFontScaling={false}>
          {glyph}
        </Text>
      )}
      <Text style={styles.ruleText}>{text}</Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: space.lg, gap: space.lg },

  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  back: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backGlyph: { color: colors.text, fontSize: font.display, fontWeight: weight.bold },
  h1: { flex: 1, color: colors.text, fontSize: font.h1, fontWeight: weight.bold },
  h2: { color: colors.text, fontSize: font.h3, fontWeight: weight.semibold },

  body: { color: colors.text, fontSize: font.body, lineHeight: font.body + 7 },
  dim: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 6 },
  /**
   * ★ TEXT TOKENS, NOT FILLS ★
   * These four carry the refusals this screen is built around — "a camera that
   * cannot do that is not allowed to run", the s.66E placement rejection, the
   * thermal advisory, the auto-disable notice. On bgCard the fill tokens measure
   * 2.43–2.76:1, so the blocking explanation was the least readable thing on the
   * screen it blocks. The *Text variants are 7.85–7.95:1. The red banner above
   * keeps `colors.danger` because that is a FILL with white on it, which is what
   * the fill tokens are for.
   */
  warn: { color: colors.warnText, fontSize: font.small, fontWeight: weight.semibold, lineHeight: font.small + 6 },
  ok: { color: colors.okText, fontSize: font.small, fontWeight: weight.semibold, lineHeight: font.small + 6 },
  danger: { color: colors.dangerText, fontSize: font.small, fontWeight: weight.semibold, lineHeight: font.small + 6 },
  error: { color: colors.dangerText, fontSize: font.small, lineHeight: font.small + 6 },

  recBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.danger,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    minHeight: MIN_TOUCH_TARGET,
  },
  recDot: { color: colors.white, fontSize: font.h2 },
  recText: {
    flex: 1,
    color: colors.white,
    fontSize: font.body,
    fontWeight: weight.heavy,
    letterSpacing: tracking.caps,
  },

  // The same geometry as recBanner so the two read as one control changing
  // state rather than as two different objects appearing and disappearing.
  holdBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.warnSoft,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.warnBorder,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    minHeight: MIN_TOUCH_TARGET,
  },
  holdGlyph: { color: colors.warnText, fontSize: font.h2, fontWeight: weight.heavy },
  holdText: {
    flex: 1,
    color: colors.warnText,
    fontSize: font.body,
    fontWeight: weight.heavy,
    letterSpacing: tracking.caps,
  },

  previewBox: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.black,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  previewTag: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bgElevated,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  previewTagText: { color: colors.textDim, fontSize: font.tiny },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },

  rule: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  // infoText: at colors.info these five glyphs measured 1.89:1 on the card, so
  // the bullets on the consent screen — the screen somebody reads before
  // agreeing to put a camera in their home — had effectively invisible markers.
  ruleGlyph: { color: colors.infoText, fontSize: font.body, width: 18, textAlign: 'center' },
  ruleIconSlot: { width: 18, alignItems: 'center' },
  ruleText: { flex: 1, color: colors.text, fontSize: font.body, lineHeight: font.body + 7 },

  input: {
    backgroundColor: colors.bgInput,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    color: colors.text,
    fontSize: font.body,
    padding: space.md,
    minHeight: MIN_TOUCH_TARGET + space.md,
    textAlignVertical: 'top',
  },

  stat: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, minHeight: 24 },
  statLabel: { flex: 1, color: colors.textDim, fontSize: font.small },
  statValue: { color: colors.text, fontSize: font.small, fontWeight: weight.semibold },

  controls: { gap: space.md },
  legal: { color: colors.textFaint, fontSize: font.tiny, lineHeight: font.tiny + 6 },
});
