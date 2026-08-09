/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * INCIDENTS — the stack, and the ledger that judges it.
 *
 * ★ WHY THE FALSE POSITIVE LEDGER IS AT THE TOP AND NOT IN A SUB-SCREEN ★
 * PRD §18.5: an automatic detector that cries wolf makes the family LESS safe
 * than no detector at all, because the first thing a family does with an alarm
 * they do not believe is silence it — and then the real one arrives muted. So
 * the false-positive rate is a P0 metric (§16.3 Dashboard 3), and the only way a
 * metric stays honest is if the people it indicts see it first, unprompted, with
 * the trigger and the confidence that produced each one attached. That is the
 * whole tuning feedback loop: FALL at 71% confidence produced a false alarm →
 * raise the threshold for that device.
 *
 * ★ F-03 — DRILLS ARE NOT FALSE POSITIVES ★
 * A drill is a deliberate trigger with a known answer. Counting drills into the
 * false-positive rate would let a family "improve" the number by never
 * practising, which inverts the incentive the drill exists to create. They are
 * separated visually AND arithmetically, in both directions: excluded from the
 * ledger, excluded from the rate, given their own section.
 *
 * ★ WHAT THIS SCREEN DELIBERATELY DOES NOT RENDER ★
 * `incident.duress` is on every row in memory and appears nowhere on screen.
 * F-01 makes the duress path indistinguishable from the ordinary cancel, and a
 * history list that quietly labels one incident "duress" hands that property to
 * whoever picks up the phone — which, in the scenario duress exists for, is the
 * person the PIN was typed in front of. ACTIVE_L1_SILENT sorts and renders
 * exactly as ACTIVE_L1 for the same reason.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import type { Incident, Member, TriggerType, UUID } from '../../src/core/types';
import { relativeTime } from '../../src/i18n';
import { useKavach } from '../../src/state/store';
import { isActive, type IncidentState } from '../../src/t0/stateMachine.generated';
import {
  Card,
  EmptyState,
  ListItem,
  Pill,
  PressableScale,
  Section,
  StateBadge,
} from '../../src/ui/components';
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

const DAY_MS = 86_400_000;
/**
 * How many incidents each ledger bucket lists inline.
 *
 * The bucket cards used to re-list every incident a second time, under the stack
 * that already lists them all — so opening this tab mounted a pressable row per
 * incident TWICE. The bucket's job is the tuning signal (which trigger, at what
 * confidence, went wrong), and three recent examples carry that as well as a
 * hundred do. The count next to the title is what carries the size.
 */
const LEDGER_PREVIEW = 3;
/** Same reasoning for the drills footer: the Drills filter is where all of them live. */
const DRILL_PREVIEW = 5;
/** Mean Gregorian month. The target is "<1 per user per MONTH", so months it is. */
const DAYS_PER_MONTH = 30.437;
/** PRD §16.3 Dashboard 3. The number this whole screen exists to hold us to. */
const FP_TARGET_PER_USER_MONTH = 1;

// ── Vocabulary ────────────────────────────────────────────────────────────────

/**
 * Plain language, not enum names. A family member reading their own history at
 * 3 a.m. should not have to know that NO_MOTION is a thing the phone can decide.
 */
const TRIGGER_LABEL: Record<TriggerType, string> = {
  MANUAL: 'Panic button',
  FALL: 'Fall detected',
  CRASH: 'Crash detected',
  NO_MOTION: 'No motion',
  DEADMAN: 'Missed check-in',
  GEOFENCE: 'Left a safe area',
  SENSOR_HOME: 'Home sensor',
  DEVICE_SILENCED: 'Phone went silent',
  BLE_FOB: 'Panic button pressed',
  VOICE_PHRASE: 'Spoken phrase',
  RELAY: 'Relayed from another phone',
  DRILL: 'Practice drill',
};

type LedgerKey = 'real' | 'false_alarm' | 'unknown' | 'unclassified';

interface Classification {
  key: LedgerKey;
  label: string;
  /** Used for the proportion bar. Always paired with a written legend (P-018). */
  colour: string;
  meaning: string;
}

const CLASSIFICATIONS: Classification[] = [
  { key: 'real', label: 'Real', colour: colors.danger, meaning: 'Something had actually happened.' },
  { key: 'false_alarm', label: 'False alarm', colour: colors.warn, meaning: 'The detector was wrong.' },
  { key: 'unknown', label: 'Never determined', colour: colors.textFaint, meaning: 'Closed without an answer.' },
  {
    key: 'unclassified',
    label: 'Not classified yet',
    colour: colors.info,
    // P-017: an unclassified incident is not neutral — it silently poisons every
    // threshold the system would otherwise learn from.
    meaning: 'Nobody has said yet whether this was real. Open it and say.',
  },
];

type FilterKey = 'all' | 'active' | 'drills' | 'false';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'drills', label: 'Drills' },
  { key: 'false', label: 'False alarms' },
];

/**
 * P-016 / P-057 — severity first, recency second.
 *
 * ACTIVE_L1 and ACTIVE_L1_SILENT share a rank deliberately (F-01). Owned and
 * resolving incidents rank below unowned live ones because somebody is already
 * on them: the list is a work queue, and the top of it must be what nobody has
 * picked up.
 */
const STATE_RANK: Record<IncidentState, number> = {
  ACTIVE_L3: 0,
  ACTIVE_L2: 1,
  ACTIVE_L1: 2,
  ACTIVE_L1_SILENT: 2,
  PENDING: 3,
  PROBE: 4,
  SUSPECT: 5,
  WATCH: 6,
  OWNED: 7,
  RESOLVING: 8,
  FALSE_ALARM: 9,
  RESOLVED: 9,
  DORMANT: 10,
  IDLE: 11,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A drill, or an incident that was classified as one. Never a false positive (F-03). */
function isDrillLike(i: Incident): boolean {
  return i.isDrill || i.outcome === 'drill';
}

function ledgerKeyOf(i: Incident): LedgerKey {
  if (i.outcome === null) return 'unclassified';
  if (i.outcome === 'real') return 'real';
  if (i.outcome === 'false_alarm') return 'false_alarm';
  return 'unknown';
}

function outcomeLine(i: Incident): string {
  const classification = CLASSIFICATIONS.find((c) => c.key === ledgerKeyOf(i));
  return isDrillLike(i) ? 'Drill' : (classification?.label ?? 'Not classified yet');
}

function sortForQueue(list: Incident[]): Incident[] {
  return [...list].sort((a, b) => {
    // ×2 leaves room for the tie-break below without disturbing the ranks.
    const rankA = STATE_RANK[a.state] * 2 + (a.outcome === null ? 0 : 1);
    const rankB = STATE_RANK[b.state] * 2 + (b.outcome === null ? 0 : 1);
    return rankA - rankB || b.openedAt - a.openedAt;
  });
}

function memberName(members: Member[], id: UUID): string {
  return members.find((m) => m.id === id)?.displayName ?? 'Unknown member';
}

function round2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

// ── Small local pieces ────────────────────────────────────────────────────────

interface ChipProps {
  label: string;
  count: number;
  selected: boolean;
  onPress: () => void;
}

function FilterChip({ label, count, selected, onPress }: ChipProps): ReactElement {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count} incidents`}
      // `selected` is what makes the current filter audible; without it the row
      // of chips is four identical buttons to a screen-reader user.
      accessibilityState={{ selected }}
      highlightColor={colors.focus}
      highlightRadius={radius.pill}
      style={[styles.chip, selected ? styles.chipSelected : null]}
    >
      {selected ? (
        <Text style={styles.chipTick} allowFontScaling={false} importantForAccessibility="no">
          ✓
        </Text>
      ) : null}
      <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>{label}</Text>
      <Text style={[styles.chipCount, selected ? styles.chipTextSelected : null]}>{count}</Text>
    </PressableScale>
  );
}

/**
 * Section's heading, standing on its own.
 *
 * The incident rows under this line are FlatList items rather than children of a
 * <Section/>, because a Section takes its children as a rendered array — which is
 * precisely the `.map()` that mounted every row of the stack on first paint. The
 * three type rules below are Section's; if they ever diverge, this is the copy to
 * bring back into line.
 */
function ListHeading({ title, right }: { title: string; right?: string }): ReactElement {
  return (
    <View style={styles.heading}>
      <Text accessibilityRole="header" numberOfLines={2} style={styles.headingTitle}>
        {title}
      </Text>
      {right === undefined ? null : <Text style={styles.headingRight}>{right}</Text>}
    </View>
  );
}

interface RowProps {
  incident: Incident;
  subjectName: string;
  onPress: () => void;
}

function IncidentRow({ incident, subjectName, onPress }: RowProps): ReactElement {
  const when = relativeTime(incident.openedAt);
  const confidence = `${Math.round(incident.confidencePct)}% confidence`;
  const subtitle = `${when} · ${outcomeLine(incident)} · ${confidence} · #${incident.inc8}`;

  return (
    <ListItem
      title={`${TRIGGER_LABEL[incident.trigger]} — ${subjectName}`}
      subtitle={subtitle}
      // Live and unclaimed is the only thing that earns the red edge; a resolved
      // emergency is history, and history that shouts is history that gets muted.
      danger={isActive(incident.state) && incident.firstAckAt === null}
      right={<StateBadge state={incident.state} compact />}
      onPress={onPress}
    />
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function IncidentsScreen(): ReactElement {
  const router = useRouter();
  const ready = useKavach((s) => s.ready);
  const incidents = useKavach((s) => s.incidents);
  const members = useKavach((s) => s.members);
  const [filter, setFilter] = useState<FilterKey>('all');

  /**
   * ★ The ledger. Computed over EVERY incident, never over the filtered view —
   * a rate you can improve by changing a filter is not a rate.
   */
  const ledger = useMemo(() => {
    const drills = incidents.filter(isDrillLike);
    const counted = incidents.filter((i) => !isDrillLike(i));

    const buckets = new Map<LedgerKey, Incident[]>();
    for (const c of CLASSIFICATIONS) buckets.set(c.key, []);
    for (const i of counted) buckets.get(ledgerKeyOf(i))?.push(i);
    // ★ Sorted here, once per change to `incidents`, and not in the render body.
    //   `sortForQueue(rows)` inside the CLASSIFICATIONS.map ran four copies and
    //   four sorts on EVERY render of this screen — and this screen subscribes to
    //   `s.incidents`, which the store replaces on every putIncident, every
    //   classification and every demo responder event.
    for (const [key, rows] of buckets) buckets.set(key, sortForQueue(rows));

    const falseAlarms = buckets.get('false_alarm')?.length ?? 0;
    const unclassified = buckets.get('unclassified')?.length ?? 0;

    // The observation window is the real one: from the oldest incident this
    // device holds until now. Assuming a month of history we do not have would
    // flatter the number, which is the one thing this metric must never do.
    const oldest = counted.reduce<number | null>(
      (acc, i) => (acc === null || i.openedAt < acc ? i.openedAt : acc),
      null,
    );
    const observedDays = oldest === null ? 0 : Math.max(1, (Date.now() - oldest) / DAY_MS);
    const users = Math.max(1, members.length);
    const rate =
      observedDays === 0 ? 0 : falseAlarms / users / (observedDays / DAYS_PER_MONTH);

    return {
      drills,
      counted,
      buckets,
      falseAlarms,
      unclassified,
      observedDays,
      users,
      rate,
      meetsTarget: rate < FP_TARGET_PER_USER_MONTH,
      // Under a fortnight, one bad night dominates the extrapolation. Say so
      // rather than printing a confident number nobody should act on.
      thin: observedDays < 14,
    };
  }, [incidents, members]);

  const visible = useMemo(() => {
    switch (filter) {
      case 'active':
        return incidents.filter((i) => isActive(i.state));
      case 'drills':
        return incidents.filter(isDrillLike);
      case 'false':
        // F-03 again, at the filter: a drill can never appear here.
        return incidents.filter((i) => !isDrillLike(i) && i.outcome === 'false_alarm');
      case 'all':
      default:
        return incidents;
    }
  }, [incidents, filter]);

  const realRows = useMemo(() => sortForQueue(visible.filter((i) => !isDrillLike(i))), [visible]);
  const drillRows = useMemo(() => sortForQueue(visible.filter(isDrillLike)), [visible]);

  const counts = useMemo(
    () => ({
      all: incidents.length,
      active: incidents.filter((i) => isActive(i.state)).length,
      drills: incidents.filter(isDrillLike).length,
      false: incidents.filter((i) => !isDrillLike(i) && i.outcome === 'false_alarm').length,
    }),
    [incidents],
  );

  const open = useCallback(
    (id: UUID): void => {
      router.push(`/incident/${id}`);
    },
    [router],
  );

  /**
   * ★ The stack is now ONE list, and the Drills filter finally shows drills.
   * It never did: `realRows` strips drills out, so selecting Drills left the
   * section empty while the drills block below it was suppressed by
   * `filter !== 'drills'`. The filter with the biggest count showed nothing.
   */
  const stackRows = filter === 'drills' ? drillRows : realRows;

  const rateTone = ledger.falseAlarms === 0 || ledger.meetsTarget ? 'ok' : ledger.rate < 2 ? 'warn' : 'danger';
  // ★ The *Text* tokens. This number renders at font.display heavy inside a toned
  //   Card, where the fills measure 2.46 / 2.68 / 3.05:1 against their own soft
  //   panel — the P0 metric of the whole product was the least legible thing on
  //   the screen that exists to hold us to it. Now 8.02 / 7.75 / 8.77:1.
  const rateColour =
    rateTone === 'ok' ? colors.okText : rateTone === 'warn' ? colors.warnText : colors.dangerText;

  const renderRow = useCallback(
    ({ item }: { item: Incident }) => (
      <IncidentRow
        incident={item}
        subjectName={memberName(members, item.subjectMemberId)}
        onPress={() => open(item.id)}
      />
    ),
    [members, open],
  );

  const subtitle = !ready
    ? 'Reading the log on this phone.'
    : incidents.length === 0
      ? 'Nothing has ever triggered on this family.'
      : `${incidents.length} in the log · ${ledger.unclassified} still ${
          ledger.unclassified === 1 ? 'needs' : 'need'
        } an answer`;

  const headerBlock = (
    <View style={styles.headerBlock}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={`Incidents. ${subtitle}`}
        style={styles.header}
      >
        <Text style={styles.screenTitle}>Incidents</Text>
        <Text style={styles.screenSubtitle}>{subtitle}</Text>
      </View>

      {/* ── False Positive Ledger (PRD §16.3 Dashboard 3, §18.5) ───────────── */}
      <Section title="False positive ledger">
        <Card tone={rateTone === 'ok' ? 'ok' : rateTone === 'warn' ? 'warn' : 'danger'}>
          <View style={styles.rateRow}>
            <View style={styles.rateNumber}>
              <Text style={[styles.rateValue, { color: rateColour }]}>{round2(ledger.rate)}</Text>
              <Text style={styles.rateUnit}>false alarms per person per month</Text>
            </View>
            <Pill
              label={ledger.meetsTarget ? 'Within target' : 'Over target'}
              tone={ledger.meetsTarget ? 'ok' : rateTone === 'warn' ? 'warn' : 'danger'}
            />
          </View>

          <Text style={styles.body}>
            Target: under {FP_TARGET_PER_USER_MONTH} per person per month. A detector that cries
            wolf makes this family less safe than no detector at all — the alarm gets muted, and
            then the real one arrives muted too.
          </Text>

          <Text style={styles.meta}>
            {ledger.falseAlarms} false {ledger.falseAlarms === 1 ? 'alarm' : 'alarms'} ·{' '}
            {ledger.counted.length} incidents counted · {ledger.users}{' '}
            {ledger.users === 1 ? 'person' : 'people'} · {Math.round(ledger.observedDays)} days of
            history
          </Text>

          {ledger.thin ? (
            <Text style={styles.caveat}>
              Projected from under a fortnight of history. One unusual night still moves this
              number a long way; it tightens as the log grows.
            </Text>
          ) : null}

          {/* F-03 stated on the surface, not just enforced in the arithmetic. */}
          <Text style={styles.meta}>
            {ledger.drills.length} {ledger.drills.length === 1 ? 'drill is' : 'drills are'}{' '}
            excluded. A drill is a deliberate trigger with a known answer — counting it here would
            reward never practising.
          </Text>

          {ledger.counted.length > 0 ? (
            <View
              accessible
              accessibilityRole="image"
              accessibilityLabel={CLASSIFICATIONS.map(
                (c) => `${ledger.buckets.get(c.key)?.length ?? 0} ${c.label}`,
              ).join(', ')}
              style={styles.bar}
            >
              {CLASSIFICATIONS.map((c) => {
                const n = ledger.buckets.get(c.key)?.length ?? 0;
                if (n === 0) return null;
                return (
                  <View key={c.key} style={[styles.barSegment, { flex: n, backgroundColor: c.colour }]} />
                );
              })}
            </View>
          ) : null}
        </Card>

        {/* Classification × trigger × confidence — the tuning signal itself.
            Already sorted in the memo above; three examples per bucket, because
            the full list is the stack lower down and rendering it twice is what
            mounted two hundred rows on first paint. */}
        {CLASSIFICATIONS.map((c) => {
          const rows = ledger.buckets.get(c.key) ?? [];
          if (rows.length === 0) return null;
          const shown = rows.slice(0, LEDGER_PREVIEW);
          return (
            <Card key={c.key} enter="rise">
              <View style={styles.bucketHeader}>
                <View style={styles.swatchRow}>
                  <View style={[styles.swatch, { backgroundColor: c.colour }]} />
                  <Text style={styles.h3}>{c.label}</Text>
                </View>
                <Text style={styles.count}>{rows.length}</Text>
              </View>
              <Text style={styles.meta}>{c.meaning}</Text>
              {shown.map((i) => (
                <PressableScale
                  key={i.id}
                  onPress={() => open(i.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${TRIGGER_LABEL[i.trigger]}, ${Math.round(
                    i.confidencePct,
                  )} percent confidence, ${relativeTime(i.openedAt)}. Open incident.`}
                  highlightColor={colors.info}
                  highlightRadius={radius.md}
                  style={styles.evidence}
                >
                  <Text style={styles.evidenceTrigger}>{TRIGGER_LABEL[i.trigger]}</Text>
                  <Text style={styles.evidenceMeta}>
                    {Math.round(i.confidencePct)}% · risk {i.riskContext} ·{' '}
                    {relativeTime(i.openedAt)}
                  </Text>
                </PressableScale>
              ))}
              {rows.length > shown.length ? (
                // Deliberately does not say "in the list below": the list below
                // obeys the filter, and the ledger never does.
                <Text style={styles.meta}>
                  The {shown.length} most recent. {rows.length - shown.length} more are in the log.
                </Text>
              ) : null}
            </Card>
          );
        })}

        {ledger.unclassified > 0 ? (
          <Card tone="info">
            <Text style={styles.h3}>
              {ledger.unclassified} {ledger.unclassified === 1 ? 'incident needs' : 'incidents need'}{' '}
              an answer
            </Text>
            <Text style={styles.body}>
              Until somebody says whether these were real, they count for nothing and the
              thresholds learn nothing from them. Open one and classify it.
            </Text>
          </Card>
        ) : null}
      </Section>

      {/* ── Filters ──────────────────────────────────────────────────────────── */}
      <View style={styles.chipRow}>
        {FILTERS.map((f) => (
          <FilterChip
            key={f.key}
            label={f.label}
            count={counts[f.key]}
            selected={filter === f.key}
            onPress={() => setFilter(f.key)}
          />
        ))}
      </View>

      <ListHeading
        title={filter === 'drills' ? 'Drills' : 'Incidents'}
        right={`${stackRows.length}`}
      />
    </View>
  );

  /* Separated, always. Never folded into the list above (F-03). The five most
     recent, with the Drills filter as the way to all of them — a footer is not
     virtualised, and drills accumulate one silent canary at a time. */
  const drillFooter =
    drillRows.length > 0 && filter !== 'drills' ? (
      <View style={styles.footerBlock}>
        <ListHeading title="Drills — practice, not emergencies" right={`${drillRows.length}`} />
        <Text style={styles.meta}>
          These were triggered on purpose to find out whether the machinery still works. They do not
          count towards the false positive rate.
        </Text>
        {drillRows.slice(0, DRILL_PREVIEW).map((i) => (
          <IncidentRow
            key={i.id}
            incident={i}
            subjectName={memberName(members, i.subjectMemberId)}
            onPress={() => open(i.id)}
          />
        ))}
        {drillRows.length > DRILL_PREVIEW ? (
          <Text style={styles.meta}>
            The {DRILL_PREVIEW} most recent of {drillRows.length}. Tap “Drills” above for the rest.
          </Text>
        ) : null}
      </View>
    ) : null;

  /**
   * The log lives on this phone, so "loading" is a database read and never a
   * network wait. Saying which one it is stops a slow open reading as a failure.
   */
  if (!ready) {
    return (
      <SafeAreaView edges={['top']} style={styles.screen}>
        <View style={styles.content}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.screenTitle}>
              Incidents
            </Text>
            <Text style={styles.screenSubtitle}>{subtitle}</Text>
          </View>
          <View style={[styles.skeleton, styles.skeletonTall]} />
          <View style={styles.skeleton} />
          <View style={styles.skeleton} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      {/*
        ★ ONE FlatList, NOT a ScrollView full of .map() ★
        store.loadEverything holds 100 incidents and this screen used to render
        each of them twice — once inside its ledger bucket and once in the stack —
        so opening the tab mounted ~200 pressable rows synchronously on a phone
        that cost ₹6,000. The ledger and the filters are the header, the drills
        are the footer, and only the stack is windowed. Putting them in
        ListHeader/ListFooter rather than around the list is also what keeps this
        from being a VirtualizedList nested inside a ScrollView.

        No getItemLayout: ListItem has a MIN_TOUCH_TARGET floor but its subtitle
        wraps to three lines, so a fixed row height would be a lie that shows up
        as a jumping scrollbar.
      */}
      <FlatList
        data={stackRows}
        keyExtractor={(i) => i.id}
        renderItem={renderRow}
        contentContainerStyle={styles.content}
        ListHeaderComponent={headerBlock}
        ListFooterComponent={drillFooter}
        ListEmptyComponent={
          <EmptyState
            glyph="✓"
            title={filter === 'all' ? 'No incidents' : 'Nothing matches this filter'}
            body={
              filter === 'all'
                ? 'Nothing has ever triggered on this family. That is the outcome this app is built for.'
                : 'Try another filter — the history is still there.'
            }
          />
        }
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
        keyboardShouldPersistTaps="handled"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    // The tab bar is laid out below this scene and pads its own inset, so the
    // 96 dp that used to be here was half a screen of blank at the end of the
    // list — and every tab guessed a different number for it. One rule now.
    paddingBottom: space.xl,
    // Row spacing. The header and footer blocks carry their own space.lg
    // internally; the list itself wants Section's own body rhythm.
    gap: space.sm,
  },
  headerBlock: { gap: space.lg },
  footerBlock: { gap: space.sm, paddingTop: space.md },

  header: { gap: space.xxs },
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

  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    minHeight: 20,
  },
  headingTitle: {
    flexShrink: 1,
    color: colors.textDim,
    fontSize: font.small,
    fontWeight: weight.semibold,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  headingRight: { color: colors.textDim, fontSize: font.small, fontWeight: weight.medium },

  skeleton: {
    height: 72,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
  },
  skeletonTall: { height: 148 },

  h3: { color: colors.text, fontSize: font.h3, fontWeight: weight.semibold },
  body: { color: colors.text, fontSize: font.body, fontWeight: weight.regular, lineHeight: leading.body },
  meta: { color: colors.textDim, fontSize: font.small, fontWeight: weight.regular, lineHeight: leading.small },
  // warnText, not warn: this caveat is the sentence that stops someone acting on
  // a number projected from ten days of history, and `warn` on bgCard is 2.71:1.
  caveat: { color: colors.warnText, fontSize: font.small, fontWeight: weight.medium, lineHeight: leading.small },
  count: { color: colors.textDim, fontSize: font.h3, fontWeight: weight.bold },

  rateRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md },
  rateNumber: { flex: 1, gap: space.xxs },
  rateValue: { fontSize: font.display, fontWeight: weight.heavy },
  rateUnit: { color: colors.textDim, fontSize: font.small, fontWeight: weight.medium },

  bar: { flexDirection: 'row', height: 10, borderRadius: radius.pill, overflow: 'hidden', gap: 2 },
  barSegment: { height: 10 },

  bucketHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  swatchRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexShrink: 1 },
  swatch: { width: 12, height: 12, borderRadius: radius.sm },

  evidence: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  evidenceTrigger: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: weight.semibold },
  evidenceMeta: { color: colors.textDim, fontSize: font.small, fontWeight: weight.medium },

  // ── the shared chip ─────────────────────────────────────────────────────────
  // Byte-for-byte the geometry on home, map and settings. See home.tsx.
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
  chipCount: { color: colors.textFaint, fontSize: font.small, fontWeight: weight.bold },
});
