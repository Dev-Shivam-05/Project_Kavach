/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PRIVACY — the anti-stalkerware surface.
 *
 * ★ WHY THIS SCREEN EXISTS AT ALL ★
 * Every family safety app is one product decision away from being spyware. The
 * decision is not made in the tracking code; it is made here, by whether the
 * person being watched can see the watching. PRD §10.6 and P-008 make three
 * things non-negotiable and this file is where all three are cashed:
 *   1. No grant is permanent. Every one expires — expiresAt is never null.
 *   2. Every access is logged and surfaced TO THE SUBJECT, not to the accessor.
 *   3. Revocation is one tap and needs nobody's approval.
 *
 * ★ F-14 — THE HONEST TWO-LAYER REVOCATION ★
 * Layer 1 (routing) dies instantly and locally: the grantee can no longer
 * request anything, with no server and no network involved. Layer 2 (the
 * location-stream key ratchet) cannot complete until the grantor's phone is next
 * online to re-wrap the key. Until it lands, the grantee still holds the key for
 * points already delivered. `grant.keyRotationPending` is the store's word for
 * that gap and this screen renders it verbatim via t('consent.revokePending').
 * Telling someone their revocation is complete before the ratchet lands is a
 * comfortable lie that would be worse than the lag itself.
 *
 * ★ F-10 — CLASS A′ DISCLOSURES ARE NOT FOOTNOTES ★
 * When every encrypted leg is down, an incident's precise coordinates go out
 * over SMS in the clear, because a located person beats an encrypted silence.
 * That is a real disclosure and it is written into the access log with
 * `degradedPlaintext`, then shown here in the same words the person deserves:
 * their precise location was sent unencrypted.
 *
 * ★ PRD §1.6.1 — THE AUTONOMY RAMP IS PUBLISHED, NOT PROMISED ★
 * A minor who can read the exact date each rule ends is being governed. A minor
 * who is told "when you're older" is being managed. The ramp is rendered with
 * real dates computed from a real date of birth, to the child, unprompted.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Alert, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type {
  AccessLogEntry,
  ConsentGrant,
  ConsentPurpose,
  ConsentScope,
  Member,
  UUID,
} from '../src/core/types';
import { relativeTime, t } from '../src/i18n';
import { useKavach } from '../src/state/store';
import { Button, Card, EmptyState, ListItem, Pill, Section } from '../src/ui/components';
import { colors, font, leading, radius, space, tracking, weight } from '../src/ui/theme';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** ASCII months: Intl is not guaranteed on every low-end Android build. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SCOPE_LABEL: Record<ConsentScope, string> = {
  live_location: 'live location',
  history: 'location history',
  vitals: 'vitals',
  audio: 'audio',
  documents: 'documents',
  screen_time: 'screen time',
};

const PURPOSE_LABEL: Record<ConsentPurpose, string> = {
  safety: 'Safety',
  incident_only: 'Emergencies only',
  routine: 'Routine',
  care: 'Care',
};

const VIA_LABEL: Record<ConsentGrant['grantedVia'], string> = {
  self: 'You granted this',
  guardian_policy: 'Guardian policy',
  autonomy_ramp: 'Autonomy ramp',
};

/** What an access-log row actually touched, in words rather than column names. */
const WHAT_LABEL: Record<string, string> = {
  live_location: 'live location',
  precise_location: 'precise location',
  history: 'location history',
  vitals: 'vitals',
  documents: 'documents',
  audio: 'audio',
  screen_time: 'screen time',
  find_phone: 'phone — they rang it',
};

/**
 * PRD §1.6.1. Four rungs, published in advance, each one a rule that ENDS on a
 * date the child can read today. The wording is deliberately in the second
 * person: this is addressed to them, not written about them.
 */
const AUTONOMY_RAMP: { age: number; title: string; body: string }[] = [
  {
    age: 13,
    title: 'You can see everything',
    body: 'Everything your guardians can see about you appears on this screen, and every time one of them opens your data it is written into the log below. Nothing about you is watched invisibly.',
  },
  {
    age: 15,
    title: 'Routine tracking ends',
    body: 'Continuous location sharing stops. Your guardians can see you during a journey you started and during an emergency — not for the rest of the day.',
  },
  {
    age: 16,
    title: 'You control your own grants',
    body: 'You can revoke any grant on this screen yourself, including one a guardian set. They are told that you did. They are not asked first.',
  },
  {
    age: 18,
    title: 'Guardian policy expires',
    body: 'Every grant made under guardian policy expires on this date and does not renew. From here, nothing about you is shared unless you grant it yourself.',
  },
];

// ── Small pure helpers ────────────────────────────────────────────────────────

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "in 3d 4h" — the phrasing t('consent.expires') expects after "Expires". */
function countdown(msRemaining: number): string {
  if (msRemaining < MINUTE) return 'in under a minute';
  if (msRemaining < HOUR) return `in ${Math.floor(msRemaining / MINUTE)}m`;
  if (msRemaining < DAY) {
    const h = Math.floor(msRemaining / HOUR);
    return `in ${h}h ${Math.floor((msRemaining - h * HOUR) / MINUTE)}m`;
  }
  const d = Math.floor(msRemaining / DAY);
  return `in ${d}d ${Math.floor((msRemaining - d * DAY) / HOUR)}h`;
}

/** Epoch ms of the `age`th birthday. Null when the date of birth is unknown. */
function birthdayAt(dob: string | null, age: number): number | null {
  if (dob === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob.trim());
  if (!m) return null;
  return new Date(Number(m[1]) + age, Number(m[2]) - 1, Number(m[3])).getTime();
}

function nameOf(members: Member[], id: UUID): string {
  return members.find((x) => x.id === id)?.displayName ?? 'Someone outside the family';
}

function whatLabel(what: string): string {
  return WHAT_LABEL[what] ?? what.replace(/_/g, ' ');
}

/**
 * Section's heading, standing on its own.
 *
 * The access-log rows below it are SectionList items rather than children of a
 * <Section/>: store.loadEverything holds two hundred of them and a <Section/>
 * takes its children already rendered, which is exactly the `.map()` that mounted
 * all two hundred on first paint. The type rules here are Section's own.
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

// ── Screen ────────────────────────────────────────────────────────────────────

export default function ConsentScreen(): ReactElement {
  const ready = useKavach((s) => s.ready);
  const me = useKavach((s) => s.me);
  const members = useKavach((s) => s.members);
  const grants = useKavach((s) => s.grants);
  const accessLog = useKavach((s) => s.accessLog);
  const incidents = useKavach((s) => s.incidents);
  const revokeConsent = useKavach((s) => s.revokeConsent);

  /** Expiry is the product promise; a countdown frozen at mount would undercut it. */
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const meId = me?.id ?? '';

  const mine = useMemo(() => {
    const all = grants.filter((g) => g.grantorMemberId === meId);
    return {
      live: all
        .filter((g) => g.revokedAt === null && g.expiresAt > now)
        .sort((a, b) => a.expiresAt - b.expiresAt),
      // ★ F-14: revoked, but the key ratchet has not landed. These stay visible
      //   and keep saying so until the grantor's phone next connects.
      pending: all.filter((g) => g.revokedAt !== null && g.keyRotationPending),
      finished: all
        .filter((g) => (g.revokedAt !== null && !g.keyRotationPending) || (g.revokedAt === null && g.expiresAt <= now))
        .sort((a, b) => (b.revokedAt ?? b.expiresAt) - (a.revokedAt ?? a.expiresAt)),
    };
  }, [grants, meId, now]);

  const theirs = useMemo(
    () =>
      grants
        .filter((g) => g.granteeMemberId === meId && g.revokedAt === null && g.expiresAt > now)
        .sort((a, b) => a.expiresAt - b.expiresAt),
    [grants, meId, now],
  );

  const lookedAtMe = useMemo(
    () => accessLog.filter((a) => a.subjectMemberId === meId).sort((a, b) => b.at - a.at),
    [accessLog, meId],
  );

  /**
   * The mirror. A log that only shows what was done TO you lets you forget what
   * you did to everyone else; showing both is what makes the surface symmetric
   * rather than merely defensive (PRD §10.6).
   */
  const iLookedAt = useMemo(
    () => accessLog.filter((a) => a.accessorMemberId === meId && a.subjectMemberId !== meId).sort((a, b) => b.at - a.at),
    [accessLog, meId],
  );

  /** Rendered to the child when it is theirs, and to everyone else as published policy. */
  const rampFor = useMemo(() => {
    if (me?.role === 'minor') return [me];
    return members.filter((m) => m.role === 'minor');
  }, [me, members]);

  // Stable across renders so `renderLogRow` below is too — a renderItem that
  // changes identity every render defeats the windowing it is passed to.
  const incidentTag = useCallback(
    (context: string): string => {
      if (context === 'routine' || context.length === 0) return 'Routine access';
      const incident = incidents.find((i) => i.id === context);
      return incident ? `During incident #${incident.inc8}` : 'During an incident';
    },
    [incidents],
  );

  const onRevoke = (grant: ConsentGrant): void => {
    const name = nameOf(members, grant.granteeMemberId);
    Alert.alert(
      `Revoke ${name}'s access?`,
      `${name} will no longer be able to request your ${SCOPE_LABEL[grant.scope]}. That part stops the moment you tap Revoke, with or without a network.\n\nThe encryption key rotation finishes when your phone is next online. Until then ${name} can still open location points already delivered.`,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('consent.revoke'),
          style: 'destructive',
          // No await: the store commits locally and synchronously updates the
          // list; the network leg is fire-and-forget by design (store §11.1).
          onPress: () => {
            void revokeConsent(grant.id);
          },
        },
      ],
    );
  };

  /**
   * ★ TWO ACCESS LOGS, ONE VIRTUALISED LIST ★
   * `lookedAtMe` and `iLookedAt` are disjoint slices of the same 200-row log, and
   * both were `.map()`ed inside a ScrollView — every row mounted on first paint of
   * the privacy tab. Neither can be truncated: a log that shows "the most recent
   * twenty" of what was done to you is not the surface PRD §10.6 promises. So they
   * become the two sections of one SectionList, kept whole and windowed.
   */
  const logSections = useMemo(
    () => [
      {
        key: 'mine',
        title: t('consent.accessLog'),
        note: null,
        subjectIsMe: true,
        data: lookedAtMe,
      },
      {
        key: 'theirs',
        title: 'What I looked at',
        // The mirror is shown even when it is empty. A log of what was done to
        // you that appears while the log of what you did to others quietly
        // disappears is a defensive surface, not a symmetric one (PRD §10.6).
        note: 'The same log, from the other side. Everyone here can read their own copy of these rows.',
        subjectIsMe: false,
        data: iLookedAt,
      },
    ],
    [lookedAtMe, iLookedAt],
  );

  const renderLogRow = useCallback(
    ({
      item,
      section,
    }: {
      item: AccessLogEntry;
      section: { subjectIsMe: boolean };
    }): ReactElement => (
      <AccessRow
        entry={item}
        members={members}
        tag={incidentTag(item.context)}
        subjectIsMe={section.subjectIsMe}
      />
    ),
    [members, incidentTag],
  );

  if (!ready) {
    return (
      <SafeAreaView edges={['top']} style={styles.screen}>
        <View style={styles.content}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.screenTitle}>
              {t('consent.title')}
            </Text>
            <Text style={styles.screenSubtitle}>
              Reading your grants and your access log off this phone.
            </Text>
          </View>
          <View style={[styles.skeleton, styles.skeletonTall]} />
          <View style={styles.skeleton} />
          <View style={styles.skeleton} />
        </View>
      </SafeAreaView>
    );
  }

  const header = (
    <View style={styles.headerBlock}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${t('consent.title')}. ${mine.live.length} can see you. ${
          lookedAtMe.length
        } entries in your access log.`}
        style={styles.header}
      >
        <Text style={styles.screenTitle}>{t('consent.title')}</Text>
        <Text style={styles.screenSubtitle}>
          {`${mine.live.length} can see you · ${theirs.length} you can see · ${lookedAtMe.length} in your log`}
        </Text>
      </View>

      {/* ★ P-008, at the top of the screen, before anything can be granted. */}
      <Card tone="info">
        <Text style={styles.banner}>{t('consent.noPermanent')}</Text>
        <Text style={styles.body}>
          Every grant on this phone carries an expiry date it cannot be given without. Nobody — not a
          guardian, not this app — can create a permanent one.
        </Text>
      </Card>

      {/* ── Who can see me ───────────────────────────────────────────────────── */}
      <Section title={t('consent.whoSeesMe')} right={`${mine.live.length}`}>
        {mine.live.length === 0 ? (
          <EmptyState
            glyph="○"
            title="Nobody can see you"
            body="No live grant lets anyone in this family look at your data right now."
          />
        ) : (
          mine.live.map((g) => {
            const name = nameOf(members, g.granteeMemberId);
            return (
              <Card key={g.id}>
                <Text style={styles.h3}>
                  {name} can see your {SCOPE_LABEL[g.scope]}
                </Text>
                <View style={styles.pillRow}>
                  <Pill label={PURPOSE_LABEL[g.purpose]} tone="info" />
                  <Pill
                    label={t('consent.expires', { when: countdown(g.expiresAt - now) })}
                    tone={g.expiresAt - now < DAY ? 'warn' : 'neutral'}
                    glyph="⏱"
                  />
                </View>
                <Text style={styles.meta}>
                  {VIA_LABEL[g.grantedVia]} · granted {relativeTime(g.grantedAt)} · ends{' '}
                  {formatDate(g.expiresAt)}
                </Text>
                <Button
                  label={t('consent.revoke')}
                  variant="danger"
                  onPress={() => onRevoke(g)}
                  accessibilityLabel={`Revoke ${name}'s access to your ${SCOPE_LABEL[g.scope]}`}
                />
              </Card>
            );
          })
        )}

        {/* ★ F-14 rendered exactly as the store recorded it. */}
        {mine.pending.map((g) => (
          <Card key={g.id} tone="warn">
            <Text style={styles.h3}>Revoked — key rotation still pending</Text>
            <Text style={styles.body}>
              {t('consent.revokePending', { name: nameOf(members, g.granteeMemberId) })}
            </Text>
            <Text style={styles.meta}>
              {SCOPE_LABEL[g.scope]} · revoked {relativeTime(g.revokedAt)}. Requests already stop.
              Points delivered before then stay readable until the rotation lands.
            </Text>
          </Card>
        ))}

        {mine.finished.map((g) => (
          <ListItem
            key={g.id}
            glyph="✓"
            title={`${nameOf(members, g.granteeMemberId)} — ${SCOPE_LABEL[g.scope]}`}
            subtitle={
              g.revokedAt !== null
                ? `Revoked ${relativeTime(g.revokedAt)}. Key rotation complete.`
                : `Expired ${relativeTime(g.expiresAt)}, on its own, with nobody asked.`
            }
          />
        ))}
      </Section>

      {/* ── What I can see ─────────────────────────────────────────────────── */}
      <Section title={t('consent.whatISee')} right={`${theirs.length}`}>
        {theirs.length === 0 ? (
          <EmptyState
            glyph="○"
            title="You cannot see anyone"
            body="Nobody in this family has granted you access to their data."
          />
        ) : (
          theirs.map((g) => {
            const name = nameOf(members, g.grantorMemberId);
            return (
              <Card key={g.id}>
                <Text style={styles.h3}>
                  You can see {name}&apos;s {SCOPE_LABEL[g.scope]}
                </Text>
                <View style={styles.pillRow}>
                  <Pill label={PURPOSE_LABEL[g.purpose]} tone="info" />
                  <Pill
                    label={t('consent.expires', { when: countdown(g.expiresAt - now) })}
                    tone="neutral"
                    glyph="⏱"
                  />
                </View>
                {/* The asymmetry is the point: it is their grant, not yours. */}
                <Text style={styles.meta}>
                  {VIA_LABEL[g.grantedVia]} · only {name} can revoke this · every time you open
                  it, {name} sees the entry on their own copy of this screen.
                </Text>
              </Card>
            );
          })
        )}
      </Section>
    </View>
  );

  const footer =
    rampFor.length === 0 ? null : (
      // ── The published Autonomy Ramp (PRD §1.6.1) ─────────────────────────────
      <View style={styles.footerBlock}>
        <ListHeading title="Autonomy ramp" />
        <Text style={styles.meta}>
          Published in advance, with dates. A rule that ends on a date everyone can read is a rule; a
          rule that ends &quot;when you are older&quot; is a mood.
        </Text>
        {rampFor.map((child) => (
          <RampCard key={child.id} child={child} now={now} isMe={child.id === meId} />
        ))}
      </View>
    );

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <SectionList
        sections={logSections}
        keyExtractor={(entry) => `${entry.id}`}
        renderItem={renderLogRow}
        // A heading that sticks covers the row it is describing on a 5" screen,
        // and this list is read by someone checking who looked at them — losing a
        // row to a floating title is the wrong trade.
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHead}>
            <ListHeading title={section.title} right={`${section.data.length}`} />
            {section.note === null ? null : <Text style={styles.meta}>{section.note}</Text>}
          </View>
        )}
        renderSectionFooter={({ section }) =>
          section.data.length > 0 ? null : section.subjectIsMe ? (
            <EmptyState
              glyph="○"
              title="Nobody has opened your data"
              body="Not once. Every future access lands here, newest first, whether or not the person meant you to know."
            />
          ) : (
            <ListItem
              glyph="—"
              title="You have not opened anyone else's data"
              subtitle="Nothing you have done to anyone in this family is missing from here."
            />
          )
        }
        contentContainerStyle={styles.content}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
      />
    </SafeAreaView>
  );
}

// ── Access log row ────────────────────────────────────────────────────────────

interface AccessRowProps {
  entry: AccessLogEntry;
  members: Member[];
  tag: string;
  subjectIsMe: boolean;
}

function AccessRow({ entry, members, tag, subjectIsMe }: AccessRowProps): ReactElement {
  const accessor = nameOf(members, entry.accessorMemberId);
  const subject = nameOf(members, entry.subjectMemberId);
  const what = whatLabel(entry.what);

  // ★ F-10. A Class A′ disclosure gets a card and a full sentence, never a badge.
  if (entry.degradedPlaintext === true) {
    return (
      <Card tone="danger">
        <Text style={styles.h3}>Sent unencrypted by SMS</Text>
        <Text style={styles.body}>
          {subjectIsMe
            ? `Your precise location was sent unencrypted by SMS ${tag.toLowerCase()}.`
            : `${subject}'s precise location was sent unencrypted by SMS ${tag.toLowerCase()}, to reach ${accessor}. ${subject} was told, in these words, on their own copy of this screen.`}
        </Text>
        <Text style={styles.meta}>
          SMS cannot be encrypted. Every other leg was down, and a located person beats an encrypted
          silence — but it is a real disclosure, so it is written down instead of hidden.
        </Text>
        <Text style={styles.meta}>
          {relativeTime(entry.at)} · {formatDate(entry.at)} · {tag}
        </Text>
      </Card>
    );
  }

  return (
    <ListItem
      icon="eye"
      title={subjectIsMe ? t('consent.viewedBy', { name: accessor, what }) : `You viewed ${subject}'s ${what}`}
      subtitle={`${relativeTime(entry.at)} · ${tag}`}
      right={entry.grantId === null ? <Pill label="No grant" tone="warn" /> : <Pill label="Granted" tone="ok" />}
    />
  );
}

// ── Autonomy ramp card ────────────────────────────────────────────────────────

interface RampProps {
  child: Member;
  now: number;
  isMe: boolean;
}

function RampCard({ child, now, isMe }: RampProps): ReactElement {
  const first = birthdayAt(child.dob, AUTONOMY_RAMP[0].age);

  return (
    <Card>
      <Text style={styles.h3}>{isMe ? 'Your schedule' : `${child.displayName}'s schedule`}</Text>
      {first === null ? (
        <Text style={styles.meta}>
          No date of birth is recorded for {child.displayName}, so these dates cannot be computed.
          The rungs below still apply in order.
        </Text>
      ) : null}
      {AUTONOMY_RAMP.map((rung) => {
        const at = birthdayAt(child.dob, rung.age);
        const reached = at !== null && at <= now;
        return (
          <View
            key={rung.age}
            accessible
            accessibilityRole="text"
            accessibilityLabel={`Age ${rung.age}. ${rung.title}. ${
              at === null ? 'Date unknown' : reached ? `Reached ${formatDate(at)}` : `From ${formatDate(at)}`
            }. ${rung.body}`}
            style={[styles.rung, reached ? styles.rungReached : null]}
          >
            <View style={styles.rungHead}>
              <Text style={[styles.rungAge, reached ? styles.rungAgeOn : null]}>{rung.age}</Text>
              <Text style={styles.rungTitle}>{rung.title}</Text>
              <Pill
                label={at === null ? 'Date unknown' : reached ? 'In force' : formatDate(at)}
                tone={at === null ? 'neutral' : reached ? 'ok' : 'info'}
                glyph={reached ? '✓' : '→'}
              />
            </View>
            <Text style={styles.body}>{rung.body}</Text>
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    // The tab bar pads its own inset; the 96 that used to be here left this
    // screen ending in half a screen of blank while Home ended flush.
    paddingBottom: space.xl,
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

  sectionHead: { gap: space.sm, paddingTop: space.md },
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
  skeletonTall: { height: 128 },

  h3: { color: colors.text, fontSize: font.h3, fontWeight: weight.semibold },
  banner: { color: colors.text, fontSize: font.h3, fontWeight: weight.bold, lineHeight: leading.h3 },
  body: { color: colors.text, fontSize: font.body, fontWeight: weight.regular, lineHeight: leading.body },
  meta: { color: colors.textDim, fontSize: font.small, fontWeight: weight.regular, lineHeight: leading.small },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },

  rung: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  // The border is non-text and answers to WCAG's 3:1, so the fill token is right
  // there. The AGE beside it is text at font.h2 heavy, and `ok` on bgElevated is
  // 2.65:1 — so that one takes okText (8.64:1), same split as everywhere else.
  rungReached: { borderColor: colors.ok },
  rungHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  rungAge: {
    color: colors.textDim,
    fontSize: font.h2,
    fontWeight: weight.heavy,
    minWidth: 34,
  },
  rungAgeOn: { color: colors.okText },
  rungTitle: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: weight.semibold },
});
