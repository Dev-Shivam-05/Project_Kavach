/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ONBOARDING  —  six steps, one transaction
 *
 * PRD Appendix E.4 is a CHECKLIST, not a tour. Each step below exists because
 * skipping it produces a family that believes it is protected and is not:
 *
 *   1 reality      What Kavach is AND is not. Up front (§20.1) — a limitation
 *                  buried in a footer is a limitation nobody read.
 *   2 agreement    §20.3 family agreement: what is collected, who sees it, for
 *                  how long, how to leave, and what leaving costs.
 *   3 permissions  Appendix A justification strings, verbatim. Background
 *                  location is TWO steps and is VERIFIED afterwards (P-040).
 *   4 pins         Cancel PIN + duress PIN + a practice entry (F-01).
 *   5 medical      The card a paramedic reads off the lock screen.
 *   6 drill        ★ Fire a test SOS and cancel it unaided. Appendix E.4 calls
 *                  this the single best predictor of whether the system works
 *                  when it matters, and it is the one step with no substitute.
 *
 * ★ NOTHING HERE INVENTS A RESULT ★
 * Every permission answer is re-read from the OS after the request returns, the
 * PINs are written through expo-secure-store and pushed into the live T0 router,
 * and the test SOS runs through `store.trigger` → the real state machine → the
 * real constant-time `verifyPin`. There is no simulated success anywhere in this
 * file; a rehearsal that cannot fail teaches nothing.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import * as Haptics from 'expo-haptics';
import {
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type AppStateStatus,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';

import { Button, Card, CountdownRing, Pill, PressableScale, Section, Toggle } from '../../src/ui/components';
import {
  MIN_TOUCH_TARGET,
  colors,
  font,
  radius,
  shadow,
  space,
  tracking,
  weight,
} from '../../src/ui/theme';
import { t } from '../../src/i18n';
import { useKavach } from '../../src/state/store';
import { STORAGE_KEYS } from '../../src/core/config';
import { DEFAULT_POLICY, effectiveCancelWindowS } from '../../src/core/policy';
import type { MedicalCard, UUID } from '../../src/core/types';
import { isActive } from '../../src/t0/stateMachine.generated';
// The router keeps the PINs in memory so that `verifyPin` never awaits a
// keystore read on the cancel path. Writing SecureStore alone would leave the
// running process comparing against the OLD pair until the next cold start.
import { setPins } from '../../src/t0/triggerRouter';

// ═══════════════════════════════════════════════════════════════════════════════
// Steps
// ═══════════════════════════════════════════════════════════════════════════════

type StepId = 'reality' | 'agreement' | 'permissions' | 'pins' | 'medical' | 'drill';

const STEPS: { id: StepId; title: string }[] = [
  { id: 'reality', title: 'What Kavach is' },
  { id: 'agreement', title: 'Your family agreement' },
  { id: 'permissions', title: 'Permissions' },
  { id: 'pins', title: 'Your two PINs' },
  { id: 'medical', title: t('medical.title') },
  { id: 'drill', title: 'Test it now' },
];

const PIN_LENGTH = 4;
/** Long enough that a pocket cannot do it, short enough that a panicking hand can. */
const HOLD_MS = 1200;
const HOLD_TICK_MS = 50;

type PermState = 'unknown' | 'granted' | 'denied';

// ═══════════════════════════════════════════════════════════════════════════════

export default function Onboarding() {
  const router = useRouter();
  /**
   * ★ Onboarding sets headerShown:false in BOTH layouts, so nothing else on the
   * route supplies safe area. The header used a hardcoded 32 and the footer had
   * no bottom padding at all, which put "STEP 1 / 6" under a 59 pt Dynamic
   * Island and the Continue button — the primary action of the entire first-run
   * flow — under the home indicator. This is the first screen anyone ever sees.
   */
  const insets = useSafeAreaInsets();

  const completeOnboarding = useKavach((s) => s.completeOnboarding);
  const ready = useKavach((s) => s.ready);
  const booting = useKavach((s) => s.booting);
  const bootstrap = useKavach((s) => s.bootstrap);
  const saveMedical = useKavach((s) => s.saveMedical);
  const trigger = useKavach((s) => s.trigger);
  const cancelWithPin = useKavach((s) => s.cancelWithPin);
  const resolveIncident = useKavach((s) => s.resolveIncident);
  const classify = useKavach((s) => s.classify);
  const t0State = useKavach((s) => s.t0State);
  const pendingUntil = useKavach((s) => s.pendingUntil);
  const risk = useKavach((s) => s.risk);

  const [step, setStep] = useState(0);
  const current = STEPS[step];

  // The store is booted by the root layout, but onboarding is also a valid cold
  // entry point (a deep link, a re-run from Settings). bootstrap() is idempotent,
  // so asking twice costs nothing and asking never costs the whole flow.
  useEffect(() => {
    if (!ready && !booting) void bootstrap();
  }, [ready, booting, bootstrap]);

  // ── step 2: the agreement must be affirmatively accepted ───────────────────
  const [agreed, setAgreed] = useState(false);

  // ── step 3: permissions ────────────────────────────────────────────────────
  const [notif, setNotif] = useState<PermState>('unknown');
  const [fgLoc, setFgLoc] = useState<PermState>('unknown');
  const [bgLoc, setBgLoc] = useState<PermState>('unknown');
  /** P-040 step 2 of 2: the explanation is shown BEFORE the OS dialog, not after. */
  const [bgExplained, setBgExplained] = useState(false);
  const [permBusy, setPermBusy] = useState(false);

  /**
   * Read the truth from the OS. Called on mount, after every request, and every
   * time the app comes back to the foreground — because the most common way a
   * permission changes is the user walking to Settings and changing it there,
   * and a screen that keeps showing the stale answer is exactly the "dead and
   * looks alive" failure (P-031).
   */
  const refreshPermissions = useCallback(async (): Promise<void> => {
    try {
      const n = await Notifications.getPermissionsAsync();
      setNotif(n.granted ? 'granted' : n.canAskAgain ? 'unknown' : 'denied');
    } catch {
      setNotif('unknown');
    }
    try {
      const f = await Location.getForegroundPermissionsAsync();
      setFgLoc(f.granted ? 'granted' : f.canAskAgain ? 'unknown' : 'denied');
    } catch {
      setFgLoc('unknown');
    }
    try {
      const b = await Location.getBackgroundPermissionsAsync();
      setBgLoc(b.granted ? 'granted' : b.canAskAgain ? 'unknown' : 'denied');
    } catch {
      setBgLoc('unknown');
    }
  }, []);

  useEffect(() => {
    void refreshPermissions();
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') void refreshPermissions();
    });
    return () => sub.remove();
  }, [refreshPermissions]);

  const askNotifications = useCallback(async (): Promise<void> => {
    setPermBusy(true);
    try {
      await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowSound: true,
          allowBadge: true,
          // F-03: without the critical-alerts entitlement this is silently
          // ignored, which is why the answer below is re-read rather than assumed.
          allowCriticalAlerts: true,
        },
      });
    } catch {
      // A refusal, a missing module or a thrown dialog all mean the same thing:
      // ask the OS what actually happened.
    }
    await refreshPermissions();
    setPermBusy(false);
  }, [refreshPermissions]);

  const askForeground = useCallback(async (): Promise<void> => {
    setPermBusy(true);
    try {
      await Location.requestForegroundPermissionsAsync();
    } catch {
      /* fall through to the verify */
    }
    await refreshPermissions();
    setPermBusy(false);
  }, [refreshPermissions]);

  /**
   * ★ P-040 — THE SECOND HALF OF THE TWO-STEP ★
   *
   * Android will not grant "Allow all the time" from a cold prompt: it must be
   * preceded by a granted foreground permission, and on Android 11+ it does not
   * even show a dialog — it opens the Settings page and returns `granted: false`
   * immediately. So the result of the request is discarded and the OS is asked
   * again. Assuming this worked is how a family's location silently stops at the
   * lock screen for six months.
   */
  const askBackground = useCallback(async (): Promise<void> => {
    setPermBusy(true);
    try {
      await Location.requestBackgroundPermissionsAsync();
    } catch {
      /* fall through to the verify */
    }
    await refreshPermissions();
    setPermBusy(false);
  }, [refreshPermissions]);

  const openOsSettings = useCallback((): void => {
    // Wrapped: on some OEM builds this activity is not exported and throws.
    void (async () => {
      try {
        await Linking.openSettings();
      } catch {
        setBgExplained(true);
      }
    })();
  }, []);

  // ── step 4: PINs ───────────────────────────────────────────────────────────
  // ★ PERFORMANCE — why the parent holds only a boolean here.
  //
  // The PIN entry state used to live in THIS component, so every digit ran two
  // setState calls on a 1,700-line screen with ~30 hooks and a dozen store
  // subscriptions, recreating every inline handler and re-rendering the active
  // step. On a mid-range phone that is tens of milliseconds of JS per keystroke,
  // which is exactly the "unregistered keystrokes" symptom.
  //
  // PinsStep now owns the whole choose → confirm → practise machine internally
  // and reports one fact back. A keypress re-renders the pad and nothing else.
  const [pinsDone, setPinsDone] = useState(false);

  // ── step 5: medical ────────────────────────────────────────────────────────
  // The ten fields live INSIDE MedicalStep. Holding them here meant every
  // character typed into any of them re-rendered this entire screen; the parent
  // only ever needs the values at the moment the user advances, so it reads them
  // once through the ref instead of tracking them keystroke by keystroke.
  const medicalRef = useRef<MedicalHandle>(null);
  const [medicalSaved, setMedicalSaved] = useState(false);

  // ── step 6: the test SOS ───────────────────────────────────────────────────
  //
  // ★ PERFORMANCE — the 10 Hz tick does NOT live here (any more). ★
  //
  // The countdown ring needs a 100 ms clock. Holding that clock in THIS
  // component re-rendered a 1,800-line screen with ~30 hooks ten times a second
  // for the whole cancel window, and `DrillStep` re-rendered with it — which
  // meant all eleven `PinKey`s re-rendered 10×/s on the one screen whose entire
  // purpose is teaching people that the pad is reliable. The `memo` on `PinPad`
  // could not help, because the handlers below used to be inline arrows and
  // changed identity on every one of those renders.
  //
  // The clock now lives in `DrillRing`, which subscribes to `pendingUntil`
  // itself. This is the same fix the comment at PinsStep describes, applied one
  // step later.
  const [drillId, setDrillId] = useState<UUID | null>(null);
  const [drillPin, setDrillPin] = useState('');
  const [drillPassed, setDrillPassed] = useState(false);
  const [drillNote, setDrillNote] = useState<string | null>(null);
  const [holdMs, setHoldMs] = useState(0);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The PIN as the keypad has it, so the key handler has no changing dependency. */
  const drillPinRef = useRef('');

  const windowMs = useMemo(
    // The rehearsal uses the REAL window for this device and this risk context,
    // not a friendly one. Practising against a longer clock than you get is not
    // practice (ADR-013: policy is the authority on duration).
    () => effectiveCancelWindowS(DEFAULT_POLICY, 'DRILL', risk) * 1000,
    [risk],
  );

  const stopHold = useCallback((): void => {
    if (holdTimer.current !== null) {
      clearInterval(holdTimer.current);
      holdTimer.current = null;
    }
    setHoldMs(0);
  }, []);

  useEffect(() => stopHold, [stopHold]);

  const fireTestSos = useCallback((): void => {
    setDrillNote(null);
    drillPinRef.current = '';
    setDrillPin('');
    void (async () => {
      // isDrill rides on the incident, the sealed envelope and every notification
      // it produces, so nobody downstream mistakes a rehearsal for an emergency
      // (F-02 — the drill is exercised, the family is not woken).
      const id = await trigger('DRILL', { isDrill: true, confidencePct: 100 });
      setDrillId(id);
    })();
  }, [trigger]);

  const beginHold = useCallback((): void => {
    if (holdTimer.current !== null) return;
    setHoldMs(0);
    let elapsed = 0;
    holdTimer.current = setInterval(() => {
      elapsed += HOLD_TICK_MS;
      setHoldMs(elapsed);
      if (elapsed >= HOLD_MS) {
        stopHold();
        fireTestSos();
      }
    }, HOLD_TICK_MS);
  }, [fireTestSos, stopHold]);

  const submitDrillPin = useCallback(
    (pin: string): void => {
      void (async () => {
        const verdict = await cancelWithPin(pin);
        if (verdict === 'wrong') {
          drillPinRef.current = '';
          setDrillPin('');
          setDrillNote('That is not one of your PINs. Try again — the clock is still running.');
          return;
        }
        // ★ F-01 — ONE BRANCH FOR BOTH ACCEPTING VERDICTS ★
        // 'cancelled' and 'duress' render the identical screen, run the identical
        // follow-up and leave the identical trace on this device. Anything that
        // distinguished them here — a different string, an extra call, an early
        // return — would tell an attacker watching over your shoulder which PIN
        // you just typed, and that is the whole point of having two.
        drillPinRef.current = '';
        setDrillPin('');
        setDrillPassed(true);
        setDrillNote(null);
        const id = drillId;
        if (id) await classify(id, 'drill');
      })();
    },
    [cancelWithPin, classify, drillId],
  );

  /**
   * The pad's two handlers, stable across the countdown.
   *
   * The digits live in a ref beside the state so this closure has nothing to
   * depend on but `submitDrillPin`. As inline arrows they were rebuilt on every
   * parent render, which defeated `memo(PinPad)` entirely.
   */
  const onDrillKey = useCallback(
    (digit: string): void => {
      const next = (drillPinRef.current + digit).slice(0, PIN_LENGTH);
      drillPinRef.current = next;
      setDrillPin(next);
      if (next.length === PIN_LENGTH) submitDrillPin(next);
    },
    [submitDrillPin],
  );

  const onDrillBackspace = useCallback((): void => {
    drillPinRef.current = drillPinRef.current.slice(0, -1);
    setDrillPin(drillPinRef.current);
  }, []);

  /** The window ran out. Close the rehearsal honestly rather than hiding it. */
  const stopRunawayDrill = useCallback((): void => {
    const id = drillId;
    if (!id) return;
    void (async () => {
      await resolveIncident(id);
      await classify(id, 'drill');
      setDrillId(null);
      drillPinRef.current = '';
      setDrillPin('');
      setDrillNote('Test stopped. Try again — this time enter your PIN before the ring empties.');
    })();
  }, [classify, drillId, resolveIncident]);

  const drillRunaway = drillId !== null && !drillPassed && pendingUntil === null && isActive(t0State);

  // ── navigation ─────────────────────────────────────────────────────────────

  const canAdvance = useMemo((): boolean => {
    switch (current.id) {
      case 'reality':
        return true;
      case 'agreement':
        return agreed;
      case 'permissions':
        // Permissions are refusable. Holding onboarding hostage to them produces
        // a user who taps Allow without reading, which is worse than a user who
        // knowingly declined — so the gate is honesty, not consent (§20.3).
        return true;
      case 'pins':
        return pinsDone;
      case 'medical':
        return true;
      case 'drill':
        // ★ NEVER a hard gate. ★
        // This used to be `return drillPassed`, which meant that on any device
        // where the rehearsal could not complete, "Finish setup" was disabled —
        // and a disabled button with no explanation is indistinguishable from a
        // broken one. It trapped people on the last step with no way into the
        // app at all.
        //
        // The drill is still the single best predictor that this will work when
        // it matters (Appendix E.4), so skipping it is recorded and surfaced
        // afterwards rather than silently forgiven. Refusing entry is the one
        // response that helps nobody: a person stuck in onboarding has NO panic
        // button, which is strictly worse than one who has not yet rehearsed.
        return true;
    }
  }, [current.id, agreed, pinsDone]);

  const finish = useCallback((): void => {
    void (async () => {
      // Store first: the router reacts to it, so navigation can never be held up
      // by a slow — or, on a device with no hardware keystore, failing — write.
      await completeOnboarding(drillPassed);
      router.replace('/');
    })();
  }, [completeOnboarding, drillPassed, router]);

  const goNext = useCallback((): void => {
    if (current.id === 'medical' && !medicalSaved) {
      void (async () => {
        const card = medicalRef.current?.build();
        if (card) await saveMedical(card);
        setMedicalSaved(true);
        setStep((s) => Math.min(STEPS.length - 1, s + 1));
      })();
      return;
    }
    if (step === STEPS.length - 1) {
      finish();
      return;
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }, [current.id, finish, medicalSaved, saveMedical, step]);

  const goBack = useCallback((): void => {
    // Never leave a rehearsal incident open behind you.
    if (current.id === 'drill' && drillRunaway) stopRunawayDrill();
    setStep((s) => Math.max(0, s - 1));
  }, [current.id, drillRunaway, stopRunawayDrill]);

  // ═════════════════════════════════════════════════════════════════════════════

  return (
    <View style={styles.root}>
      <StepHeader
        index={step}
        total={STEPS.length}
        title={current.title}
        topInset={insets.top}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollBody}
        keyboardShouldPersistTaps="handled"
      >
        {current.id === 'reality' ? <RealityStep /> : null}

        {current.id === 'agreement' ? (
          <AgreementStep agreed={agreed} onChange={setAgreed} />
        ) : null}

        {current.id === 'permissions' ? (
          <PermissionsStep
            notif={notif}
            fgLoc={fgLoc}
            bgLoc={bgLoc}
            bgExplained={bgExplained}
            busy={permBusy}
            onAskNotifications={() => void askNotifications()}
            onAskForeground={() => void askForeground()}
            onExplainBackground={() => setBgExplained(true)}
            onAskBackground={() => void askBackground()}
            onRecheck={() => void refreshPermissions()}
            onOpenSettings={openOsSettings}
          />
        ) : null}

        {current.id === 'pins' ? <PinsStep onDoneChange={setPinsDone} /> : null}

        {/* Kept mounted across steps so a half-typed card survives Back/Continue. */}
        <View style={current.id === 'medical' ? undefined : styles.hidden}>
          <MedicalStep ref={medicalRef} />
        </View>

        {current.id === 'drill' ? (
          <DrillStep
            ready={ready}
            armed={drillId !== null}
            pending={pendingUntil !== null}
            runaway={drillRunaway}
            passed={drillPassed}
            note={drillNote}
            holdProgress={holdMs / HOLD_MS}
            windowMs={windowMs}
            pin={drillPin}
            onHoldStart={beginHold}
            onHoldEnd={stopHold}
            onKey={onDrillKey}
            onBackspace={onDrillBackspace}
            onStopRunaway={stopRunawayDrill}
            onRetry={fireTestSos}
          />
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + space.lg }]}>
        {step > 0 ? (
          <Button
            label="Back"
            variant="quiet"
            onPress={goBack}
            accessibilityLabel={`Back to ${STEPS[Math.max(0, step - 1)].title}`}
            style={styles.footerBack}
          />
        ) : null}
        <Button
          label={step === STEPS.length - 1 ? 'Finish setup' : 'Continue'}
          variant="primary"
          size="lg"
          disabled={!canAdvance}
          onPress={goNext}
          accessibilityLabel={
            canAdvance
              ? step === STEPS.length - 1
                ? 'Finish setup'
                : `Continue to ${STEPS[Math.min(STEPS.length - 1, step + 1)].title}`
              : blockedReason(current.id)
          }
          style={styles.footerNext}
        />
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Both PINs, written with the same keychain class the store uses for the
 * emergency key: `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, never biometric-gated. An
 * unconscious person cannot provide a fingerprint (F-17), and a cancel PIN that
 * needs a face to reach is a cancel PIN that fails in the dark.
 */
async function persistPins(cancelPin: string, duressPin: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEYS.cancelPin, cancelPin, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(STORAGE_KEYS.duressPin, duressPin, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch {
    return false;
  }
  setPins(cancelPin, duressPin);
  return true;
}

function isWeakPin(pin: string): boolean {
  if (/^(\d)\1{3}$/.test(pin)) return true;
  return ['1234', '4321', '0123', '1111', '2580', '1212'].includes(pin);
}

function blockedReason(id: StepId): string {
  switch (id) {
    case 'agreement':
      return 'Read and accept the family agreement to continue';
    case 'pins':
      return 'Set and practise both PINs to continue';
    case 'drill':
      return 'Send a test SOS and cancel it to finish';
    default:
      return 'Continue';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Header
// ═══════════════════════════════════════════════════════════════════════════════

function StepHeader({
  index,
  total,
  title,
  topInset,
}: {
  index: number;
  total: number;
  title: string;
  topInset: number;
}) {
  return (
    <View style={[styles.header, { paddingTop: topInset + space.md }]}>
      <Text style={styles.headerCount} accessibilityLabel={`Step ${index + 1} of ${total}`}>
        {`STEP ${index + 1} / ${total}`}
      </Text>
      <Text accessibilityRole="header" style={styles.headerTitle}>
        {title}
      </Text>
      <View style={styles.dots} importantForAccessibility="no-hide-descendants">
        {STEPS.map((s, i) => (
          <View
            key={s.id}
            style={[
              styles.dot,
              i < index ? styles.dotDone : null,
              i === index ? styles.dotCurrent : null,
            ]}
          />
        ))}
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 1 — what this is, and what it is not
// ═══════════════════════════════════════════════════════════════════════════════

function RealityStep() {
  return (
    <>
      <Card tone="info" style={styles.card}>
        <Text style={styles.h2}>Kavach is a second layer.</Text>
        <Text style={styles.body}>
          When something goes wrong, Kavach wakes the people who already love you — the six
          people whose phones are in this family. It gives them your location, your medical
          card and a way to say “I am on my way”, in seconds, without anyone having to explain
          anything to a stranger.
        </Text>
      </Card>

      {/* ★ §20.1 — the limits go FIRST, at full size, in the same type as the
          promises. A limitation a user discovers during an emergency is a lie
          they were told during onboarding. */}
      <Card tone="danger" style={styles.card}>
        <Text style={styles.h2}>What Kavach is NOT</Text>
        <Bullet glyph="✕">
          <Text style={styles.bulletStrong}>It cannot call an ambulance or the police for you.</Text>
          {'\n'}
          Kavach has no connection to 112, to any control room, or to any emergency service.
          Nobody official is watching. The CALL 112 button dials your phone’s dialler — you or
          whoever reaches you still has to speak to them.
        </Bullet>
        <Bullet glyph="✕">
          <Text style={styles.bulletStrong}>It is not a guarantee, and it will sometimes fail.</Text>
          {'\n'}
          A dead battery, a phone left at home, no signal in a basement, a phone destroyed on
          impact, or Android quietly killing the app in the background — any of these and
          Kavach sends nothing at all.
        </Bullet>
        <Bullet glyph="✕">
          <Text style={styles.bulletStrong}>It is not a first response. It is a second one.</Text>
          {'\n'}
          If you can call 112 yourself, call 112. Use Kavach when you cannot, or afterwards, so
          your family knows where you are.
        </Bullet>
        <Bullet glyph="✕">
          <Text style={styles.bulletStrong}>It is not a tracker for watching people.</Text>
          {'\n'}
          Every look at someone’s location is logged and shown to them, and every permission
          expires on its own. There is no permanent, invisible view of anybody.
        </Bullet>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.h3}>What it does do, honestly</Text>
        <Bullet glyph="✓">Alerts your family in seconds, over whatever still works — internet, push, or plain SMS.</Bullet>
        <Bullet glyph="✓">Shows exactly who has responded, and shouts when nobody has.</Bullet>
        <Bullet glyph="✓">Keeps working with no internet, no server and no signal from us.</Bullet>
        <Bullet glyph="✓">Tells you when it is broken, instead of pretending to be fine.</Bullet>
      </Card>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 2 — family agreement (PRD §20.3)
// ═══════════════════════════════════════════════════════════════════════════════

function AgreementStep({ agreed, onChange }: { agreed: boolean; onChange: (v: boolean) => void }) {
  return (
    <>
      <Card style={styles.card}>
        <Text style={styles.h3}>What is collected</Text>
        <Bullet glyph="•">
          <Text style={styles.bulletStrong}>Your location.</Text> Roughly every 15 minutes while
          nothing is happening, every 3 seconds during an emergency. Precise points stay on this
          phone; only a coarse area — about a neighbourhood — ever leaves it outside an incident.
        </Bullet>
        <Bullet glyph="•">
          <Text style={styles.bulletStrong}>Your phone’s health.</Text> Battery level, whether the
          safety agent is alive, and whether your permissions are still granted.
        </Bullet>
        <Bullet glyph="•">
          <Text style={styles.bulletStrong}>Your medical card,</Text> if you fill one in. It is
          encrypted and only unsealed during an incident you are the subject of.
        </Bullet>
        <Bullet glyph="•">
          <Text style={styles.bulletStrong}>Incidents.</Text> What triggered, who was told, who
          responded, when, and how it ended.
        </Bullet>
        <Bullet glyph="•">
          <Text style={styles.bulletStrong}>Never:</Text> your microphone, your camera, your
          messages, your browsing, or the addresses you save as safe places. Journey routes and
          geofence centres never leave this phone at all.
        </Bullet>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.h3}>Who sees what, and for how long</Text>
        <Bullet glyph="•">
          Nobody sees your live location by default. Someone sees it only while a permission you
          granted is still alive, or while you are the subject of an active incident.
        </Bullet>
        <Bullet glyph="•">
          <Text style={styles.bulletStrong}>No permission is permanent.</Text> Every one has an
          expiry, and it stops on its own. {t('consent.noPermanent')}
        </Bullet>
        <Bullet glyph="•">
          Every time somebody looks, you are told — the Privacy tab lists who looked at what and
          when. There is no silent view.
        </Bullet>
        <Bullet glyph="•">
          Guardians can see minors’ locations continuously. Minors are shown that this is
          happening, on their own screen, permanently. Nothing about it is hidden from them.
        </Bullet>
        <Bullet glyph="•">
          Incident history is kept so your family can look back at what happened. Raw sensor data
          is discarded within a rolling 60-second window unless an incident seals it.
        </Bullet>
      </Card>

      <Card tone="warn" style={styles.card}>
        <Text style={styles.h3}>How to opt out — and what it costs</Text>
        <Bullet glyph="•">
          <Text style={styles.bulletStrong}>Pause monitoring</Text> any time, from Settings. Your
          family is shown “monitoring paused” — not a silent gap, because a silent gap looks
          exactly like a dead phone and would send someone looking for you.
        </Bullet>
        <Bullet glyph="•">
          <Text style={styles.bulletStrong}>Revoke any permission</Text> instantly, from Privacy.
          Routing stops at once. The data already delivered cannot be un-delivered, and the app
          says so rather than pretending otherwise.
        </Bullet>
        <Bullet glyph="•">
          <Text style={styles.bulletStrong}>Leave the family</Text> from Settings. Your incidents
          and your medical card are deleted from this phone, and your family is told you left.
        </Bullet>
        <Bullet glyph="•">
          <Text style={styles.bulletStrong}>The cost is real:</Text> while paused, or after
          leaving, nothing detects a fall, nothing notices a missed check-in, and pressing SOS
          reaches nobody. Kavach will not quietly keep half-working.
        </Bullet>
      </Card>

      <Toggle
        value={agreed}
        onChange={onChange}
        label="I have read this agreement and I accept it"
        hint="Required. Your family sees the same text and accepts it on their own phone."
        style={styles.agreeToggle}
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 3 — permissions (justification strings: PRD Appendix A)
// ═══════════════════════════════════════════════════════════════════════════════

interface PermissionsStepProps {
  notif: PermState;
  fgLoc: PermState;
  bgLoc: PermState;
  bgExplained: boolean;
  busy: boolean;
  onAskNotifications: () => void;
  onAskForeground: () => void;
  onExplainBackground: () => void;
  onAskBackground: () => void;
  onRecheck: () => void;
  onOpenSettings: () => void;
}

function PermissionsStep(p: PermissionsStepProps) {
  return (
    <>
      <Card style={styles.card}>
        <Text style={styles.body}>
          Each of these is asked for one reason, and that reason is written below it. You can say
          no to any of them — the screen will then tell you exactly what stops working, rather
          than asking again later.
        </Text>
      </Card>

      <PermissionRow
        state={p.notif}
        title="Notifications"
        // Appendix A, verbatim.
        justification="So you are woken when a member of your family needs help."
        detail="Without this you will not be told when someone triggers an alarm. Their phone will still send it; yours will stay silent."
        actionLabel="Allow notifications"
        onAction={p.onAskNotifications}
        busy={p.busy}
        onOpenSettings={p.onOpenSettings}
      />

      <PermissionRow
        state={p.fgLoc}
        title="Location, while using the app"
        justification="So your family can find you in an emergency."
        detail="Without this an alarm carries no coordinates, and the people coming to help have nothing to go to."
        actionLabel="Allow location"
        onAction={p.onAskForeground}
        busy={p.busy}
        onOpenSettings={p.onOpenSettings}
      />

      {/* ★ P-040 — TWO-STEP BACKGROUND LOCATION ★
          Step 1 is the row above. Step 2 is gated on it, explained in words
          BEFORE the OS dialog appears, and then VERIFIED by re-reading the OS.
          Android 11+ shows no dialog here at all — it opens Settings and returns
          "not granted" immediately, which is why "Check again" exists. */}
      <Card
        tone={p.bgLoc === 'granted' ? 'ok' : p.fgLoc === 'granted' ? 'warn' : undefined}
        style={styles.card}
      >
        <View style={styles.permHead}>
          <Text style={styles.h3}>Location, all the time</Text>
          <Pill
            label={
              p.bgLoc === 'granted' ? 'Granted' : p.bgLoc === 'denied' ? 'Refused' : 'Not yet asked'
            }
            tone={p.bgLoc === 'granted' ? 'ok' : p.bgLoc === 'denied' ? 'danger' : 'neutral'}
          />
        </View>
        <Text style={styles.justify}>
          So your family can find you even when your phone is in your pocket and the screen is
          locked.
        </Text>

        {p.fgLoc !== 'granted' ? (
          <Text style={styles.warnLine}>
            Step 1 first: your phone will not offer “all the time” until “while using the app” is
            granted above. This is an Android rule, not ours.
          </Text>
        ) : !p.bgExplained ? (
          <>
            <Text style={styles.body}>
              This is a second, separate permission, and it is the one that matters at 2 a.m. With
              only “while using the app”, your location stops the moment the screen locks — so a
              fall in the night, a crash on the way home, or a missed check-in reaches your family
              with no location at all.
            </Text>
            <Text style={styles.body}>
              Your phone may not show a dialog for this. It may open its Settings page instead and
              you will have to pick “Allow all the time” yourself. Kavach will check afterwards and
              tell you honestly whether it worked.
            </Text>
            <Button
              label="I understand — ask me now"
              variant="primary"
              onPress={p.onExplainBackground}
              accessibilityLabel="Continue to the all-the-time location request"
              style={styles.permButton}
            />
          </>
        ) : (
          <>
            <Text style={styles.body}>
              Choose <Text style={styles.bulletStrong}>Allow all the time</Text>. If your phone
              opened its Settings page instead of asking, set it there and come back.
            </Text>
            <View style={styles.permButtons}>
              <Button
                label={p.busy ? 'Asking…' : 'Request'}
                variant="primary"
                disabled={p.busy}
                onPress={p.onAskBackground}
                accessibilityLabel="Request all-the-time location permission"
                style={styles.permButtonHalf}
              />
              <Button
                label="Check again"
                variant="ghost"
                onPress={p.onRecheck}
                accessibilityLabel="Re-read the all-the-time location permission from the system"
                style={styles.permButtonHalf}
              />
            </View>
            {p.bgLoc !== 'granted' ? (
              <>
                <Text style={styles.warnLine}>
                  Not granted yet. Kavach checked with your phone directly — it did not assume the
                  request worked.
                </Text>
                <Button
                  label="Open phone settings"
                  variant="quiet"
                  onPress={p.onOpenSettings}
                  accessibilityLabel="Open the system settings page for Kavach"
                  style={styles.permButton}
                />
              </>
            ) : null}
          </>
        )}
      </Card>

      {Platform.OS === 'android' ? (
        <Card style={styles.card}>
          <Text style={styles.h3}>One more thing, after setup</Text>
          <Text style={styles.body}>
            Most Android phones — Xiaomi, Oppo, Realme, Vivo, Samsung, OnePlus — will kill Kavach
            in the background to save battery, and give you no warning. Self-diagnostics checks
            this and walks you through your exact phone’s menus. Run it once you are finished here.
          </Text>
        </Card>
      ) : null}
    </>
  );
}

interface PermissionRowProps {
  state: PermState;
  title: string;
  justification: string;
  detail: string;
  actionLabel: string;
  busy: boolean;
  onAction: () => void;
  onOpenSettings: () => void;
}

function PermissionRow(p: PermissionRowProps) {
  const granted = p.state === 'granted';
  return (
    <Card tone={granted ? 'ok' : p.state === 'denied' ? 'warn' : undefined} style={styles.card}>
      <View style={styles.permHead}>
        <Text style={styles.h3}>{p.title}</Text>
        <Pill
          label={granted ? 'Granted' : p.state === 'denied' ? 'Refused' : 'Not yet asked'}
          tone={granted ? 'ok' : p.state === 'denied' ? 'danger' : 'neutral'}
        />
      </View>
      <Text style={styles.justify}>{p.justification}</Text>
      {granted ? null : <Text style={styles.warnLine}>{p.detail}</Text>}
      {granted ? null : p.state === 'denied' ? (
        <Button
          label="Open phone settings"
          variant="quiet"
          onPress={p.onOpenSettings}
          accessibilityLabel={`Open system settings to grant ${p.title}`}
          style={styles.permButton}
        />
      ) : (
        <Button
          label={p.busy ? 'Asking…' : p.actionLabel}
          variant="primary"
          disabled={p.busy}
          onPress={p.onAction}
          accessibilityLabel={p.actionLabel}
          style={styles.permButton}
        />
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 4 — the two PINs
// ═══════════════════════════════════════════════════════════════════════════════

type PinPhase = 'cancel' | 'cancelConfirm' | 'duress' | 'duressConfirm' | 'practice' | 'done';

interface PinsStepProps {
  /** Fires only when the pair becomes valid/invalid — never on a keystroke. */
  onDoneChange: (done: boolean) => void;
}

const PIN_PROMPTS: Record<PinPhase, { title: string; body: string }> = {
  cancel: {
    title: 'Choose your cancel PIN',
    body: 'Four digits. You type this to stop an alarm you did not mean to send. Pick something you can enter with shaking hands, in the dark, without thinking.',
  },
  cancelConfirm: {
    title: 'Enter your cancel PIN again',
    body: 'Confirming it now is cheaper than discovering a typo during an emergency.',
  },
  duress: {
    title: 'Choose your duress PIN',
    body: 'A different four digits. If somebody is standing over you and forcing you to cancel, type THIS one. The screen will look exactly the same as a real cancel — and your family will be told anyway, silently.',
  },
  duressConfirm: {
    title: 'Enter your duress PIN again',
    body: 'This one has to be right. It is the PIN you will use when you cannot afford to be seen using it.',
  },
  practice: {
    title: 'Practise: type your cancel PIN',
    body: 'One rehearsal now, while nothing is wrong. A PIN you have never typed is a PIN you will not remember.',
  },
  done: {
    title: 'Both PINs are set',
    body: 'They are stored on this phone only, without biometrics — because an unconscious person cannot provide a fingerprint.',
  },
};

/**
 * ★ Self-contained on purpose (performance). ★
 *
 * The choose → confirm → choose → confirm → practise → persist machine and the
 * digits being typed all live HERE. The parent is told one thing, once: whether
 * the pair is valid. A keystroke therefore re-renders this card and the pad, and
 * nothing else on the screen.
 *
 * When this state lived in the parent, every digit re-rendered a 1,700-line
 * component with ~30 hooks and a dozen store subscriptions, recreating every
 * handler closure on the way — which is what made the pad feel like it was
 * dropping presses. `memo` keeps it that way: the only prop is a stable setter.
 */
const PinsStep = memo(function PinsStep({ onDoneChange }: PinsStepProps) {
  const [phase, setPhase] = useState<PinPhase>('cancel');
  const [entry, setEntry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cancelPin, setCancelPin] = useState('');
  const [duressPin, setDuressPin] = useState('');

  useEffect(() => {
    onDoneChange(phase === 'done');
  }, [phase, onDoneChange]);

  /** The machine. Order reads top to bottom, exactly as the user meets it. */
  const advance = useCallback(
    (entered: string): void => {
      switch (phase) {
        case 'cancel':
          if (isWeakPin(entered)) {
            setEntry('');
            setError('Too easy to guess. Avoid 1234, 0000 and four of the same digit.');
            return;
          }
          setCancelPin(entered);
          setEntry('');
          setPhase('cancelConfirm');
          return;

        case 'cancelConfirm':
          setEntry('');
          if (entered !== cancelPin) {
            setCancelPin('');
            setPhase('cancel');
            setError('Those did not match. Start again.');
            return;
          }
          setPhase('duress');
          return;

        case 'duress':
          setEntry('');
          if (entered === cancelPin) {
            setError('The duress PIN must be different — otherwise there is no second answer.');
            return;
          }
          if (isWeakPin(entered)) {
            setError('Too easy to guess. Avoid 1234, 0000 and four of the same digit.');
            return;
          }
          setDuressPin(entered);
          setPhase('duressConfirm');
          return;

        case 'duressConfirm':
          setEntry('');
          if (entered !== duressPin) {
            setDuressPin('');
            setPhase('duress');
            setError('Those did not match. Enter your duress PIN again.');
            return;
          }
          setPhase('practice');
          return;

        case 'practice':
          setEntry('');
          // Compares in memory against what was just chosen, and deliberately does
          // NOT call verifyPin — that has side effects (stops alarms, dispatches a
          // cancel envelope). Step 6 exercises the real one against a real
          // incident, which is where it belongs.
          if (entered !== cancelPin) {
            setError('Not your cancel PIN. This is the one you will need at 2 a.m.');
            return;
          }
          void persistPins(cancelPin, duressPin).then((ok) => {
            if (ok) {
              setPhase('done');
              setError(null);
            } else {
              setError('This phone would not store the PINs. Try once more.');
            }
          });
          return;

        case 'done':
          setEntry('');
          return;
      }
    },
    [cancelPin, duressPin, phase],
  );

  const onKey = useCallback(
    (digit: string): void => {
      setError(null);
      setEntry((prev) => {
        const next = (prev + digit).slice(0, PIN_LENGTH);
        // Deferred so the digit paints before the machine runs: advancing inside
        // the updater would make the last press of each PIN feel dropped.
        if (next.length === PIN_LENGTH) queueMicrotask(() => advance(next));
        return next;
      });
    },
    [advance],
  );

  const onBackspace = useCallback((): void => {
    setError(null);
    setEntry((v) => v.slice(0, -1));
  }, []);

  const onRestart = useCallback((): void => {
    setPhase('cancel');
    setEntry('');
    setCancelPin('');
    setDuressPin('');
    setError(null);
  }, []);

  const p = { phase, entry, error, cancelPin, onKey, onBackspace, onRestart };
  const prompt = PIN_PROMPTS[phase];
  return (
    <>
      <Card tone="info" style={styles.card}>
        <Text style={styles.h3}>Why two PINs</Text>
        <Text style={styles.body}>
          The <Text style={styles.bulletStrong}>cancel PIN</Text> is a normal “oops, I am fine”.
        </Text>
        <Text style={styles.body}>
          The <Text style={styles.bulletStrong}>duress PIN</Text> is for when someone is watching
          you cancel. Kavach behaves identically on screen — same words, same timing, same
          everything — but the alarm goes out silently anyway, marked as coerced.
        </Text>
        <Text style={styles.footnote}>
          If you never need the second one, nothing is lost. If you need it once, it is the only
          thing on this screen that matters.
        </Text>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.h2}>{prompt.title}</Text>
        <Text style={styles.body}>{prompt.body}</Text>

        {p.phase === 'done' ? (
          <View style={styles.pinDoneRow}>
            <Pill label="Cancel PIN set" tone="ok" />
            <Pill label="Duress PIN set" tone="ok" />
          </View>
        ) : (
          <>
            <PinDots filled={p.entry.length} />
            {p.error === null ? null : (
              <Text style={styles.errorLine} accessibilityLiveRegion="polite">
                {p.error}
              </Text>
            )}
            <PinPad onKey={p.onKey} onBackspace={p.onBackspace} />
          </>
        )}
      </Card>

      {p.phase === 'done' ? (
        <Button
          label="Change my PINs"
          variant="quiet"
          onPress={p.onRestart}
          accessibilityLabel="Start choosing both PINs again"
          style={styles.card}
        />
      ) : null}
    </>
  );
});

function PinDots({ filled }: { filled: number }) {
  return (
    <View
      style={styles.pinDots}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${filled} of ${PIN_LENGTH} digits entered`}
    >
      {Array.from({ length: PIN_LENGTH }, (_, i) => (
        <View key={i} style={[styles.pinDot, i < filled ? styles.pinDotFilled : null]} />
      ))}
    </View>
  );
}

/**
 * The keypad, not the system keyboard.
 *
 * §6.4: this is pressed one-handed, possibly in the rain, by someone whose
 * vision has narrowed. A 24 dp system keyboard key is not reachable under those
 * conditions; these are MIN_TOUCH_TARGET-and-a-half and never move.
 */
const PAD_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/**
 * The pad is memoised and each key takes its digit as a PROP rather than a fresh
 * closure. `onPress={() => onKey(d)}` allocated eleven new functions on every
 * render, so every key re-rendered on every keystroke — eleven Pressables of
 * pointless work per digit, on the one screen where input latency is most
 * obvious.
 */
const PinPad = memo(function PinPad({
  onKey,
  onBackspace,
}: {
  onKey: (d: string) => void;
  onBackspace: () => void;
}) {
  return (
    <View style={styles.pad}>
      {PAD_DIGITS.map((d) => (
        <PinKey key={d} label={d} digit={d} onDigit={onKey} />
      ))}
      <View style={styles.padSpacer} />
      <PinKey label="0" digit="0" onDigit={onKey} />
      <PinKey label="⌫" accessibilityLabel="Delete last digit" onPress={onBackspace} />
    </View>
  );
});

/**
 * Takes `digit` + a stable `onDigit`, so its props are referentially stable across
 * renders and `memo` actually bites. A key that carries its own closure cannot be
 * memoised at all, which is why the pad used to re-render wholesale per press.
 *
 * A light haptic on press is not decoration: on a pad with no audible click, it
 * is the only confirmation an elderly or low-vision user gets that the digit
 * registered (P-018).
 *
 * ★ AND WHY THIS ONE IS NOT PressableScale ★ Everything else on these screens
 * is, and should be. Eleven keys each carrying a hook, an Animated.Value and an
 * interpolation is a real cost on the one control in the product where input
 * latency is felt digit by digit — and the pad is pressed under a running
 * countdown. The two channels PressableScale exists to give (a haptic and a
 * static pressed state) are both here already; only the spring is traded away.
 */
const PinKey = memo(function PinKey({
  label,
  digit,
  onDigit,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  digit?: string;
  onDigit?: (d: string) => void;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const handle = useCallback((): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (digit !== undefined && onDigit) onDigit(digit);
    else if (onPress) onPress();
  }, [digit, onDigit, onPress]);

  return (
    <Pressable
      onPress={handle}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [styles.padKey, pressed ? styles.padKeyPressed : null]}
    >
      <Text style={styles.padKeyLabel} allowFontScaling={false}>
        {label}
      </Text>
    </Pressable>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Step 5 — medical card
// ═══════════════════════════════════════════════════════════════════════════════

const BLOOD_GROUPS = ['A+', 'A−', 'B+', 'B−', 'AB+', 'AB−', 'O+', 'O−'];

interface MedicalStepProps {
  bloodGroup: string;
  onBloodGroup: (v: string) => void;
  allergies: string;
  onAllergies: (v: string) => void;
  medications: string;
  onMedications: (v: string) => void;
  conditions: string;
  onConditions: (v: string) => void;
  ice1Name: string;
  onIce1Name: (v: string) => void;
  ice1Phone: string;
  onIce1Phone: (v: string) => void;
  ice2Name: string;
  onIce2Name: (v: string) => void;
  ice2Phone: string;
  onIce2Phone: (v: string) => void;
  organDonor: boolean;
  onOrganDonor: (v: boolean) => void;
  notes: string;
  onNotes: (v: string) => void;
}

export interface MedicalHandle {
  build: () => MedicalCard;
}

/**
 * ★ Owns its own ten fields (performance). ★
 *
 * These lived in the parent, so every character typed into any of the ten inputs
 * re-rendered the whole onboarding screen. The parent does not need them until
 * the user advances, so it reads them once, imperatively, via `ref.build()`.
 *
 * `memo` plus a ref means typing here costs exactly one input's re-render.
 */
// React 19 passes `ref` as an ordinary prop, so no forwardRef wrapper is needed.
const MedicalStep = memo(function MedicalStep({ ref }: { ref?: Ref<MedicalHandle> }) {
    const [bloodGroup, setBloodGroup] = useState('');
    const [allergies, setAllergies] = useState('');
    const [medications, setMedications] = useState('');
    const [conditions, setConditions] = useState('');
    const [ice1Name, setIce1Name] = useState('');
    const [ice1Phone, setIce1Phone] = useState('');
    const [ice2Name, setIce2Name] = useState('');
    const [ice2Phone, setIce2Phone] = useState('');
    const [organDonor, setOrganDonor] = useState(false);
    const [notes, setNotes] = useState('');

    useImperativeHandle(
      ref,
      () => ({
        build(): MedicalCard {
          // Capped at three per list exactly as core/types documents: the card is
          // read aloud by a stranger under time pressure, and a list of eleven is
          // a list of zero.
          const list = (raw: string): string[] =>
            raw
              .split(',')
              .map((x) => x.trim())
              .filter((x) => x.length > 0)
              .slice(0, 3);
          return {
            bloodGroup: bloodGroup.trim(),
            allergies: list(allergies),
            medications: list(medications),
            conditions: list(conditions),
            iceContacts: [
              { name: ice1Name.trim(), phone: ice1Phone.trim() },
              { name: ice2Name.trim(), phone: ice2Phone.trim() },
            ].filter((c) => c.name.length > 0 || c.phone.length > 0),
            organDonor,
            notes: notes.trim(),
          };
        },
      }),
      [
        allergies, bloodGroup, conditions, ice1Name, ice1Phone, ice2Name, ice2Phone,
        medications, notes, organDonor,
      ],
    );

    const p: MedicalStepProps = {
      bloodGroup, onBloodGroup: setBloodGroup,
      allergies, onAllergies: setAllergies,
      medications, onMedications: setMedications,
      conditions, onConditions: setConditions,
      ice1Name, onIce1Name: setIce1Name,
      ice1Phone, onIce1Phone: setIce1Phone,
      ice2Name, onIce2Name: setIce2Name,
      ice2Phone, onIce2Phone: setIce2Phone,
      organDonor, onOrganDonor: setOrganDonor,
      notes, onNotes: setNotes,
    };

    return (
    <>
      <Card tone="info" style={styles.card}>
        <Text style={styles.body}>
          {t('medical.showToResponder')}. This card is shown full-screen, in large type, to
          whoever reaches you — it is read out loud by a stranger under time pressure, so keep it
          to the three things that would change what they do.
        </Text>
        <Text style={styles.footnote}>
          It is encrypted on this phone and only unsealed during an emergency where you are the
          subject. You can leave any of it blank.
        </Text>
      </Card>

      <Section title={t('medical.bloodGroup')}>
        <View style={styles.chips}>
          {BLOOD_GROUPS.map((g) => {
            const selected = p.bloodGroup === g;
            return (
              <PressableScale
                key={g}
                onPress={() => p.onBloodGroup(selected ? '' : g)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={`Blood group ${g}`}
                highlightColor={colors.focus}
                highlightRadius={radius.md}
                style={[styles.chip, selected ? styles.chipOn : null]}
              >
                <Text style={[styles.chipLabel, selected ? styles.chipLabelOn : null]}>{g}</Text>
              </PressableScale>
            );
          })}
        </View>
      </Section>

      <Field
        label={t('medical.allergies')}
        hint="Up to three, separated by commas. Penicillin, peanuts, latex."
        value={p.allergies}
        onChange={p.onAllergies}
      />
      <Field
        label={t('medical.medications')}
        hint="Up to three. Include blood thinners first — they change what a paramedic can do."
        value={p.medications}
        onChange={p.onMedications}
      />
      <Field
        label={t('medical.conditions')}
        hint="Up to three. Epilepsy, diabetes, a pacemaker."
        value={p.conditions}
        onChange={p.onConditions}
      />

      <Section title={t('medical.ice')}>
        <Field label="Contact 1 — name" value={p.ice1Name} onChange={p.onIce1Name} />
        <Field
          label="Contact 1 — phone"
          value={p.ice1Phone}
          onChange={p.onIce1Phone}
          keyboard="phone-pad"
        />
        <Field label="Contact 2 — name" value={p.ice2Name} onChange={p.onIce2Name} />
        <Field
          label="Contact 2 — phone"
          value={p.ice2Phone}
          onChange={p.onIce2Phone}
          keyboard="phone-pad"
        />
      </Section>

      <Toggle
        value={p.organDonor}
        onChange={p.onOrganDonor}
        label="I am an organ donor"
        hint="Shown on the responder card."
        style={styles.agreeToggle}
      />

      <Field
        label="Anything else a responder must know"
        hint="One line. Deaf in the left ear. Do not move me. Speaks only Gujarati."
        value={p.notes}
        onChange={p.onNotes}
        multiline
      />
    </>
  );
});

const Field = memo(function Field({
  label,
  hint,
  value,
  onChange,
  keyboard,
  multiline,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  keyboard?: 'default' | 'phone-pad';
  multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {hint === undefined ? null : <Text style={styles.fieldHint}>{hint}</Text>}
      <TextInput
        value={value}
        onChangeText={onChange}
        keyboardType={keyboard ?? 'default'}
        multiline={multiline ?? false}
        placeholder=""
        placeholderTextColor={colors.textFaint}
        accessibilityLabel={label}
        style={[styles.input, multiline ? styles.inputMultiline : null]}
      />
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Step 6 — ★ the test SOS (PRD Appendix E.4)
// ═══════════════════════════════════════════════════════════════════════════════

interface DrillStepProps {
  ready: boolean;
  armed: boolean;
  pending: boolean;
  runaway: boolean;
  passed: boolean;
  note: string | null;
  holdProgress: number;
  windowMs: number;
  pin: string;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onKey: (d: string) => void;
  onBackspace: () => void;
  onStopRunaway: () => void;
  onRetry: () => void;
}

/**
 * ★ THE COUNTDOWN OWNS ITS OWN CLOCK ★
 *
 * The only thing on this step that changes ten times a second is this ring, so
 * this is the only thing that re-renders ten times a second. It reads
 * `pendingUntil` from the store directly rather than being handed a
 * `remainingMs` prop, because a prop would drag every ancestor — and therefore
 * the keypad — into the tick's render scope, which is exactly the bug this
 * component exists to close.
 *
 * The ring is the ONE animation PRD §6.4 permits during a live countdown.
 */
const DrillRing = memo(function DrillRing({ windowMs }: { windowMs: number }) {
  const pendingUntil = useKavach((s) => s.pendingUntil);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (pendingUntil === null) return;
    const h = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(h);
  }, [pendingUntil]);

  const remainingMs = pendingUntil === null ? 0 : Math.max(0, pendingUntil - now);
  return (
    <View style={styles.ringWrap}>
      <CountdownRing totalMs={windowMs} remainingMs={remainingMs} />
    </View>
  );
});

/**
 * `memo` is load-bearing, not decoration: with the ring's clock lifted out, none
 * of these props change during the cancel window, so the pad below renders once
 * and then stays put while the countdown runs.
 */
const DrillStep = memo(function DrillStep(p: DrillStepProps) {
  if (p.passed) {
    // ★ F-01: this is the screen for BOTH a cancel and a duress. It says nothing
    //   about which PIN was typed, because someone may be reading it over your
    //   shoulder — which is precisely the situation the duress PIN exists for.
    return (
      <>
        <Card tone="ok" style={styles.card}>
          <Text style={styles.h1}>{t('panic.sent')}</Text>
          <Text style={styles.h3}>Test cancelled.</Text>
          <Text style={styles.body}>
            You just did the only thing that matters: you sent an alarm and you stopped it,
            unaided, using the real PIN and the real countdown. Nothing was simulated — that was
            the same state machine and the same cancel path a real emergency uses.
          </Text>
        </Card>
        <Card style={styles.card}>
          <Text style={styles.h3}>Remember this</Text>
          <Bullet glyph="•">The countdown is short on purpose. Do not read it — type.</Bullet>
          <Bullet glyph="•">
            If you miss the window, the alarm goes out. That is not a bug; it is the whole design.
            Your family can be told “false alarm” afterwards in one tap.
          </Bullet>
          <Bullet glyph="•">
            Do this again from Settings every few months. A rehearsal you did once a year ago is
            not a rehearsal.
          </Bullet>
        </Card>
        <Button
          label="Run the test again"
          variant="quiet"
          onPress={p.onRetry}
          accessibilityLabel="Send another test SOS"
          style={styles.card}
        />
      </>
    );
  }

  if (p.pending) {
    return (
      <>
        <Card tone="danger" style={styles.card}>
          <Text style={styles.h2}>{t('panic.cancelIn')}</Text>
          <DrillRing windowMs={p.windowMs} />
          <Text style={styles.h3}>{t('panic.enterPin')}</Text>
          <Text style={styles.body}>
            Either PIN will stop this. Use the cancel PIN — this is a test, and nobody is
            standing over you.
          </Text>
          <PinDots filled={p.pin.length} />
          {p.note === null ? null : (
            <Text style={styles.errorLine} accessibilityLiveRegion="assertive">
              {p.note}
            </Text>
          )}
          <PinPad onKey={p.onKey} onBackspace={p.onBackspace} />
        </Card>
      </>
    );
  }

  if (p.runaway) {
    return (
      <>
        <Card tone="danger" style={styles.card}>
          <Text style={styles.h2}>The window closed. The alarm is live.</Text>
          <Text style={styles.body}>
            This is exactly what happens in a real emergency when nobody cancels: the siren is
            sounding, the escalation ladder has started, and your family is being told — marked as
            a drill, because it is one.
          </Text>
          <Text style={styles.body}>
            Nothing has gone wrong. You have just seen the half of the system that is hardest to
            believe until you watch it.
          </Text>
          <Button
            label="Stop the test"
            variant="danger"
            size="lg"
            onPress={p.onStopRunaway}
            accessibilityLabel="Stop the test alarm and close the drill incident"
            style={styles.permButton}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <Card tone="warn" style={styles.card}>
        <Text style={styles.h2}>Now send one for real.</Text>
        <Text style={styles.body}>
          This is the last step and the most important one. Everything above is a setting. This is
          the only part that tells you whether the system actually works on <Text style={styles.bulletStrong}>this</Text>{' '}
          phone, in <Text style={styles.bulletStrong}>your</Text> hands.
        </Text>
        <Bullet glyph="•">A real incident opens, marked as a drill.</Bullet>
        <Bullet glyph="•">
          You get {Math.round(p.windowMs / 1000)} seconds to cancel it with the PIN you just set.
          That is the real window for this phone right now.
        </Bullet>
        <Bullet glyph="•">
          If you do not make it, the siren sounds and the ladder starts. You can stop it, and you
          should see it happen once here rather than for the first time at 2 a.m.
        </Bullet>
      </Card>

      {p.note === null ? null : (
        <Card style={styles.card}>
          <Text style={styles.body} accessibilityLiveRegion="polite">
            {p.note}
          </Text>
        </Card>
      )}

      {!p.ready ? (
        <Card style={styles.card}>
          <Text style={styles.body}>
            Starting the safety engine. The test button appears the moment it is genuinely armed —
            an SOS button that is not yet wired to anything would be the worst possible thing to
            show you here.
          </Text>
        </Card>
      ) : (
        <Pressable
          onPressIn={p.onHoldStart}
          onPressOut={p.onHoldEnd}
          accessibilityRole="button"
          accessibilityLabel="Hold to send a test SOS"
          accessibilityHint="Press and hold for just over a second"
          style={({ pressed }) => [styles.sos, pressed ? styles.sosPressed : null]}
        >
          <View style={[styles.sosFill, { width: `${Math.min(100, p.holdProgress * 100)}%` }]} />
          {/* ★ THE LABEL MUST FIT. ★ At font.display with letterSpacing 1 and no
              horizontal padding, "HOLD TO GET HELP" is about 350 pt wide inside
              a card interior of ~328 pt on a 360 dp phone and ~288 on a 320 dp
              one — so it was clipped at both ends on the final and most
              important step of setup, and the Hindi and Gujarati strings are
              longer again. font.h1 is what panic.tsx's own HoldToTrigger uses
              for the same words; the two shrink-to-fit props are the belt to
              that braces. */}
          <Text
            style={styles.sosLabel}
            allowFontScaling={false}
            numberOfLines={2}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            {p.holdProgress > 0 ? 'KEEP HOLDING' : t('panic.hold').toUpperCase()}
          </Text>
          <Text style={styles.sosSub}>Test SOS — marked as a drill</Text>
        </Pressable>
      )}
    </>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Shared bits
// ═══════════════════════════════════════════════════════════════════════════════

function Bullet({ glyph, children }: { glyph: string; children: React.ReactNode }) {
  return (
    <View style={styles.bullet}>
      <Text
        // The glyph is decoration; announcing "bullet" before every line triples
        // the utterance for a screen-reader user and adds nothing.
        importantForAccessibility="no"
        allowFontScaling={false}
        style={styles.bulletGlyph}
      >
        {glyph}
      </Text>
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },

  header: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  headerCount: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontWeight: weight.bold,
    letterSpacing: tracking.caps,
  },
  headerTitle: {
    color: colors.text,
    fontSize: font.h1,
    fontWeight: weight.bold,
    marginTop: space.xs,
  },
  dots: { flexDirection: 'row', gap: space.xs, marginTop: space.md, alignItems: 'center' },
  dot: { flex: 1, height: 4, borderRadius: radius.sm, backgroundColor: colors.border },
  /**
   * ★ P-018 APPLIES TO PROGRESS TOO ★
   * These were border / ok / info on bgElevated: current against todo measured
   * 1.41:1 and current against done 1.28:1, so all six steps looked identical
   * and the dots were decoration pretending to be a control. The light tokens
   * separate them, and the current step is also taller and wider — shape
   * carries it as well as colour, which is the rule everywhere else in this app.
   */
  dotDone: { backgroundColor: colors.okText },
  dotCurrent: { flex: 1.6, height: 6, backgroundColor: colors.text },

  scroll: { flex: 1 },
  // MedicalStep stays mounted on every step so a half-typed card is not lost to a
  // Back tap. `display: none` keeps it out of layout AND out of the accessibility
  // tree, so a screen reader on step 4 never announces ten invisible inputs.
  hidden: { display: 'none' },
  scrollBody: { padding: space.lg, paddingBottom: space.xxxl, gap: space.md },

  card: { marginBottom: space.xs },

  h1: { color: colors.text, fontSize: font.h1, fontWeight: weight.bold, marginBottom: space.sm },
  h2: { color: colors.text, fontSize: font.h2, fontWeight: weight.bold, marginBottom: space.sm },
  h3: { color: colors.text, fontSize: font.h3, fontWeight: weight.semibold, marginBottom: space.sm },
  body: { color: colors.textDim, fontSize: font.body, lineHeight: 22, marginBottom: space.sm },
  footnote: { color: colors.textFaint, fontSize: font.small, lineHeight: 19 },
  justify: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: weight.medium,
    lineHeight: 22,
    marginBottom: space.sm,
  },
  /**
   * ★ Text tokens. These two lines are the whole argument of two steps. ★
   * `warnLine` carries every permission consequence — "Without this you will not
   * be told when someone triggers an alarm" — and `errorLine` carries every PIN
   * failure, including "Not your cancel PIN. This is the one you will need at
   * 2 a.m." On bgCard the fill tokens measure 2.71:1 and 2.76:1 at font.small,
   * so someone mistyped four digits and got no readable explanation of why.
   * The *Text variants clear 7.85 and 7.95.
   */
  warnLine: { color: colors.warnText, fontSize: font.small, lineHeight: 19, marginBottom: space.sm },
  errorLine: {
    color: colors.dangerText,
    fontSize: font.small,
    fontWeight: weight.semibold,
    lineHeight: 19,
    marginBottom: space.sm,
    textAlign: 'center',
  },

  bullet: { flexDirection: 'row', gap: space.sm, marginBottom: space.sm },
  bulletGlyph: { color: colors.textFaint, fontSize: font.body, lineHeight: 22, width: 16 },
  bulletText: { flex: 1, color: colors.textDim, fontSize: font.body, lineHeight: 22 },
  bulletStrong: { color: colors.text, fontWeight: weight.bold },

  agreeToggle: { marginTop: space.sm },

  permHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    marginBottom: space.sm,
  },
  permButton: { marginTop: space.sm },
  permButtons: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  permButtonHalf: { flex: 1 },

  pinDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.md,
    marginVertical: space.lg,
  },
  pinDot: {
    width: 18,
    height: 18,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.borderStrong,
  },
  pinDotFilled: { backgroundColor: colors.text, borderColor: colors.text },
  pinDoneRow: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },

  pad: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, justifyContent: 'center' },
  padKey: {
    width: '30%',
    minHeight: MIN_TOUCH_TARGET + 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgInput,
  },
  padKeyPressed: { opacity: 0.72 },
  padKeyLabel: { color: colors.text, fontSize: font.h1, fontWeight: weight.semibold },
  padSpacer: { width: '30%' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: 68,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgInput,
  },
  // infoText on the edge: at colors.info the selected blood group was carried by
  // a 1.9:1 border and a faint tint, which on a card a paramedic's information
  // is being entered into is not enough to see that a choice registered.
  chipOn: { backgroundColor: colors.infoSoft, borderColor: colors.infoText },
  chipLabel: { color: colors.textDim, fontSize: font.h3, fontWeight: weight.semibold },
  chipLabelOn: { color: colors.text },

  field: { marginBottom: space.md },
  fieldLabel: { color: colors.text, fontSize: font.small, fontWeight: weight.semibold },
  fieldHint: { color: colors.textFaint, fontSize: font.tiny, marginTop: space.xxs },
  input: {
    marginTop: space.xs,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    color: colors.text,
    fontSize: font.body,
  },
  inputMultiline: { minHeight: 88, textAlignVertical: 'top' },

  ringWrap: { alignItems: 'center', marginVertical: space.lg },

  sos: {
    minHeight: 140,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.danger,
    backgroundColor: colors.dangerDark,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    ...shadow.card,
  },
  sosPressed: { opacity: 0.9 },
  sosFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.danger,
  },
  sosLabel: {
    color: colors.white,
    fontSize: font.h1,
    fontWeight: weight.heavy,
    letterSpacing: tracking.caps,
    textAlign: 'center',
    paddingHorizontal: space.lg,
  },
  sosSub: { color: colors.white, fontSize: font.small, marginTop: space.xs, opacity: 0.85 },

  footer: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  footerBack: { minWidth: 96 },
  footerNext: { flex: 1 },
});
