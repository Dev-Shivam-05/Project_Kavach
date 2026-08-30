/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * app/panic.tsx — THE SCREEN THE ENTIRE PRODUCT EXISTS FOR
 *
 * Every constraint below is PRD §6.4 and none of them are stylistic:
 *   · the primary action is PANIC_BUTTON_HEIGHT (96 dp) / CALL_112_HEIGHT (88 dp),
 *     full width, and lives in the FOOTER — the bottom third of a 6.7" device,
 *     which is the only region a shaking thumb reaches one-handed
 *   · ≥7:1 contrast, and never colour alone — every tone carries a glyph and a word
 *   · ≤4 words per element, present tense: "Family alerted." not "Your family
 *     members have now been contacted"
 *   · the ONLY animation on this screen is CountdownRing, and it owns no timer —
 *     `pendingUntil` from T0 is the single clock (see CountdownRing's header)
 *   · a distinct cue fires on every state change, because the subject is looking
 *     at the road / the attacker / the floor, not at the phone
 *
 * ★★★ THERE IS NO ERROR SCREEN HERE. ★★★
 * No red ✗, no spinner, no "no connection", no retry. When the network is gone the
 * screen degrades to t('panic.sentSms') or t('panic.offline') over BigCoordinates,
 * because the floor of this product (§4.4 ZERO_INFRA) is a screaming phone showing
 * six-decimal Latin digits that a stranger can read aloud to a 112 operator.
 *
 * ★ WHAT THIS SCREEN DOES NOT OWN ★
 * The siren, the strobe, the countdown haptics and the escalation ladder all
 * belong to T0 (t0/triggerRouter, t0/alarm). A second controller fighting T0 over
 * the siren is exactly how a panic button ends up silent, so this file never calls
 * startAlarm/stopAlarm. It reads state and renders it.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { BigCoordinates, Button, Call112Button, CountdownRing } from '../src/ui/components';
import {
  MIN_TOUCH_TARGET,
  PANIC_BUTTON_HEIGHT,
  colors,
  font,
  radius,
  space,
  tracking,
  weight,
} from '../src/ui/theme';
import { t, type StringKey } from '../src/i18n';
import {
  DEGRADATION_LABELS,
  DegradationLevel,
  type Incident,
  type IncidentEventRow,
  type Member,
  type TransportKind,
  type UUID,
} from '../src/core/types';
import { isActive, isTerminal, type IncidentState } from '../src/t0/stateMachine.generated';
import { effectiveCancelWindowS } from '../src/core/policy';
import { currentPolicy, lastKnownFix, useKavach } from '../src/state/store';
import { playCue, type CueKind } from '../src/t0/alarm';

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** The ring is re-rendered from `pendingUntil`; 100 ms is one tenth of the unit
 *  the subject is reading, so the numeral never appears to skip a second. */
const RING_TICK_MS = 100;

/** How long the "I am safe" confirmation stays before the screen dismisses. Long
 *  enough to read at arm's length, short enough not to be a dead end. */
const CONFIRM_DISMISS_MS = 2200;

/**
 * A deliberate press-and-hold, not a tap. P-002: a tap is what a pocket, a
 * handbag and a toddler produce, and every one of those costs the family a false
 * alarm they will eventually mute the product over.
 */
const HOLD_MS = 700;

/** t0/triggerRouter pads to a fixed compare length; the pad simply must not
 *  outrun it. Any length is accepted — families do not all choose four digits. */
const PIN_MAX = 12;

/** Explicit rather than a template literal, so a renamed state is a compile
 *  error here instead of an English fallback string at 2 a.m. */
const STATE_KEY: Record<IncidentState, StringKey> = {
  IDLE: 'state.IDLE',
  WATCH: 'state.WATCH',
  SUSPECT: 'state.SUSPECT',
  PROBE: 'state.PROBE',
  PENDING: 'state.PENDING',
  FALSE_ALARM: 'state.FALSE_ALARM',
  ACTIVE_L1: 'state.ACTIVE_L1',
  ACTIVE_L1_SILENT: 'state.ACTIVE_L1_SILENT',
  ACTIVE_L2: 'state.ACTIVE_L2',
  ACTIVE_L3: 'state.ACTIVE_L3',
  OWNED: 'state.OWNED',
  RESOLVING: 'state.RESOLVING',
  RESOLVED: 'state.RESOLVED',
  DORMANT: 'state.DORMANT',
};

/**
 * §6.4: the subject will be looking away, so every state change must be audible
 * and felt. 'ack' is reserved for OWNED — "someone is coming" is the one sound in
 * this system worth learning by ear.
 */
const STATE_CUE: Record<IncidentState, CueKind> = {
  IDLE: 'state',
  WATCH: 'state',
  SUSPECT: 'state',
  PROBE: 'probe',
  PENDING: 'probe',
  FALSE_ALARM: 'resolve',
  ACTIVE_L1: 'state',
  ACTIVE_L1_SILENT: 'state',
  ACTIVE_L2: 'state',
  ACTIVE_L3: 'state',
  OWNED: 'ack',
  RESOLVING: 'ack',
  RESOLVED: 'resolve',
  DORMANT: 'resolve',
};

/** What the subject needs to know is "did it leave the phone", not the protocol. */
const TRANSPORT_WORD: Record<TransportKind, string> = {
  ws: 'App',
  http: 'App',
  http_direct: 'App',
  push: 'Push',
  sms: 'SMS',
  ble_relay: 'Nearby',
  local: 'Phone',
};

const PAD_DIGITS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/**
 * The fallback for "this incident has no log rows yet", which is exactly the
 * first seconds of a live emergency. A fresh `[]` here is a new identity on
 * every render, and during PENDING that is ten renders a second — each one
 * invalidating the `notifiedFrom` memo below, which walks the whole event log.
 * One frozen array costs nothing and makes the memo actually memoise.
 */
const EMPTY_ROWS: IncidentEventRow[] = [];

// ═══════════════════════════════════════════════════════════════════════════════
// Derivations
// ═══════════════════════════════════════════════════════════════════════════════

interface Fix {
  lat: number;
  lon: number;
  accuracyM: number;
}

interface Notified {
  memberId: UUID;
  name: string;
  transport: TransportKind;
  delivered: boolean;
}

function detailString(detail: Record<string, unknown> | undefined, key: string): string | null {
  const v = detail?.[key];
  return typeof v === 'string' ? v : null;
}

/**
 * Who has actually been told, from the incident log rather than from intent.
 *
 * P-003 again: "the family was notified" is a claim about six people; this list
 * is the evidence. The last row per member wins, so a failed push followed by a
 * delivered SMS reads as delivered — which is what happened.
 */
function notifiedFrom(rows: IncidentEventRow[], members: Member[]): Notified[] {
  const byMember = new Map<UUID, Notified>();
  for (const row of rows) {
    if (row.eventType !== 'DELIVERED' && row.eventType !== 'DELIVERY_FAILED') continue;
    const memberId = detailString(row.detail, 'memberId');
    if (memberId === null) continue;
    byMember.set(memberId, {
      memberId,
      name: members.find((m) => m.id === memberId)?.displayName ?? t('tab.home'),
      transport: row.sourceTransport,
      delivered: row.eventType === 'DELIVERED',
    });
  }
  return [...byMember.values()];
}

/**
 * The one line that replaces every error message this screen is forbidden to
 * show. Evidence first — an SMS receipt is proof the message left by SMS — then
 * the connectivity rung.
 */
function transportLine(rows: Notified[], degradation: DegradationLevel): string | null {
  if (rows.some((r) => r.delivered && r.transport === 'sms')) return t('panic.sentSms');
  if (degradation <= DegradationLevel.PEER_ONLY) return t('panic.offline');
  if (degradation <= DegradationLevel.SMS_ONLY) return t('panic.sentSms');
  return null;
}

/**
 * Degradation is never colour alone (P-018): glyph/icon + word + tone, always.
 * Returns exactly one of `glyph` (plain text) or `icon` (Feather) — only the
 * worst-case mark was a catalogued text-glyph character (★ Spec A4); the other
 * two are unaffected.
 */
function degradationMark(
  level: DegradationLevel,
): { glyph?: string; icon?: keyof typeof Feather.glyphMap } {
  if (level >= DegradationLevel.FULL) return { glyph: '✓' };
  if (level >= DegradationLevel.PUSH_ONLY) return { glyph: 'ℹ' };
  return { icon: 'alert-triangle' };
}

/**
 * The *Text* variants, not the fills. This colour is used as ink on `bgElevated`
 * (the chip glyph) and as its border. `colors.ok` there measures 2.9:1 — under
 * §6.4's 7:1 floor and under WCAG's 3:1 floor for a border — so the one element
 * telling the subject which transports still work would be the faintest thing on
 * the screen. `okText` is 8.6:1 on the same surface.
 */
function degradationColour(level: DegradationLevel): string {
  if (level >= DegradationLevel.FULL) return colors.okText;
  if (level >= DegradationLevel.PUSH_ONLY) return colors.infoText;
  return colors.warnText;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Pieces
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The subject is entitled to know which transports carried their alarm — §4.4
 * makes the ladder honest rather than hidden, and "SMS only" changes what a
 * reasonable person does next.
 */
const DegradationHeader = memo(function DegradationHeader({
  level,
  stateLabel,
}: {
  level: DegradationLevel;
  stateLabel: string | null;
}): React.ReactElement {
  const label = DEGRADATION_LABELS[level];
  const colour = degradationColour(level);
  const mark = degradationMark(level);
  return (
    <View style={styles.header}>
      {stateLabel === null ? (
        <View />
      ) : (
        <Text style={styles.headerState} numberOfLines={1} allowFontScaling={false}>
          {stateLabel}
        </Text>
      )}
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={label}
        style={[styles.degrade, { borderColor: colour }]}
      >
        {mark.icon !== undefined ? (
          <Feather name={mark.icon} size={font.small + 1} color={colour} />
        ) : (
          <Text style={[styles.degradeGlyph, { color: colour }]} allowFontScaling={false}>
            {mark.glyph}
          </Text>
        )}
        <Text style={styles.degradeLabel} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </View>
  );
});

/**
 * ★ THE CONFIRMATION AFTER AN ACCEPTED PIN ★
 *
 * It takes NO incident, NO t0State and NO member. That is not minimalism, it is
 * the enforcement mechanism for P-011: a component that cannot see the incident
 * cannot render a difference between a cancel and a duress. See `acceptCancelUi`.
 */
function SafeConfirmation({
  level,
  topInset,
}: {
  level: DegradationLevel;
  topInset: number;
}): React.ReactElement {
  return (
    <View style={[styles.screen, { paddingTop: topInset }]}>
      <DegradationHeader level={level} stateLabel={null} />
      <View style={styles.confirmBody}>
        <Text style={styles.confirmGlyph} allowFontScaling={false}>
          ✓
        </Text>
        <Text
          style={styles.confirmTitle}
          accessibilityRole="header"
          accessibilityLiveRegion="assertive"
        >
          {t('panic.cancel')}
        </Text>
      </View>
    </View>
  );
}

/**
 * Press-and-hold, with a tap path that exists only for TalkBack.
 *
 * §6.4 requires the whole flow to be completable without sight. TalkBack
 * activates a control with a double-tap, which never becomes a press-and-hold, so
 * a hold-only button is unreachable for a blind user — the failure mode is total,
 * not cosmetic. The tap path is therefore enabled exactly when a screen reader is.
 */
function HoldToTrigger({
  onFire,
  screenReader,
}: {
  onFire: () => void;
  screenReader: boolean;
}): React.ReactElement {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => clear, [clear]);

  const start = useCallback(() => {
    // The hold is confirmed by feel, not by an animation (§6.4 forbids one).
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      onFire();
    }, HOLD_MS);
  }, [clear, onFire]);

  return (
    <Pressable
      onPressIn={start}
      onPressOut={clear}
      onPress={screenReader ? onFire : undefined}
      accessibilityRole="button"
      accessibilityLabel={t('panic.trigger')}
      accessibilityHint={t('panic.hold')}
      android_ripple={{ color: colors.danger }}
      style={({ pressed }) => [styles.hold, pressed ? styles.holdPressed : null]}
    >
      <Text style={styles.holdLabel} numberOfLines={2} allowFontScaling={false}>
        {t('panic.hold')}
      </Text>
    </Pressable>
  );
}

/** Hoisted so the twelve keys share one function instead of allocating twelve
 *  new ones per render — see PinKey's header for why that mattered here. */
const keyStyle = ({ pressed }: { pressed: boolean }): (object | null)[] => [
  styles.key,
  styles.keyFace,
  pressed ? styles.keyPressed : null,
];

/** Same reason as `keyStyle`: one shared function rather than one per render. */
const medicalLinkStyle = ({ pressed }: { pressed: boolean }): (object | null)[] => [
  styles.medicalLink,
  pressed ? styles.medicalLinkPressed : null,
];

/**
 * ★ ONE MEMOISED NODE PER KEY, AND THE DIGIT TRAVELS AS A PROP ★
 *
 * During PENDING this screen repaints ten times a second off the ring tick
 * (RING_TICK_MS). With `onPress={() => onDigit(key)}` written inline, each of
 * those repaints handed twelve Pressables a brand-new callback and a brand-new
 * style function, so React reconciled the entire pad 10×/s — on the one screen
 * in the product where a press that feels dropped costs the most.
 *
 * app/onboarding/index.tsx was rewritten to this exact shape and says so in as
 * many words: a per-render closure per key "is what made the pad feel like it
 * was dropping presses". Do not put a closure back.
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
}): React.ReactElement {
  const handle = useCallback((): void => {
    // No audible click and no motion (§6.4 forbids one here), so the haptic is
    // the only confirmation a low-vision or elderly user gets that it landed.
    void Haptics.selectionAsync().catch(() => {});
    if (digit !== undefined && onDigit) onDigit(digit);
    else if (onPress) onPress();
  }, [digit, onDigit, onPress]);

  return (
    <Pressable
      onPress={handle}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `Digit ${label}`}
      android_ripple={{ color: colors.borderStrong }}
      style={keyStyle}
    >
      <Text style={styles.keyLabel} allowFontScaling={false}>
        {label}
      </Text>
    </Pressable>
  );
});

/** Digits only. No biometric, no "forgot PIN", no lockout — every one of those is
 *  a door that stays shut for the person who needs it (F-17). */
const PinPad = memo(function PinPad({
  onDigit,
  onDelete,
}: {
  onDigit: (d: string) => void;
  onDelete: () => void;
}): React.ReactElement {
  return (
    <View style={styles.pad}>
      {PAD_DIGITS.map((d) => (
        <PinKey key={d} label={d} digit={d} onDigit={onDigit} />
      ))}
      <View style={styles.key} />
      <PinKey label="0" digit="0" onDigit={onDigit} />
      <PinKey label="⌫" accessibilityLabel="Delete last digit" onPress={onDelete} />
    </View>
  );
});

/**
 * ★ The empty case is a sentence, not an absent card. ★
 * This list used to render nothing at all until the first receipt landed, so for
 * the first seconds of a real emergency the screen answered "has anyone been
 * told?" with silence — the one answer this product is not allowed to give. It
 * now says what is true: the alarm is out, nothing has come back yet.
 */
const NotifiedList = memo(function NotifiedList({
  rows,
}: {
  rows: Notified[];
}): React.ReactElement {
  return (
    <View style={styles.notified}>
      <Text style={styles.notifiedTitle} allowFontScaling={false}>
        WHO HAS BEEN TOLD
      </Text>
      {rows.length === 0 ? (
        <Text style={styles.notifiedWaiting} accessibilityLiveRegion="polite">
          Still sending. No phone has confirmed yet.
        </Text>
      ) : null}
      {rows.map((row) => {
        // The *Text* variants: `colors.ok` on this card measures 2.4:1, so the
        // tick saying a relative actually received the alarm was the least
        // legible mark on the screen. Glyph AND word AND colour (P-018).
        const colour = row.delivered ? colors.okText : colors.warnText;
        const word = TRANSPORT_WORD[row.transport];
        return (
          <View
            key={row.memberId}
            accessible
            accessibilityRole="text"
            accessibilityLabel={`${row.name}. ${row.delivered ? 'Delivered' : 'Not delivered'}. ${word}.`}
            style={styles.notifiedRow}
          >
            {row.delivered ? (
              <Text style={[styles.notifiedGlyph, { color: colour }]} allowFontScaling={false}>
                ✓
              </Text>
            ) : (
              <Feather name="alert-triangle" size={font.h3} color={colour} />
            )}
            <Text style={styles.notifiedName} numberOfLines={1}>
              {row.name}
            </Text>
            <Text style={styles.notifiedTransport} numberOfLines={1}>
              {word}
            </Text>
          </View>
        );
      })}
    </View>
  );
});

/**
 * The L0 floor. When there is no fix at all the screen still refuses to show an
 * error: it says what the person holding the phone should do instead.
 */
const Coordinates = memo(function Coordinates({ fix }: { fix: Fix | null }): React.ReactElement {
  if (fix === null) {
    return (
      <View style={styles.noFix}>
        <Text style={styles.noFixTitle}>No location yet.</Text>
        <Text style={styles.noFixBody}>{t('medical.showToResponder')}</Text>
      </View>
    );
  }
  return <BigCoordinates lat={fix.lat} lon={fix.lon} accuracyM={fix.accuracyM} />;
});

// ═══════════════════════════════════════════════════════════════════════════════
// The screen
// ═══════════════════════════════════════════════════════════════════════════════

export default function PanicScreen(): React.ReactElement {
  // A phone that sleeps mid-emergency is a phone whose coordinates nobody can
  // read aloud. This is the one screen that is always allowed to hold the wake
  // lock (§4.4 — the local floor keeps working when everything else has gone).
  useKeepAwake();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const t0State = useKavach((s) => s.t0State);
  const pendingUntil = useKavach((s) => s.pendingUntil);
  const activeIncident = useKavach((s) => s.activeIncident);
  const incidents = useKavach((s) => s.incidents);
  const members = useKavach((s) => s.members);
  const presence = useKavach((s) => s.presence);
  const me = useKavach((s) => s.me);
  const degradation = useKavach((s) => s.degradation);
  const risk = useKavach((s) => s.risk);

  const cancelWithPin = useKavach((s) => s.cancelWithPin);
  const raise = useKavach((s) => s.trigger);
  const resolveIncident = useKavach((s) => s.resolveIncident);

  const [entry, setEntry] = useState('');
  const [wrong, setWrong] = useState(false);
  /** Set the instant the subject presses "I am safe" — BEFORE any verdict exists. */
  const [pinSubmitted, setPinSubmitted] = useState(false);
  /** Set when the PIN was accepted. Never says WHICH PIN. */
  const [safeConfirmed, setSafeConfirmed] = useState(false);
  /** A terminal state observed while mounted, as opposed to one left over from a
   *  previous incident — otherwise opening this screen after any past emergency
   *  would flash a confirmation and dismiss itself. */
  const [closedWhileOpen, setClosedWhileOpen] = useState(false);
  const [screenReader, setScreenReader] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [totalMs, setTotalMs] = useState(0);

  const lastStateRef = useRef<IncidentState>(t0State);

  const incident: Incident | null = useMemo(
    () => activeIncident ?? incidents.find((i) => !isTerminal(i.state)) ?? null,
    [activeIncident, incidents],
  );

  /**
   * ★ Subscribed to ONE incident's rows, not to the whole `incidentEvents` map. ★
   * `appendRow` (state/store.ts) replaces that map wholesale, so selecting it
   * meant every DISPATCHED / LADDER / DELIVERED row of every incident on the
   * device repainted the emergency screen. Returning the stored array — or the
   * frozen EMPTY_ROWS — keeps the reference stable, which is what lets the memo
   * below survive the 100 ms ring tick instead of re-walking the log ten times a
   * second.
   */
  const incidentId = incident?.id ?? null;
  const rows = useKavach((s) =>
    incidentId === null ? EMPTY_ROWS : (s.incidentEvents[incidentId] ?? EMPTY_ROWS),
  );
  const notified = useMemo(() => notifiedFrom(rows, members), [rows, members]);

  const fix: Fix | null = useMemo(() => {
    // The sealed payload is where the alarm was RAISED — the honest answer to
    // "where is she", and the value the family already received (§10.2).
    const sealed = incident?.sealed;
    if (sealed) return { lat: sealed.lat, lon: sealed.lon, accuracyM: sealed.accuracyM };
    const cached = lastKnownFix();
    if (cached) return { lat: cached.lat, lon: cached.lon, accuracyM: cached.accuracyM };
    const mine = me ? (presence[me.id]?.location ?? null) : null;
    if (mine) return { lat: mine.lat, lon: mine.lon, accuracyM: mine.accuracyM };
    return null;
  }, [incident, me, presence]);

  // ── navigation ──────────────────────────────────────────────────────────────

  const dismiss = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  // ── the countdown ───────────────────────────────────────────────────────────

  /**
   * The full window, captured once when T0 opens it. Read from the deadline
   * itself rather than recomputed, so an adaptive lengthening (P-017, repeated
   * false positives) is reflected instead of silently drawn as a short ring. The
   * policy value is the floor for the case where this screen mounts late.
   */
  useEffect(() => {
    if (pendingUntil === null) {
      setTotalMs(0);
      return;
    }
    const policyMs =
      effectiveCancelWindowS(currentPolicy(), incident?.trigger ?? 'MANUAL', risk) * 1000;
    setTotalMs(Math.max(1, policyMs, pendingUntil - Date.now()));
    // `incident` is deliberately not a dependency: the window belongs to the
    // deadline, and re-reading it on every incident row change would rescale the
    // ring mid-countdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUntil, risk]);

  useEffect(() => {
    if (pendingUntil === null || pinSubmitted) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), RING_TICK_MS);
    return () => clearInterval(id);
  }, [pendingUntil, pinSubmitted]);

  // ── cues ────────────────────────────────────────────────────────────────────

  const confirming = pinSubmitted || safeConfirmed || closedWhileOpen;

  useEffect(() => {
    const previous = lastStateRef.current;
    lastStateRef.current = t0State;
    if (previous === t0State) return;
    if (isTerminal(t0State)) setClosedWhileOpen(true);
    // ★ Silence here while the confirmation is on screen. FALSE_ALARM emits no
    //   cue and ACTIVE_L1_SILENT emits one, so letting this effect speak during a
    //   cancel would announce, out loud, which PIN was typed (P-011). The single
    //   cue for both outcomes is played by acceptCancelUi instead.
    if (confirming) return;
    playCue(STATE_CUE[t0State]);
  }, [t0State, confirming]);

  // ── the accept / reject pair ────────────────────────────────────────────────

  /**
   * ★★★ THE DURESS PATH — P-011 / I-7 / T-213 ★★★
   *
   * This function is the WHOLE of what the screen does when a PIN is accepted,
   * and it is deliberately unable to tell a cancel from a duress:
   *
   *   1. it takes no arguments, so the verdict cannot be passed in;
   *   2. it is declared at component scope, so the verdict — which only ever
   *      exists inside `submitPin`'s async closure — is not even in its lexical
   *      scope. There is nothing here to branch on;
   *   3. it plays 'state', not 'resolve'. A genuine cancel "deserves" the falling
   *      third, but T0 emits 'state' on entering ACTIVE_L1_SILENT and nothing on
   *      entering FALSE_ALARM (t0/triggerRouter onEnterState), so 'state' is the
   *      cue that makes both outcomes sound the same. Semantics lose to
   *      indistinguishability every time on this screen;
   *   4. it renders <SafeConfirmation/>, which is passed no incident and no state
   *      and therefore cannot leak one;
   *   5. the render lock is taken in `submitPin` BEFORE verification, so the
   *      frame between "PIN entered" and "verdict known" is identical too. T0's
   *      transition lands synchronously inside cancelWithPin and would otherwise
   *      repaint FALSE_ALARM or ACTIVE_L1_SILENT for one frame.
   *
   * Residual, stated honestly, in the layer below this file: entering
   * ACTIVE_L1_SILENT makes T0 play its own 'state' cue, so a duress emits that
   * tone from T0 and this one from here, ~1 frame apart, into the same single cue
   * player — one restart of one tone. A cancel emits this one alone. The audible
   * result is one 660 Hz tick either way. Do not "improve" this to 'resolve'.
   */
  const acceptCancelUi = useCallback(() => {
    setEntry('');
    setWrong(false);
    setSafeConfirmed(true);
    playCue('state');
  }, []);

  /** The only outcome that is allowed to look different. */
  const rejectCancelUi = useCallback(() => {
    setEntry('');
    setWrong(true);
    setPinSubmitted(false);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  }, []);

  const submitPin = useCallback(() => {
    // ★ Lock first, verify second — point 5 above.
    setPinSubmitted(true);
    const candidate = entry;
    void (async () => {
      // The verdict is never bound to a name and never leaves this expression;
      // both accepting outcomes select the identical function reference.
      const accepted = (await cancelWithPin(candidate)) !== 'wrong';
      (accepted ? acceptCancelUi : rejectCancelUi)();
    })();
  }, [entry, cancelWithPin, acceptCancelUi, rejectCancelUi]);

  // ── auto-dismiss ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(dismiss, CONFIRM_DISMISS_MS);
    return () => clearTimeout(id);
  }, [confirming, dismiss]);

  // ── accessibility ───────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((on) => {
        if (alive) setScreenReader(on);
      })
      .catch(() => {
        /* an unreadable setting must not disable the trigger */
      });
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', (on) =>
      setScreenReader(on),
    );
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  // ── handlers ────────────────────────────────────────────────────────────────

  const fire = useCallback(() => {
    void raise('MANUAL');
  }, [raise]);

  const onDigit = useCallback((d: string) => {
    setWrong(false);
    setEntry((p) => (p.length >= PIN_MAX ? p : p + d));
  }, []);

  const onDelete = useCallback(() => {
    setWrong(false);
    setEntry((p) => p.slice(0, -1));
  }, []);

  const closeIncident = useCallback(() => {
    if (!incident) return;
    void resolveIncident(incident.id);
  }, [incident, resolveIncident]);

  const openMedical = useCallback(() => {
    router.push('/medical-card');
  }, [router]);

  // ═══ render ═══════════════════════════════════════════════════════════════

  const padTop = insets.top + space.sm;
  const padBottom = insets.bottom + space.lg;

  // ★ First, and reading nothing about the incident. Everything below this line
  //   is unreachable while a PIN has been accepted (P-011).
  if (confirming) return <SafeConfirmation level={degradation} topInset={padTop} />;

  if (t0State === 'PENDING') {
    const remainingMs = pendingUntil === null ? 0 : Math.max(0, pendingUntil - now);
    return (
      <View style={[styles.screen, { paddingTop: padTop }]}>
        <DegradationHeader level={degradation} stateLabel={t(STATE_KEY[t0State])} />

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="always"
        >
          <View style={styles.ringWrap}>
            {/* ★ The colour is passed, not defaulted. CountdownRing paints its
                NUMERAL with this as well as its arc, and its default —
                `colors.danger` — is 3.31:1 on this background. The seconds
                remaining is the number the subject is staring at while deciding
                whether to type a PIN; `dangerText` is 9.53:1 and the arc stays
                unmistakably red. */}
            <CountdownRing
              totalMs={totalMs}
              remainingMs={remainingMs}
              size={148}
              colour={colors.dangerText}
            />
          </View>

          <Text style={styles.lead} accessibilityRole="header">
            {t('panic.sending')}
          </Text>
          <Text style={styles.sub}>{t('panic.cancelIn')}</Text>

          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel={`${entry.length} digits entered`}
            accessibilityLiveRegion="polite"
            style={styles.pinDisplay}
          >
            <Text style={styles.pinDots} allowFontScaling={false} numberOfLines={1}>
              {entry.length === 0 ? '—' : '●'.repeat(entry.length)}
            </Text>
          </View>

          {/* Colour, glyph AND word: a failed PIN reads the same to someone who
              cannot distinguish the amber (P-018). The words never change. */}
          <View style={styles.promptRow}>
            {wrong ? (
              <Feather name="alert-triangle" size={font.small + 1} color={colors.warnText} />
            ) : (
              <Text
                style={[styles.promptGlyph, { color: colors.textFaint }]}
                allowFontScaling={false}
              >
                •
              </Text>
            )}
            <Text
              style={[styles.prompt, wrong ? styles.promptWrong : null]}
              accessibilityLiveRegion="polite"
            >
              {t('panic.enterPin')}
            </Text>
          </View>

          <PinPad onDigit={onDigit} onDelete={onDelete} />
        </ScrollView>

        {/* Bottom third, full width, ≥88 dp — PRD §6.4. Never disabled: a control
            that refuses to respond during a countdown is worse than a wrong PIN. */}
        <View style={[styles.footer, { paddingBottom: padBottom }]}>
          <Button
            label={t('panic.cancel')}
            onPress={submitPin}
            variant="primary"
            size="panic"
            accessibilityLabel={t('panic.cancel')}
          />
        </View>
      </View>
    );
  }

  if (isActive(t0State)) {
    const owner = incident?.ownerMemberId
      ? members.find((m) => m.id === incident.ownerMemberId)
      : undefined;
    const unacked = incident === null || (incident.firstAckAt === null && incident.ownerMemberId === null);
    const responding = t0State === 'OWNED' || t0State === 'RESOLVING';
    const headline = responding
      ? t0State === 'RESOLVING'
        ? t('state.RESOLVING')
        : owner
          ? t('panic.responding', { name: owner.displayName })
          : t('state.OWNED')
      : t('panic.sent');
    const line = transportLine(notified, degradation);

    return (
      <View style={[styles.screen, { paddingTop: padTop }]}>
        <DegradationHeader level={degradation} stateLabel={t(STATE_KEY[t0State])} />

        <ScrollView style={styles.flex} contentContainerStyle={styles.body}>
          <Text style={styles.headline} accessibilityRole="header" accessibilityLiveRegion="assertive">
            {headline}
          </Text>

          {/* The degraded truth, never an error. §4.4. */}
          {line === null ? null : <Text style={styles.transportLine}>{line}</Text>}

          {/* ★ P-003 — THE MOST IMPORTANT STRING IN THE PRODUCT ★
              "Somebody should help" diffuses across six people until nobody moves.
              Naming the absence creates individual responsibility, so it stays up,
              bold, until a claim lands. */}
          {!responding && unacked ? (
            <View style={styles.nobody} accessible accessibilityRole="alert">
              <Feather name="alert-triangle" size={font.h2} color={colors.dangerText} />
              <Text style={styles.nobodyText}>{t('panic.nobodyResponded')}</Text>
            </View>
          ) : null}

          <Coordinates fix={fix} />

          {/*
            ★ PRD §10.4 layer 1 — the break-glass card, one tap from the live
            incident. The subject may be unable to speak; the person who reached
            them needs a blood group and an allergy list NOW, and they will not
            go hunting through Settings to find it.

            It sits HERE, against the coordinates, and not in the footer. Three
            stacked footer controls came to ~270 pt with insets — 40-47 % of a
            568-667 pt screen — which broke §6.4's "bottom third only" and pushed
            BigCoordinates, the single thing this screen exists to show, below the
            fold. This is also where the responder's eye already is: they are
            reading the position aloud when they need the blood group.
          */}
          <Pressable
            onPress={openMedical}
            accessibilityRole="button"
            accessibilityLabel="Show the medical card to whoever is helping"
            android_ripple={{ color: colors.borderStrong }}
            style={medicalLinkStyle}
          >
            <Text style={styles.medicalLinkGlyph} allowFontScaling={false}>
              ✚
            </Text>
            <Text style={styles.medicalLinkText} numberOfLines={2}>
              {t('medical.title')}
            </Text>
            <Text style={styles.medicalLinkChevron} allowFontScaling={false}>
              ›
            </Text>
          </Pressable>

          <NotifiedList rows={notified} />
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: padBottom }]}>
          {/* Ending it is a person's decision, and it must cost one press —
              two-party confirm where the machine allows it, self-clear where it
              does not (the store picks). */}
          <Button
            label={t('panic.resolve')}
            onPress={closeIncident}
            variant="ghost"
            size="md"
            accessibilityLabel={t('panic.resolve')}
            style={styles.secondary}
          />
          {/* ADR-019: hands off to the dialler so the OS still classifies this as
              an emergency call and AML fires. Never wrapped, never auto-dialled. */}
          <Call112Button />
        </View>
      </View>
    );
  }

  // IDLE / WATCH / SUSPECT / PROBE — nothing is live, so the screen is what it is
  // named for: the way to raise an alarm, over coordinates a stranger can read.
  return (
    <View style={[styles.screen, { paddingTop: padTop }]}>
      <DegradationHeader level={degradation} stateLabel={t(STATE_KEY[t0State])} />

      <ScrollView style={styles.flex} contentContainerStyle={styles.body}>
        <Text style={styles.headline} accessibilityRole="header">
          {t('panic.trigger')}
        </Text>
        <Coordinates fix={fix} />
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: padBottom }]}>
        <Call112Button compact />
        <HoldToTrigger onFire={fire} screenReader={screenReader} />
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: { flex: 1 },
  body: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xl,
    gap: space.lg,
  },

  // ── header ──
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: space.sm,
  },
  headerState: {
    flexShrink: 1,
    color: colors.text,
    fontSize: font.h3,
    fontWeight: weight.bold,
  },
  degrade: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    backgroundColor: colors.bgElevated,
    maxWidth: '58%',
  },
  degradeGlyph: { fontSize: font.small, fontWeight: weight.bold },
  degradeLabel: {
    flexShrink: 1,
    color: colors.text,
    fontSize: font.small,
    fontWeight: weight.semibold,
  },

  // ── confirmation ──
  confirmBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    paddingHorizontal: space.lg,
  },
  confirmGlyph: {
    // okText, not ok: a 68 px tick in `colors.ok` renders at 2.9:1 on this
    // background — near-black, on the one frame that has to say "you are safe"
    // to someone who has just typed a PIN with shaking hands.
    color: colors.okText,
    fontSize: font.display * 2,
    fontWeight: weight.heavy,
    includeFontPadding: false,
  },
  confirmTitle: {
    color: colors.text,
    fontSize: font.h1,
    fontWeight: weight.heavy,
    textAlign: 'center',
  },

  // ── pending ──
  ringWrap: { alignItems: 'center', paddingTop: space.sm },
  lead: {
    color: colors.text,
    fontSize: font.h1,
    fontWeight: weight.heavy,
    textAlign: 'center',
  },
  sub: {
    color: colors.textDim,
    fontSize: font.body,
    fontWeight: weight.semibold,
    textAlign: 'center',
    marginTop: -space.sm,
  },
  pinDisplay: {
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgInput,
  },
  pinDots: {
    color: colors.text,
    fontSize: font.h2,
    fontWeight: weight.bold,
    letterSpacing: 6,
  },
  promptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    marginTop: -space.sm,
  },
  promptGlyph: { fontSize: font.small, fontWeight: weight.bold },
  prompt: {
    color: colors.textDim,
    fontSize: font.small,
    fontWeight: weight.semibold,
  },
  promptWrong: { color: colors.warnText },

  // ── keypad ──
  pad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  key: {
    width: '31.5%',
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyFace: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
  },
  keyPressed: { backgroundColor: colors.bgInput },
  keyLabel: {
    color: colors.text,
    fontSize: font.h2,
    fontWeight: weight.bold,
    includeFontPadding: false,
  },

  // ── active ──
  headline: {
    color: colors.text,
    fontSize: font.display,
    fontWeight: weight.heavy,
  },
  transportLine: {
    // ★ The one line that replaces every error message this screen is forbidden
    //   to show (see the file header). In `colors.warn` it measured 3.25:1 —
    //   read with adrenaline-narrowed vision, the sentence telling the subject
    //   their alarm went out over SMS rather than data was nearly invisible.
    //   `warnText` is 9.40:1 on this background.
    color: colors.warnText,
    fontSize: font.h3,
    fontWeight: weight.semibold,
    marginTop: -space.sm,
  },
  nobody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 2,
    borderColor: colors.danger,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    padding: space.md,
  },
  nobodyText: {
    flex: 1,
    // Deliberately the loudest type on the screen after the coordinates.
    color: colors.text,
    fontSize: font.h2,
    fontWeight: weight.heavy,
    letterSpacing: 0.5,
  },

  // ── notified ──
  notified: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  notifiedTitle: {
    color: colors.textDim,
    fontSize: font.tiny,
    fontWeight: weight.bold,
    letterSpacing: tracking.caps,
  },
  notifiedWaiting: {
    color: colors.textDim,
    fontSize: font.body,
    fontWeight: weight.semibold,
    paddingVertical: space.sm,
  },
  notifiedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: MIN_TOUCH_TARGET,
  },
  notifiedGlyph: { fontSize: font.h3, fontWeight: weight.bold },
  notifiedName: {
    flex: 1,
    color: colors.text,
    fontSize: font.body,
    fontWeight: weight.semibold,
  },
  notifiedTransport: {
    color: colors.textDim,
    fontSize: font.small,
    fontWeight: weight.semibold,
  },

  // ── the break-glass link, in the scroll body beside the coordinates ──
  medicalLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: MIN_TOUCH_TARGET + space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgElevated,
  },
  medicalLinkPressed: { backgroundColor: colors.bgInput, borderColor: colors.focus },
  medicalLinkGlyph: { color: colors.dangerText, fontSize: font.h2, fontWeight: weight.heavy },
  medicalLinkText: {
    flex: 1,
    color: colors.text,
    fontSize: font.h3,
    fontWeight: weight.bold,
  },
  medicalLinkChevron: { color: colors.textDim, fontSize: font.h2, fontWeight: weight.bold },

  // ── no fix ──
  noFix: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgElevated,
    padding: space.lg,
    gap: space.xs,
  },
  noFixTitle: {
    color: colors.text,
    fontSize: font.h2,
    fontWeight: weight.bold,
  },
  noFixBody: {
    color: colors.textDim,
    fontSize: font.body,
  },

  // ── footer: the bottom third, and nothing else lives here ──
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  secondary: { alignSelf: 'stretch' },
  hold: {
    minHeight: PANIC_BUTTON_HEIGHT,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.danger,
    // dangerDark behind a white label is 9.5:1; colors.danger behind it is 4.35:1
    // and would miss the §6.4 floor. The saturated red stays on the edge.
    backgroundColor: colors.dangerDark,
  },
  holdPressed: { backgroundColor: colors.danger },
  holdLabel: {
    color: colors.white,
    fontSize: font.h2,
    fontWeight: weight.heavy,
    letterSpacing: 1,
    textAlign: 'center',
  },
});
