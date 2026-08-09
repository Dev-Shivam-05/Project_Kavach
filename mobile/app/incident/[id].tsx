/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE RESPONDER VIEW
 *
 * This is the screen a family member lands on from the notification. Everything
 * on it exists to answer four questions in order, because that is the order a
 * frightened person asks them in:
 *   1. Who, and what happened?          — subject, trigger, state, elapsed
 *   2. Is anyone going?                 — the owner banner (P-003)
 *   3. Where are they, and what do the paramedics need to know?
 *                                       — sealed payload + break-glass medical
 *   4. What happens next, and what did already happen?
 *                                       — the ladder and the HLC-ordered log
 *
 * ★ P-003 — THE SINGLE MOST IMPORTANT STRING IN THE PRODUCT ★
 *   Until `ownerMemberId` is set, this screen shouts t('panic.nobodyResponded').
 *   Six phones buzzing and six people assuming one of the others has it is the
 *   documented failure mode; the only defence is making "nobody" visible.
 *
 * ★ P-030 CORRECTION 1 — A CLAIM MUST NOT PRODUCE SILENCE ★
 *   After someone claims, the others do NOT get a blank screen. They get a
 *   persistent quiet banner (t('panic.responding')) that stays up for the life
 *   of the incident. Full silence makes the other five responders forget an
 *   emergency is in progress, and the store agrees with this screen: `OWNED`
 *   stops the siren and re-posts the notification rather than clearing it.
 *
 * ★ THE UN-CLAIM PATH IS NOT OPTIONAL ★
 *   t('panic.release') — "I can't get there". Without it, the first person to
 *   claim gets stuck in traffic and the other five have stood down permanently.
 *   Releasing must be exactly as cheap as claiming, or nobody ever claims.
 *
 * ★ EVERY CONTROL IS GATED ON THE GENERATED MACHINE, NOT ON A GUESS ★
 *   Enablement is computed with `nextState()` so a button can never be a no-op:
 *   if the transition does not exist from the current state, the control says so
 *   instead of silently swallowing the press (ADR-018, hard rule 1).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';

import { ladderFor } from '../../src/core/policy';
import {
  DEGRADATION_LABELS,
  DegradationLevel,
  type Incident,
  type IncidentEventRow,
  type IncidentOutcome,
  type Member,
  type UUID,
} from '../../src/core/types';
import { t } from '../../src/i18n';
import { currentPolicy, useKavach } from '../../src/state/store';
import { isActive, isTerminal, nextState } from '../../src/t0/stateMachine.generated';
import {
  BigCoordinates,
  Button,
  Call112Button,
  Card,
  EmptyState,
  MemberAvatar,
  Pill,
  Section,
  StateBadge,
} from '../../src/ui/components';
import { colors, font, radius, space, weight } from '../../src/ui/theme';

/**
 * How much of the log renders before the responder asks for the rest.
 * `store.appendRow` appends without a cap, so a long incident grows this list
 * without bound; the four clocks card above already carries the opening of the
 * timeline, so the useful default is the recent end of it.
 */
const LOG_VISIBLE = 40;

/**
 * ★ THE 1 Hz TICK, SUBSCRIBED WHERE IT IS READ ★
 *
 * This used to be one `setNow` on the screen, which repainted the decrypted
 * medical card, the sealed payload, the event log and the classify buttons once
 * a second for a value none of them use. Each clock now owns its own interval,
 * so a tick's render scope is the four numbers that actually changed.
 *
 * The interval is torn down the moment the incident is terminal: a resolved
 * incident has a frozen elapsed time, and a ticking one would imply it is open.
 */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [active]);
  return now;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Screen
// ═══════════════════════════════════════════════════════════════════════════════

export default function IncidentScreen(): ReactElement {
  const params = useLocalSearchParams();
  const raw = params.id;
  const id: UUID = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');

  // Selectors return stored references, never freshly-built objects: zustand v5
  // compares with Object.is and a new array per render is an infinite loop.
  const incident = useKavach((s) => s.incidents.find((i) => i.id === id) ?? null);
  const events = useKavach((s) => s.incidentEvents[id]);
  const members = useKavach((s) => s.members);
  const me = useKavach((s) => s.me);
  const degradation = useKavach((s) => s.degradation);
  // Bootstrap reads the incident table off disk asynchronously. Without this the
  // screen spends the first frames of a cold start telling a responder the
  // incident "is not on this phone", which is both false and the worst possible
  // thing to say to someone who just opened a notification.
  const ready = useKavach((s) => s.ready);
  const claim = useKavach((s) => s.claim);
  const release = useKavach((s) => s.release);
  const onScene = useKavach((s) => s.onScene);
  const resolveIncident = useKavach((s) => s.resolveIncident);
  const classify = useKavach((s) => s.classify);

  const live = incident !== null && !isTerminal(incident.state);
  const insets = useSafeAreaInsets();

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);

  const byId = useMemo(() => {
    const map = new Map<UUID, Member>();
    for (const m of members) map.set(m.id, m);
    return map;
  }, [members]);

  const nameOf = useCallback(
    (memberId: UUID | null | undefined): string | null => {
      if (!memberId) return null;
      return byId.get(memberId)?.displayName ?? null;
    },
    [byId],
  );

  const onClaim = useCallback(() => {
    void claim(id);
  }, [claim, id]);
  const onRelease = useCallback(() => {
    void release(id);
  }, [release, id]);
  const onArrived = useCallback(() => {
    void onScene(id);
  }, [onScene, id]);
  const onResolve = useCallback(() => {
    void resolveIncident(id);
  }, [resolveIncident, id]);
  const onClassify = useCallback(
    (outcome: IncidentOutcome) => {
      void classify(id, outcome);
    },
    [classify, id],
  );

  if (incident === null) {
    return (
      <View style={styles.screen}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        {ready ? (
          <EmptyState
            glyph="?"
            title="This incident is not on this phone"
            body="It was opened by a device that has not synced here yet, or the link is stale."
            action={{ label: t('common.close'), onPress: goBack }}
            style={styles.notFound}
          />
        ) : (
          <EmptyState
            glyph="⋯"
            title="Opening this incident"
            body="Reading it off this phone. Nothing is being fetched from a server."
            style={styles.notFound}
          />
        )}
      </View>
    );
  }

  const subject = byId.get(incident.subjectMemberId) ?? null;
  const ownerName = nameOf(incident.ownerMemberId);
  const iOwnIt = me !== null && incident.ownerMemberId === me.id;
  const scenario = currentPolicy().scenarios[incident.trigger];

  // The machine is the authority on what is possible from here. `resolveIncident`
  // in the store tries TWO_PARTY_CONFIRM first and falls back to SELF_CLEAR_PIN,
  // so the control is live if EITHER transition exists.
  const canClaim = nextState(incident.state, 'CLAIM') !== null;
  const canRelease = nextState(incident.state, 'RELEASE') !== null;
  const canArrive = nextState(incident.state, 'ON_SCENE') !== null;
  const canResolve =
    nextState(incident.state, 'TWO_PARTY_CONFIRM') !== null ||
    nextState(incident.state, 'SELF_CLEAR_PIN') !== null;

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* No back control of its own: `_layout.tsx` gives this route a native
            header, and its own comment says that header IS the guaranteed way
            back out. A second chevron eight points below the first one is how a
            product ends up with seven different ways to leave a screen. */}
        <ScreenHeader
          title={subject?.displayName ?? 'Family member'}
          subtitle={scenario?.label ?? incident.trigger}
          right={<StateBadge state={incident.state} />}
        />

        <OwnerBanner ownerName={ownerName} iOwnIt={iOwnIt} live={live} />

        <IdentityCard
          incident={incident}
          subject={subject}
          live={live}
          degradation={degradation}
        />

        <FourClocksCard incident={incident} live={live} />

        <LadderCard incident={incident} live={live} />

        <SealedCard incident={incident} />

        <BreakGlassMedical incident={incident} />

        <EventLog rows={events} nameOf={nameOf} />

        <ClassifySection outcome={incident.outcome} onClassify={onClassify} />

        <View style={styles.scrollTail} />
      </ScrollView>

      <ActionBar
        live={live}
        canClaim={canClaim}
        canRelease={canRelease}
        canArrive={canArrive}
        canResolve={canResolve}
        onClaim={onClaim}
        onRelease={onRelease}
        onArrived={onArrived}
        onResolve={onResolve}
        bottomInset={insets.bottom}
      />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Header
// ═══════════════════════════════════════════════════════════════════════════════

function ScreenHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactElement;
}): ReactElement {
  return (
    <View style={styles.header}>
      <View style={styles.headerText}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>

      {right ?? null}
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// The owner banner — P-003 and P-030 correction 1 live here
// ═══════════════════════════════════════════════════════════════════════════════

const OwnerBanner = memo(function OwnerBanner({
  ownerName,
  iOwnIt,
  live,
}: {
  ownerName: string | null;
  iOwnIt: boolean;
  live: boolean;
}): ReactElement | null {
  if (!live) return null;

  // ★ P-003. Loudest element on the screen while nobody has claimed. It is not a
  //   status line — it is an accusation, and it is meant to feel like one.
  if (ownerName === null) {
    return (
      <View
        style={styles.unackedBanner}
        accessibilityRole="alert"
        accessibilityLiveRegion="assertive"
        accessibilityLabel={t('panic.nobodyResponded')}
      >
        <Text style={styles.unackedText} allowFontScaling={false}>
          {t('panic.nobodyResponded')}
        </Text>
        <Text style={styles.unackedHint}>
          Every phone in the family is showing this. Claiming it is what stops the guessing.
        </Text>
      </View>
    );
  }

  // ★ P-030 correction 1. Quiet, but PERSISTENT — it does not dismiss, time out
  //   or fade, because the failure this prevents is people forgetting.
  return (
    <View
      style={styles.respondingBanner}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={t('panic.responding', { name: ownerName })}
    >
      <Text style={styles.respondingText}>{t('panic.responding', { name: ownerName })}</Text>
      <Text style={styles.respondingHint}>
        {iOwnIt
          ? 'You own this. If anything stops you getting there, release it immediately.'
          : 'This banner stays until the incident closes. Do not stand down.'}
      </Text>
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Identity — who, what, how long, under what conditions
// ═══════════════════════════════════════════════════════════════════════════════

/** The only node in the identity card that changes every second. */
const ElapsedClock = memo(function ElapsedClock({
  openedAt,
  resolvedAt,
  live,
}: {
  openedAt: number;
  resolvedAt: number | null;
  live: boolean;
}): ReactElement {
  const now = useSecondTick(live);
  return (
    <View style={styles.elapsedBlock}>
      <Text style={styles.elapsedValue} allowFontScaling={false}>
        {formatElapsed((resolvedAt ?? now) - openedAt)}
      </Text>
      <Text style={styles.elapsedLabel} allowFontScaling={false}>
        ELAPSED
      </Text>
    </View>
  );
});

const IdentityCard = memo(function IdentityCard({
  incident,
  subject,
  live,
  degradation,
}: {
  incident: Incident;
  subject: Member | null;
  live: boolean;
  degradation: DegradationLevel;
}): ReactElement {
  return (
    <Card tone={isActive(incident.state) ? 'danger' : undefined}>
      <View style={styles.identityRow}>
        {subject === null ? null : <MemberAvatar member={subject} size={52} />}
        <View style={styles.identityText}>
          <Text style={styles.identityName} numberOfLines={1}>
            {subject?.displayName ?? incident.subjectMemberId}
          </Text>
          <Text style={styles.identityMeta} numberOfLines={1}>
            {`#${incident.inc8} · ${incident.trigger}`}
          </Text>
        </View>
        <ElapsedClock openedAt={incident.openedAt} resolvedAt={incident.resolvedAt} live={live} />
      </View>

      <View style={styles.pillRow}>
        {/* Confidence and risk are the two numbers that decided how fast this
            escalated; a responder second-guessing the alert deserves to see both. */}
        <Pill label={`Confidence ${incident.confidencePct}%`} tone="info" glyph="%" />
        <Pill
          label={`Risk ${incident.riskContext}`}
          tone={incident.riskContext >= 3 ? 'danger' : incident.riskContext >= 2 ? 'warn' : 'neutral'}
          glyph="▲"
        />
        {/* §4.4: the rung is stated honestly on the responder's screen too — a
            responder who thinks the family is fully connected will not think to
            phone around when the incident is riding an SMS leg. */}
        <Pill
          label={DEGRADATION_LABELS[degradation]}
          tone={
            degradation === DegradationLevel.FULL
              ? 'ok'
              : degradation <= DegradationLevel.SMS_ONLY
                ? 'danger'
                : 'warn'
          }
        />
        {incident.isDrill ? <Pill label="DRILL" tone="info" glyph="◎" /> : null}
        {incident.syntheticFromSms ? <Pill label="From SMS" tone="warn" /> : null}
      </View>

      {/* ★ F-01: duress is NEVER surfaced on the subject's own device. It is shown
          here because a responder walking into a coercion scene must know. */}
      {incident.duress ? (
        <View style={styles.duressStrip}>
          <Text style={styles.duressText}>
            Duress PIN was used. Treat as coerced — do not announce this alert on arrival.
          </Text>
        </View>
      ) : null}
    </Card>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// The four clocks (PRD §1.6)
// ═══════════════════════════════════════════════════════════════════════════════

const FourClocksCard = memo(function FourClocksCard({
  incident,
  live,
}: {
  incident: Incident;
  live: boolean;
}): ReactElement {
  const now = useSecondTick(live);
  const t0 = incident.openedAt;
  return (
    <Section title="The four clocks">
      <Card>
        <ClockRow label="t0 · Trigger" at={t0} base={null} now={now} />
        <ClockRow
          label="t3 · First notified"
          at={incident.firstNotifiedAt}
          base={t0}
          now={now}
          pendingNote="Nothing has left this phone yet"
        />
        <ClockRow
          label="t4 · First acknowledged"
          at={incident.firstAckAt}
          base={t0}
          now={now}
          pendingNote={t('panic.nobodyResponded')}
        />
        <ClockRow
          label="Resolved"
          at={incident.resolvedAt}
          base={t0}
          now={now}
          pendingNote="Still open"
        />
      </Card>
    </Section>
  );
});

function ClockRow({
  label,
  at,
  base,
  now,
  pendingNote,
}: {
  label: string;
  at: number | null;
  base: number | null;
  now: number;
  pendingNote?: string;
}): ReactElement {
  // An unreached clock still shows a number: how long it has been unreached is
  // the metric that matters (PRD §16.3 — the yellow line is a clock that never
  // ticked, not a clock that ticked late).
  let delta: number | null = null;
  if (base !== null) delta = at !== null ? at - base : now - base;

  const value = at === null ? '—' : formatWallClock(at);
  const deltaText = delta === null ? '' : `${at === null ? 'waiting ' : '+'}${formatElapsed(delta)}`;

  return (
    <View
      style={styles.clockRow}
      accessible
      accessibilityRole="text"
      accessibilityLabel={
        at === null
          ? `${label}, not reached. ${pendingNote ?? ''} ${deltaText}`
          : `${label}, ${value}, ${deltaText} after trigger`
      }
    >
      <View style={styles.clockLeft}>
        <Text style={[styles.clockLabel, at === null ? styles.clockLabelPending : null]}>
          {label}
        </Text>
        {at !== null || pendingNote === undefined ? null : (
          <Text style={styles.clockPending} numberOfLines={2}>
            {pendingNote}
          </Text>
        )}
      </View>
      <View style={styles.clockRight}>
        <Text
          style={[styles.clockValue, at === null ? styles.clockValuePending : null]}
          allowFontScaling={false}
        >
          {value}
        </Text>
        {deltaText.length === 0 ? null : (
          <Text style={styles.clockDelta} allowFontScaling={false}>
            {deltaText}
          </Text>
        )}
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// The escalation ladder (PRD §12.1 — "what happens next, and when")
// ═══════════════════════════════════════════════════════════════════════════════

const LadderCard = memo(function LadderCard({
  incident,
  live,
}: {
  incident: Incident;
  live: boolean;
}): ReactElement {
  const now = useSecondTick(live);
  const steps = useMemo(
    // The policy in force, not the default — an after-action review must render
    // under the rules that applied at the time (P-069, policyVersion is stamped).
    () => ladderFor(currentPolicy(), incident.trigger),
    [incident.trigger],
  );
  const elapsedMs = (incident.resolvedAt ?? now) - incident.openedAt;
  const elapsedS = Math.max(0, Math.floor(elapsedMs / 1000));

  // The current rung is the last one whose clock has passed. Once the incident is
  // closed nothing further fires, so nothing is highlighted as "now".
  let currentIndex = -1;
  if (live) {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].atS <= elapsedS) currentIndex = i;
    }
  }

  return (
    <Section title="Escalation ladder" right={`policy v${incident.policyVersion}`}>
      <Card>
        {steps.map((step, index) => {
          const passed = elapsedS >= step.atS;
          const isNow = index === currentIndex;
          return (
            <View
              key={`${step.atS}-${step.tier}-${step.label}`}
              style={[styles.ladderRow, isNow ? styles.ladderRowNow : null]}
              accessible
              accessibilityRole="text"
              accessibilityLabel={`Tier ${step.tier}, ${step.label}, at ${step.atS} seconds, ${
                isNow ? 'happening now' : passed ? 'already sent' : 'not yet'
              }`}
            >
              <Text
                style={[styles.ladderAt, passed ? styles.ladderAtPassed : null]}
                allowFontScaling={false}
              >
                {step.atS === 0 ? 'T+0' : `T+${formatShortSeconds(step.atS)}`}
              </Text>
              <View style={styles.ladderBody}>
                <Text style={[styles.ladderLabel, isNow ? styles.ladderLabelNow : null]}>
                  {`L${step.tier} · ${step.label}`}
                </Text>
                <Text style={styles.ladderChannels} numberOfLines={1}>
                  {step.channels.join(' · ')}
                </Text>
              </View>
              <Text
                style={[
                  styles.ladderMark,
                  isNow ? styles.ladderMarkNow : passed ? styles.ladderMarkPassed : null,
                ]}
                allowFontScaling={false}
              >
                {isNow ? '●' : passed ? '✓' : '○'}
              </Text>
            </View>
          );
        })}
      </Card>
    </Section>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// The sealed payload — decrypted here and only here
// ═══════════════════════════════════════════════════════════════════════════════

const SealedCard = memo(function SealedCard({ incident }: { incident: Incident }): ReactElement {
  const sealed = incident.sealed;

  if (sealed === null) {
    return (
      <Section title="Where">
        <Card tone="warn">
          <Text style={styles.body}>
            No position was sealed into this incident. The phone had no cached fix when the
            trigger fired.
          </Text>
          {incident.coarseH3R7 === null ? null : (
            <Text style={styles.mono}>{`Coarse cell ${incident.coarseH3R7}`}</Text>
          )}
        </Card>
      </Section>
    );
  }

  return (
    <Section title="Where" right="decrypted on this device">
      <View style={styles.sealedWrap}>
        {/* Read these aloud to a 112 operator — that is the whole job (§4.4). */}
        <BigCoordinates lat={sealed.lat} lon={sealed.lon} accuracyM={sealed.accuracyM} />
        <View style={styles.pillRow}>
          <Pill
            label={`Phone battery ${sealed.batteryPct}%`}
            tone={sealed.batteryPct <= 15 ? 'danger' : sealed.batteryPct <= 35 ? 'warn' : 'neutral'}
          />
          {sealed.speed === undefined ? null : (
            <Pill label={`${Math.round(sealed.speed * 3.6)} km/h at trigger`} tone="info" />
          )}
          {sealed.heading === undefined ? null : (
            <Pill label={`Heading ${Math.round(sealed.heading)}°`} tone="neutral" />
          )}
          {incident.coarseH3R7 === null ? null : (
            <Pill label={`Cell ${incident.coarseH3R7}`} tone="neutral" />
          )}
        </View>
        {sealed.note === undefined || sealed.note.length === 0 ? null : (
          <Text style={styles.body}>{sealed.note}</Text>
        )}
      </View>
    </Section>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Break-glass, layer 2 (PRD §10.4)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ★ The medical card opens with NO unlock while the incident is live, and seals
 * itself again the moment it is not. That asymmetry is the entire design: a
 * responder holding a phone in an ambulance bay cannot be asked for a PIN, and a
 * relative browsing last month's incidents has no business reading a blood group.
 */
const BreakGlassMedical = memo(function BreakGlassMedical({
  incident,
}: {
  incident: Incident;
}): ReactElement | null {
  const medical = incident.sealed?.medical;
  const open = isActive(incident.state);

  if (medical === undefined) return null;

  if (!open) {
    return (
      <Section title={t('medical.title')}>
        <Card>
          <Text style={styles.body}>
            Sealed. The medical card is readable without an unlock only while the incident is
            live.
          </Text>
        </Card>
      </Section>
    );
  }

  const hasAny =
    medical.bloodGroup.length > 0 ||
    medical.allergies.length > 0 ||
    medical.medications.length > 0 ||
    medical.conditions.length > 0;

  return (
    <Section title={t('medical.title')} right="break-glass">
      <Card tone="warn">
        <Text style={styles.breakGlassNote}>{t('medical.showToResponder')}</Text>

        {hasAny ? null : (
          <Text style={styles.body}>This member has not filled in a medical card.</Text>
        )}

        {medical.bloodGroup.length === 0 ? null : (
          <View style={styles.bloodRow}>
            <Text style={styles.bloodLabel} allowFontScaling={false}>
              {t('medical.bloodGroup')}
            </Text>
            <Text style={styles.bloodValue} allowFontScaling={false} selectable>
              {medical.bloodGroup}
            </Text>
          </View>
        )}

        <MedicalList title={t('medical.allergies')} items={medical.allergies} tone="danger" />
        <MedicalList title={t('medical.medications')} items={medical.medications} tone="info" />
        <MedicalList title={t('medical.conditions')} items={medical.conditions} tone="warn" />

        {medical.organDonor ? (
          <Text style={styles.organDonor}>Registered organ donor.</Text>
        ) : null}

        {medical.iceContacts.length === 0 ? null : (
          <View style={styles.iceBlock}>
            <Text style={styles.subLabel}>{t('medical.ice')}</Text>
            {medical.iceContacts.map((c) => (
              <Text key={`${c.name}-${c.phone}`} style={styles.mono} selectable>
                {`${c.name} — ${c.phone}`}
              </Text>
            ))}
          </View>
        )}

        {medical.notes.length === 0 ? null : <Text style={styles.body}>{medical.notes}</Text>}
      </Card>
    </Section>
  );
});

function MedicalList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: 'danger' | 'warn' | 'info';
}): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <View>
      <Text style={styles.subLabel}>{title}</Text>
      <View style={styles.pillRow}>
        {/* Top three only — the card is a glance, not a chart (PRD §10.4). */}
        {items.slice(0, 3).map((item) => (
          <Pill key={item} label={item} tone={tone} />
        ))}
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// The event log — HLC order, not arrival order
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ★ P-052: six phones with six disagreeing wall clocks produce one causally
 * correct timeline only if it is sorted by the hybrid logical clock. The HLC is a
 * fixed-width 24-character hex string, so a lexicographic compare IS the causal
 * compare; `localCreatedAt` is the tie-break for rows written in the same tick.
 */
const EventLog = memo(function EventLog({
  rows,
  nameOf,
}: {
  rows: IncidentEventRow[] | undefined;
  nameOf: (id: UUID | null | undefined) => string | null;
}): ReactElement {
  const [showAll, setShowAll] = useState(false);

  const ordered = useMemo(() => {
    const list = rows ?? [];
    return [...list].sort((a, b) => {
      if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
      return a.localCreatedAt - b.localCreatedAt;
    });
  }, [rows]);

  // ★ Capped, and the cap is stated. A long incident appends without bound, and
  //   mounting three hundred rows behind a scroll a responder will never reach
  //   costs them frames on the screen they are reading NOW. Nothing is deleted —
  //   the control below opens the rest, and the count in the section header is
  //   always the true total.
  const hidden = showAll ? 0 : Math.max(0, ordered.length - LOG_VISIBLE);
  const visible = hidden === 0 ? ordered : ordered.slice(ordered.length - LOG_VISIBLE);

  return (
    <Section title="What happened" right={`${ordered.length}`}>
      {ordered.length === 0 ? (
        <Card>
          <Text style={styles.body}>
            No log rows have reached this phone yet. They arrive as the incident progresses.
          </Text>
        </Card>
      ) : (
        <Card>
          {hidden === 0 ? null : (
            <Button
              label={`Show the earlier ${hidden}`}
              variant="quiet"
              onPress={() => setShowAll(true)}
              accessibilityLabel={`Show the ${hidden} earlier log rows. ${LOG_VISIBLE} of ${ordered.length} are shown.`}
            />
          )}
          {visible.map((row) => {
            const actor =
              nameOf(typeof row.detail?.memberId === 'string' ? row.detail.memberId : null) ?? null;
            const detail = summariseDetail(row.detail);
            return (
              <View key={`${row.hlc}-${row.id}`} style={styles.logRow}>
                <Text style={styles.logTime} allowFontScaling={false}>
                  {formatWallClock(row.localCreatedAt)}
                </Text>
                <View style={styles.logBody}>
                  <View style={styles.logHeadline}>
                    <Text style={styles.logType} numberOfLines={1}>
                      {humanEvent(row.eventType)}
                    </Text>
                    <Pill label={row.sourceTransport} tone={transportTone(row.sourceTransport)} />
                  </View>
                  {actor === null ? null : <Text style={styles.logActor}>{actor}</Text>}
                  {detail === null ? null : (
                    <Text style={styles.logDetail} numberOfLines={3}>
                      {detail}
                    </Text>
                  )}
                </View>
              </View>
            );
          })}
        </Card>
      )}
    </Section>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Classification — the only input the False Positive Ledger has (P-017)
// ═══════════════════════════════════════════════════════════════════════════════

const OUTCOMES: { value: IncidentOutcome; label: string }[] = [
  { value: 'real', label: 'Real emergency' },
  { value: 'false_alarm', label: 'False alarm' },
  { value: 'drill', label: 'Drill' },
];

const ClassifySection = memo(function ClassifySection({
  outcome,
  onClassify,
}: {
  outcome: IncidentOutcome | null;
  onClassify: (o: IncidentOutcome) => void;
}): ReactElement {
  return (
    <Section title="Close the loop">
      <Card>
        {/* ★ P-017 / PRD §16.3 Dashboard 3. An unclassified incident silently
            poisons every threshold the system would otherwise learn from, so
            this stays available in every state including terminal ones. */}
        <Text style={styles.body}>
          Classifying this is what stops the next false alarm. It is the only input the false
          positive ledger has.
        </Text>
        <View style={styles.classifyRow}>
          {OUTCOMES.map((o) => {
            const selected = outcome === o.value;
            return (
              <Button
                key={o.value}
                label={selected ? `✓ ${o.label}` : o.label}
                variant={selected ? 'primary' : 'quiet'}
                onPress={() => onClassify(o.value)}
                accessibilityLabel={
                  selected ? `${o.label}, currently selected` : `Classify as ${o.label}`
                }
                style={styles.classifyButton}
              />
            );
          })}
        </View>
      </Card>
    </Section>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// The action bar — pinned, because CLAIM must never be scrolled off screen
// ═══════════════════════════════════════════════════════════════════════════════

const ActionBar = memo(function ActionBar({
  live,
  canClaim,
  canRelease,
  canArrive,
  canResolve,
  onClaim,
  onRelease,
  onArrived,
  onResolve,
  bottomInset,
}: {
  live: boolean;
  canClaim: boolean;
  canRelease: boolean;
  canArrive: boolean;
  canResolve: boolean;
  onClaim: () => void;
  onRelease: () => void;
  onArrived: () => void;
  onResolve: () => void;
  /** Real inset, not a guessed constant: CLAIM must not sit under a gesture bar. */
  bottomInset: number;
}): ReactElement {
  const pad = { paddingBottom: bottomInset + space.lg };

  // A closed incident has no responder actions left, and rendering four dead
  // buttons under one would teach people that the bar is decorative. Only
  // classification survives, and it lives in the scroll body.
  if (!live) {
    return (
      <View style={[styles.actionBar, pad]}>
        <Text style={styles.closedNote} accessibilityRole="text">
          This incident is closed. Classifying it above is the last thing it needs.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.actionBar, pad]}>
      {/* ★ P-003 makes CLAIM the hero control: it is the press that converts six
          people hoping into one person going. */}
      {canClaim ? (
        <Button
          label={t('panic.claim')}
          variant="danger"
          size="lg"
          onPress={onClaim}
          accessibilityLabel={`${t('panic.claim')}. Tells the whole family you are going.`}
        />
      ) : null}

      <View style={styles.actionRow}>
        {/* ★ The un-claim path. Same row, same size, one press — a release that
            costs more than a claim means nobody ever claims. */}
        <Button
          label={t('panic.release')}
          variant="quiet"
          onPress={onRelease}
          disabled={!canRelease}
          accessibilityLabel={
            canRelease
              ? `${t('panic.release')}. Hands the incident back so someone else goes.`
              : `${t('panic.release')}. Not available — you can only release an incident you have claimed.`
          }
          style={styles.actionButton}
        />
        <Button
          label={t('panic.onScene')}
          variant="quiet"
          onPress={onArrived}
          disabled={!canArrive}
          accessibilityLabel={
            canArrive
              ? t('panic.onScene')
              : `${t('panic.onScene')}. Not available — claim the incident before marking that you have arrived.`
          }
          style={styles.actionButton}
        />
        <Button
          label={t('panic.resolve')}
          variant="quiet"
          onPress={onResolve}
          disabled={!canResolve}
          accessibilityLabel={
            canResolve
              ? `${t('panic.resolve')}. Closes the incident for the whole family.`
              : `${t('panic.resolve')}. Not available — an incident closes once a responder is on scene, or by the subject's own PIN.`
          }
          style={styles.actionButton}
        />
      </View>

      {/* ADR-019: hand off to the dialler so Advanced Mobile Location still fires. */}
      <Call112Button compact />
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════════════════════

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `04:12` / `1:04:12`. Latin digits, no locale routing (P-059). */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

function formatWallClock(at: number): string {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatShortSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 360) / 10}h`;
}

const EVENT_LABELS: Record<string, string> = {
  INCIDENT_OPEN: 'Incident opened',
  SENSOR_ANOMALY: 'Sensor anomaly',
  CONFIDENCE: 'Confidence scored',
  MANUAL_TRIGGER: 'Panic button held',
  CANCEL_WINDOW_EXPIRED: 'Cancel window expired',
  PIN_CORRECT: 'Cancelled with PIN',
  PIN_DURESS: 'PIN entered',
  PROBE_TIMEOUT: 'No answer to the probe',
  USER_FINE: 'Answered "I am fine"',
  NO_ACK: 'Nobody acknowledged — escalated',
  CLAIM: 'Claimed',
  RELEASE: 'Released',
  ON_SCENE: 'Arrived on scene',
  TWO_PARTY_CONFIRM: 'Confirmed resolved by two people',
  SELF_CLEAR_PIN: 'Cleared with PIN',
  AUTO_QUIESCE: 'Closed automatically',
  REESCALATE: 'Re-escalated',
  PROGRESS_WATCHDOG: 'Owner made no progress — re-escalated',
  MOTION_RESUMED: 'Movement resumed',
  CONTEXT_ELEVATED: 'Context elevated',
  CONTEXT_ENDED: 'Context ended',
  DISPATCHED: 'Dispatched',
  TRANSMIT: 'First transmission',
  DELIVERED: 'Delivered',
  DELIVERY_FAILED: 'Delivery failed',
  LOCATION_UPDATE: 'Position updated',
  BLACKBOX_SEALED: 'Black box sealed',
  LADDER: 'Escalation rung fired',
  CLASSIFIED: 'Classified',
};

/**
 * ★ PIN_DURESS reads as a plain "PIN entered" here for the same reason the store
 * adds no branch to the duress path: the two accepting outcomes must be
 * indistinguishable to an observer looking over a shoulder (F-01, T-213).
 */
function humanEvent(eventType: string): string {
  const known = EVENT_LABELS[eventType];
  if (known !== undefined) return known;
  return eventType
    .toLowerCase()
    .split('_')
    .map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function humanKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

/** Everything the log row carries, minus what the row already renders elsewhere. */
function summariseDetail(detail: Record<string, unknown> | undefined): string | null {
  if (detail === undefined) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'memberId' || key === 'clock') continue;
    if (value === null || value === undefined) continue;
    const text = Array.isArray(value)
      ? value.join(', ')
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
    if (text.length === 0) continue;
    parts.push(`${humanKey(key)}: ${text}`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

function transportTone(kind: string): 'ok' | 'warn' | 'danger' | 'info' | 'neutral' {
  // ★ F-10: an SMS leg carried the precise position as Class A′ plaintext. That
  //   is a disclosure, and it is marked as one rather than blending in.
  if (kind === 'sms') return 'warn';
  if (kind === 'ble_relay') return 'warn';
  if (kind === 'local') return 'neutral';
  return 'info';
}

// ═══════════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: { padding: space.lg, gap: space.lg },
  scrollTail: { height: space.sm },
  notFound: { marginTop: space.xxl },

  // header
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  headerText: { flex: 1, gap: space.xxs },
  headerTitle: { color: colors.text, fontSize: font.h2, fontWeight: weight.bold },
  headerSubtitle: { color: colors.textDim, fontSize: font.small, fontWeight: weight.medium },

  // banners
  unackedBanner: {
    backgroundColor: colors.dangerDark,
    borderColor: colors.danger,
    borderWidth: 2,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
  },
  unackedText: {
    color: colors.white,
    fontSize: font.h1,
    fontWeight: weight.heavy,
    letterSpacing: 0.5,
  },
  unackedHint: { color: colors.white, fontSize: font.small, fontWeight: weight.medium },
  respondingBanner: {
    backgroundColor: colors.infoSoft,
    borderColor: colors.info,
    borderWidth: 1.5,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.xs,
  },
  respondingText: { color: colors.text, fontSize: font.h3, fontWeight: weight.bold },
  respondingHint: { color: colors.textDim, fontSize: font.small },

  // identity
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  identityText: { flex: 1, gap: space.xxs },
  identityName: { color: colors.text, fontSize: font.h2, fontWeight: weight.bold },
  identityMeta: {
    color: colors.textDim,
    fontSize: font.small,
    fontFamily: font.mono,
  },
  elapsedBlock: { alignItems: 'flex-end' },
  elapsedValue: {
    color: colors.text,
    fontSize: font.h1,
    fontWeight: weight.heavy,
    fontFamily: font.mono,
    includeFontPadding: false,
  },
  elapsedLabel: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontWeight: weight.bold,
    letterSpacing: 1.5,
  },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  duressStrip: {
    borderLeftWidth: 3,
    borderLeftColor: colors.duress,
    paddingLeft: space.md,
  },
  duressText: { color: colors.text, fontSize: font.small, fontWeight: weight.semibold },

  // clocks
  clockRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.md,
    paddingVertical: space.xs,
  },
  clockLeft: { flex: 1, gap: space.xxs },
  clockLabel: { color: colors.text, fontSize: font.body, fontWeight: weight.semibold },
  clockLabelPending: { color: colors.textDim },
  // "Nothing has left this phone yet" / "NOBODY HAS RESPONDED YET" — 11 px, and
  // in `colors.warn` it measured 2.71:1. The clock that never ticked is the whole
  // point of this card (PRD §16.3); it cannot be the line nobody can read.
  clockPending: { color: colors.warnText, fontSize: font.tiny, fontWeight: weight.semibold },
  clockRight: { alignItems: 'flex-end' },
  clockValue: {
    color: colors.text,
    fontSize: font.body,
    fontWeight: weight.bold,
    fontFamily: font.mono,
  },
  clockValuePending: { color: colors.textFaint },
  clockDelta: { color: colors.textDim, fontSize: font.tiny, fontFamily: font.mono },

  // ladder
  ladderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  ladderRowNow: { backgroundColor: colors.dangerSoft },
  ladderAt: {
    color: colors.textFaint,
    fontSize: font.small,
    fontWeight: weight.bold,
    fontFamily: font.mono,
    width: 48,
  },
  ladderAtPassed: { color: colors.textDim },
  ladderBody: { flex: 1, gap: space.xxs },
  ladderLabel: { color: colors.text, fontSize: font.body, fontWeight: weight.semibold },
  ladderLabelNow: { color: colors.dangerText, fontWeight: weight.heavy },
  ladderChannels: { color: colors.textFaint, fontSize: font.tiny, fontFamily: font.mono },
  // ★ The check / dot / circle column is the only glanceable progress indicator
  //   on this screen. At 2.43:1 (`ok`) and 3.05:1 (`danger`) a responder could
  //   not tell a rung that has fired from one that has not — which is the single
  //   question the column exists to answer. Both are now *Text variants, and the
  //   glyph still differs by shape so the answer never rests on colour (P-018).
  ladderMark: { color: colors.textFaint, fontSize: font.body, width: 20, textAlign: 'center' },
  ladderMarkPassed: { color: colors.okText },
  ladderMarkNow: { color: colors.dangerText },

  // sealed
  sealedWrap: { gap: space.md },
  body: { color: colors.textDim, fontSize: font.body, lineHeight: font.body + 6 },
  mono: { color: colors.text, fontSize: font.small, fontFamily: font.mono },

  // medical
  breakGlassNote: { color: colors.text, fontSize: font.body, fontWeight: weight.semibold },
  bloodRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  bloodLabel: { color: colors.textDim, fontSize: font.small, fontWeight: weight.semibold },
  bloodValue: {
    color: colors.text,
    fontSize: font.display,
    fontWeight: weight.heavy,
    fontFamily: font.mono,
    includeFontPadding: false,
  },
  subLabel: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontWeight: weight.bold,
    letterSpacing: 1.2,
    marginBottom: space.xs,
  },
  organDonor: { color: colors.okText, fontSize: font.body, fontWeight: weight.semibold },
  iceBlock: { gap: space.xs },

  // log
  logRow: { flexDirection: 'row', gap: space.md, paddingVertical: space.sm },
  logTime: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontFamily: font.mono,
    width: 58,
    paddingTop: 2,
  },
  logBody: { flex: 1, gap: space.xxs },
  logHeadline: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  logType: { color: colors.text, fontSize: font.body, fontWeight: weight.semibold },
  logActor: { color: colors.textDim, fontSize: font.small, fontWeight: weight.medium },
  logDetail: { color: colors.textFaint, fontSize: font.tiny, fontFamily: font.mono },

  // classify
  classifyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  classifyButton: { flexGrow: 1, flexBasis: '30%' },

  // action bar
  actionBar: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgElevated,
    padding: space.lg,
    gap: space.sm,
  },
  actionRow: { flexDirection: 'row', gap: space.sm },
  actionButton: { flex: 1 },
  closedNote: { color: colors.textDim, fontSize: font.small, textAlign: 'center' },
});
