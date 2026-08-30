/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DRILLS — the quarterly rehearsal (PRD §17.4)
 *
 * ★★★ P-063, DRILL FATIGUE, IS WHAT KILLS THIS FEATURE ★★★
 * Not the technology. A family will run the first drill, mostly run the second,
 * and quietly stop after that — unless the drill is short, dated, and free. So:
 *
 *   · four minutes, once a quarter, in the calendar, not "when we remember"
 *   · NOBODY RECORDS ANYTHING BY HAND. Every number on this screen is derived
 *     from the delivery receipts already in the incident log. A drill that ends
 *     with someone filling in a form is a drill that happens once.
 *   · the scorecard names what FAILED. A drill that cannot fail is theatre — the
 *     seeded quarterly drill exists precisely because it caught a phone that had
 *     been silently dead for fifteen hours (PRD §16.3).
 *   · a leaderboard, because a family will compete over a number they can see
 *     and will not comply with a chore they cannot.
 *
 * ★ THE CANARY IS NOT A DRILL (F-02 / F-03) ★
 * It exercises the machinery — watchdog tick, outbox, transports — and notifies
 * NOBODY. A canary that woke six people every few minutes would be muted within
 * a day and would then freeze every deploy behind a permanently "active"
 * incident. Only the quarterly and annual runs open a real incident.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { CONFIG } from '../src/core/config';
import type {
  Device,
  DrillRun,
  DrillScorecard,
  FourClocks,
  Incident,
  IncidentEventRow,
  Member,
  UUID,
} from '../src/core/types';
import { relativeTime } from '../src/i18n';
import { currentPolicy, ladderSteps, useKavach } from '../src/state/store';
import { isActive } from '../src/t0/stateMachine.generated';
import {
  Button,
  Card,
  CountdownRing,
  EmptyState,
  ListItem,
  MemberAvatar,
  Pill,
  Section,
  StateBadge,
} from '../src/ui/components';
import { MIN_TOUCH_TARGET, colors, font, radius, space, weight } from '../src/ui/theme';

/** PRD §17.4. Four minutes is the whole budget, start to scorecard. */
const DRILL_BUDGET_MS = 4 * 60_000;
/** A quarter. Past this the family is overdue and the card says so. */
const QUARTER_MS = 91 * 24 * 3_600_000;
const YEAR_MS = 365 * 24 * 3_600_000;
/** A drill run is matched to the incident it opened within this window. */
const MATCH_WINDOW_MS = 120_000;
/** Targets this build holds itself to. t2 comes from CONFIG; the rest are here. */
const T3_TARGET_MS = 5_000;
const T4_TARGET_MS = 120_000;
/** A node phone this warm has a battery worth looking at (annual inspection). */
const BATTERY_TEMP_WATCH_C = 40;

const KIND_LABEL: Record<DrillRun['kind'], string> = {
  canary: 'Canary',
  quarterly: 'Quarterly drill',
  annual_full: 'Annual full drill',
};

// ═══════════════════════════════════════════════════════════════════════════════
// Reading the log
// ═══════════════════════════════════════════════════════════════════════════════

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function durationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * ★ THE AUTOMATED SCORECARD ★
 *
 * Built entirely from rows the system wrote for its own reasons — DELIVERED,
 * DELIVERY_FAILED, CLAIM, ON_SCENE, TRANSMIT. Nobody is asked to time anything,
 * tick anything or remember anything, which is the only reason the fourth drill
 * of the year will still happen (P-063).
 */
function computeScorecard(
  incident: Incident,
  rows: IncidentEventRow[],
  members: Member[],
): DrillScorecard {
  const ordered = [...rows].sort((a, b) => a.localCreatedAt - b.localCreatedAt);

  const perMember: DrillScorecard['perMember'] = members.map((m) => {
    let received = false;
    let latencyMs: number | null = null;
    let acknowledged = false;
    let failureReason: string | undefined;

    for (const r of ordered) {
      const memberId = str(r.detail?.memberId);
      if (memberId !== m.id) continue;
      if (r.eventType === 'DELIVERED') {
        if (!received) {
          received = true;
          latencyMs = num(r.detail?.latencyMs) ?? r.localCreatedAt - incident.openedAt;
          if (r.sourceTransport === 'sms') {
            // Reaching someone only by SMS is a partial failure even though the
            // message arrived — it means every data leg to that phone was dead.
            failureReason = failureReason ?? 'Reached only by SMS — no data leg worked';
          }
        }
      } else if (r.eventType === 'DELIVERY_FAILED') {
        failureReason = str(r.detail?.reason) ?? 'Delivery failed';
      } else if (r.eventType === 'CLAIM' || r.eventType === 'ON_SCENE') {
        acknowledged = true;
      }
    }

    if (incident.ownerMemberId === m.id) acknowledged = true;
    if (!received && failureReason === undefined) {
      failureReason = 'No receipt of any kind from this device';
    }

    return failureReason === undefined
      ? { memberId: m.id, received, latencyMs, acknowledged }
      : { memberId: m.id, received, latencyMs, acknowledged, failureReason };
  });

  let firstClaimMemberId: UUID | null = incident.ownerMemberId;
  let firstClaimMs: number | null = null;
  for (const r of ordered) {
    if (r.eventType !== 'CLAIM') continue;
    firstClaimMemberId = str(r.detail?.memberId) ?? firstClaimMemberId;
    firstClaimMs = r.localCreatedAt - incident.openedAt;
    break;
  }
  if (firstClaimMs === null && incident.firstAckAt !== null) {
    firstClaimMs = incident.firstAckAt - incident.openedAt;
  }

  const firstOf = (types: string[]): number | null => {
    for (const r of ordered) if (types.includes(r.eventType)) return r.localCreatedAt;
    return null;
  };

  const clocks: FourClocks = {
    t0TriggerAt: incident.openedAt,
    t1ConfirmedAt: firstOf(['CANCEL_WINDOW_EXPIRED', 'PIN_CORRECT', 'MANUAL_TRIGGER']),
    t2FirstTransmitAt: firstOf(['TRANSMIT', 'DISPATCHED']),
    t3FirstNotifiedAt: incident.firstNotifiedAt ?? firstOf(['DELIVERED', 'LADDER']),
    t4FirstAckAt: incident.firstAckAt ?? firstOf(['CLAIM']),
  };

  return { perMember, firstClaimMemberId, firstClaimMs, clocks };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Four clocks vs SLO
// ═══════════════════════════════════════════════════════════════════════════════

interface ClockRow {
  key: string;
  label: string;
  measuredMs: number | null;
  targetMs: number;
  basis: string;
}

function clockRows(clocks: FourClocks, cancelWindowMs: number): ClockRow[] {
  const t0 = clocks.t0TriggerAt;
  const t1 = clocks.t1ConfirmedAt;
  const t2 = clocks.t2FirstTransmitAt;
  const t3 = clocks.t3FirstNotifiedAt;
  return [
    {
      key: 't1',
      label: 't1 · confirmed',
      measuredMs: t1 === null ? null : t1 - t0,
      // The cancel window is a design value, not a latency: passing means the
      // machine waited exactly as long as the policy said and no longer.
      targetMs: cancelWindowMs + 1_500,
      basis: 'from trigger · cancel window + 1.5 s',
    },
    {
      key: 't2',
      label: 't2 · first transmit',
      measuredMs: t2 === null ? null : t2 - (t1 ?? t0),
      targetMs: CONFIG.t2BudgetMs,
      basis: `from confirm · ${CONFIG.t2BudgetMs} ms budget`,
    },
    {
      key: 't3',
      label: 't3 · first notified',
      measuredMs: t3 === null ? null : t3 - (t2 ?? t0),
      targetMs: T3_TARGET_MS,
      basis: 'from transmit · delivery',
    },
    {
      key: 't4',
      label: 't4 · first ack',
      measuredMs: clocks.t4FirstAckAt === null ? null : clocks.t4FirstAckAt - t0,
      targetMs: T4_TARGET_MS,
      basis: 'from trigger · a human answered',
    },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// One drill
// ═══════════════════════════════════════════════════════════════════════════════

interface DrillCardProps {
  run: DrillRun;
  incident: Incident | null;
  members: Member[];
  scorecard: DrillScorecard | null;
  now: number;
  pendingUntil: number | null;
  cancelWindowMs: number;
}

function DrillCard({
  run,
  incident,
  members,
  scorecard,
  now,
  pendingUntil,
  cancelWindowMs,
}: DrillCardProps): React.ReactElement {
  const live = incident !== null && isActive(incident.state);
  const elapsedS = incident === null ? 0 : (now - incident.openedAt) / 1000;
  const ladder: ReturnType<typeof ladderSteps> =
    incident === null ? [] : ladderSteps(incident.trigger);
  const nameOf = (id: UUID | null): string =>
    members.find((m) => m.id === id)?.displayName ?? 'Nobody';

  const received = scorecard?.perMember.filter((p) => p.received).length ?? 0;
  const audience = scorecard?.perMember.length ?? 0;
  const missed = scorecard?.perMember.filter((p) => !p.received) ?? [];

  return (
    // The one card on this screen that arrives rather than sits: a run appears
    // the moment somebody starts a drill, and the rise says "this is new".
    <Card enter="rise" tone={live ? 'danger' : missed.length > 0 ? 'warn' : 'ok'}>
      <View style={styles.cardHead}>
        <View style={styles.cardHeadText}>
          <Text style={styles.cardTitle}>{KIND_LABEL[run.kind]}</Text>
          <Text style={styles.cardSub}>
            {relativeTime(run.startedAt)} · {run.audienceDeviceIds.length} device
            {run.audienceDeviceIds.length === 1 ? '' : 's'} ·{' '}
            {run.notifiesFamily ? 'family notified' : 'silent'}
          </Text>
        </View>
        {incident === null ? (
          <Pill label={run.notifiesFamily ? 'No incident' : 'Silent'} tone="neutral" />
        ) : (
          <StateBadge state={incident.state} />
        )}
      </View>

      {/* ★ Watching the ladder run. The steps are the policy's own data, marked
          against the wall clock — not a re-implementation of the schedule. */}
      {live ? (
        <View style={styles.live}>
          {pendingUntil !== null && pendingUntil > now ? (
            <View style={styles.ringWrap}>
              <CountdownRing
                totalMs={cancelWindowMs}
                remainingMs={pendingUntil - now}
                size={120}
                // CountdownRing paints the NUMERAL with this too, not just the
                // arc: `colors.warn` put a 40 px digit at 2.71:1 on the card.
                colour={colors.warnText}
              />
              <Text style={styles.help}>
                Cancel window. A drill uses the same countdown as the real thing, because rehearsing a
                different machine rehearses nothing.
              </Text>
            </View>
          ) : null}
          {ladder.map((step) => {
            const fired = elapsedS >= step.atS;
            return (
              <View key={`${step.tier}-${step.atS}-${step.label}`} style={styles.ladderRow}>
                <Text style={[styles.ladderMark, fired ? styles.ladderMarkOn : null]}>
                  {fired ? '✓' : '·'}
                </Text>
                <Text style={[styles.ladderLabel, fired ? styles.ladderLabelOn : null]}>
                  {step.label}
                </Text>
                <Text style={styles.ladderAt}>
                  {step.atS === 0 ? 'at once' : `+${step.atS}s`}
                </Text>
              </View>
            );
          })}
          <Text style={styles.help}>
            {Math.max(0, Math.round((DRILL_BUDGET_MS - (now - run.startedAt)) / 1000))} s of the
            four-minute budget left.
          </Text>
        </View>
      ) : null}

      {scorecard === null ? (
        <Text style={styles.help}>
          No scorecard. This run opened no incident, so there are no delivery receipts to score —
          which is correct for a canary: it exercises the transports and wakes nobody (F-02).
        </Text>
      ) : (
        <>
          {audience > 0 ? (
            <>
              <View style={styles.scoreHead}>
                <Text style={styles.scoreBig}>
                  {received}/{audience}
                </Text>
                <Text style={styles.scoreLabel}>agents received the alert</Text>
              </View>

              {scorecard.perMember.map((p) => {
                const member = members.find((m) => m.id === p.memberId);
                return (
                  <View key={p.memberId} style={styles.memberRow}>
                    {member ? <MemberAvatar member={member} size={30} /> : null}
                    <View style={styles.memberText}>
                      <Text style={styles.memberName}>{member?.displayName ?? p.memberId}</Text>
                      <Text style={styles.memberMeta}>
                        {p.received
                          ? `received in ${p.latencyMs === null ? '—' : durationMs(p.latencyMs)}`
                          : 'never received'}
                        {p.acknowledged ? ' · acknowledged' : ' · no answer'}
                      </Text>
                      {p.failureReason === undefined ? null : (
                        <Text style={styles.memberFail}>{p.failureReason}</Text>
                      )}
                    </View>
                    <Pill
                      label={p.received ? (p.acknowledged ? 'Answered' : 'Silent') : 'Missed'}
                      tone={p.received ? (p.acknowledged ? 'ok' : 'warn') : 'danger'}
                    />
                  </View>
                );
              })}

              <ListItem
                glyph="→"
                title={`First to claim: ${nameOf(scorecard.firstClaimMemberId)}`}
                subtitle={
                  scorecard.firstClaimMs === null
                    ? 'Nobody claimed this run'
                    : `${durationMs(scorecard.firstClaimMs)} after the trigger`
                }
              />
            </>
          ) : null}

          {/* ── Four clocks vs SLO ─────────────────────────────────────────── */}
          <Text style={styles.blockTitle}>Four clocks</Text>
          {clockRows(scorecard.clocks, cancelWindowMs).map((c) => {
            const pass = c.measuredMs !== null && c.measuredMs <= c.targetMs;
            return (
              <View key={c.key} style={styles.clockRow}>
                <View style={styles.clockText}>
                  <Text style={styles.clockLabel}>{c.label}</Text>
                  <Text style={styles.clockBasis}>{c.basis}</Text>
                </View>
                <Text style={styles.clockValue}>
                  {c.measuredMs === null ? '—' : durationMs(c.measuredMs)}
                </Text>
                <Pill
                  label={c.measuredMs === null ? 'No data' : pass ? 'Met' : 'Missed'}
                  tone={c.measuredMs === null ? 'neutral' : pass ? 'ok' : 'danger'}
                />
              </View>
            );
          })}

          {missed.length > 0 ? (
            <Text style={styles.failSummary}>
              {missed.length} device{missed.length === 1 ? '' : 's'} did not receive this drill. That
              is the finding — a drill that cannot fail is theatre. Fix the reason above before the
              next one.
            </Text>
          ) : null}
        </>
      )}

      <Text style={styles.footnote}>
        Every number here is read out of the incident log. Nobody timed anything by hand (P-063).
      </Text>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Screen
// ═══════════════════════════════════════════════════════════════════════════════

interface Standing {
  member: Member;
  runs: number;
  received: number;
  acknowledged: number;
  latencies: number[];
  claims: number;
}

export default function DrillsScreen(): React.ReactElement {
  const router = useRouter();

  const ready = useKavach((s) => s.ready);
  const drills = useKavach((s) => s.drills);
  const incidents = useKavach((s) => s.incidents);
  const incidentEvents = useKavach((s) => s.incidentEvents);
  const members = useKavach((s) => s.members);
  const devices = useKavach((s) => s.devices);
  const pendingUntil = useKavach((s) => s.pendingUntil);
  const lastCanaryAt = useKavach((s) => s.lastCanaryAt);
  const startDrill = useKavach((s) => s.startDrill);

  const [now, setNow] = useState(() => Date.now());
  const [armed, setArmed] = useState<DrillRun['kind'] | null>(null);
  const [running, setRunning] = useState<DrillRun['kind'] | null>(null);
  /** Which kind failed to start, if any. A press that produces nothing visible
   *  is how a family concludes the drill button is decorative (P-063). */
  const [launchFailed, setLaunchFailed] = useState<DrillRun['kind'] | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const cancelWindowMs = currentPolicy().scenarios.DRILL.cancelWindowS * 1000;

  /** A run is tied to the incident it opened by time. Canaries open none (F-02). */
  function incidentFor(run: DrillRun): Incident | null {
    if (run.kind === 'canary') return null;
    let best: Incident | null = null;
    let bestDelta = MATCH_WINDOW_MS;
    for (const i of incidents) {
      if (!i.isDrill) continue;
      const delta = Math.abs(i.openedAt - run.startedAt);
      if (delta <= bestDelta) {
        best = i;
        bestDelta = delta;
      }
    }
    return best;
  }

  /** Stored scorecard if the run has one; otherwise computed from the log, live. */
  const scored = useMemo(() => {
    return drills.map((run) => {
      const incident = incidentFor(run);
      const rows = incident === null ? [] : (incidentEvents[incident.id] ?? []);
      const audience = members.filter((m) =>
        devices.some((d) => d.memberId === m.id && run.audienceDeviceIds.includes(d.id)),
      );
      const scorecard =
        run.scorecard ??
        (incident === null ? null : computeScorecard(incident, rows, audience.length > 0 ? audience : members));
      return { run, incident, rows, scorecard };
    });
    // `incidents`/`incidentEvents` change as a live drill runs — that is what
    // makes the scorecard build itself while the family watches.
  }, [drills, incidents, incidentEvents, members, devices]);

  const lastQuarterly = useMemo(() => {
    let best: DrillRun | null = null;
    for (const d of drills) {
      if (d.kind !== 'quarterly') continue;
      if (best === null || d.startedAt > best.startedAt) best = d;
    }
    return best;
  }, [drills]);

  const lastAnnual = useMemo(() => {
    let best: DrillRun | null = null;
    for (const d of drills) {
      if (d.kind !== 'annual_full') continue;
      if (best === null || d.startedAt > best.startedAt) best = d;
    }
    return best;
  }, [drills]);

  const quarterlyOverdue = lastQuarterly === null || now - lastQuarterly.startedAt > QUARTER_MS;
  const annualOverdue = lastAnnual === null || now - lastAnnual.startedAt > YEAR_MS;

  /** ★ The leaderboard. Aggregated from scorecards; never entered by anyone. */
  const standings = useMemo(() => {
    const table = new Map<UUID, Standing>();
    for (const m of members) {
      table.set(m.id, { member: m, runs: 0, received: 0, acknowledged: 0, latencies: [], claims: 0 });
    }
    for (const entry of scored) {
      const card = entry.scorecard;
      if (card === null || card.perMember.length === 0) continue;
      for (const p of card.perMember) {
        const row = table.get(p.memberId);
        if (!row) continue;
        row.runs += 1;
        if (p.received) row.received += 1;
        if (p.acknowledged) row.acknowledged += 1;
        if (p.latencyMs !== null) row.latencies.push(p.latencyMs);
      }
      if (card.firstClaimMemberId !== null) {
        const row = table.get(card.firstClaimMemberId);
        if (row) row.claims += 1;
      }
    }
    return [...table.values()]
      .filter((s) => s.runs > 0)
      .sort((a, b) => {
        const ackA = a.acknowledged / a.runs;
        const ackB = b.acknowledged / b.runs;
        if (ackB !== ackA) return ackB - ackA;
        if (b.claims !== a.claims) return b.claims - a.claims;
        const mA = median(a.latencies);
        const mB = median(b.latencies);
        if (mA === null) return 1;
        if (mB === null) return -1;
        return mA - mB;
      });
  }, [scored, members]);

  const nodePhones = devices.filter((d: Device) => d.platform === 'node' || d.platform === 'fob');
  const swellingWatch = nodePhones.filter(
    (d) => (d.batteryTempC !== null && d.batteryTempC >= BATTERY_TEMP_WATCH_C) || d.batteryHealth !== 'good',
  );

  async function launch(kind: DrillRun['kind']): Promise<void> {
    setRunning(kind);
    setLaunchFailed(null);
    try {
      await startDrill(kind);
      setArmed(null);
    } catch {
      setLaunchFailed(kind);
    } finally {
      // A drill button stuck disabled is a drill that never runs again.
      setRunning(null);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* No title and no back chevron of its own: `_layout.tsx` gives this route
          a native header titled "Drills" and calls that header the guaranteed way
          back out. Two chevrons and two copies of the word were one job done
          twice. */}
      <Text style={styles.lead}>Four minutes, once a quarter. Put it in the calendar.</Text>

      <Card tone={quarterlyOverdue ? 'warn' : 'ok'}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>Quarterly drill</Text>
          <Pill
            label={
              lastQuarterly === null
                ? 'Never run'
                : quarterlyOverdue
                  ? 'Overdue'
                  : `Last ${relativeTime(lastQuarterly.startedAt)}`
            }
            tone={quarterlyOverdue ? 'warn' : 'ok'}
          />
        </View>
        <Text style={styles.help}>
          One trigger, the real ladder, the real transports, the real alarm — and a scorecard the
          moment it ends. It alerts everybody, which is the point: an alert nobody feels proves
          nothing. Budget: four minutes.
        </Text>
        {launchFailed === 'quarterly' ? (
          <Text style={styles.failSummary} accessibilityLiveRegion="assertive">
            This phone could not start the drill. Nobody was alerted. Try once more.
          </Text>
        ) : null}
        {armed === 'quarterly' ? (
          <View style={styles.actions}>
            <Button
              label={running === 'quarterly' ? 'Starting…' : 'Yes — alert the family'}
              onPress={() => void launch('quarterly')}
              variant="danger"
              size="lg"
              disabled={running !== null}
              style={styles.grow}
              accessibilityLabel="Confirm: run the quarterly drill and alert the whole family"
            />
            <Button
              label="Not now"
              onPress={() => setArmed(null)}
              variant="ghost"
              size="lg"
              style={styles.grow}
              accessibilityLabel="Cancel the quarterly drill"
            />
          </View>
        ) : (
          <Button
            label="Run the quarterly drill"
            onPress={() => setArmed('quarterly')}
            variant="primary"
            size="lg"
            accessibilityLabel="Run the quarterly drill — asks for confirmation first"
          />
        )}
      </Card>

      <Card>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>Canary</Text>
          <Pill
            label={lastCanaryAt === null ? 'Never' : relativeTime(lastCanaryAt)}
            tone={lastCanaryAt === null ? 'warn' : 'ok'}
          />
        </View>
        <Text style={styles.help}>
          Silent. Ticks the watchdog, drains the outbox, proves the transports are alive — and
          notifies nobody. Run it as often as you like; that is exactly why it wakes no one (F-03).
        </Text>
        {launchFailed === 'canary' ? (
          <Text style={styles.failSummary} accessibilityLiveRegion="polite">
            The canary could not run on this phone. Nothing was sent.
          </Text>
        ) : null}
        <Button
          label={running === 'canary' ? 'Running…' : 'Run canary now'}
          onPress={() => void launch('canary')}
          variant="ghost"
          size="lg"
          disabled={running !== null}
          accessibilityLabel="Run the silent canary check now"
        />
      </Card>

      {/* ★★ THE LEADERBOARD ★★ */}
      <Section title="Family leaderboard" right={<Pill label="Measured, not reported" tone="info" />}>
        {standings.length === 0 ? (
          <EmptyState
            glyph="≡"
            title="No drills scored yet"
            body="Run a quarterly drill and the table fills itself from the delivery receipts."
          />
        ) : (
          standings.map((s, i) => {
            const med = median(s.latencies);
            return (
              <View key={s.member.id} style={styles.standingRow}>
                <Text style={styles.rank}>#{i + 1}</Text>
                <MemberAvatar member={s.member} size={34} />
                <View style={styles.standingText}>
                  <Text style={styles.memberName}>{s.member.displayName}</Text>
                  <Text style={styles.memberMeta}>
                    answered {s.acknowledged}/{s.runs} · received {s.received}/{s.runs} ·{' '}
                    {med === null ? 'no timing' : `median ${durationMs(med)}`}
                  </Text>
                </View>
                {s.claims > 0 ? <Pill label={`${s.claims}× first`} tone="ok" /> : null}
              </View>
            );
          })
        )}
        <Text style={styles.footnote}>
          Ranked by how often you answered, then by who got there first, then by median delivery
          latency. Nothing here is self-reported — it is all receipts.
        </Text>
      </Section>

      {/* ── Runs and scorecards ─────────────────────────────────────────────── */}
      <Section title={`Runs (${scored.length})`}>
        {scored.length === 0 && !ready ? (
          // Drill history is read off disk during bootstrap. "No drills yet" is a
          // finding; before the read completes it would be a guess.
          <EmptyState
            glyph="⋯"
            title="Reading drill history"
            body="Off this phone, not off a server. A moment on a cold start."
          />
        ) : scored.length === 0 ? (
          <EmptyState glyph="◷" title="No drills yet" body="The first one takes four minutes." />
        ) : (
          scored.map((entry) => (
            <DrillCard
              key={entry.run.id}
              run={entry.run}
              incident={entry.incident}
              members={members}
              scorecard={entry.scorecard}
              now={now}
              pendingUntil={pendingUntil}
              cancelWindowMs={cancelWindowMs}
            />
          ))
        )}
      </Section>

      {/* ── The annual extras ───────────────────────────────────────────────── */}
      <Section
        title="Once a year, as well"
        right={<Pill label={annualOverdue ? 'Overdue' : 'Done'} tone={annualOverdue ? 'warn' : 'ok'} />}
      >
        <ListItem
          glyph="⚿"
          title="Key recovery"
          subtitle="Two guardians rebuild the vault key from their shares. 20 minutes."
          right="Open vault"
          onPress={() => router.push('/vault')}
        />
        <ListItem
          icon="archive"
          title="Backup restore"
          subtitle="Restore last month's backup onto a spare phone and open one document from it. A backup nobody has restored is a hope, not a backup."
        />
        <ListItem
          glyph="☰"
          title="Runbook handover"
          subtitle="Somebody other than the person who set this up walks the runbook start to finish, out loud, while the others listen for the step that only lives in their head."
        />
        <ListItem
          icon="alert-triangle"
          title="Node-phone battery inspection"
          subtitle={
            swellingWatch.length === 0
              ? `${nodePhones.length} always-on node${nodePhones.length === 1 ? '' : 's'}: look for a swollen pack, a lifting screen, a warm back.`
              : `${swellingWatch.length} node${swellingWatch.length === 1 ? '' : 's'} to inspect: ${swellingWatch
                  .map((d) => `${d.model ?? d.id} ${d.batteryTempC === null ? '' : `${d.batteryTempC}°C`} ${d.batteryHealth ?? ''}`.trim())
                  .join(', ')}`
          }
          danger={swellingWatch.length > 0}
        />
        <ListItem
          glyph="☰"
          title="IMEI verification"
          subtitle="Check every recorded IMEI still matches the phone it belongs to. Phones get replaced quietly."
          right="Open register"
          onPress={() => router.push('/vault')}
        />
        {launchFailed === 'annual_full' ? (
          <Text style={styles.failSummary} accessibilityLiveRegion="assertive">
            This phone could not start the drill. Nobody was alerted. Try once more.
          </Text>
        ) : null}
        {armed === 'annual_full' ? (
          <View style={styles.actions}>
            <Button
              label={running === 'annual_full' ? 'Starting…' : 'Yes — run the annual drill'}
              onPress={() => void launch('annual_full')}
              variant="danger"
              size="lg"
              disabled={running !== null}
              style={styles.grow}
              accessibilityLabel="Confirm: run the annual full drill and alert the whole family"
            />
            <Button
              label="Not now"
              onPress={() => setArmed(null)}
              variant="ghost"
              size="lg"
              style={styles.grow}
              accessibilityLabel="Cancel the annual full drill"
            />
          </View>
        ) : (
          <Button
            label="Run the annual full drill"
            onPress={() => setArmed('annual_full')}
            variant="ghost"
            size="lg"
            accessibilityLabel="Run the annual full drill — asks for confirmation first"
          />
        )}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.xl },

  lead: { color: colors.textDim, fontSize: font.body, lineHeight: font.body + 7 },

  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  cardHeadText: { flex: 1, gap: space.xxs },
  cardTitle: { flex: 1, color: colors.text, fontSize: font.h3, fontWeight: weight.bold },
  cardSub: { color: colors.textDim, fontSize: font.small },

  help: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 6, marginBottom: space.md },
  footnote: { color: colors.textFaint, fontSize: font.tiny, lineHeight: font.tiny + 6, marginTop: space.md },
  // "N devices did not receive this drill. That is the finding." A drill that
  // cannot fail is theatre, and a finding nobody can read is the same thing:
  // `colors.warn` on a card is 2.71:1, `warnText` 7.85:1.
  failSummary: {
    color: colors.warnText,
    fontSize: font.small,
    lineHeight: font.small + 6,
    marginTop: space.md,
  },

  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  grow: { flex: 1 },

  live: { gap: space.xs, marginBottom: space.md },
  ringWrap: { alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  ladderRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 28 },
  ladderMark: { width: 18, textAlign: 'center', color: colors.textFaint, fontSize: font.small, fontWeight: weight.bold },
  ladderMarkOn: { color: colors.okText },
  ladderLabel: { flex: 1, color: colors.textDim, fontSize: font.small },
  ladderLabelOn: { color: colors.text, fontWeight: weight.semibold },
  ladderAt: { color: colors.textFaint, fontSize: font.tiny, fontFamily: font.mono },

  scoreHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm, marginBottom: space.sm },
  scoreBig: { color: colors.text, fontSize: font.display, fontWeight: weight.heavy },
  scoreLabel: { flex: 1, color: colors.textDim, fontSize: font.small },

  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: space.xs,
  },
  memberText: { flex: 1, gap: space.xxs },
  memberName: { color: colors.text, fontSize: font.body, fontWeight: weight.semibold },
  memberMeta: { color: colors.textDim, fontSize: font.tiny },
  // Why one member's phone missed the drill — the sentence the whole scorecard
  // is for. It was 2.71:1 at 11 px, which is not a finding, it is a rumour.
  memberFail: { color: colors.warnText, fontSize: font.tiny, lineHeight: font.tiny + 5 },

  blockTitle: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontWeight: weight.bold,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: space.md,
    marginBottom: space.xs,
  },
  clockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  clockText: { flex: 1, gap: space.xxs },
  clockLabel: { color: colors.text, fontSize: font.small, fontWeight: weight.semibold },
  clockBasis: { color: colors.textFaint, fontSize: font.tiny },
  clockValue: { color: colors.text, fontSize: font.small, fontFamily: font.mono },

  standingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: MIN_TOUCH_TARGET + 6,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
  },
  rank: { width: 30, color: colors.textDim, fontSize: font.body, fontWeight: weight.heavy },
  standingText: { flex: 1, gap: space.xxs },
});
