/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE INDICATOR — what the WATCHED person sees (6-D-7b · spec D2, D3, E3)
 *
 * ★ THIS IS NOT A NOTIFICATION. IT IS THE OTHER HALF OF THE FEATURE. ★
 * GLOSSARY.md: "every session is non-negotiably paired with the indicator: a
 * banner + status dot + start-sound on the watched device that cannot be
 * suppressed... Do not build one half without the other." D-029 records that
 * this was fixed by the user on 21 Aug and is not open to reinterpretation.
 *
 * So there is deliberately NO prop, NO setting and NO dismiss control on this
 * component. It renders from `watchSession.ts`'s live session and from nothing
 * else, it mounts in `app/_layout.tsx` above the navigator so no route can be
 * on top of it, and the only thing that removes it is the session actually
 * ending. The kill button on it is always available (D5, prior lock) — the
 * watched person can stop a session from any screen, at any moment, without
 * navigating anywhere.
 *
 * ★ D3: THE WORDING DOES NOT CHANGE WHEN THE CAMERA FLIPS ★
 * "{name} is viewing your camera" / "{name} is listening" are the two strings,
 * per D2/E3. Which lens is streaming is not in the sentence, deliberately — a
 * banner whose text changes under you invites the reading that the quiet
 * version is the safe one. Both come from i18n (NFR-020): the person whose
 * camera is on has to be able to READ the sentence, in their own language.
 *
 * ★ IT IS THE TOP OF THE WINDOW WHEN IT RENDERS ★
 * `_layout.tsx` mounts this FIRST, above `GlobalBars`, and this component
 * applies the status-bar inset itself. It used to sit second with no inset,
 * which put "{name} is viewing your camera" under the clock and battery icons
 * in exactly the common case — no incident, no degradation, nothing else to
 * eat the inset. GlobalBars skips its own top padding while this is live, so
 * the inset is paid once whichever strip is on top.
 *
 * ★ THE STOP BUTTON IS 48 dp TALL, BY CONSTRUCTION ★
 * D5's kill switch is the one control the watched person must hit from any
 * screen, in a hurry. `minHeight: MIN_TOUCH_TARGET` makes the visual box the
 * touch box; the slop is horizontal only, so it cannot swallow a press aimed
 * at the text beside it.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '../i18n';
import { useKavach, watchContextForUi } from '../state/store';
import {
  currentWatchSession,
  endWatchSession,
  subscribeWatchSession,
  type WatchSession,
} from '../state/watchSession';
import { playCue } from '../t0/alarm';
import { PressableScale } from './components';
import { colors, font, leading, MIN_TOUCH_TARGET, radius, space, weight } from './theme';

/** True while THIS phone is the one being watched, live. Shared with GlobalBars. */
export function useWatchedLive(): boolean {
  const [session, setSession] = useState<WatchSession | null>(() => currentWatchSession());
  useEffect(() => subscribeWatchSession(setSession), []);
  return session !== null && session.role === 'watched' && session.phase === 'live';
}

export function WatchIndicator(): React.ReactElement | null {
  const [session, setSession] = useState<WatchSession | null>(() => currentWatchSession());
  const members = useKavach((s) => s.members);
  useKavach((s) => s.locale);
  const insets = useSafeAreaInsets();
  // D2 pins the sound to the session OPENING, not to this component mounting —
  // a re-render must never re-play it, and a session that opened while this was
  // unmounted must still announce itself when it appears.
  const announced = useRef<string | null>(null);

  useEffect(() => subscribeWatchSession(setSession), []);

  const live = session !== null && session.role === 'watched' && session.phase === 'live';

  useEffect(() => {
    if (!live || session === null) return;
    if (announced.current === session.id) return;
    announced.current = session.id;
    playCue('watch');
  }, [live, session]);

  if (!live || session === null) return null;

  const peer = members.find((m) => m.id === session.peerMemberId);
  const name = peer?.displayName ?? t('watch.someone');
  const label =
    session.kind === 'camera' ? t('watch.viewingCamera', { name }) : t('watch.listening', { name });

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      style={[styles.bar, { paddingTop: insets.top + space.md }]}
    >
      {/* The dot. Red, filled, and next to the words rather than instead of them. */}
      <View style={styles.dot} />
      <Feather name={session.kind === 'camera' ? 'video' : 'mic'} size={font.h3} color={colors.dangerText} />
      <Text style={styles.label} numberOfLines={2}>
        {label}
      </Text>
      <PressableScale
        onPress={() => {
          const ctx = watchContextForUi();
          if (ctx !== null) void endWatchSession('watched', ctx);
        }}
        accessibilityRole="button"
        accessibilityLabel={t('watch.stopHint')}
        hitSlop={STOP_SLOP}
        style={styles.stop}
      >
        <Text style={styles.stopText}>{t('watch.stop')}</Text>
      </PressableScale>
    </View>
  );
}

/** Horizontal only: the box is already 48 dp tall (see the header). */
const STOP_SLOP = { top: 0, bottom: 0, left: space.sm, right: space.sm };

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    backgroundColor: colors.dangerSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.dangerBorder,
  },
  // Same geometry as the incident bar's dot in _layout.tsx: the two strips
  // stack, and two different dots on adjacent rows read as a mistake.
  dot: {
    width: space.md,
    height: space.md,
    borderRadius: space.md / 2,
    backgroundColor: colors.danger,
  },
  label: {
    flex: 1,
    color: colors.dangerText,
    fontSize: font.small,
    lineHeight: leading.small,
    fontWeight: weight.semibold,
  },
  stop: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.dangerText,
  },
  stopText: {
    color: colors.dangerText,
    fontSize: font.small,
    lineHeight: leading.small,
    fontWeight: weight.bold,
  },
});
