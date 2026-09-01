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
 * version is the safe one.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { useKavach, watchContextForUi } from '../state/store';
import {
  currentWatchSession,
  endWatchSession,
  subscribeWatchSession,
  type WatchSession,
} from '../state/watchSession';
import { playCue } from '../t0/alarm';
import { PressableScale } from './components';
import { colors, font, leading, radius, space, weight } from './theme';

export function WatchIndicator(): React.ReactElement | null {
  const [session, setSession] = useState<WatchSession | null>(() => currentWatchSession());
  const members = useKavach((s) => s.members);
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
  const name = peer?.displayName ?? 'Someone in your family';
  const label =
    session.kind === 'camera' ? `${name} is viewing your camera` : `${name} is listening`;

  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.bar}>
      {/* The dot. Red, filled, and next to the words rather than instead of them. */}
      <View style={styles.dot} />
      <Feather name={session.kind === 'camera' ? 'video' : 'mic'} size={16} color={colors.dangerText} />
      <Text style={styles.label} numberOfLines={2}>
        {label}
      </Text>
      <PressableScale
        onPress={() => {
          const ctx = watchContextForUi();
          if (ctx !== null) void endWatchSession('watched', ctx);
        }}
        accessibilityRole="button"
        accessibilityLabel="Stop this now"
        hitSlop={space.sm}
        style={styles.stop}
      >
        <Text style={styles.stopText}>Stop</Text>
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: colors.dangerSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.dangerBorder,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
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
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.dangerText,
  },
  stopText: {
    color: colors.dangerText,
    fontSize: font.small,
    fontWeight: weight.bold,
  },
});
