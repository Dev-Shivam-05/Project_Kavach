/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROBE — "Are you okay?" (P-002)
 *
 * ★ WHY THIS SCREEN EXISTS AT ALL ★
 * Every accelerometer-based fall detector on earth fires on a dropped phone, a
 * dog's tail and a jacket thrown onto a sofa. The industry answer is to raise the
 * detection threshold until the false alarms stop, which also stops the real
 * falls. Kavach's answer is this screen: when the evidence is MEDIUM rather than
 * HIGH the machine does not open an incident, it asks one question. Almost every
 * would-be false positive is converted into a non-event here — nobody is
 * telephoned, no siren sounds, no family group chat lights up at 3 a.m. — and the
 * entire price is a single vibration in the pocket of someone who was fine.
 *
 * That vibration has already been played by T0 (onEnterState 'PROBE' → the
 * 'probe' cue). This screen adds NO haptic of its own: doubling it would double
 * the only cost the design is spending, and a probe that buzzes twice is a probe
 * people switch off.
 *
 * ★ THE COUNTDOWN IS A DISPLAY, NOT A TIMER. ★
 * The 45 s belongs to T0 (t0/triggerRouter armSpecTimeouts, from the generated
 * spec). The interval below moves a ring; it can drift, it can be starved by a
 * busy JS thread, and none of that changes when the escalation fires. Silence is
 * an answer — the DEFAULT answer — because someone who cannot reach their phone
 * is exactly the person this whole product is for.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useKeepAwake } from 'expo-keep-awake';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '../src/i18n';
import { useKavach } from '../src/state/store';
import { TRANSITIONS, isActive } from '../src/t0/stateMachine.generated';
import { probeRespond as t0ProbeRespond } from '../src/t0/triggerRouter';
import { Button, CountdownRing } from '../src/ui/components';
import { colors, font, space, stateColor, weight } from '../src/ui/theme';

/**
 * Read from the generated spec rather than typed as 45. The screen and the state
 * machine must never be able to disagree about how long the subject has; if the
 * spec is regenerated with a different window, this number follows it.
 */
const PROBE_WINDOW_MS =
  (TRANSITIONS.find((tr) => tr.from === 'PROBE' && tr.on === 'PROBE_TIMEOUT')?.afterS ?? 45) * 1000;

/** Fast enough that the ring reads as motion, slow enough to cost nothing. */
const TICK_MS = 250;

export default function ProbeScreen() {
  // A question nobody can read is a question nobody answers. 45 s is longer than
  // most screen timeouts (PRD §6.4).
  useKeepAwake();
  const insets = useSafeAreaInsets();

  const t0State = useKavach((s) => s.t0State);
  const respond = useKavach((s) => s.probeRespond);
  /**
   * A PROBE raised on ANOTHER member's device and folded onto this one. Our own
   * probe has no incident row yet — T0 only creates the record when it enters
   * PENDING (t0/triggerRouter enterPending) — so this is null in the common case
   * and that is not a bug.
   */
  const remoteProbe = useKavach((s) => s.incidents.find((i) => i.state === 'PROBE') ?? null);

  const [now, setNow] = useState(() => Date.now());
  const enteredAt = useRef(Date.now());
  const dismissed = useRef(false);

  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(handle);
  }, []);

  // The screen is presented by the root layout at the instant the machine enters
  // PROBE, so mount time IS the entry time to within a frame. Re-anchoring on the
  // transition keeps that true if the screen was already up for some other reason.
  useEffect(() => {
    if (t0State === 'PROBE') enteredAt.current = Date.now();
  }, [t0State]);

  const dismiss = useCallback(() => {
    if (dismissed.current) return;
    dismissed.current = true;
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home');
  }, []);

  /**
   * Leave when there is no longer a question.
   *
   * The isActive() guard is the important half: PROBE → PENDING means the answer
   * was "help", and the root layout is at that moment replacing this screen with
   * the panic screen. Popping here as well would pop the panic screen with it.
   */
  useEffect(() => {
    if (t0State === 'PROBE') return;
    if (isActive(t0State)) return;
    if (remoteProbe !== null) return;
    dismiss();
  }, [t0State, remoteProbe, dismiss]);

  const answer = useCallback(
    (ok: boolean) => {
      if (t0State === 'PROBE') {
        // ★ Our own machine. T0 is holding the 45 s timer and no incident id, so
        //   the store's probeRespond has nothing to key on — going straight to
        //   the router is exactly what it does for an own-incident anyway, and it
        //   is the only call that clears the timer that is actually running.
        t0ProbeRespond(ok);
      } else if (remoteProbe !== null) {
        // Somebody else's probe: the store owns the fold and the durable log.
        void respond(remoteProbe.id, ok);
      } else {
        // The window closed while the phone was being picked up. Nothing to
        // answer; leaving is the only honest thing left to do.
        dismiss();
        return;
      }

      // "I'm fine" ends it here and the app goes back to whatever it was doing.
      // "I need help" does NOT wait out a countdown — T0 takes PROBE straight to
      // PENDING — so the root layout swaps this screen for the panic screen and
      // we must not pop underneath it.
      if (ok) dismiss();
    },
    [t0State, remoteProbe, respond, dismiss],
  );

  const remainingMs = Math.max(0, enteredAt.current + PROBE_WINDOW_MS - now);
  const seconds = Math.ceil(remainingMs / 1000);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.lg }]}>
      {/*
       * ★ THE QUESTION SCROLLS. THE ANSWERS NEVER DO. ★
       * The fixed content above the buttons is about 400 pt before insets — a
       * 34 pt question, a 17 pt body, a 168 pt ring and a line of consequence.
       * On a 320×568 handset, or at 150 % system font, that pushed both answers
       * off the bottom of a plain space-between column with no way to reach
       * them. A screen whose only job is to collect one of two answers became
       * unanswerable, and the answer silence gives is "escalate".
       *
       * So the reading matter goes in a ScrollView and the actions stay pinned
       * outside it, exactly as panic.tsx pins its footer.
       */}
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scrollBody}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.top}>
          {/* ONE question. Not a form, not a list of trigger types, not a map.
              Anything else on this screen is something to read before answering. */}
          <Text accessibilityRole="header" style={styles.question}>
            {t('probe.title')}
          </Text>
          <Text style={styles.body}>{t('probe.body')}</Text>
        </View>

        <View style={styles.middle}>
          <CountdownRing
            totalMs={PROBE_WINDOW_MS}
            remainingMs={remainingMs}
            size={168}
            colour={stateColor('PROBE')}
          />
          {/* Say out loud what silence means. A countdown with no stated
              consequence reads as a loading spinner (PRD §6.4). */}
          {/* Deliberately NOT a live region: this string changes every second,
              and a screen reader re-reading it every second would talk over the
              two answers it is trying to explain. */}
          <Text style={styles.consequence}>
            {seconds > 0
              ? `No answer in ${seconds}s and your family is alerted.`
              : 'Alerting your family now.'}
          </Text>
        </View>
      </ScrollView>

      {/* Bottom third, thumb-reachable one-handed (PRD §6.4). "I need help" is
          the lowest and largest control: a fumbled press escalates, which is the
          direction a safety product is allowed to fail in. */}
      <View style={styles.actions}>
        <Button
          label={t('probe.fine')}
          onPress={() => answer(true)}
          variant="ghost"
          size="lg"
          accessibilityLabel={`${t('probe.fine')}. ${t('state.IDLE')}`}
        />
        <Button
          label={t('probe.needHelp')}
          onPress={() => answer(false)}
          variant="danger"
          size="panic"
          accessibilityLabel={`${t('probe.needHelp')}. ${t('panic.sending')}`}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: space.lg,
  },
  flex: { flex: 1 },
  // flexGrow keeps the question and the ring spread apart on a tall phone and
  // lets them scroll on a short one, from the same rule.
  scrollBody: { flexGrow: 1, justifyContent: 'space-between', paddingBottom: space.lg },
  top: { gap: space.sm },
  question: {
    color: colors.text,
    fontSize: font.display,
    fontWeight: weight.heavy,
    textAlign: 'center',
  },
  body: {
    color: colors.textDim,
    fontSize: font.h3,
    textAlign: 'center',
  },
  middle: { alignItems: 'center', gap: space.lg },
  // ★ warnText, not warn. This line IS the screen's argument — it is the only
  // thing that turns a rotating ring into a stated consequence — and the fill
  // token rendered it at 3.25:1 on bg, under half of the 7:1 §6.4 requires.
  // warnText is 9.40:1. A consequence nobody can read is a countdown with no
  // consequence, which is the exact failure the comment above warns about.
  consequence: {
    color: colors.warnText,
    fontSize: font.body,
    fontWeight: weight.semibold,
    textAlign: 'center',
    paddingHorizontal: space.md,
  },
  actions: { gap: space.md },
});
