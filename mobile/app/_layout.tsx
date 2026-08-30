/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ROOT LAYOUT — the L0 floor.
 *
 * ★ IT ALWAYS RENDERS ITS CHILDREN. ★
 * There is deliberately no `if (!ready) return <Splash/>` in this file and there
 * must never be one. Hard rule 8 / PRD §11.1: the store commits locally, swallows
 * a corrupt database or a denied permission, and comes up READY regardless — so a
 * boot that is still in flight is a background fact, not a gate. A panic button
 * that has not rendered yet is a panic button that does not exist.
 *
 * Three things live here because NOTHING ELSE IS MOUNTED FOR EVERY ROUTE:
 *   · the degradation banner (§4.4) — the rung of the ladder we are actually on,
 *     stated honestly on every screen rather than discovered during an emergency;
 *   · the active-incident bar (PRD §12.1) — one tap back into the emergency from
 *     anywhere, because a family member who wandered into Settings must not have
 *     to remember how they got out;
 *   · the error boundary below, which is the only thing standing between a
 *     render-time throw and a white screen with no panic button on it.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { Feather } from '@expo/vector-icons';
import { useContext, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, usePathname, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  SafeAreaInsetsContext,
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { DEGRADATION_LABELS, DegradationLevel } from '../src/core/types';
import { t } from '../src/i18n';
import { countUnacked, lastKnownFix, useKavach } from '../src/state/store';
import { isActive } from '../src/t0/stateMachine.generated';
import { BigCoordinates, Button, Call112Button } from '../src/ui/components';
import { MIN_TOUCH_TARGET, colors, font, space, stateColor, weight } from '../src/ui/theme';

/** Routes that ARE the emergency; a bar pointing at them there is just noise. */
const INCIDENT_ROUTES = ['/panic', '/probe'];

export default function RootLayout() {
  // bootstrap() is idempotent inside the store (it memoises its own promise), so
  // a double mount of the root — which expo-router does do — cannot run two
  // migrations against one database.
  useEffect(() => {
    void useKavach.getState().bootstrap();
  }, []);

  return (
    <View style={styles.root}>
      {/* Dark theme only (hard rule 3): the status bar glyphs must be light. */}
      <StatusBar style="light" />

      <GlobalBars />
      <T0Presenter />

      {/*
       * ★ WHY A SECOND SafeAreaProvider AND NOT A CONTEXT OVERRIDE ★
       * GlobalBars sits IN FLOW and eats the top inset when it renders. Every
       * screen below also asks for the full top inset — home/map through
       * useSafeAreaInsets, incidents/consent/settings through <SafeAreaView
       * edges={['top']}> — and neither knows a sibling already consumed it, so
       * a dropped connection used to add a second 24–59 dp band of dead space
       * to every tab exactly when the UI matters most.
       *
       * Overriding SafeAreaInsetsContext with top:0 would fix only the hook
       * callers: <SafeAreaView> is a NATIVE view and never reads that context.
       * A nested provider measures where this subtree actually sits in the
       * window and republishes the truth, so both kinds of caller get the same
       * correct answer with no conditional to keep in sync. It seeds from the
       * parent's insets, so it never renders empty — hard rule 8 holds.
       */}
      <SafeAreaProvider style={styles.stackHost}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
            headerStyle: { backgroundColor: colors.bgElevated },
            headerTintColor: colors.text,
            headerTitleStyle: {
              color: colors.text,
              fontSize: font.h3,
              fontWeight: weight.semibold,
            },
            navigationBarColor: colors.bg,
          }}
        >
          <Stack.Screen name="index" options={{ animation: 'none' }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />

          {/*
           * ★★★ THE PANIC SCREEN ★★★
           * gestureEnabled:false is load-bearing, not styling. A screen that
           * reports "help is coming" and can be flicked away by a hand that is
           * shaking, or by a phone tumbling in a pocket, is worse than no screen
           * at all — it removes the cancel control and the coordinates at the
           * exact moment both are needed. animation:'none' for the same reason:
           * PRD §6.4 forbids motion during an emergency, and a 350 ms slide is
           * 350 ms of a screen that is not yet readable.
           */}
          <Stack.Screen
            name="panic"
            options={{
              presentation: 'fullScreenModal',
              gestureEnabled: false,
              headerShown: false,
              animation: 'none',
            }}
            dangerouslySingular
          />

          {/*
           * PROBE (P-002). Same lock for a different reason: a question that can
           * be swiped away is a question that gets answered by accident, and the
           * default answer here is "escalate".
           */}
          <Stack.Screen
            name="probe"
            options={{
              presentation: 'fullScreenModal',
              gestureEnabled: false,
              headerShown: false,
              animation: 'none',
            }}
            dangerouslySingular
          />

          {/*
           * ★ ONE HEADER PER SCREEN ★
           * These routes each draw their own title and their own way back. A
           * native header on top of that gave the user "Diagnostics" twice, a
           * system arrow beside a custom chevron, and — worst — a dark chrome
           * bar sitting on the medical card, which is meant to read as a
           * printed object a stranger picks up, not as a page in an app.
           *
           * The in-screen header wins because an emergency surface has to own
           * its whole frame. Each of these screens applies its own top inset;
           * that is the condition for dropping the native bar, not a detail.
           */}
          <Stack.Screen name="incident/[id]" options={{ title: 'Incident' }} />
          <Stack.Screen
            name="medical-card"
            options={{ presentation: 'fullScreenModal', title: t('medical.title') }}
          />
          <Stack.Screen name="diagnostics" options={{ title: t('diag.title') }} />
          <Stack.Screen name="vault" options={{ title: 'Documents' }} />
          <Stack.Screen name="screen-time" options={{ title: 'Screen time' }} />

          {/* NOTE: journeys and drills still draw two headers. They render their own
              but apply NO top inset, so removing the native bar here would push
              their titles under the status bar. The line to delete is this one —
              once each screen adds `insets.top` it joins the block above. */}
          <Stack.Screen name="journeys" options={{ headerShown: true, title: 'Journeys' }} />
          <Stack.Screen name="drills" options={{ headerShown: true, title: 'Drills' }} />
          {/* Consent left the tab bar in the Phase-6 nav (Spec B1 / 6.7). It is
              reached from Settings > Privacy now; a native header gives the way
              back a tab never needed. */}
          <Stack.Screen name="consent" options={{ headerShown: true, title: t('tab.consent') }} />
          {/* Spec E1 — name/size a family. Reached from Settings; native header. */}
          <Stack.Screen name="create-family" options={{ headerShown: true, title: t('family.createTitle') }} />

          {/* Enrolment owns the whole screen and cannot be escaped sideways —
              a half-enrolled device has no keys and cannot raise an alarm. */}
          <Stack.Screen
            name="onboarding"
            options={{ headerShown: false, gestureEnabled: false, animation: 'none' }}
          />
        </Stack>
      </SafeAreaProvider>
    </View>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ★★★ THE LAST FLOOR — what is left when the app itself throws ★★★
 *
 * expo-router wraps the root route in this the moment any render below it
 * throws. Before it existed, one bad index into a Record — `DEGRADATION_LABELS`
 * keyed by a value off a persisted row, `stateColor` on a state that arrived
 * from the network, `STATE_CUE` on the panic screen — took the whole navigator
 * down and left a release build showing nothing at all. On this product a white
 * screen on /panic is the total failure: no panic button, no coordinates, no way
 * back, and the person holding the phone has no idea any of that is true.
 *
 * So this screen is not an apology. It is the L0 floor, rendered from things
 * that cannot depend on the render that just failed:
 *   · CALL 112, which is a dialler hand-off and needs nothing from this app;
 *   · the last coordinates T0 cached, read from a plain module variable rather
 *     than through the store's React bindings;
 *   · one button back in.
 *
 * Everything here is defensive on purpose. A boundary that throws is a crash
 * with extra steps.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const [retrying, setRetrying] = useState(false);
  // Through the context, not useSafeAreaInsets(): the hook THROWS when no
  // provider is mounted, and a boundary that throws is a crash with extra steps.
  const insets = useContext(SafeAreaInsetsContext);

  // Never through useKavach(): subscribing here would re-run the boundary on
  // every store change, and the store is a plausible source of the throw.
  let fix: { lat: number; lon: number; accuracyM: number } | null = null;
  try {
    const cached = lastKnownFix();
    if (cached !== null && Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) {
      fix = { lat: cached.lat, lon: cached.lon, accuracyM: cached.accuracyM };
    }
  } catch {
    /* the store module itself is unusable; 112 below still works */
  }

  return (
    <View style={styles.crashRoot}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={[
          styles.crashBody,
          {
            paddingTop: (insets?.top ?? 0) + space.xl,
            paddingBottom: (insets?.bottom ?? 0) + space.xxxl,
          },
        ]}
      >
        <Text accessibilityRole="header" style={styles.crashTitle}>
          Kavach stopped
        </Text>
        <Text style={styles.crashBody1}>
          Something in the app broke. Nothing you did caused it. If you need help right now, use
          the button below — it dials 112 through your phone, not through Kavach.
        </Text>

        <Call112Button />

        {fix === null ? (
          <Text style={styles.crashDim}>
            This phone has no saved position to show you. Say where you are out loud instead.
          </Text>
        ) : (
          <>
            <Text style={styles.crashDim}>
              The last place this phone knew it was. Read these numbers out.
            </Text>
            <BigCoordinates lat={fix.lat} lon={fix.lon} accuracyM={fix.accuracyM} />
          </>
        )}

        <Button
          label={retrying ? 'Starting…' : 'Try again'}
          variant="primary"
          size="lg"
          disabled={retrying}
          accessibilityLabel="Try to open Kavach again"
          onPress={() => {
            setRetrying(true);
            // retry() rejecting must not throw out of the boundary — that would
            // unmount the only working 112 button on screen.
            void Promise.resolve(retry())
              .catch(() => undefined)
              .finally(() => setRetrying(false));
          }}
        />

        <Text style={styles.crashDim}>
          If it stops again, close Kavach completely and open it. Your PINs, your medical card and
          your family are stored on this phone and are not affected.
        </Text>

        {/* Last, smallest, and in the developer's words rather than the user's:
            it is the one line that makes a bug report actionable. */}
        <Text style={styles.crashTrace} selectable>
          {String(error?.message ?? error ?? 'unknown error')}
        </Text>
      </ScrollView>
    </View>
  );
}

/**
 * ★ SENSOR-DRIVEN SCREENS (P-002, PRD §7.5) ★
 *
 * A PROBE and a cancel window are opened by a fall, not by a press, so no screen
 * is in a position to navigate to them — by definition nobody is holding the
 * phone. The root is the only component mounted for every route, so it does it.
 *
 * This component renders nothing: keeping it a sibling of <Stack> means a T0
 * state change re-renders eleven lines of effect instead of the whole navigator.
 */
function T0Presenter(): null {
  const t0State = useKavach((s) => s.t0State);
  const pathname = usePathname();
  /** The route this presenter last opened, so a manual exit is not undone. */
  const opened = useRef<string | null>(null);

  useEffect(() => {
    const target = t0State === 'PROBE' ? '/probe' : isActive(t0State) ? '/panic' : null;

    if (target === null) {
      opened.current = null;
      return;
    }
    if (opened.current === target) return;

    const from = opened.current;
    opened.current = target;
    if (pathname === target) return;

    // ★ PROBE → PENDING must SWAP, never stack. Leaving an answered question
    //   mounted underneath the panic screen means it reappears the moment the
    //   emergency is closed, asking about something that already happened.
    if (from === '/probe' && pathname === '/probe') router.replace(target);
    else router.push(target);
  }, [t0State, pathname]);

  return null;
}

/**
 * The two strips that outrank every screen.
 *
 * They sit IN FLOW above the navigator rather than floating over it: an overlay
 * would eventually cover somebody's cancel button, and PRD §6.4 does not permit
 * a control to be occluded by chrome. The cost is a little vertical space, which
 * is the correct thing to spend it on.
 */
function GlobalBars() {
  const insets = useSafeAreaInsets();
  const pathname = usePathname();

  const degradation = useKavach((s) => s.degradation);
  // activeIncident tracks OUR machine; the find() also catches a relative's
  // emergency that was folded onto this device from the network (store.applyEvent).
  const incident = useKavach((s) => s.activeIncident ?? s.incidents.find((i) => isActive(i.state)) ?? null);
  const members = useKavach((s) => s.members);
  const unacked = useKavach((s) => countUnacked(s));

  // §4.4: at SMS_ONLY and below, capability the user assumes they have is gone.
  // Above it the ladder is a detail; here it changes what will actually happen.
  const showDegraded = degradation <= DegradationLevel.SMS_ONLY;
  const showIncident = incident !== null && !INCIDENT_ROUTES.includes(pathname) && !pathname.startsWith('/incident/');

  if (!showDegraded && !showIncident) return null;

  const subject = incident ? members.find((m) => m.id === incident.subjectMemberId) : undefined;
  const stateLabel = incident ? t(`state.${incident.state}`) : '';
  const headline = unacked > 0 ? t('panic.nobodyResponded') : stateLabel;

  return (
    <View style={[styles.bars, { paddingTop: insets.top }]}>
      {showDegraded ? (
        <Pressable
          onPress={() => router.push('/diagnostics')}
          accessibilityRole="button"
          accessibilityLabel={`${DEGRADATION_LABELS[degradation]}. ${degradedDetail(degradation)} ${t('diag.run')}`}
          style={({ pressed }) => [styles.degradedBar, pressed ? styles.pressed : null]}
        >
          {/* warnText, not warn: the fill token measures 2.68:1 on warnSoft and was
              the least visible thing on this corner-of-the-eye bar; warnText is
              7.75:1. The bar's borderBottomColor stays the fill — a 2 dp edge,
              not an icon. */}
          <Feather name="alert-triangle" size={font.h2} color={colors.warnText} />
          <View style={styles.barText}>
            <Text style={styles.barTitle} numberOfLines={1}>
              {DEGRADATION_LABELS[degradation]}
            </Text>
            <Text style={styles.barSub} numberOfLines={2}>
              {degradedDetail(degradation)}
            </Text>
          </View>
          <Text style={styles.chevron} allowFontScaling={false}>
            ›
          </Text>
        </Pressable>
      ) : null}

      {showIncident && incident !== null ? (
        <Pressable
          onPress={() => {
            // Our own live incident belongs on the panic screen, which carries the
            // cancel control. Somebody else's belongs on the responder timeline.
            const mine = useKavach.getState().me?.id;
            if (mine !== undefined && incident.subjectMemberId === mine) router.push('/panic');
            else router.push(`/incident/${incident.id}`);
          }}
          accessibilityRole="button"
          accessibilityLabel={`${t('home.activeIncident')}. ${subject?.displayName ?? ''} ${headline}`}
          style={({ pressed }) => [styles.incidentBar, pressed ? styles.pressed : null]}
        >
          {/* Never colour alone (PRD §6.4): the dot repeats what the two lines
              of text already say, it does not carry the meaning by itself. */}
          <View style={[styles.dot, { backgroundColor: stateColor(incident.state) }]} />
          <View style={styles.barText}>
            <Text style={styles.incidentTitle} numberOfLines={1}>
              {subject ? `${subject.displayName} — ${t('home.activeIncident')}` : t('home.activeIncident')}
            </Text>
            <Text style={styles.incidentSub} numberOfLines={2}>
              {headline}
            </Text>
          </View>
          <Text style={styles.chevron} allowFontScaling={false}>
            ›
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * What the rung actually costs the user, in a sentence.
 * DEGRADATION_LABELS names the rung; a name alone ("Peer only") tells a parent
 * nothing about whether their child's phone can still reach them.
 */
function degradedDetail(level: DegradationLevel): string {
  switch (level) {
    case DegradationLevel.ZERO_INFRA:
      return 'No network at all. The alarm still sounds on this phone.';
    case DegradationLevel.PEER_ONLY:
      return 'No network. Family devices nearby can still relay.';
    case DegradationLevel.SMS_ONLY:
      return 'Data is down. Emergencies will go out by SMS.';
    default:
      return 'Connection limited.';
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  stackHost: { flex: 1 },
  bars: { backgroundColor: colors.bg },

  degradedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: colors.warnSoft,
    borderBottomWidth: 2,
    borderBottomColor: colors.warn,
  },
  incidentBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: colors.dangerSoft,
    borderBottomWidth: 2,
    borderBottomColor: colors.danger,
  },
  pressed: { opacity: 0.72 },

  barText: { flex: 1 },
  barTitle: { color: colors.text, fontSize: font.small, fontWeight: weight.bold },
  barSub: { color: colors.textDim, fontSize: font.tiny, marginTop: space.xxs },
  incidentTitle: { color: colors.text, fontSize: font.body, fontWeight: weight.bold },
  incidentSub: { color: colors.text, fontSize: font.small, fontWeight: weight.semibold, marginTop: space.xxs },

  dot: { width: 12, height: 12, borderRadius: 6 },
  chevron: { color: colors.textDim, fontSize: font.h2, fontWeight: weight.bold },

  crashRoot: { flex: 1, backgroundColor: colors.bg },
  crashBody: { paddingHorizontal: space.lg, gap: space.lg },
  crashTitle: { color: colors.text, fontSize: font.h1, fontWeight: weight.bold },
  crashBody1: { color: colors.text, fontSize: font.body, lineHeight: font.body + 7 },
  crashDim: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 6 },
  crashTrace: { color: colors.textFaint, fontSize: font.tiny, fontFamily: font.mono },
});
