/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SELF-DIAGNOSTICS   (P-031, P-034, FR-014, PRD §6.4 / §17.2, Appendix B)
 *
 * "The app is installed, the family believes they are protected, and one
 *  permission has been silently revoked. The system is dead and looks alive."
 *
 * This screen exists to make that sentence impossible. Which means its single
 * most important property is not the checks — it is the REFUSAL TO TICK.
 *
 * ★ THE RULE THIS SCREEN IS BUILT AROUND ★
 * `t0/diagnostics.runSelfCheck()` reports an undeterminable check as `false` and
 * lists it in `unknownChecks()`. Most of these settings have no JavaScript API,
 * so in Expo Go we genuinely cannot look. Those rows render as
 * "Unknown — install the full build to verify", in amber, with a question mark.
 * They are NEVER green. A green tick that means "we did not look" is a lie that
 * gets someone killed at 2 a.m., and it is the exact failure this feature exists
 * to prevent (P-031).
 *
 * Second rule: the report is re-run on mount. A report loaded from SQLite was
 * true last Tuesday; `unknownChecks()` is module state that is empty until a
 * check has actually run in THIS process, so rendering a stale report against a
 * fresh unknown-set would silently turn "we could not look" into a red cross,
 * which is a different lie. Until the first run completes every row reads
 * "not checked yet".
 *
 * ★ THE TENTH CHECK IS ABOUT THE PERSON, NOT THE PHONE ★
 * PRD Appendix E.4 calls the unaided test SOS — fire it, cancel it yourself,
 * nobody helping — the single best predictor of whether the system works when it
 * matters. It outranks every permission on this screen. Onboarding deliberately
 * lets it be skipped, because trapping someone on step six leaves them with no
 * panic button at all; `store.rehearsalSkipped` records that it was skipped, and
 * this screen fails on it. P-031's whole argument is that a system which hides
 * its own degradation is worse than one that has none, and "the family have
 * never practised" is degradation of exactly that kind: invisible, unalarming,
 * and decisive at 2 a.m. It is also the one row here that a phone setting cannot
 * fix, so its button goes to onboarding rather than to Android.
 *
 * That row is `pending` — never green — until the store has finished booting.
 * `rehearsalSkipped` defaults to false, and rendering that default as a tick
 * would be the same "we did not look" lie the rest of this screen exists to
 * refuse.
 *
 * Third rule (Appendix B): the deep links are guesses. Every OEM intent below is
 * an unexported activity on some builds and a renamed one on others, and they
 * change between OS versions. So every launch is tried, caught, and degraded —
 * native intent → bare action → the app's own settings page → the written steps
 * in the user's own menu names. The written steps are the product; the deep link
 * is a shortcut that is allowed to fail.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Pill, PressableScale } from '../src/ui/components';
import type { PillTone } from '../src/ui/components';
import { keyBackingStatus, type KeyBacking, type KeyStatus } from '../src/crypto/hardware';
import { MIN_TOUCH_TARGET, colors, font, radius, space, weight } from '../src/ui/theme';
import { relativeTime, t } from '../src/i18n';
import { presenceStatus } from '../src/domain/presenceService';
import { bootstrapFailures, useKavach } from '../src/state/store';
import type { DiagnosticKey } from '../src/core/types';
import {
  DIAGNOSTIC_KEYS,
  checkLabel,
  isStale,
  notApplicable,
  oemProfile,
  remediationFor,
  unknownChecks,
  type Remediation,
} from '../src/t0/diagnostics';
import { openOemSettings } from '../src/t0/native';

type Status = 'pending' | 'pass' | 'fail' | 'unknown' | 'na';

const GLYPH: Record<Status, string> = {
  // Plain BMP characters only — an emoji font is not guaranteed on a ₹6,000
  // Android, and this screen must render on the worst phone in the family.
  pending: '·',
  pass: '✓',
  fail: '✕',
  unknown: '?',
  na: '—',
};

/**
 * ★ TEXT TOKENS, NOT FILLS ★
 *
 * This map colours the status glyph, the status sentence and the 4 dp left edge
 * of every row. It used to point at the fill tokens, which measure 2.43 / 2.76 /
 * 2.71:1 on bgCard — so the amber "Unknown — install the full build to verify",
 * the sentence this whole screen is built around, was rendered at a third of the
 * 7:1 §6.4 demands, and the left edge did not reach the 3:1 a non-text element
 * needs either. A pessimistic screen nobody can read is a screen that reassures.
 *
 * The *Text variants clear 7:1 on every surface and 3:1 as an edge, so one map
 * still serves all three uses. `keyCaveat` below already knew this.
 */
const TONE: Record<Status, string> = {
  pending: colors.textFaint,
  pass: colors.okText,
  fail: colors.dangerText,
  unknown: colors.warnText,
  na: colors.textFaint,
};

const STATUS_WORD: Record<Status, string> = {
  pending: 'Not checked yet',
  pass: 'Passing',
  fail: 'Failing',
  // ★ The exact words. Not "unavailable", not "—", not a tick.
  unknown: 'Unknown — install the full build to verify',
  na: 'Not applicable on this platform',
};

/**
 * The rehearsal check is not a DiagnosticKey: `t0/diagnostics` probes the
 * operating system, and this one asks whether a human has ever practised. It is
 * kept out of DIAGNOSTIC_KEYS so no self-check can ever try to answer it from a
 * permission, and given a row here because P-031 is about what the family is not
 * being told, whatever the source.
 */
const REHEARSAL_KEY = 'testSosRehearsed';
type RowKey = DiagnosticKey | typeof REHEARSAL_KEY;

const REHEARSAL_LABEL = 'Test SOS practised on this phone';

/**
 * ★ P-031 / F-17 — NAME THE KEY THAT SIGNS, NOT THE ONE WE HOPED FOR ★
 *
 * `js_heap` renders as a failure, not as a shrug. It means the private key that
 * proves an SOS came from this phone is sitting in the app's own memory, where
 * any code in this runtime can read it. That is a real weakness and it is the
 * common case in Expo Go, so it gets the same red treatment as a dead permission
 * rather than a quiet grey one.
 *
 * `keystore_software` is deliberately its own middle value. The key is weaker
 * than one in the secure area, but the private half still never enters this
 * process — collapsing it into either neighbour would be a lie in one direction
 * or the other.
 */
const KEY_BACKING_TONE: Record<KeyBacking, PillTone> = {
  strongbox: 'ok',
  tee: 'ok',
  keystore_software: 'warn',
  js_heap: 'danger',
};

/** Plain words. "TEE" and "StrongBox" mean nothing to the person holding the phone. */
const KEY_BACKING_LABEL: Record<KeyBacking, string> = {
  strongbox: 'Secure chip',
  tee: 'Secure area',
  keystore_software: 'Phone keystore',
  js_heap: 'Inside the app',
};

const KEY_ROLE_LABEL: Record<KeyStatus['role'], string> = {
  emergency: 'The key that signs your SOS',
  identity: 'The key that proves this phone to your family',
};

// ═══════════════════════════════════════════════════════════════════════════════

export default function Diagnostics() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const report = useKavach((s) => s.diagnostics);
  const runDiagnostics = useKavach((s) => s.runDiagnostics);
  const rehearsalSkipped = useKavach((s) => s.rehearsalSkipped);
  /** Boot gate for the rehearsal row: an unread flag must not render as a tick. */
  const storeReady = useKavach((s) => s.ready);

  const [running, setRunning] = useState(false);
  /** Null until a check has actually run in this process. See rule 2 in the header. */
  const [unknown, setUnknown] = useState<ReadonlySet<DiagnosticKey> | null>(null);
  const [expanded, setExpanded] = useState<RowKey | null>(null);
  const [linkFailed, setLinkFailed] = useState<RowKey | null>(null);
  /**
   * The check itself failed to run. Not the same as a failing check, and it
   * must not be silent: a screen that shows nine grey "not checked yet" rows
   * and no reason is exactly the "dead and looks alive" state this file exists
   * to make impossible.
   */
  const [runError, setRunError] = useState<string | null>(null);
  /**
   * Snapshot, not a subscription: crypto/hardware.ts holds the resolution in a
   * module variable that bootstrap fills via prepareKeys(). Re-read whenever the
   * store finishes booting or a check is run, which are the only two moments the
   * answer can have changed.
   */
  const [keys, setKeys] = useState<KeyStatus[]>(() => keyBackingStatus());

  /**
   * ★ THE TWO THINGS THAT FAIL WITHOUT FAILING A CHECK ★
   * Every row above asks the OS a question. Neither of these does, and both are
   * the exact shape this screen exists to catch — "the system is dead and looks
   * alive":
   *
   *   · `bootstrapFailures()` — bootstrap runs each stage in isolation so one
   *     bad stage cannot take the rest with it. That is the right behaviour, and
   *     it is also how the app comes up looking ready with no keypair or no
   *     outbox. The stage list is the only place that is recorded.
   *   · `presenceStatus()` — a location service that is up but permission-blocked
   *     reports no fixes, and "no fix yet" and "no fix ever" are indistinguishable
   *     from the panic screen's empty coordinate block.
   *
   * Both are module state rather than store state, so they are snapshotted on the
   * same two beats as `keys`: the store finishing its boot, and any manual re-run.
   */
  const [runtime, setRuntime] = useState(() => ({
    boot: bootstrapFailures(),
    presence: presenceStatus(),
  }));

  useEffect(() => {
    if (storeReady) {
      setKeys(keyBackingStatus());
      setRuntime({ boot: bootstrapFailures(), presence: presenceStatus() });
    }
  }, [storeReady]);

  const run = useCallback(async (): Promise<void> => {
    setRunning(true);
    setRunError(null);
    try {
      await runDiagnostics();
    } catch {
      // Fail open and SAY SO (ADR-018). Swallowing this left an unhandled
      // rejection and a screen of pending rows that never resolved.
      setRunError(
        'The check could not finish on this phone. Nothing below has been read, so treat every row as unknown until it runs.',
      );
    } finally {
      // Snapshot AFTER the run: `unknownChecks()` is only meaningful once
      // runSelfCheck has populated it, and it must be read in the same tick as
      // the report it describes.
      setUnknown(new Set(unknownChecks()));
      setKeys(keyBackingStatus());
      setRuntime({ boot: bootstrapFailures(), presence: presenceStatus() });
      setRunning(false);
    }
  }, [runDiagnostics]);

  useEffect(() => {
    void run();
  }, [run]);

  const statusOf = useCallback(
    (key: DiagnosticKey): Status => {
      if (unknown === null) return 'pending';
      // Checked first: on iOS there is no OEM battery manager and no exact-alarm
      // permission, so a cross there would be a fault the user cannot fix.
      if (notApplicable(key)) return 'na';
      if (unknown.has(key)) return 'unknown';
      return report[key] === true ? 'pass' : 'fail';
    },
    [report, unknown],
  );

  /**
   * ★ Never green before the store has answered. ★ `rehearsalSkipped` is `false`
   * in the initial store state as well as on a phone that genuinely rehearsed,
   * and those two must not render the same.
   */
  const rehearsalStatus: Status = !storeReady ? 'pending' : rehearsalSkipped ? 'fail' : 'pass';

  const counts = useMemo(() => {
    let pass = 0;
    let fail = 0;
    let unk = 0;
    // The rehearsal row is counted with the rest: a verdict card reading "all
    // checks passing" above a red row is the failure this screen is against.
    for (const s of [...DIAGNOSTIC_KEYS.map(statusOf), rehearsalStatus]) {
      if (s === 'pass') pass += 1;
      else if (s === 'fail') fail += 1;
      else if (s === 'unknown') unk += 1;
    }
    return { pass, fail, unknown: unk };
  }, [statusOf, rehearsalStatus]);

  const oem = oemProfile();
  const checked = unknown !== null;
  const stale = report.lastCheckedAt > 0 && isStale(report);

  /**
   * Launch a settings screen, honestly.
   *
   * Returns false when every route failed, and the caller then shows the written
   * steps rather than a dead button. Each leg is individually caught because a
   * missing activity throws rather than resolving false on most Android builds.
   */
  const openSettingsFor = useCallback(async (intent: string | undefined): Promise<boolean> => {
    // 1. The native module, which is the only thing that can start an intent by
    //    component name ("com.miui.securitycenter/…"). Returns false in Expo Go.
    if (intent !== undefined) {
      try {
        if (await openOemSettings(intent)) return true;
      } catch {
        /* fall through */
      }
    }

    // 2. A bare action string can be launched from JS. A component name cannot —
    //    Linking.sendIntent has no component field — so it is skipped here.
    if (Platform.OS === 'android' && intent !== undefined && !intent.includes('/')) {
      try {
        await Linking.sendIntent(intent);
        return true;
      } catch {
        /* the activity is not exported on this build; keep degrading */
      }
    }

    // 3. This app's own settings page. It is the one destination that exists on
    //    every Android and every iOS, and it is one tap from most of the menus
    //    the written steps describe.
    try {
      await Linking.openSettings();
      return true;
    } catch {
      /* fall through */
    }

    // 4. Last resort: the generic battery-optimisation list, by URL.
    if (Platform.OS === 'android') {
      try {
        await Linking.openURL('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
        return true;
      } catch {
        /* nothing left to try */
      }
    }
    return false;
  }, []);

  const onFix = useCallback(
    (key: RowKey, deepLink: string | undefined): void => {
      void (async () => {
        const ok = await openSettingsFor(deepLink);
        // The steps are already on screen; this only marks the shortcut as dead
        // so the user is not left tapping a button that does nothing.
        setLinkFailed(ok ? null : key);
      })();
    },
    [openSettingsFor],
  );

  const goBack = useCallback((): void => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  /**
   * Onboarding's own last step is the fix, so the button goes there rather than
   * to a settings screen. It is a push, not a reset: finishing the checklist
   * calls `completeOnboarding(drillPassed)`, which is what clears this check —
   * and it clears it because the SOS was actually fired, not because the screen
   * was visited.
   */
  const practiseNow = useCallback((): void => {
    router.push('/onboarding');
  }, [router]);

  const rehearsalRemediation = useMemo<Remediation>(() => {
    if (rehearsalStatus === 'pass') {
      return {
        title: 'A test SOS has been fired and cancelled on this phone',
        steps: [
          'That is the one check on this screen that measures the people rather than the phone, and it is the one PRD Appendix E.4 says predicts most.',
          'Do it again every few months. A rehearsal from a year ago is not a rehearsal — PINs are forgotten, and the countdown feels different when you have not seen it recently.',
          'Everyone who uses this phone should have done it themselves, unaided. Watching somebody else do it does not count.',
        ],
      };
    }
    return {
      title: 'Nobody has fired a test SOS on this phone',
      steps: [
        'Setup step six fires a real incident through the real state machine and asks you to stop it with your own cancel PIN. It can be skipped, and on this phone it was.',
        'A PIN you have never typed under a running countdown is a PIN you will not remember, and a countdown you have never seen is one you will not trust.',
        'Nothing about this is dangerous to practise: the incident is marked as a drill, and it is classified and closed when you finish.',
        'It takes about a minute. The other five steps re-confirm what is already set and delete nothing.',
      ],
    };
  }, [rehearsalStatus]);

  return (
    <View style={styles.root}>
      {/* The native header was removed from the root layout (this screen already
          draws its own), so the top inset is now this file's responsibility.
          A hardcoded 32 put "Self-diagnostics" under a 59 pt Dynamic Island. */}
      <View style={[styles.header, { paddingTop: insets.top + space.md }]}>
        <View style={styles.headerRow}>
          <Text accessibilityRole="header" style={styles.title}>
            {t('diag.title')}
          </Text>
          <PressableScale
            onPress={goBack}
            accessibilityLabel={t('common.close')}
            hitSlop={space.md}
            style={styles.close}
          >
            <Text style={styles.closeLabel} allowFontScaling={false}>
              ✕
            </Text>
          </PressableScale>
        </View>
        <Text style={styles.sub}>
          {checked
            ? `Last checked ${relativeTime(report.lastCheckedAt === 0 ? null : report.lastCheckedAt)}`
            : 'Reading this phone’s settings…'}
        </Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollBody, { paddingBottom: insets.bottom + space.xxxl }]}
      >
        {/* ── verdict ─────────────────────────────────────────────────────── */}
        <Card
          tone={
            runError !== null
              ? 'danger'
              : !checked
                ? undefined
                : counts.fail > 0
                  ? 'danger'
                  : counts.unknown > 0
                    ? 'warn'
                    : 'ok'
          }
          style={styles.card}
        >
          <Text style={styles.h2}>
            {runError !== null
              ? 'The check did not finish'
              : !checked
                ? 'Reading this phone…'
                : counts.fail > 0
                  ? t('diag.problems', { n: counts.fail })
                  : counts.unknown > 0
                    ? `${counts.pass} passing, ${counts.unknown} unverifiable`
                    : t('diag.healthy')}
          </Text>
          {runError !== null ? (
            <Text style={styles.errorLine} accessibilityLiveRegion="assertive">
              {runError}
            </Text>
          ) : null}
          {/* Counts before the first run would be four zeroes dressed as a
              verdict. The rows below already say "not checked yet". */}
          {!checked ? (
            <Text style={styles.body}>
              Every row below stays grey until it has actually been read. None of them will turn
              green because the check took a moment.
            </Text>
          ) : (
            <View style={styles.pills}>
              <Pill label={`${counts.pass} passing`} tone="ok" />
              {counts.fail > 0 ? <Pill label={`${counts.fail} failing`} tone="danger" /> : null}
              {counts.unknown > 0 ? <Pill label={`${counts.unknown} unknown`} tone="warn" /> : null}
            </View>
          )}
          {counts.unknown > 0 ? (
            <Text style={styles.body}>
              {counts.unknown} of these checks have no JavaScript API, so this build genuinely
              cannot read them. They are shown as unknown rather than as passing — a tick that
              meant “we did not look” would be worse than no screen at all.
            </Text>
          ) : null}
          {stale ? (
            <Text style={styles.warnLine}>
              The stored report was more than a week old. Android silently resets permissions on
              apps you have not opened (P-034), which is why this runs weekly.
            </Text>
          ) : null}
          <Button
            label={running ? 'Reading this phone…' : runError !== null ? 'Try the check again' : t('diag.run')}
            variant="primary"
            size="lg"
            disabled={running}
            onPress={() => void run()}
            accessibilityLabel={t('diag.run')}
            style={styles.runButton}
          />
        </Card>

        {/* ── the rehearsal, first: it outranks every permission below it ──── */}
        <CheckRow
          rowKey={REHEARSAL_KEY}
          label={REHEARSAL_LABEL}
          status={rehearsalStatus}
          statusWord={
            rehearsalStatus === 'fail'
              ? 'You have never practised a test SOS.'
              : rehearsalStatus === 'pass'
                ? 'Practised at least once'
                : STATUS_WORD[rehearsalStatus]
          }
          remediation={rehearsalRemediation}
          expanded={expanded === REHEARSAL_KEY}
          linkDead={false}
          onToggle={() => setExpanded((cur) => (cur === REHEARSAL_KEY ? null : REHEARSAL_KEY))}
          onFix={onFix}
          action={{
            label: rehearsalStatus === 'pass' ? 'Practise again' : 'Practise a test SOS now',
            onPress: practiseNow,
          }}
        />

        {/* ── the nine checks ─────────────────────────────────────────────── */}
        {DIAGNOSTIC_KEYS.map((key) => (
          <CheckRow
            key={key}
            rowKey={key}
            label={checkLabel(key)}
            status={statusOf(key)}
            statusWord={STATUS_WORD[statusOf(key)]}
            remediation={remediationFor(key)}
            expanded={expanded === key}
            linkDead={linkFailed === key}
            onToggle={() => setExpanded((cur) => (cur === key ? null : key))}
            onFix={onFix}
          />
        ))}

        {/* ── what started, and what quietly did not ──────────────────────── */}
        <Card tone={runtime.boot.length > 0 ? 'danger' : undefined} style={styles.card}>
          <Text style={styles.h3}>What started when Kavach opened</Text>
          {runtime.boot.length === 0 ? (
            <Text style={styles.body}>
              Every part of Kavach started. The database, your keys, the safety agent and the
              sending queue are all up.
            </Text>
          ) : (
            <>
              <Text style={styles.body}>
                Kavach opened, but these parts did not start. The app still runs without them,
                which is why nothing warned you — so they are named here.
              </Text>
              {runtime.boot.map((f) => (
                <Text key={f} style={styles.errorLine}>
                  {f}
                </Text>
              ))}
              <Text style={styles.body}>
                Close Kavach completely and open it again. If the same part fails twice, the
                phone is low on storage often enough to be the first thing to check.
              </Text>
            </>
          )}

          <View style={styles.keyRow}>
            <View style={styles.keyHead}>
              <Text style={styles.keyRole}>Location</Text>
              <Pill
                label={
                  runtime.presence.permissionBlocked
                    ? 'Not allowed'
                    : runtime.presence.running
                      ? 'Running'
                      : 'Stopped'
                }
                tone={
                  runtime.presence.permissionBlocked
                    ? 'danger'
                    : runtime.presence.running
                      ? 'ok'
                      : 'warn'
                }
              />
            </View>
            <Text style={styles.keyReason}>
              {runtime.presence.permissionBlocked
                ? 'Kavach is watching for your location but the phone will not give it. An SOS from this phone would carry no coordinates at all.'
                : !runtime.presence.running
                  ? 'Kavach is not watching your location. An SOS would be sent without a position.'
                  : runtime.presence.fixCount === 0
                    ? 'Watching, but no position has come through yet. This is normal indoors and for the first minute or so.'
                    : `Last position ${relativeTime(runtime.presence.lastFixAt === 0 ? null : runtime.presence.lastFixAt)}.`}
            </Text>
          </View>
        </Card>

        {/* ── P-031 / F-17: where the signing keys actually live ──────────── */}
        <Card style={styles.card}>
          <Text style={styles.h3}>Where your keys are kept</Text>
          <Text style={styles.body}>
            An SOS is trusted because it is signed by this phone. These are the keys that do
            the signing, and where each one is really held — measured on this device, not
            assumed from the model name.
          </Text>
          {keys.map((k) => (
            <View key={k.role} style={styles.keyRow}>
              <View style={styles.keyHead}>
                <Text style={styles.keyRole}>{KEY_ROLE_LABEL[k.role]}</Text>
                <Pill label={KEY_BACKING_LABEL[k.backing]} tone={KEY_BACKING_TONE[k.backing]} />
              </View>
              <Text style={styles.keyReason}>{k.reason}</Text>
              {!k.measured && (
                <Text style={styles.keyCaveat}>
                  This is what the key was asked for, not what was read back off it.
                </Text>
              )}
            </View>
          ))}
          <Text style={styles.body}>
            {keys.some((k) => k.backing === 'js_heap')
              ? 'A key kept inside the app still signs, and your SOS still works. It is weaker because anything running in this app could read it — which is why it is named here rather than hidden.'
              : 'Your phone kept these keys outside the app, so nothing running here can copy them.'}
          </Text>
        </Card>

        {/* ── Appendix B: this phone, in its own menu names ───────────────── */}
        <Card style={styles.card}>
          <Text style={styles.h3}>Your phone: {oem.label}</Text>
          <Text style={styles.body}>
            These are the menus on this manufacturer’s software, in their own words. They move
            between versions — if a menu is not where it says, search your Settings for the last
            word of the step.
          </Text>
          {oem.steps.map((s, i) => (
            <Step key={s} n={i + 1} text={s} />
          ))}
          <Button
            label="Open settings"
            variant="ghost"
            onPress={() => {
              void (async () => {
                const ok = await openSettingsFor(oem.deepLink);
                if (!ok) setLinkFailed(null);
              })();
            }}
            accessibilityLabel={`Open ${oem.label} settings`}
            style={styles.runButton}
          />
        </Card>

        <Card style={styles.card}>
          <Text style={styles.h3}>Why this screen is pessimistic</Text>
          <Text style={styles.body}>
            Kavach reports a check it cannot read as failing, never as passing. That means this
            screen sometimes looks worse than your phone actually is — in Expo Go, most of it
            will. That trade is deliberate: an alarming screen costs you a minute, and a
            falsely reassuring one costs somebody the night they needed help.
          </Text>
        </Card>
      </ScrollView>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

interface CheckRowProps {
  rowKey: RowKey;
  label: string;
  status: Status;
  /** Usually STATUS_WORD[status]; overridden where the check deserves a sentence. */
  statusWord: string;
  remediation: Remediation;
  expanded: boolean;
  linkDead: boolean;
  onToggle: () => void;
  onFix: (key: RowKey, deepLink: string | undefined) => void;
  /**
   * For a check no phone setting can fix. When present it replaces the settings
   * deep link entirely — offering "Take me there" for something Android cannot
   * change would be a button that is allowed to do nothing.
   */
  action?: { label: string; onPress: () => void };
}

function CheckRow({
  rowKey,
  label,
  status,
  statusWord,
  remediation,
  expanded,
  linkDead,
  onToggle,
  onFix,
  action,
}: CheckRowProps) {
  const healthy = status === 'pass' || status === 'na';

  return (
    <View
      style={[
        styles.row,
        { borderLeftColor: TONE[status] },
        expanded ? styles.rowExpanded : null,
      ]}
    >
      {/* PressableScale, not a bare Pressable: ten rows that only dimmed gave a
          user no sense that the tap landed on THIS row. `highlightColor` puts a
          ring on the row instead of fading it, which is what makes a long list
          feel touched rather than unavailable — and it comes with the same
          haptic every other control in the app has. */}
      <PressableScale
        onPress={onToggle}
        // The screen reader gets the verdict in the label, not in the colour —
        // never colour alone (PRD §6.4).
        accessibilityLabel={`${label}. ${statusWord}${statusWord.endsWith('.') ? '' : '.'}`}
        accessibilityHint={healthy ? 'Shows what this check means' : 'Shows how to fix this'}
        accessibilityState={{ expanded }}
        highlightColor={TONE[status]}
        highlightRadius={radius.md}
        style={styles.rowHead}
      >
        <Text
          importantForAccessibility="no"
          allowFontScaling={false}
          style={[styles.rowGlyph, { color: TONE[status] }]}
        >
          {GLYPH[status]}
        </Text>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{label}</Text>
          <Text style={[styles.rowStatus, { color: TONE[status] }]}>{statusWord}</Text>
        </View>
        <Text importantForAccessibility="no" allowFontScaling={false} style={styles.chevron}>
          {expanded ? '⌃' : '⌄'}
        </Text>
      </PressableScale>

      {expanded ? (
        <View style={styles.rowBody}>
          <Text style={styles.h3}>{remediation.title}</Text>
          {/* remediationFor() already appends the "this build cannot read this
              setting" sentence for unknown keys, so the note is never duplicated
              or, worse, omitted here. */}
          {remediation.steps.map((s, i) => (
            <Step key={s} n={i + 1} text={s} />
          ))}

          {action !== undefined ? (
            <Button
              label={action.label}
              variant={healthy ? 'quiet' : 'primary'}
              onPress={action.onPress}
              accessibilityLabel={action.label}
              style={styles.rowButton}
            />
          ) : remediation.deepLink === undefined ? (
            <Text style={styles.footnote}>
              There is no settings screen to jump to for this one — it is fixed by installing the
              full build, not by a toggle.
            </Text>
          ) : (
            <>
              <Button
                label="Take me there"
                variant={healthy ? 'quiet' : 'primary'}
                onPress={() => onFix(rowKey, remediation.deepLink)}
                accessibilityLabel={`Open the phone settings screen for ${label}`}
                style={styles.rowButton}
              />
              {linkDead ? (
                <Text style={styles.warnLine} accessibilityLiveRegion="polite">
                  This phone would not open that screen — the activity is not exported on this
                  build. Follow the numbered steps above by hand; they are the real fix and the
                  shortcut was only ever a shortcut.
                </Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <View style={styles.step}>
      <Text importantForAccessibility="no" allowFontScaling={false} style={styles.stepNum}>
        {n}
      </Text>
      <Text style={styles.stepText}>{text}</Text>
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
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: font.h1, fontWeight: weight.bold, flex: 1 },
  close: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeLabel: { color: colors.textDim, fontSize: font.h2, fontWeight: weight.semibold },
  sub: { color: colors.textFaint, fontSize: font.small, marginTop: space.xxs },

  scroll: { flex: 1 },
  scrollBody: { padding: space.lg, paddingBottom: space.xxxl, gap: space.md },

  card: { marginBottom: space.xs },
  h2: { color: colors.text, fontSize: font.h2, fontWeight: weight.bold, marginBottom: space.sm },
  h3: { color: colors.text, fontSize: font.h3, fontWeight: weight.semibold, marginBottom: space.sm },
  keyRow: { marginBottom: space.md },
  keyHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    marginBottom: space.xs,
  },
  keyRole: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: weight.semibold },
  keyReason: { color: colors.textDim, fontSize: font.small, lineHeight: 20 },
  keyCaveat: { color: colors.warnText, fontSize: font.small, lineHeight: 20, marginTop: space.xs },
  body: { color: colors.textDim, fontSize: font.body, lineHeight: 22, marginBottom: space.sm },
  footnote: { color: colors.textFaint, fontSize: font.small, lineHeight: 19 },
  warnLine: { color: colors.warnText, fontSize: font.small, lineHeight: 19, marginTop: space.sm },
  errorLine: {
    color: colors.dangerText,
    fontSize: font.small,
    fontWeight: weight.semibold,
    lineHeight: 19,
    marginTop: space.sm,
  },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.sm },
  runButton: { marginTop: space.sm },

  row: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    backgroundColor: colors.bgCard,
    overflow: 'hidden',
  },
  rowExpanded: { backgroundColor: colors.bgElevated },
  rowHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: MIN_TOUCH_TARGET + 12,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  rowGlyph: { fontSize: font.h1, width: 26, textAlign: 'center', fontWeight: weight.bold },
  rowText: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: font.body, fontWeight: weight.semibold },
  rowStatus: { fontSize: font.small, marginTop: space.xxs },
  chevron: { color: colors.textFaint, fontSize: font.h3, width: 20, textAlign: 'center' },
  rowBody: {
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: space.md,
  },
  rowButton: { marginTop: space.sm },

  step: { flexDirection: 'row', gap: space.sm, marginBottom: space.sm },
  stepNum: {
    color: colors.textInverse,
    backgroundColor: colors.borderStrong,
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    textAlign: 'center',
    lineHeight: 20,
    fontSize: font.tiny,
    fontWeight: weight.bold,
    overflow: 'hidden',
  },
  stepText: { flex: 1, color: colors.textDim, fontSize: font.body, lineHeight: 21 },
});
