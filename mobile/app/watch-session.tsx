/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LIVE VIEW — the VIEWER's screen (6-D-7b · spec D1, D3, D4, E1, E2)
 *
 * D1: opened with no intermediate dialog. `watch.tsx` starts the session and
 * pushes straight here, so the only thing between the tap and this screen is a
 * navigation. What this screen must NOT do is pretend: until the watched phone
 * has accepted and a track has arrived, it says which of those it is waiting
 * for, rather than showing a black rectangle that could equally mean "connecting"
 * or "they said no".
 *
 * D3: the flip control is HERE, on the viewer's side, because the spec's whole
 * point is that the watched person does nothing mid-session. It sends a request;
 * `watchSession.ts` relays it and `watchMedia.ts` acts on it over there.
 *
 * E2: a Listen session carries a 5:00 countdown ring around End, with "+5 min"
 * beside it. A camera session has no timer at all (D4), so the ring is simply
 * absent rather than shown full — a ring that never moves is a lie about a
 * deadline that does not exist.
 *
 * ★ NOTHING HERE HAS BEEN SEEN RUNNING ★
 * `RTCView` needs the native module, which needs a device build (D-021). Every
 * state below is reachable in principle and none has been observed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { RTCView } from 'react-native-webrtc';

import { useKavach, watchContextForUi } from '../src/state/store';
import { subscribeRemoteStream, turnConfigured } from '../src/state/watchMedia';
import {
  LISTEN_EXTEND_MS,
  currentWatchSession,
  endWatchSession,
  extendWatchSession,
  flipWatchCamera,
  subscribeWatchSession,
  type WatchSession,
} from '../src/state/watchSession';
import { Button, CountdownRing, PressableScale } from '../src/ui/components';
import { colors, font, leading, radius, space, weight } from '../src/ui/theme';

/** Ticks the countdown. 250 ms so the ring moves smoothly without a frame loop. */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export default function WatchSessionScreen(): React.ReactElement {
  const [session, setSession] = useState<WatchSession | null>(() => currentWatchSession());
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const members = useKavach((s) => s.members);

  useEffect(() => subscribeWatchSession(setSession), []);
  useEffect(() => subscribeRemoteStream(setStreamUrl), []);

  const isCamera = session?.kind === 'camera';
  const now = useTick(session?.phase === 'live' && session.expiresAt !== null);

  const peer = useMemo(
    () => members.find((m) => m.id === session?.peerMemberId),
    [members, session?.peerMemberId],
  );
  const name = peer?.displayName ?? 'Your family member';

  // D4/E2: when the session ends — by either party, or by the clock — this
  // screen closes itself. The acceptance criterion is "closes both sides'
  // screens within 1s"; there is nothing to wait for, so it goes immediately.
  useEffect(() => {
    if (session === null || session.phase !== 'ended') return;
    const id = setTimeout(() => {
      if (router.canGoBack()) router.back();
      else router.replace('/watch');
    }, 900);
    return () => clearTimeout(id);
  }, [session]);

  function onEnd(): void {
    const ctx = watchContextForUi();
    if (ctx !== null) void endWatchSession('viewer', ctx);
    else if (router.canGoBack()) router.back();
  }

  if (session === null) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.centre}>
          <Text style={styles.heading}>No session is open.</Text>
          <Text style={styles.body}>Nothing is being watched right now.</Text>
          <Button label="Back" onPress={() => router.replace('/watch')} />
        </View>
      </SafeAreaView>
    );
  }

  const ended = session.phase === 'ended';
  const waiting = session.phase === 'inviting';
  const remainingMs = session.expiresAt === null ? null : Math.max(0, session.expiresAt - now);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.heading} numberOfLines={1}>
          {isCamera ? `${name}'s camera` : `Listening to ${name}`}
        </Text>
        <Text style={styles.sub}>
          {/* D2, stated to the VIEWER too: this is not a covert feature, and the
              person watching should know the other phone is announcing it. */}
          {ended
            ? 'Session ended.'
            : `${name}'s phone is showing a banner and made a sound. They can stop this at any time.`}
        </Text>
      </View>

      <View style={styles.stage}>
        {streamUrl !== null && isCamera ? (
          <RTCView streamURL={streamUrl} objectFit="contain" style={styles.video} />
        ) : (
          <View style={styles.placeholder}>
            <Feather
              name={ended ? 'x-circle' : isCamera ? 'video' : 'headphones'}
              size={40}
              color={colors.textFaint}
            />
            <Text style={styles.placeholderText}>
              {ended
                ? session.declinedReason ?? endedLine(session, name)
                : waiting
                  ? `Asking ${name}'s phone…`
                  : streamUrl === null
                    ? 'Connected. Waiting for the first frame…'
                    : `Listening. There is nothing to see — audio only.`}
            </Text>
            {waiting && !turnConfigured() ? (
              <Text style={styles.caveat}>
                No relay is configured, so this only connects if both phones are reachable to each
                other. Across mobile networks it may not.
              </Text>
            ) : null}
          </View>
        )}
      </View>

      <View style={styles.controls}>
        {/* D3 — viewer-side flip, camera sessions only. */}
        {isCamera ? (
          <PressableScale
            onPress={() => {
              const ctx = watchContextForUi();
              if (ctx !== null) flipWatchCamera(ctx);
            }}
            disabled={session.phase !== 'live'}
            accessibilityRole="button"
            accessibilityLabel={
              session.facing === 'back' ? 'Switch to their front camera' : 'Switch to their back camera'
            }
            hitSlop={space.sm}
            style={[styles.roundButton, session.phase !== 'live' && styles.roundButtonOff]}
          >
            <Feather
              name="refresh-ccw"
              size={20}
              color={session.phase === 'live' ? colors.text : colors.textFaint}
            />
          </PressableScale>
        ) : null}

        {/* E2 — the ring wraps End, and only exists when there is a deadline. */}
        <View style={styles.endWrap}>
          {remainingMs !== null ? (
            <View style={styles.ring} pointerEvents="none">
              <CountdownRing
                totalMs={LISTEN_EXTEND_MS}
                remainingMs={remainingMs}
                size={96}
                colour={colors.accent}
              />
            </View>
          ) : null}
          <PressableScale
            onPress={onEnd}
            accessibilityRole="button"
            accessibilityLabel="End this session"
            style={styles.endButton}
          >
            <Text style={styles.endText}>End</Text>
          </PressableScale>
        </View>

        {/* E2 — "+5 min", repeatable with no cap. */}
        {remainingMs !== null ? (
          <PressableScale
            onPress={() => {
              const ctx = watchContextForUi();
              if (ctx !== null) extendWatchSession(ctx);
            }}
            disabled={session.phase !== 'live'}
            accessibilityRole="button"
            accessibilityLabel="Add five more minutes"
            hitSlop={space.sm}
            style={[styles.roundButton, session.phase !== 'live' && styles.roundButtonOff]}
          >
            <Text style={styles.plusText}>+5</Text>
          </PressableScale>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

/** Says WHO ended it. "Session ended" alone leaves the viewer guessing whether they were refused. */
function endedLine(session: WatchSession, name: string): string {
  switch (session.endedBy) {
    case 'watched':
      return `${name} ended this.`;
    case 'timeout':
      return 'The five minutes ran out.';
    case 'viewer':
      return 'You ended this.';
    default:
      return 'Session ended.';
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.lg },

  header: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.xxs },
  heading: { color: colors.text, fontSize: font.h2, fontWeight: weight.bold },
  sub: { color: colors.textDim, fontSize: font.small, lineHeight: leading.small },
  body: { color: colors.text, fontSize: font.body, lineHeight: leading.body, textAlign: 'center' },

  stage: {
    flex: 1,
    margin: space.lg,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  video: { flex: 1, backgroundColor: '#000' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.lg },
  placeholderText: {
    color: colors.textDim,
    fontSize: font.body,
    lineHeight: leading.body,
    textAlign: 'center',
  },
  caveat: {
    color: colors.textFaint,
    fontSize: font.tiny,
    lineHeight: leading.tiny + 3,
    textAlign: 'center',
  },

  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xl,
    paddingBottom: space.xl,
    paddingHorizontal: space.lg,
  },
  roundButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundButtonOff: { borderColor: colors.border },
  plusText: { color: colors.text, fontSize: font.body, fontWeight: weight.bold },

  endWrap: { width: 96, height: 96, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', top: 0, left: 0 },
  endButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endText: { color: '#FFFFFF', fontSize: font.body, fontWeight: weight.bold },
});
