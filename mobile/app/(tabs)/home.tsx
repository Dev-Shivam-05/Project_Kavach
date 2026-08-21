/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DASHBOARD 1 — the screen this family opens every day (PRD §16.3).
 *
 * ★★★ THE YELLOW LINE ★★★
 * PRD §16.3, on a family member's agent being silently dead for nineteen hours:
 *   "that single line is worth more than every other metric in the system
 *    combined."
 * So it is rendered as a full-width, warn-toned, NON-DISMISSABLE card directly
 * under the status header, above the family list, above the quick actions, and
 * it carries the probable cause ("LIKELY OEM KILL") rather than a neutral
 * "offline". There is deliberately no close button and no snooze: the only way to
 * make it go away is to fix the phone, which is the entire point.
 *
 * ★ WHY THE HEADER IS NOT ALWAYS "EVERYONE IS OKAY" ★
 * A dashboard that says everything is fine while one agent has been dark for
 * nineteen hours has taught the family to ignore it (F-02). The header states
 * exactly what is known: an active emergency, or agents not reporting, or —
 * only when both are absent — t('home.everyoneOk').
 *
 * ★ P-062 — "an app that is only opened during emergencies will be uninstalled
 *   before the first emergency." ★ Hence journeys with live ETAs, recent
 *   check-ins, the fixed-node roll call, home sensor events and the drill clock:
 *   ordinary, useful, boring information that earns the icon on the home screen
 *   during the 364 days nothing happens.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { CONFIG } from '../../src/core/config';
import {
  DEGRADATION_LABELS,
  DegradationLevel,
  type Device,
  type HaSafetyEvent,
  type Incident,
  type Journey,
  type Member,
  type UUID,
} from '../../src/core/types';
import { relativeTime, t } from '../../src/i18n';
import { useKavach } from '../../src/state/store';
import { isActive } from '../../src/t0/stateMachine.generated';
import {
  Button,
  Card,
  EmptyState,
  FamilyIdentity,
  ListItem,
  MemberRow,
  Pill,
  PressableScale,
  Section,
  StateBadge,
} from '../../src/ui/components';
import { NO_MOTION } from '../../src/ui/motion';
import {
  MIN_TOUCH_TARGET,
  colors,
  font,
  leading,
  radius,
  space,
  tracking,
  weight,
} from '../../src/ui/theme';

/** Presets, not a free-text minute field: a number pad in the rain is a bad ask. */
const ETA_CHOICES = [10, 20, 30, 45, 60, 90] as const;
/** A check-in older than this is history, not "recent". */
const RECENT_CHECKIN_MS = 12 * 60 * 60_000;
/** Home-sensor events are a today surface; anything older belongs to a log. */
const HOME_EVENT_WINDOW_MS = 24 * 60 * 60_000;
const LOW_BATTERY_PCT = 20;

// ═══════════════════════════════════════════════════════════════════════════════
// Derived facts
// ═══════════════════════════════════════════════════════════════════════════════

interface SilentAgent {
  member: Member;
  device: Device;
  /** null = this device has never reported at all. */
  hours: number | null;
  /** The OEM-kill fingerprint: the agent was never exempted from doze. */
  batteryOptimisationExempt: boolean;
  backgroundRestricted: boolean;
}

/** Re-renders the relative timestamps without touching the store. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function degradationTone(level: DegradationLevel): 'ok' | 'info' | 'warn' | 'danger' {
  if (level === DegradationLevel.FULL) return 'ok';
  if (level === DegradationLevel.ZERO_INFRA) return 'danger';
  if (level <= DegradationLevel.SMS_ONLY) return 'warn';
  return 'info';
}

/** Future-facing counterpart to relativeTime(), which only speaks about the past. */
function etaText(etaAt: number | null, now: number): string {
  if (etaAt === null) return 'No ETA set';
  const minutes = Math.round((etaAt - now) / 60_000);
  if (minutes > 0) return `ETA in ${minutes} min`;
  if (minutes === 0) return 'ETA now';
  return `${Math.abs(minutes)} min overdue`;
}

function homeEventGlyph(kind: HaSafetyEvent['kind']): string {
  switch (kind) {
    case 'smoke':
      return '≋';
    case 'gas':
      return '◇';
    case 'water':
      return '≈';
    case 'door':
      return '⌂';
    case 'lock':
      return '⚿';
    case 'motion':
      return '↗';
    default:
      return '•';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════

export default function HomeScreen(): React.ReactElement {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const now = useNow(60_000);

  // One selector per field: zustand v5 compares by reference, and a selector that
  // builds an object would re-render this screen on every store write.
  const familyId = useKavach((s) => s.familyId);
  const familyName = useKavach((s) => s.familyName);
  const bootstrap = useKavach((s) => s.bootstrap);
  const ready = useKavach((s) => s.ready);
  const me = useKavach((s) => s.me);
  const members = useKavach((s) => s.members);
  const devices = useKavach((s) => s.devices);
  const presence = useKavach((s) => s.presence);
  const incidents = useKavach((s) => s.incidents);
  const journeys = useKavach((s) => s.journeys);
  const drills = useKavach((s) => s.drills);
  const haEvents = useKavach((s) => s.haEvents);
  const degradation = useKavach((s) => s.degradation);
  const outboxDepth = useKavach((s) => s.outboxDepth);
  // Not read directly — subscribing makes every t() on this screen re-render when
  // the member changes language (i18n keeps the locale in module scope).
  useKavach((s) => s.locale);

  const checkIn = useKavach((s) => s.checkIn);
  const findPhone = useKavach((s) => s.findPhone);
  const startJourney = useKavach((s) => s.startJourney);
  const arriveJourney = useKavach((s) => s.arriveJourney);
  const startDrill = useKavach((s) => s.startDrill);

  const [ringOpen, setRingOpen] = useState(false);
  const [journeyOpen, setJourneyOpen] = useState(false);

  // bootstrap() is idempotent by construction (see store.bootstrap) — calling it
  // here means this tab shows real data even if it is the first surface mounted.
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const nameOf = useCallback(
    (id: UUID): string => members.find((m) => m.id === id)?.displayName ?? 'Unknown',
    [members],
  );

  const liveIncidents = useMemo<Incident[]>(
    () => incidents.filter((i) => isActive(i.state)),
    [incidents],
  );

  /**
   * ★ The yellow line's input set.
   *
   * Excluded on purpose:
   *  · this device — it is demonstrably alive, it is drawing this screen;
   *  · 'ha' and 'node' platforms — a mains-powered bridge or a repurposed handset
   *    bolted to a wall is a facilities problem, not a person's agent, and mixing
   *    the two dilutes the one line that matters;
   *  · anyone who PAUSED monitoring (P-066) — a right exercised is not a fault,
   *    and alarming about it is how the family learns to ignore both.
   */
  const silentAgents = useMemo<SilentAgent[]>(() => {
    const out: SilentAgent[] = [];
    for (const device of devices) {
      if (device.platform === 'ha' || device.platform === 'node') continue;
      const member = members.find((m) => m.id === device.memberId);
      if (!member) continue;
      if (me && member.id === me.id) continue;
      if (presence[member.id]?.monitoringPaused) continue;

      const lastBeat = device.lastHeartbeatAt ?? presence[member.id]?.lastSeenAt ?? null;
      const silentMs = lastBeat === null ? Number.POSITIVE_INFINITY : now - lastBeat;
      if (silentMs <= CONFIG.agentSilentAlertMs) continue;

      out.push({
        member,
        device,
        hours: lastBeat === null ? null : silentMs / 3_600_000,
        batteryOptimisationExempt: device.diagnostics.batteryOptimisationExempt,
        backgroundRestricted: !device.diagnostics.notBackgroundRestricted,
      });
    }
    return out.sort((a, b) => (b.hours ?? Number.MAX_SAFE_INTEGER) - (a.hours ?? Number.MAX_SAFE_INTEGER));
  }, [devices, members, presence, me, now]);

  const activeJourneys = useMemo<Journey[]>(
    () => journeys.filter((j) => j.state === 'active').sort((a, b) => (a.etaAt ?? 0) - (b.etaAt ?? 0)),
    [journeys],
  );

  const recentCheckIns = useMemo(
    () =>
      members
        .map((m) => ({ member: m, at: presence[m.id]?.lastSeenAt ?? null }))
        .filter((r): r is { member: Member; at: number } => r.at !== null && now - r.at <= RECENT_CHECKIN_MS)
        .sort((a, b) => b.at - a.at)
        .slice(0, 4),
    [members, presence, now],
  );

  const todaysHomeEvents = useMemo(
    () => haEvents.filter((e) => now - e.at <= HOME_EVENT_WINDOW_MS).sort((a, b) => b.at - a.at).slice(0, 3),
    [haEvents, now],
  );

  const phones = useMemo(
    () => devices.filter((d) => d.platform === 'android' || d.platform === 'ios'),
    [devices],
  );

  const nodes = useMemo(() => devices.filter((d) => d.platform === 'node'), [devices]);
  const nodesOnline = nodes.filter((d) => d.agentHealthy).length;

  const agentsReporting = useMemo(
    () => phones.filter((d) => d.lastHeartbeatAt !== null && now - d.lastHeartbeatAt <= CONFIG.agentSilentAlertMs).length,
    [phones, now],
  );

  const lowBattery = useMemo(
    () => members.filter((m) => (presence[m.id]?.batteryPct ?? 100) <= LOW_BATTERY_PCT),
    [members, presence],
  );

  const lastDrillAt = useMemo(() => {
    const family = drills.filter((d) => d.kind !== 'canary');
    return family.length === 0 ? null : Math.max(...family.map((d) => d.startedAt));
  }, [drills]);

  // ── actions ─────────────────────────────────────────────────────────────────

  const handleCheckIn = useCallback(() => {
    void checkIn();
  }, [checkIn]);

  /**
   * ★ THE CONFIRMATION MAY NOT CLAIM THE PHONE IS RINGING ★
   * `store.findPhone` writes the access-log row locally and then fires the
   * control-plane POST fire-and-forget, discarding the result. On a device with
   * no auth token that POST fails and NOTHING leaves this phone — so the old
   * copy, "it will sound as soon as the phone receives the request", told a
   * parent their child's handset was ringing when it was not. The two things
   * this screen can actually stand behind are that the request was made and that
   * the log row exists, so those are the two things it says. The await is what
   * makes the second one true at the moment it is read.
   *
   * The staleness line is the honest half the UI *does* know: a handset that has
   * not sent a heartbeat for hours will not ring, and saying so beats letting
   * someone stand in a doorway waiting for a sound that is not coming.
   */
  const handleRing = useCallback(
    (device: Device) => {
      setRingOpen(false);
      const name = nameOf(device.memberId);
      const silentMs = device.lastHeartbeatAt === null ? null : now - device.lastHeartbeatAt;
      const stale = silentMs === null || silentMs > CONFIG.agentSilentAlertMs;
      void (async () => {
        await findPhone(device.id);
        Alert.alert(
          `Asked ${name}'s phone to ring`,
          [
            'It rings at full volume when the request reaches it, even if the phone is silenced.',
            stale
              ? silentMs === null
                ? `That phone has never reported to this one, so it may not ring at all.`
                : `That phone has been quiet for ${Math.round(silentMs / 3_600_000)}h, so it may not ring until it is back.`
              : null,
            // Ringing someone's phone is consent-bearing and writes an access-log
            // row (PRD §10.6). Saying so is the difference between a feature and
            // spyware.
            `${name} sees this in their access log either way.`,
          ]
            .filter((line): line is string => line !== null)
            .join(' '),
          [{ text: t('common.done') }],
        );
      })();
    },
    [findPhone, nameOf, now],
  );

  const handleStartJourney = useCallback(
    (destName: string, etaMinutes: number) => {
      setJourneyOpen(false);
      void startJourney({ label: `Heading to ${destName}`, destName, etaMinutes });
    },
    [startJourney],
  );

  const handleArrive = useCallback(
    (journey: Journey) => {
      void arriveJourney(journey.id);
    },
    [arriveJourney],
  );

  /**
   * A quarterly drill notifies the whole family and opens a real incident
   * (store.startDrill → trigger('DRILL')). That is exactly what makes it worth
   * running — and exactly why it is confirmed first.
   */
  const handleDrill = useCallback(() => {
    Alert.alert(
      'Run a practice drill?',
      'Every phone in the family will alert as if this were real. A drill is how a dead agent is found before an emergency finds it.',
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: 'Run drill', style: 'destructive', onPress: () => void startDrill('quarterly') },
      ],
    );
  }, [startDrill]);

  // ── header copy ─────────────────────────────────────────────────────────────

  const headline =
    liveIncidents.length > 0
      ? t('home.activeIncident')
      : silentAgents.length > 0
        ? `${silentAgents.length} agent${silentAgents.length === 1 ? '' : 's'} not reporting`
        : t('home.everyoneOk');

  const headlineTone: 'danger' | 'warn' | 'ok' =
    liveIncidents.length > 0 ? 'danger' : silentAgents.length > 0 ? 'warn' : 'ok';

  // `me === null` after boot is a real gap, not a cosmetic one: the emergency SMS
  // is built from asciiShortName, so an alert from this phone would not say who
  // needs help (F-18). "This device" hid that behind two neutral words.
  const signedInAs =
    me === null
      ? 'No profile on this phone yet — an alert from it would not say who you are'
      : `Signed in as ${me.displayName}`;

  /**
   * ★ THE SOS BUTTON OUTLIVES THE LOADING STATE ★
   * store.bootstrap can take a second on a cold cheap Android, and hard rule 8
   * says a store that is not ready yet must never be a panic button that does not
   * render. So the boot screen is the real footer plus one honest sentence about
   * what is happening, and never a spinner over an empty screen: the thing the
   * family might need in that second is still under their thumb.
   */
  if (!ready) {
    return (
      <SafeAreaView edges={['top']} style={styles.screen}>
        <View style={styles.booting}>
          <View style={styles.header}>
            <Text style={styles.eyebrow}>{CONFIG.appName}</Text>
            <Text accessibilityRole="header" style={styles.screenTitle}>
              Opening
            </Text>
            <Text style={styles.screenSubtitle}>
              Reading what is already on this phone. Nothing is being fetched from anywhere.
            </Text>
          </View>
          <View style={styles.skeletonBlock}>
            <View style={[styles.skeleton, styles.skeletonWide]} />
            <View style={styles.skeleton} />
            <View style={[styles.skeleton, styles.skeletonShort]} />
          </View>
        </View>
        <View style={styles.footer}>
          <Button
            label={t('panic.trigger')}
            variant="danger"
            size="panic"
            onPress={() => router.push('/panic')}
            accessibilityLabel="S O S. Opens the emergency screen."
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        // The tab bar is laid out below this scene rather than over it, and it
        // pads its own bottom inset — so the content stops at space.xl and does
        // not double-count anything. Same rule on all five tabs.
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── status header ─────────────────────────────────────────────────────
            Same geometry as the other four tabs — eyebrow, h1 title, small
            subtitle, one space.lg gap to the content — so the title baseline does
            not move as you swipe across the tab bar. What is deliberately NOT
            shared is the COLOUR: on this tab the h1 is the status itself, because
            a dashboard that reads "Family" while an agent has been dark for
            nineteen hours has taught the family to ignore it (F-02). */}
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={`${CONFIG.appName}. ${headline}. ${signedInAs}`}
          style={styles.header}
        >
          <Text style={styles.eyebrow}>{CONFIG.appName}</Text>
          <Text
            style={[
              styles.screenTitle,
              headlineTone === 'danger'
                ? styles.headlineDanger
                : headlineTone === 'warn'
                  ? styles.headlineWarn
                  : styles.headlineOk,
            ]}
          >
            {headline}
          </Text>
          <Text style={styles.screenSubtitle}>{signedInAs}</Text>
        </View>

        {/* ── whose space this is (Spec E5) ─────────────────────────────────────
            A quiet, persistent reminder that this screen belongs to one family and
            is private to it (P-008). It sits below the status headline so it never
            competes with F-02, and the crest is derived on-device from familyId —
            nothing about it is fetched or stored. */}
        <View style={styles.familyIdentity}>
          <FamilyIdentity familyId={familyId} name={familyName} compact />
        </View>

        {/* ── degradation strip: which rung of §4.4 we are actually on ──────── */}
        <View style={styles.strip}>
          <Pill label={DEGRADATION_LABELS[degradation]} tone={degradationTone(degradation)} />
          {outboxDepth > 0 ? (
            <Pill label={`${outboxDepth} waiting to sync`} tone="neutral" glyph="↑" />
          ) : null}
        </View>

        {/* ── live incidents ────────────────────────────────────────────────── */}
        {liveIncidents.map((incident) => {
          const subject = nameOf(incident.subjectMemberId);
          const acked = incident.firstAckAt !== null && incident.ownerMemberId !== null;
          const line = acked
            ? t('panic.responding', { name: nameOf(incident.ownerMemberId as UUID) })
            : t('panic.nobodyResponded');
          return (
            <PressableScale
              key={incident.id}
              onPress={() => router.push('/panic')}
              // NO_MOTION on this one card only. The haptic and the opacity step
              // stay, the movement does not: while an emergency is live, a card
              // that shifts under the thumb is indistinguishable from a card
              // still loading, and §6.4 spends that ambiguity nowhere.
              motion={NO_MOTION}
              accessibilityRole="button"
              accessibilityLabel={`${t('home.activeIncident')}. ${subject}. ${line}`}
              accessibilityHint="Opens the emergency screen"
            >
              <Card tone="danger">
                <View style={styles.badgeRow}>
                  <StateBadge state={incident.state} />
                  {incident.isDrill ? <Pill label="Drill" tone="info" /> : null}
                </View>
                <Text style={styles.bannerTitle}>{subject}</Text>
                <Text style={[styles.bannerLine, acked ? null : styles.bannerShout]}>{line}</Text>
                <Text style={styles.bannerMeta}>
                  {`Opened ${relativeTime(incident.openedAt)} · #${incident.inc8}`}
                </Text>
              </Card>
            </PressableScale>
          );
        })}

        {/* ══ THE YELLOW LINE (PRD §16.3) ══════════════════════════════════════
            Non-dismissable by design. No close button, no snooze, no "remind me
            later" — the card leaves when the phone is fixed and not before. */}
        {silentAgents.map((s) => (
          <PressableScale
            key={s.device.id}
            onPress={() => router.push('/diagnostics')}
            accessibilityRole="button"
            accessibilityLabel={
              s.hours === null
                ? `${s.member.displayName}'s safety agent has never reported. Likely killed by the phone's battery manager.`
                : `${t('home.agentSilent', {
                    name: s.member.displayName,
                    hours: Math.round(s.hours),
                  })}. Likely killed by the phone's battery manager.`
            }
            accessibilityHint="Opens diagnostics, where this can be fixed"
          >
            <Card tone="warn" style={styles.yellowCard}>
              <View style={styles.badgeRow}>
                <Pill label="LIKELY OEM KILL" tone="warn" glyph="☠" />
                <Text style={styles.yellowSince}>
                  {s.hours === null ? 'never reported' : `${Math.round(s.hours)}h silent`}
                </Text>
              </View>

              <Text style={styles.yellowHeadline}>
                {s.hours === null
                  ? `${s.member.displayName}'s safety agent has never reported`
                  : t('home.agentSilent', { name: s.member.displayName, hours: Math.round(s.hours) })}
              </Text>

              <Text style={styles.yellowBody}>
                {`${s.device.manufacturer ?? 'This'} ${s.device.model ?? 'phone'} has not sent a heartbeat. `}
                {s.batteryOptimisationExempt
                  ? 'Battery optimisation is exempt, so this is not the usual cause — open diagnostics.'
                  : 'Battery optimisation was never exempted, so the phone stopped the agent in the background.'}
                {s.backgroundRestricted ? ' Background activity is also restricted.' : ''}
              </Text>

              <Text style={styles.yellowAction}>
                {`If ${s.member.asciiShortName} pressed the button right now, nothing would leave that phone. Tap to fix.`}
              </Text>
            </Card>
          </PressableScale>
        ))}

        {/* ── quick actions ─────────────────────────────────────────────────── */}
        <Section title="Quick actions">
          <View style={styles.actionGrid}>
            <Button
              label={t('home.checkIn')}
              icon="✓"
              variant="ghost"
              onPress={handleCheckIn}
              accessibilityLabel={`${t('home.checkIn')}. Tells the family you are fine and resets your journey clock.`}
              style={styles.action}
            />
            <Button
              label={t('home.findPhone')}
              icon="♪"
              variant="ghost"
              onPress={() => setRingOpen(true)}
              accessibilityLabel={`${t('home.findPhone')}. Choose whose phone to ring.`}
              style={styles.action}
            />
            <Button
              label={t('home.startJourney')}
              icon="→"
              variant="ghost"
              onPress={() => setJourneyOpen(true)}
              accessibilityLabel={`${t('home.startJourney')}. Set a destination and an expected arrival time.`}
              style={styles.action}
            />
            <Button
              label="Practice drill"
              icon="⚑"
              variant="ghost"
              onPress={handleDrill}
              accessibilityLabel="Run a practice drill. Every phone in the family will alert."
              style={styles.action}
            />
          </View>
        </Section>

        {/* ── the family ────────────────────────────────────────────────────── */}
        <Section title="Family" right={`${members.length}`}>
          {members.length === 0 ? (
            <EmptyState
              glyph="○"
              title="No family members yet"
              body="Nobody has been enrolled on this device. Enrol someone to start looking after each other."
            />
          ) : (
            members.map((member) => {
              const phone = phones.find((d) => d.memberId === member.id);
              // Ringing your own phone while holding it is not a feature.
              const ring =
                phone !== undefined && (me === null || member.id !== me.id) ? (
                  <PressableScale
                    onPress={() => handleRing(phone)}
                    accessibilityRole="button"
                    accessibilityLabel={`Ring ${member.displayName}'s phone`}
                    accessibilityHint="Asks the phone to ring and records it in the access log"
                    hitSlop={space.sm}
                    highlightColor={colors.info}
                    highlightRadius={radius.md}
                    style={styles.ring}
                  >
                    <Text
                      style={styles.ringGlyph}
                      allowFontScaling={false}
                      importantForAccessibility="no"
                    >
                      ♪
                    </Text>
                    <Text style={styles.ringLabel}>Ring</Text>
                  </PressableScale>
                ) : undefined;

              return (
                <MemberRow
                  key={member.id}
                  member={member}
                  presence={presence[member.id]}
                  right={ring}
                />
              );
            })
          )}
        </Section>

        {/* ── journeys ──────────────────────────────────────────────────────── */}
        <Section title="Journeys" right={activeJourneys.length > 0 ? `${activeJourneys.length} active` : undefined}>
          {activeJourneys.length === 0 ? (
            <EmptyState
              glyph="→"
              title="Nobody is travelling"
              body="Start a journey and this phone watches the clock: if the check-in never comes, the family finds out."
              action={{ label: t('home.startJourney'), onPress: () => setJourneyOpen(true) }}
            />
          ) : (
            activeJourneys.map((journey) => {
              const overdue = journey.etaAt !== null && journey.etaAt < now;
              const mine = me !== null && journey.memberId === me.id;
              return (
                <ListItem
                  key={journey.id}
                  glyph={overdue ? '!' : '→'}
                  danger={overdue}
                  title={`${nameOf(journey.memberId)} → ${journey.destName}`}
                  subtitle={`${etaText(journey.etaAt, now)} · started ${relativeTime(journey.startedAt)}`}
                  right={
                    // Only the traveller can say they arrived. Anyone else marking
                    // it would be guessing on their behalf.
                    mine ? (
                      <Button
                        label="Arrived"
                        variant="primary"
                        onPress={() => handleArrive(journey)}
                        accessibilityLabel={`Mark arrived at ${journey.destName}`}
                      />
                    ) : (
                      <Pill
                        label={overdue ? 'Overdue' : 'On the way'}
                        tone={overdue ? 'warn' : 'info'}
                      />
                    )
                  }
                />
              );
            })
          )}
        </Section>

        {/* ── recent check-ins (P-062: the boring, useful half of the app) ───── */}
        <Section title="Recent check-ins">
          {recentCheckIns.length === 0 ? (
            <ListItem
              glyph="—"
              title="No check-ins in the last 12 hours"
              subtitle="Silence is not the same as safety. Press “I’m safe” to leave a mark."
            />
          ) : (
            recentCheckIns.map((row) => {
              const battery = presence[row.member.id]?.batteryPct ?? null;
              return (
                <ListItem
                  key={row.member.id}
                  glyph="✓"
                  title={row.member.displayName}
                  subtitle={t('home.lastSeen', { ago: relativeTime(row.at) })}
                  right={battery === null ? undefined : t('home.battery', { pct: Math.round(battery) })}
                />
              );
            })
          )}
        </Section>

        {/* ── today at a glance ─────────────────────────────────────────────── */}
        <Section title="Today">
          <ListItem
            glyph="◉"
            title="Agents reporting"
            subtitle="Phones that sent a heartbeat in the last six hours"
            right={`${agentsReporting}/${phones.length}`}
          />
          {nodes.length > 0 ? (
            <ListItem
              glyph="▣"
              title="Fixed nodes"
              subtitle="Old handsets repurposed as always-on eyes and relays"
              right={`${nodesOnline}/${nodes.length} online`}
            />
          ) : null}
          <ListItem
            glyph="⚑"
            title="Last practice drill"
            subtitle={
              lastDrillAt === null
                ? 'Never run. An untested alarm is an assumption.'
                : 'A drill is the only proof the ladder still works'
            }
            right={lastDrillAt === null ? t('common.never') : relativeTime(lastDrillAt)}
            danger={lastDrillAt === null}
          />
          {lowBattery.length > 0 ? (
            <ListItem
              glyph="▁"
              title="Low battery"
              subtitle={lowBattery.map((m) => m.displayName).join(', ')}
              right={`${lowBattery.length}`}
              danger
            />
          ) : null}
        </Section>

        {/* ── the house ─────────────────────────────────────────────────────── */}
        {todaysHomeEvents.length > 0 ? (
          <Section title="At home">
            {todaysHomeEvents.map((event) => (
              <ListItem
                key={event.id}
                glyph={homeEventGlyph(event.kind)}
                danger={event.severity === 'critical'}
                title={event.suggestedActions[0] ?? event.entity}
                subtitle={`${event.entity} · ${relativeTime(event.at)}`}
                right={
                  event.severity === 'info' ? undefined : (
                    <Pill
                      label={event.severity === 'critical' ? 'Critical' : 'Check'}
                      tone={event.severity === 'critical' ? 'danger' : 'warn'}
                    />
                  )
                }
              />
            ))}
          </Section>
        ) : null}

        <Text style={styles.footnote}>
          Everything on this screen was computed on this phone. Precise locations, geofences and
          journey corridors never leave it (ADR-010).
        </Text>
      </ScrollView>

      {/* ── the SOS button: outside the ScrollView, so it can never be scrolled
          away from a shaking thumb (PRD §6.4 — bottom third, ≥88 dp). The bottom
          inset is NOT added here: the tab bar sits directly under this footer and
          already pads the gesture bar, so adding it again pushed the button a
          thumb's width further from the edge for nothing. ─────────────────────── */}
      <View style={styles.footer}>
        <Button
          label={t('panic.trigger')}
          variant="danger"
          size="panic"
          onPress={() => router.push('/panic')}
          accessibilityLabel="S O S. Opens the emergency screen."
        />
      </View>

      <RingSheet
        visible={ringOpen}
        devices={phones.filter((d) => me === null || d.memberId !== me.id)}
        members={members}
        now={now}
        onRing={handleRing}
        onClose={() => setRingOpen(false)}
        bottomInset={insets.bottom}
      />

      <JourneySheet
        visible={journeyOpen}
        onStart={handleStartJourney}
        onClose={() => setJourneyOpen(false)}
        bottomInset={insets.bottom}
      />
    </SafeAreaView>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sheets
// ═══════════════════════════════════════════════════════════════════════════════

interface RingSheetProps {
  visible: boolean;
  devices: Device[];
  members: Member[];
  now: number;
  onRing: (device: Device) => void;
  onClose: () => void;
  bottomInset: number;
}

/** Whose phone to ring. Every row states how long ago that phone last spoke, so
 *  ringing a nineteen-hour-dead handset is a decision rather than a surprise. */
function RingSheet({
  visible,
  devices,
  members,
  now,
  onRing,
  onClose,
  bottomInset,
}: RingSheetProps): React.ReactElement {
  return (
    <Modal
      visible={visible}
      transparent
      // theme.ts allows no animation except the cancel countdown ring (§6.4).
      animationType="none"
      // Without this the Android scrim stops at the status bar and the screen
      // underneath shows through above it, which reads as a half-drawn sheet.
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.sheetRoot}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        />
        <View style={[styles.sheet, { paddingBottom: bottomInset + space.lg }]}>
          <Text accessibilityRole="header" style={styles.sheetTitle}>
            {t('home.findPhone')}
          </Text>
          <Text style={styles.sheetBody}>
            The phone rings at full volume even if it is silenced. Every ring is written to that
            person’s access log.
          </Text>

          <ScrollView style={styles.sheetScroll}>
            {devices.length === 0 ? (
              <ListItem glyph="—" title="No other phones enrolled" subtitle="Nothing to ring yet." />
            ) : (
              devices.map((device) => {
                const owner = members.find((m) => m.id === device.memberId);
                const seen =
                  device.lastHeartbeatAt === null
                    ? t('common.never')
                    : relativeTime(device.lastHeartbeatAt);
                const stale =
                  device.lastHeartbeatAt === null || now - device.lastHeartbeatAt > CONFIG.agentSilentAlertMs;
                return (
                  <ListItem
                    key={device.id}
                    glyph="♪"
                    title={owner?.displayName ?? device.id}
                    subtitle={`${device.manufacturer ?? ''} ${device.model ?? ''}`.trim() || device.platform}
                    right={<Pill label={seen} tone={stale ? 'warn' : 'ok'} />}
                    onPress={() => onRing(device)}
                    style={styles.sheetRow}
                  />
                );
              })
            )}
          </ScrollView>

          <Button label={t('common.close')} variant="ghost" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

interface JourneySheetProps {
  visible: boolean;
  onStart: (destName: string, etaMinutes: number) => void;
  onClose: () => void;
  bottomInset: number;
}

/**
 * A journey is a promise with a clock attached: if the traveller is not heard
 * from by the ETA, DEADMAN evidence starts accumulating (core/policy). So the
 * two things asked for are the two things that clock needs — where, and by when.
 */
function JourneySheet({ visible, onStart, onClose, bottomInset }: JourneySheetProps): React.ReactElement {
  const [dest, setDest] = useState('');
  const [minutes, setMinutes] = useState<number>(30);

  const trimmed = dest.trim();

  const close = useCallback(() => {
    setDest('');
    setMinutes(30);
    onClose();
  }, [onClose]);

  const start = useCallback(() => {
    if (trimmed.length === 0) return;
    setDest('');
    setMinutes(30);
    onStart(trimmed, minutes);
  }, [trimmed, minutes, onStart]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={close}
    >
      <View style={styles.sheetRoot}>
        <Pressable
          style={styles.backdrop}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel={t('common.close')}
        />
        <View style={[styles.sheet, { paddingBottom: bottomInset + space.lg }]}>
          <Text accessibilityRole="header" style={styles.sheetTitle}>
            {t('home.startJourney')}
          </Text>
          <Text style={styles.sheetBody}>
            The route stays on this phone. Only the fact that you are travelling, and when you are
            expected, is shared with the family.
          </Text>

          <TextInput
            value={dest}
            onChangeText={setDest}
            placeholder="Where are you going?"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            accessibilityLabel="Destination"
            maxLength={48}
            returnKeyType="done"
          />

          <Text style={styles.fieldLabel}>Expected arrival</Text>
          <View style={styles.chipRow}>
            {ETA_CHOICES.map((choice) => {
              const selected = choice === minutes;
              return (
                <PressableScale
                  key={choice}
                  onPress={() => setMinutes(choice)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`In ${choice} minutes`}
                  highlightColor={colors.focus}
                  highlightRadius={radius.pill}
                  style={[styles.chip, selected ? styles.chipSelected : null]}
                >
                  {/* P-018: the tick, not only the tint, says which one is on. */}
                  {selected ? (
                    <Text
                      style={styles.chipTick}
                      allowFontScaling={false}
                      importantForAccessibility="no"
                    >
                      ✓
                    </Text>
                  ) : null}
                  <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>
                    {`${choice} min`}
                  </Text>
                </PressableScale>
              );
            })}
          </View>

          <Button
            label={t('home.startJourney')}
            variant="primary"
            size="lg"
            disabled={trimmed.length === 0}
            onPress={start}
            accessibilityLabel={
              trimmed.length === 0
                ? 'Enter a destination first'
                : `Start journey to ${trimmed}, expected in ${minutes} minutes`
            }
          />
          <Button label={t('common.cancel')} variant="quiet" onPress={close} />
        </View>
      </View>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  familyIdentity: { marginTop: space.lg },
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    gap: space.lg,
  },

  // ── the shared screen header ────────────────────────────────────────────────
  // Identical on all five tabs: eyebrow (this tab only), h1 title, small
  // subtitle, space.xxs between them, one space.lg gap to the first block. The
  // audit's finding was that the title baseline moved on every swipe; these three
  // rules are what stop it. They belong in one <ScreenHeader/> in
  // src/ui/components — see the report.
  header: { gap: space.xxs },
  eyebrow: {
    color: colors.textFaint,
    fontSize: font.tiny,
    lineHeight: leading.tiny,
    letterSpacing: tracking.caps,
    fontWeight: weight.bold,
    textTransform: 'uppercase',
  },
  screenTitle: {
    color: colors.text,
    fontSize: font.h1,
    lineHeight: leading.h1,
    letterSpacing: tracking.h1,
    fontWeight: weight.bold,
  },
  screenSubtitle: {
    color: colors.textDim,
    fontSize: font.small,
    lineHeight: leading.small,
    letterSpacing: tracking.small,
  },
  // ★ The *Text* tokens, not the fills. On `bg` the fills measure 2.91 / 3.25 /
  //   3.31:1, under even WCAG AA's 4.5 floor, and this is the largest and most
  //   read string in the product — the one sentence meant to be legible across a
  //   room in daylight. okText/warnText/dangerText are the 9.49 / 9.40 / 9.53:1
  //   pairs theme.ts created for exactly this case.
  headlineOk: { color: colors.okText },
  headlineWarn: { color: colors.warnText },
  headlineDanger: { color: colors.dangerText },

  // Static blocks, not a spinner: nothing on this screen may animate while the
  // SOS button below it is live, and a shimmer would read as progress we cannot
  // promise (§6.4).
  booting: { flex: 1, paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.xl },
  skeletonBlock: { gap: space.md },
  skeleton: {
    height: 64,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
  },
  skeletonWide: { height: 96 },
  skeletonShort: { width: '60%' },

  strip: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },

  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  bannerTitle: { color: colors.text, fontSize: font.h2, fontWeight: weight.bold },
  bannerLine: { color: colors.text, fontSize: font.body, fontWeight: weight.semibold },
  bannerShout: {
    // dangerText on dangerSoft (this sits inside a Card tone="danger"), 8.77:1.
    // `danger` on the same fill was 3.05:1 — on the line whose entire job is to
    // say that nobody has responded yet.
    color: colors.dangerText,
    fontSize: font.h3,
    fontWeight: weight.heavy,
    letterSpacing: 0.6,
  },
  bannerMeta: { color: colors.textDim, fontSize: font.small },

  // The yellow line gets more edge weight than any other card on the screen.
  yellowCard: { borderWidth: 2.5 },
  yellowSince: { color: colors.warnText, fontSize: font.small, fontWeight: weight.bold },
  yellowHeadline: { color: colors.text, fontSize: font.h2, fontWeight: weight.bold },
  yellowBody: { color: colors.textDim, fontSize: font.body, lineHeight: leading.body },
  yellowAction: { color: colors.warnText, fontSize: font.small, fontWeight: weight.semibold },

  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  action: { flexGrow: 1, flexBasis: '47%' },

  ring: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgElevated,
  },
  // infoText (8.61:1), not info: the glyph is the loudest mark on this control
  // and `info` on bgElevated is 2.07:1 — a mark that is not there. Same finding
  // as Pill's TONE_FG.
  ringGlyph: { color: colors.infoText, fontSize: font.h3, lineHeight: font.h3 + 2 },
  ringLabel: { color: colors.textDim, fontSize: font.tiny, fontWeight: weight.semibold },

  footnote: {
    color: colors.textFaint,
    fontSize: font.tiny,
    lineHeight: font.tiny + 5,
    marginTop: space.sm,
  },

  footer: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // The theme's own scrim. The literal it replaced was lighter and a different
    // hue from the surface scale, so the sheet sat on a slightly-off backdrop.
    backgroundColor: colors.bgOverlay,
  },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.md,
    maxHeight: '86%',
  },
  sheetTitle: { color: colors.text, fontSize: font.h2, fontWeight: weight.bold },
  sheetBody: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 6 },
  sheetScroll: { flexGrow: 0 },
  sheetRow: { marginBottom: space.sm },

  input: {
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgInput,
    paddingHorizontal: space.md,
    color: colors.text,
    fontSize: font.body,
  },
  fieldLabel: {
    color: colors.textDim,
    fontSize: font.small,
    fontWeight: weight.semibold,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  // ── the shared chip ─────────────────────────────────────────────────────────
  // One geometry, repeated verbatim on home, map, incidents and settings: 48 dp
  // tall, pill radius, 1.5 dp borderStrong edge on bgCard, `info` edge + infoSoft
  // fill when on, and a tick so the selected state is never carried by colour
  // alone (P-018). It wants to be one <Chip/> in src/ui/components — see report.
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: MIN_TOUCH_TARGET,
    minWidth: 64,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgCard,
  },
  chipSelected: { borderColor: colors.info, backgroundColor: colors.infoSoft },
  chipTick: { color: colors.infoText, fontSize: font.small, fontWeight: weight.bold },
  chipText: { color: colors.textDim, fontSize: font.body, fontWeight: weight.semibold },
  chipTextSelected: { color: colors.text },
});
