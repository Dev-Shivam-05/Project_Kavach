/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * JOURNEYS — start · monitor · arrive (FR-042)
 *
 * ★★★ THE POLICY THAT MAKES THIS SCREEN DIFFERENT FROM EVERY OTHER ONE ★★★
 *
 * An overdue journey escalates QUIETLY. DEADMAN in core/policy carries
 * `allowNeighbours: false` and `l1AudienceRoles: ['guardian']`, its L2 boundary
 * is fifteen minutes rather than ninety seconds, and its cancel window is zero
 * because nothing has been alleged yet. PRD §7.5 and §3.3 are explicit about the
 * reason: the evidence here is *silence*, and silence is the weakest evidence in
 * the system. The honest sentence is "Priya's journey looks off — can someone
 * call her?", asked of one guardian. It is never "wake the street".
 *
 * A journey feature that summoned neighbours because a bus was late would be
 * switched off within a week, and then it would not be there on the night it
 * mattered. Slow and quiet IS the feature.
 *
 * ★ THE CORRIDOR NEVER LEAVES THIS DEVICE ★
 * Journey.corridorPoints is Class A (ADR-010, core/types) — net/api strips it
 * before a journey is posted. It is drawn here, on-device, from points we
 * already hold, with no tile server and therefore no silent location disclosure
 * (the same argument as the FamilyMapView header).
 *
 * FamilyMapView is rendered for the travellers themselves because it already
 * enforces the consent rules — a paused or ungranted member is LISTED, never
 * pinned at a stale position. The corridor is drawn in its own canvas below,
 * since the shared component takes no corridor and bypassing its rules to add
 * one would be exactly the wrong trade.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';

import type { Journey, Member, MemberPresence, UUID } from '../src/core/types';
import type { Fix } from '../src/domain/geofence';
import {
  CORRIDOR_TOLERANCE_M,
  corridorDeviationM,
  journeyStatus,
  type JourneyStatus,
} from '../src/domain/journey';
import { relativeTime, t } from '../src/i18n';
import { currentPolicy, ladderSteps, lastKnownFix, useKavach } from '../src/state/store';
import {
  Button,
  Card,
  EmptyState,
  FamilyMapView,
  ListItem,
  Pill,
  Section,
} from '../src/ui/components';
import { MIN_TOUCH_TARGET, colors, font, radius, space, weight } from '../src/ui/theme';

const ETA_PRESETS = [10, 20, 30, 45, 60, 90];
/** Beyond this a fix is described as old rather than presented as current. */
const STALE_FIX_MS = 15 * 60_000;
const MAP_HEIGHT = 240;
const PAD = 30;
const M_PER_DEG_LAT = 111_320;
const NICE_METRES = [50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000];

// ═══════════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════════

function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Coarse, spoken duration. Seconds are noise at journey scale. */
function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

function metres(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// The corridor canvas
// ═══════════════════════════════════════════════════════════════════════════════

interface CorridorMapProps {
  corridor: { lat: number; lon: number }[];
  fix: Fix | null;
  toleranceM: number;
  deviationM: number;
  travellerColour: string;
}

interface CorridorGeometry {
  /** Ready-joined polyline; both strokes render the same string. */
  line: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  here: { x: number; y: number } | null;
  accuracyPx: number;
  bandPx: number;
  barMetres: number;
  barPx: number;
}

/**
 * Equirectangular, unrotated, aspect preserved on both axes — the same
 * projection as FamilyMapView, for the same reason: a scale bar that lies in one
 * direction is worse than no scale bar.
 */
function CorridorMap({
  corridor,
  fix,
  toleranceM,
  deviationM,
  travellerColour,
}: CorridorMapProps): React.ReactElement {
  const [width, setWidth] = useState(0);

  // Depended on as scalars, not as the `fix` object: the screen's 1 Hz tick
  // re-renders this card once a second, and a new object identity per render
  // would defeat the memo below on every one of them.
  const fixLat = fix?.lat ?? null;
  const fixLon = fix?.lon ?? null;
  const fixAccuracyM = fix?.accuracyM ?? null;

  /**
   * ★ The whole projection, computed once per input change. ★
   *
   * It used to be rebuilt in the render body, so the screen's per-second tick
   * re-projected every corridor point and re-joined two polyline strings for
   * every journey on screen, once a second, forever.
   *
   * The bounds are found in ONE pass rather than with four `Math.min(...arr)`
   * spreads. That is not a micro-optimisation: `Journey.corridorPoints` is
   * documented in state/store.ts as starting at one point and filling in "as the
   * journey is walked", and a spread past the engine's argument limit throws
   * `RangeError: Maximum call stack size exceeded` — a long enough walk crashed
   * the screen that exists to watch it.
   */
  const geometry = useMemo<CorridorGeometry | null>(() => {
    if (width <= 0 || corridor.length < 2) return null;

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    const consider = (lat: number, lon: number): void => {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    };
    for (const p of corridor) consider(p.lat, p.lon);
    if (fixLat !== null && fixLon !== null) consider(fixLat, fixLon);

    const latCentre = (minLat + maxLat) / 2;
    const lonCentre = (minLon + maxLon) / 2;
    const kx = Math.max(0.05, Math.cos((latCentre * Math.PI) / 180));
    const spanY = Math.max((maxLat - minLat) * 1.25, 0.0008);
    const spanX = Math.max((maxLon - minLon) * kx * 1.25, 0.0008);
    const scale = Math.min(
      Math.max(1, width - PAD * 2) / spanX,
      Math.max(1, MAP_HEIGHT - PAD * 2) / spanY,
    );
    const metresPerPx = M_PER_DEG_LAT / scale;
    const project = (lat: number, lon: number): { x: number; y: number } => ({
      x: width / 2 + (lon - lonCentre) * kx * scale,
      y: MAP_HEIGHT / 2 - (lat - latCentre) * scale,
    });

    const parts: string[] = [];
    for (const p of corridor) {
      const q = project(p.lat, p.lon);
      parts.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
    }

    const barTarget = width * 0.32 * metresPerPx;
    let barMetres = NICE_METRES[0];
    for (const m of NICE_METRES) if (m <= barTarget) barMetres = m;

    return {
      line: parts.join(' '),
      start: project(corridor[0].lat, corridor[0].lon),
      end: project(corridor[corridor.length - 1].lat, corridor[corridor.length - 1].lon),
      here: fixLat !== null && fixLon !== null ? project(fixLat, fixLon) : null,
      accuracyPx: Math.max(14, Math.min((fixAccuracyM ?? 0) / metresPerPx, width / 2)),
      // The tolerance is a real width on the ground, so it is drawn as one: the
      // band IS the rule that decides "off route", not a decorative outline.
      bandPx: Math.max(6, Math.min((toleranceM * 2) / metresPerPx, Math.max(width, MAP_HEIGHT))),
      barMetres,
      barPx: barMetres / metresPerPx,
    };
  }, [corridor, fixLat, fixLon, fixAccuracyM, toleranceM, width]);

  const body =
    geometry === null ? null : (
      <Svg width={width} height={MAP_HEIGHT}>
        <Rect x={0} y={0} width={width} height={MAP_HEIGHT} fill={colors.bgElevated} />
        {[1, 2, 3, 4].map((i) => (
          <Line
            key={`v${i}`}
            x1={(width / 5) * i}
            y1={0}
            x2={(width / 5) * i}
            y2={MAP_HEIGHT}
            stroke={colors.border}
            strokeWidth={1}
            opacity={0.5}
          />
        ))}
        <Polyline
          points={geometry.line}
          fill="none"
          stroke={colors.info}
          strokeOpacity={0.18}
          strokeWidth={geometry.bandPx}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Polyline
          points={geometry.line}
          fill="none"
          stroke={colors.info}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Circle
          cx={geometry.start.x}
          cy={geometry.start.y}
          r={7}
          fill={colors.info}
          stroke={colors.bg}
          strokeWidth={2}
        />
        <Circle
          cx={geometry.end.x}
          cy={geometry.end.y}
          r={9}
          fill={colors.ok}
          stroke={colors.bg}
          strokeWidth={2}
        />
        <SvgText
          x={geometry.end.x}
          y={geometry.end.y - 14}
          fill={colors.text}
          fontSize={font.tiny}
          fontWeight="700"
          textAnchor="middle"
        >
          END
        </SvgText>
        {geometry.here === null ? null : (
          <>
            <Circle
              cx={geometry.here.x}
              cy={geometry.here.y}
              r={geometry.accuracyPx}
              fill={travellerColour}
              fillOpacity={0.12}
              stroke={travellerColour}
              strokeOpacity={0.5}
              strokeWidth={1.5}
            />
            <Circle
              cx={geometry.here.x}
              cy={geometry.here.y}
              r={11}
              fill={deviationM > toleranceM ? colors.warn : travellerColour}
              stroke={colors.bg}
              strokeWidth={2.5}
            />
          </>
        )}
        <SvgText
          x={width - space.md}
          y={space.lg}
          fill={colors.textFaint}
          fontSize={font.tiny}
          fontWeight="700"
          textAnchor="end"
        >
          N ↑
        </SvgText>
        <Line
          x1={space.md}
          y1={MAP_HEIGHT - space.xl}
          x2={space.md + geometry.barPx}
          y2={MAP_HEIGHT - space.xl}
          stroke={colors.text}
          strokeWidth={2.5}
        />
        <SvgText
          x={space.md}
          y={MAP_HEIGHT - space.sm}
          fill={colors.text}
          fontSize={font.tiny}
          fontWeight="600"
        >
          {geometry.barMetres >= 1000 ? `${geometry.barMetres / 1000} km` : `${geometry.barMetres} m`}
        </SvgText>
      </Svg>
    );

  return (
    <View
      style={styles.corridorCanvas}
      onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width))}
      accessible
      accessibilityRole="image"
      accessibilityLabel={
        corridor.length >= 2
          ? `Route corridor, ${corridor.length} points, tolerance ${Math.round(toleranceM)} metres${
              fix ? `, currently ${metres(deviationM)} from the route` : ', no live position'
            }`
          : 'No corridor recorded yet'
      }
    >
      {body ?? (
        <View style={styles.corridorEmpty}>
          <Text style={styles.corridorEmptyTitle}>No corridor yet</Text>
          <Text style={styles.corridorEmptyBody}>
            The corridor is drawn as the journey is walked. With fewer than two points nothing can be
            scored as a deviation — and calling that “off route” would be a guess.
          </Text>
        </View>
      )}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// One journey
// ═══════════════════════════════════════════════════════════════════════════════

const STATUS_LABEL: Record<JourneyStatus, string> = {
  on_track: 'On track',
  deviated: 'Off the usual route',
  overdue: 'Overdue',
  arrived: 'Arrived',
};

const STATUS_TONE: Record<JourneyStatus, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  on_track: 'ok',
  deviated: 'warn',
  overdue: 'danger',
  arrived: 'neutral',
};

interface JourneyCardProps {
  journey: Journey;
  traveller: Member | undefined;
  fix: Fix | null;
  fixReason: string;
  isMine: boolean;
  now: number;
  onCheckIn: () => void;
  onArrive: () => void;
}

function JourneyCard({
  journey,
  traveller,
  fix,
  fixReason,
  isMine,
  now,
  onCheckIn,
  onArrive,
}: JourneyCardProps): React.ReactElement {
  const name = traveller?.displayName ?? 'Someone';
  const tolerance = CORRIDOR_TOLERANCE_M + 2 * Math.max(0, fix?.accuracyM ?? 0);

  /**
   * ★ Both of these walk the whole corridor, and both are memoised on the fix's
   * SCALARS rather than on the fix object. `fixFor()` in the screen below builds
   * a fresh object on every render and the screen re-renders once a second, so
   * depending on the object would re-walk every point of every journey, every
   * second, for answers that had not changed. Neither function reads the screen's
   * clock — `journeyStatus` takes its "now" from `pos.at` — so this is a pure
   * caching win with no behavioural change.
   */
  const corridorPoints = journey.corridorPoints;
  const fixLat = fix?.lat ?? null;
  const fixLon = fix?.lon ?? null;
  const fixAt = fix?.at ?? null;
  const deviationM = useMemo(
    () => (fix && corridorPoints.length >= 2 ? corridorDeviationM(fix, corridorPoints) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [corridorPoints, fixLat, fixLon],
  );

  // Scored against the position we actually hold. With no fix the honest answer
  // is "we cannot say", never "on track" — a green tick nobody earned is the
  // single most dangerous string this screen could render.
  const status: JourneyStatus | null = useMemo(
    () => (fix ? journeyStatus(journey, fix) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [journey, fixLat, fixLon, fixAt, fix?.accuracyM],
  );

  const elapsedMs = now - journey.startedAt;
  const etaDeltaMs = journey.etaAt === null ? null : journey.etaAt - now;
  const nextCheckInAt =
    journey.checkInIntervalS === null
      ? null
      : (journey.lastCheckInAt ?? journey.startedAt) + journey.checkInIntervalS * 1000;
  const checkInDeltaMs = nextCheckInAt === null ? null : nextCheckInAt - now;

  const done = journey.arrivedAt !== null || journey.state === 'arrived' || journey.state === 'cancelled';

  return (
    // `enter` on this card and nowhere else on the screen: a journey card
    // appears when somebody starts travelling, and the 180 ms rise is what tells
    // a reader that a NEW one arrived rather than that the list re-sorted. The
    // static cards above it mount once and have nothing to announce.
    <Card
      enter="rise"
      tone={status === 'overdue' ? 'danger' : status === 'deviated' ? 'warn' : undefined}
    >
      <View style={styles.cardHead}>
        <View style={styles.cardHeadText}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {journey.label}
          </Text>
          <Text style={styles.cardSub} numberOfLines={1}>
            {name} · {journey.originName} → {journey.destName}
          </Text>
        </View>
        <Pill
          label={status === null ? 'Not scored' : STATUS_LABEL[status]}
          tone={status === null ? 'neutral' : STATUS_TONE[status]}
        />
      </View>

      <View style={styles.metricRow}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Started</Text>
          <Text style={styles.metricValue}>{clockTime(journey.startedAt)}</Text>
          <Text style={styles.metricFoot}>{duration(elapsedMs)} ago</Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>ETA</Text>
          <Text style={styles.metricValue}>
            {journey.etaAt === null ? '—' : clockTime(journey.etaAt)}
          </Text>
          <Text style={styles.metricFoot}>
            {etaDeltaMs === null
              ? 'no estimate'
              : etaDeltaMs >= 0
                ? `in ${duration(etaDeltaMs)}`
                : `${duration(-etaDeltaMs)} late`}
          </Text>
        </View>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>Off route</Text>
          <Text style={styles.metricValue}>{fix ? metres(deviationM) : '—'}</Text>
          <Text style={styles.metricFoot}>
            {fix ? `tolerance ${metres(tolerance)}` : 'no position'}
          </Text>
        </View>
      </View>

      {/* ★ Dead-man clock. A learned ETA is what arms it (store.startJourney):
          without route history there is no honest interval to demand, so the
          field stays null and the screen says so rather than inventing one. */}
      <View style={styles.deadman}>
        <Text style={styles.deadmanTitle}>Dead-man check-in</Text>
        {journey.checkInIntervalS === null ? (
          <Text style={styles.deadmanBody}>
            No check-in clock on this journey. Arrival is the only signal. The clock arms itself once
            this route has enough history to predict — half the learned duration.
          </Text>
        ) : (
          <Text style={styles.deadmanBody}>
            Every {duration(journey.checkInIntervalS * 1000)}. Last check-in{' '}
            {relativeTime(journey.lastCheckInAt ?? journey.startedAt)}.{' '}
            {checkInDeltaMs === null
              ? ''
              : checkInDeltaMs >= 0
                ? `Next due in ${duration(checkInDeltaMs)}.`
                : `Overdue by ${duration(-checkInDeltaMs)}.`}
          </Text>
        )}
      </View>

      <CorridorMap
        corridor={journey.corridorPoints}
        fix={fix}
        toleranceM={tolerance}
        deviationM={deviationM}
        travellerColour={traveller?.avatarColor ?? colors.info}
      />

      <Text style={styles.fixNote}>
        {fix
          ? `Position ${relativeTime(fix.at)}${
              now - fix.at > STALE_FIX_MS ? ' — old enough that it may no longer be where they are' : ''
            }, accurate to about ${metres(fix.accuracyM)}.`
          : fixReason}
      </Text>

      {done ? (
        <Text style={styles.fixNote}>
          Arrived {journey.arrivedAt === null ? '' : `at ${clockTime(journey.arrivedAt)}`}. This trip
          is now training data for the next ETA on this route.
        </Text>
      ) : (
        <View style={styles.actions}>
          {isMine ? (
            <Button
              label={t('home.checkIn')}
              onPress={onCheckIn}
              variant="primary"
              size="lg"
              style={styles.grow}
              accessibilityLabel={`${t('home.checkIn')} — resets the dead-man clock on ${journey.label}`}
            />
          ) : null}
          <Button
            label="Arrived"
            onPress={onArrive}
            variant="ghost"
            size="lg"
            style={styles.grow}
            accessibilityLabel={`Mark ${name}'s journey ${journey.label} as arrived`}
          />
        </View>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Screen
// ═══════════════════════════════════════════════════════════════════════════════

export default function JourneysScreen(): React.ReactElement {
  const ready = useKavach((s) => s.ready);
  const journeys = useKavach((s) => s.journeys);
  const members = useKavach((s) => s.members);
  const presence = useKavach((s) => s.presence);
  const me = useKavach((s) => s.me);
  const startJourney = useKavach((s) => s.startJourney);
  const arriveJourney = useKavach((s) => s.arriveJourney);
  const checkIn = useKavach((s) => s.checkIn);

  const [now, setNow] = useState(() => Date.now());
  const [label, setLabel] = useState('');
  const [destName, setDestName] = useState('');
  const [etaMinutes, setEtaMinutes] = useState('30');
  const [starting, setStarting] = useState(false);
  /** Set only if the store threw. The store is documented never to reject into
   *  the UI, so this stays null in every expected path — but a button that says
   *  nothing after a press is the one outcome this product cannot ship. */
  const [startFailed, setStartFailed] = useState(false);

  // One tick a second. Everything on this screen is a countdown against wall
  // clock, and a stale "in 3 min" that never becomes "late" is the failure mode.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const memberById = useMemo(() => {
    const map = new Map<UUID, Member>();
    for (const m of members) map.set(m.id, m);
    return map;
  }, [members]);

  const active = useMemo(
    () => journeys.filter((j) => j.arrivedAt === null && j.state !== 'arrived' && j.state !== 'cancelled'),
    [journeys],
  );
  const past = useMemo(
    () => journeys.filter((j) => j.arrivedAt !== null || j.state === 'arrived' || j.state === 'cancelled'),
    [journeys],
  );

  const travellers = useMemo(() => {
    const ids = new Set(active.map((j) => j.memberId));
    return members.filter((m) => ids.has(m.id));
  }, [active, members]);

  /**
   * The position a journey is scored against.
   *
   * P-066 / F-14: a paused member is treated as having no position at all. Using
   * their last known fix would turn a right they exercised into a tracker that
   * quietly still works.
   */
  function fixFor(journey: Journey): { fix: Fix | null; reason: string } {
    const p: MemberPresence | undefined = presence[journey.memberId];
    if (p && p.monitoringPaused) {
      return { fix: null, reason: 'Monitoring is paused. No position, so nothing is scored.' };
    }
    if (p && p.location) {
      return {
        fix: { lat: p.location.lat, lon: p.location.lon, accuracyM: p.location.accuracyM, at: p.location.at },
        reason: '',
      };
    }
    if (me && journey.memberId === me.id) {
      const own = lastKnownFix();
      if (own) {
        return {
          fix: { lat: own.lat, lon: own.lon, accuracyM: own.accuracyM, at: own.at },
          reason: '',
        };
      }
    }
    return { fix: null, reason: 'No location shared for this journey. Corridor and ETA are not scored.' };
  }

  const minutes = Number.parseInt(etaMinutes, 10);
  const minutesValid = Number.isFinite(minutes) && minutes >= 1 && minutes <= 24 * 60;
  const canStart = destName.trim().length > 0 && minutesValid && !starting;

  async function handleStart(): Promise<void> {
    if (!canStart) return;
    setStarting(true);
    setStartFailed(false);
    try {
      await startJourney({
        label: label.trim() || `To ${destName.trim()}`,
        destName: destName.trim(),
        etaMinutes: minutes,
      });
      setLabel('');
      setDestName('');
      setEtaMinutes('30');
    } catch {
      setStartFailed(true);
    } finally {
      // The store never rejects into the UI, but a stuck disabled button after
      // an unexpected throw would leave someone unable to start a journey.
      setStarting(false);
    }
  }

  const deadman = currentPolicy().scenarios.DEADMAN;
  const ladder = ladderSteps('DEADMAN');

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* No title and no back chevron of its own. `_layout.tsx` gives this route
          a native header titled "Journeys" whose arrow is, in that file's own
          words, the guaranteed way back out — so a second chevron under a second
          copy of the same word was two affordances doing one job. */}
      <Text style={styles.lead}>Someone is on their way. Kavach watches the clock.</Text>

      <Section title="Start a journey">
        <Card>
          <Text style={styles.fieldLabel}>Going where</Text>
          <TextInput
            value={destName}
            onChangeText={setDestName}
            placeholder="Home"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            accessibilityLabel="Destination name"
            returnKeyType="next"
          />

          <Text style={styles.fieldLabel}>What to call it</Text>
          <TextInput
            value={label}
            onChangeText={setLabel}
            placeholder="Evening class"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            accessibilityLabel="Journey label, optional"
            returnKeyType="done"
          />

          <Text style={styles.fieldLabel}>How long you expect it to take</Text>
          <View style={styles.chips}>
            {ETA_PRESETS.map((m) => {
              const selected = String(m) === etaMinutes;
              return (
                <Pressable
                  key={m}
                  onPress={() => setEtaMinutes(String(m))}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${m} minutes`}
                  style={({ pressed }) => [
                    styles.chip,
                    selected ? styles.chipOn : null,
                    pressed ? styles.chipPressed : null,
                  ]}
                >
                  <Text style={[styles.chipText, selected ? styles.chipTextOn : null]}>{m}m</Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            value={etaMinutes}
            onChangeText={(v) => setEtaMinutes(v.replace(/[^0-9]/g, '').slice(0, 4))}
            keyboardType="number-pad"
            placeholder="30"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            accessibilityLabel="Expected minutes"
          />

          <Text style={styles.help}>
            Your estimate is used until this route has enough of your own history to beat it — then the
            learned median takes over and a check-in clock arms itself (FR-042).
          </Text>

          {canStart || starting ? null : (
            <Text style={styles.formError} accessibilityLiveRegion="polite">
              {destName.trim().length === 0
                ? 'A destination is needed — it is the key the route history is learned against.'
                : 'Minutes must be a number between 1 and 1440.'}
            </Text>
          )}

          {startFailed ? (
            <Text style={styles.formError} accessibilityLiveRegion="assertive">
              This phone could not start the journey. Nothing was saved. Try once more.
            </Text>
          ) : null}

          <Button
            label={starting ? 'Starting…' : t('home.startJourney')}
            onPress={() => void handleStart()}
            variant="primary"
            size="lg"
            disabled={!canStart}
            accessibilityLabel={`${t('home.startJourney')} to ${destName.trim() || 'destination'}`}
          />
        </Card>
      </Section>

      {!ready && journeys.length === 0 ? (
        // Bootstrap reads the journey table off disk. "Nobody is travelling" is a
        // statement of fact everywhere else on this screen; during that first
        // moment it would be a guess, and the wrong one.
        <EmptyState
          glyph="⋯"
          title="Reading journeys off this phone"
          body="Nothing is being fetched from a server. This takes a moment on a cold start."
        />
      ) : active.length === 0 ? (
        <EmptyState
          icon="users"
          title="Nobody is travelling"
          body="Journeys appear here the moment one starts. An empty list is the good outcome."
        />
      ) : (
        <>
          <Section title="Travellers now">
            {/* FamilyMapView owns the consent rules for pins; see the file header. */}
            <FamilyMapView members={travellers} presence={presence} height={MAP_HEIGHT} />
          </Section>

          <Section title={`On the way (${active.length})`}>
            {active.map((j) => {
              const resolved = fixFor(j);
              return (
                <JourneyCard
                  key={j.id}
                  journey={j}
                  traveller={memberById.get(j.memberId)}
                  fix={resolved.fix}
                  fixReason={resolved.reason}
                  isMine={me !== null && j.memberId === me.id}
                  now={now}
                  onCheckIn={() => void checkIn()}
                  onArrive={() => void arriveJourney(j.id)}
                />
              );
            })}
          </Section>
        </>
      )}

      {/* ★★ THE QUIET LADDER ★★ */}
      <Section title="If nobody hears from them">
        <Card tone="info">
          <Text style={styles.policyLead}>
            A missed arrival is the weakest evidence in the system, so it gets the slowest, quietest
            policy in the system. It goes to {deadman.l1AudienceRoles.join(', ')} only.
          </Text>
          <View style={styles.policyRow}>
            <Pill
              label={deadman.allowNeighbours ? 'Neighbours may be told' : 'Neighbours are never told'}
              tone={deadman.allowNeighbours ? 'warn' : 'ok'}
            />
            <Pill
              label={
                deadman.cancelWindowS === 0
                  ? 'No countdown'
                  : `${deadman.cancelWindowS}s countdown`
              }
              tone="neutral"
            />
            <Pill label="No siren" tone="ok" />
          </View>
          {ladder.map((step) => (
            <ListItem
              key={`${step.tier}-${step.atS}-${step.label}`}
              glyph={step.tier === 1 ? '·' : step.tier === 2 ? '··' : '···'}
              title={step.label}
              subtitle={step.channels.join(' · ')}
              right={step.atS === 0 ? 'at once' : `+${duration(step.atS * 1000)}`}
            />
          ))}
          <Text style={styles.help}>
            Fifteen minutes to the second tier, thirty to the third — against ninety seconds and three
            minutes for a crash. “Everyone” on the last rung means everyone in the family:
            allowNeighbours is false for this scenario, so no rung of this ladder reaches outside it.
            The sentence a guardian gets is “this journey looks off, can someone call them?”, and a
            phone call closes it (PRD §3.3, §7.5).
          </Text>
        </Card>
      </Section>

      {past.length > 0 ? (
        <Section title={`Finished (${past.length})`}>
          {past.map((j) => {
            const traveller = memberById.get(j.memberId);
            const took = j.arrivedAt === null ? null : j.arrivedAt - j.startedAt;
            return (
              <ListItem
                key={j.id}
                glyph="✓"
                title={j.label}
                subtitle={`${traveller?.displayName ?? 'Someone'} · ${j.originName} → ${j.destName}`}
                right={took === null ? relativeTime(j.startedAt) : duration(took)}
              />
            );
          })}
          <Text style={styles.help}>
            Finished journeys are the only training data the ETA has. They stay on this device — the
            corridor is stripped before a journey is ever posted (ADR-010).
          </Text>
        </Section>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.xl },

  lead: { color: colors.textDim, fontSize: font.body, lineHeight: font.body + 7 },

  fieldLabel: {
    color: colors.textDim,
    fontSize: font.tiny,
    fontWeight: weight.bold,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: space.xs,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    backgroundColor: colors.bgInput,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    color: colors.text,
    fontSize: font.body,
    marginBottom: space.md,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md },
  chip: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: 62,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
  },
  chipOn: { borderColor: colors.info, backgroundColor: colors.infoSoft },
  chipPressed: { opacity: 0.72 },
  chipText: { color: colors.textDim, fontSize: font.body, fontWeight: weight.semibold },
  chipTextOn: { color: colors.text },

  help: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 6 },
  // The sentence that explains why "Start" will not respond. In `colors.warn` on
  // a card it measured 2.71:1 — the one line on the form nobody could read was
  // the one line telling them what to fix. `warnText` is 7.85:1 there.
  formError: {
    color: colors.warnText,
    fontSize: font.small,
    lineHeight: font.small + 5,
    marginBottom: space.sm,
  },

  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardHeadText: { flex: 1, gap: space.xxs },
  cardTitle: { color: colors.text, fontSize: font.h3, fontWeight: weight.bold },
  cardSub: { color: colors.textDim, fontSize: font.small },

  metricRow: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  metric: {
    flex: 1,
    backgroundColor: colors.bgElevated,
    borderRadius: radius.md,
    padding: space.sm,
    gap: space.xxs,
  },
  metricLabel: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontWeight: weight.bold,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  metricValue: { color: colors.text, fontSize: font.h3, fontWeight: weight.bold },
  metricFoot: { color: colors.textDim, fontSize: font.tiny },

  deadman: {
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
    gap: space.xs,
  },
  deadmanTitle: { color: colors.text, fontSize: font.small, fontWeight: weight.bold },
  deadmanBody: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 5 },

  corridorCanvas: {
    width: '100%',
    height: MAP_HEIGHT,
    marginTop: space.md,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  corridorEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg, gap: space.xs },
  corridorEmptyTitle: { color: colors.text, fontSize: font.h3, fontWeight: weight.semibold },
  corridorEmptyBody: { color: colors.textDim, fontSize: font.small, textAlign: 'center', lineHeight: font.small + 5 },

  fixNote: { color: colors.textFaint, fontSize: font.small, marginTop: space.sm, lineHeight: font.small + 5 },

  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  grow: { flex: 1 },

  policyLead: { color: colors.text, fontSize: font.body, lineHeight: font.body + 7, marginBottom: space.md },
  policyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.md },
});
