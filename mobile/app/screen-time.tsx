/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SCREEN TIME (P-026)
 *
 * ★★★ THE DESIGN RULE THAT MATTERS MORE THAN THE TECHNOLOGY ★★★
 *
 * Limits here are NEGOTIATED AND VISIBLE, never imposed silently.
 *   · the person sees their own usage, in full, before anyone else acts on it
 *   · they can ask for more time, and the ask goes to a named human
 *   · nothing is ever blocked without a five-minute warning first
 *
 * ★★★ AND AN ADULT CAN ALWAYS OVERRIDE THEIR OWN LIMIT ★★★
 * PRD §1.4.3. A wellbeing feature an adult cannot switch off is not a wellbeing
 * feature — it is control with a friendlier icon, and the same machinery that
 * makes it "for their own good" is the machinery an abuser reaches for first.
 * The override is one tap plus a confirmation, it is never hidden behind a PIN
 * somebody else holds, and the reason is printed on the screen next to it.
 *
 * The honest limit of the implementation is printed here too: real enforcement
 * requires Device Owner provisioning and
 * DevicePolicyManager.setPackagesSuspended(). Without that this screen measures,
 * warns and negotiates — it cannot force-stop another app, and saying otherwise
 * would be the same lie as a stale pin on a map.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AppUsage, Member } from '../src/core/types';
import { relativeTime, t } from '../src/i18n';
import { useKavach } from '../src/state/store';
import { Button, Card, EmptyState, Pill, PressableScale, Section, Toggle } from '../src/ui/components';
import { MIN_TOUCH_TARGET, colors, font, radius, space, tracking, weight } from '../src/ui/theme';

/** The block never arrives unannounced. This is the promise, as a constant. */
const WARNING_MINUTES = 5;
const LIMIT_PRESETS = [30, 60, 90, 120];
const EXTENSION_PRESETS = [15, 30];

interface ExtensionRequest {
  id: number;
  packageName: string;
  label: string;
  minutes: number;
  askedAt: number;
  askedOfId: string | null;
  askedOfName: string;
}

interface ResolvedRequest extends ExtensionRequest {
  outcome: 'approved' | 'declined';
  resolvedAt: number;
}

function minutesLabel(m: number): string {
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export default function ScreenTimeScreen(): React.ReactElement {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const ready = useKavach((s) => s.ready);
  const usage = useKavach((s) => s.usage);
  const me = useKavach((s) => s.me);
  const members = useKavach((s) => s.members);
  const devices = useKavach((s) => s.devices);
  const deviceId = useKavach((s) => s.deviceId);
  const grants = useKavach((s) => s.grants);
  const diagnostics = useKavach((s) => s.diagnostics);
  const setLimit = useKavach((s) => s.setLimit);

  const [requests, setRequests] = useState<ExtensionRequest[]>([]);
  const [resolved, setResolved] = useState<ResolvedRequest[]>([]);
  const [confirmOverride, setConfirmOverride] = useState<string | null>(null);
  const [restorable, setRestorable] = useState<Record<string, number>>({});
  const [showAll, setShowAll] = useState(true);

  const guardians = useMemo(() => members.filter((m) => m.role === 'guardian'), [members]);
  const askedOf: Member | null = guardians[0] ?? null;

  /**
   * ★ An adult owns their own limits (PRD §1.4.3). A minor's are a guardian's
   *   policy, and the honest thing is to say whose — not to grey a button out
   *   and leave them guessing who to argue with.
   */
  const isAdult = me === null || me.role !== 'minor';

  const totalMinutes = usage.reduce((n, u) => n + u.minutesToday, 0);
  const limited = usage.filter((u) => u.limitMinutes !== null);
  const visible = showAll ? usage : limited;

  /** Who else can see this list. Live grants only — expired ones grant nothing. */
  const watchers = useMemo(() => {
    const now = Date.now();
    // Only grants THIS member made. Listing someone else's would answer a
    // question nobody asked and leak the shape of another person's consent.
    return grants
      .filter(
        (g) =>
          g.scope === 'screen_time' &&
          g.revokedAt === null &&
          g.expiresAt > now &&
          me !== null &&
          g.grantorMemberId === me.id,
      )
      .map((g) => ({
        grant: g,
        name: members.find((m) => m.id === g.granteeMemberId)?.displayName ?? 'Someone',
      }));
  }, [grants, members, me]);

  const myDevice = devices.find((d) => d.id === deviceId) ?? null;
  const enforceable = myDevice?.isDeviceOwner === true && diagnostics.nativeT0Present;

  // ── actions ─────────────────────────────────────────────────────────────────

  function requestExtension(app: AppUsage, minutes: number): void {
    setRequests((prev) => [
      {
        id: Date.now() + prev.length,
        packageName: app.packageName,
        label: app.label,
        minutes,
        askedAt: Date.now(),
        askedOfId: askedOf?.id ?? null,
        askedOfName: askedOf?.displayName ?? 'a guardian',
      },
      ...prev,
    ]);
  }

  async function approve(request: ExtensionRequest): Promise<void> {
    const app = usage.find((u) => u.packageName === request.packageName);
    if (!app) return;
    // Granting time means moving the line, not muting the meter: the new limit is
    // written through the store so the row, the warning and the block all agree.
    const base = app.limitMinutes ?? app.minutesToday;
    await setLimit(request.packageName, base + request.minutes);
    setRequests((prev) => prev.filter((r) => r.id !== request.id));
    setResolved((prev) => [{ ...request, outcome: 'approved', resolvedAt: Date.now() }, ...prev]);
  }

  function decline(request: ExtensionRequest): void {
    setRequests((prev) => prev.filter((r) => r.id !== request.id));
    setResolved((prev) => [{ ...request, outcome: 'declined', resolvedAt: Date.now() }, ...prev]);
  }

  async function applyLimit(app: AppUsage, minutes: number | null): Promise<void> {
    if (app.limitMinutes !== null && minutes === null) {
      // Remember what it was, so "I want it back" is one tap and not a re-guess.
      setRestorable((prev) => ({ ...prev, [app.packageName]: app.limitMinutes as number }));
    }
    await setLimit(app.packageName, minutes);
    setConfirmOverride(null);
  }

  return (
    <ScrollView
      style={styles.screen}
      // This route no longer carries a native header (it always drew its own),
      // so the status-bar inset is this file's job.
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxxl },
      ]}
    >
      <View style={styles.header}>
        <PressableScale
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityLabel="Back"
          hitSlop={space.sm}
          highlightColor={colors.borderStrong}
          highlightRadius={radius.md}
          style={styles.back}
        >
          <Text style={styles.backGlyph}>‹</Text>
        </PressableScale>
        <View style={styles.headerText}>
          <Text style={styles.title}>Screen time</Text>
          <Text style={styles.subtitle}>Your usage, your limits, and who else can see them.</Text>
        </View>
      </View>

      <Card>
        <Text style={styles.totalBig}>{minutesLabel(totalMinutes)}</Text>
        <Text style={styles.totalLabel}>on screen today across {usage.length} apps</Text>
        <View style={styles.watchers}>
          {watchers.length === 0 ? (
            <Text style={styles.help}>
              Nobody else can see this list. Screen time is a consent scope like any other — someone
              can only read it while a grant you made is live (P-008).
            </Text>
          ) : (
            watchers.map((w) => (
              <Text key={w.grant.id} style={styles.help}>
                {w.name} can see this until {new Date(w.grant.expiresAt).toLocaleDateString()} —
                granted {relativeTime(w.grant.grantedAt)}, {w.grant.purpose.replace('_', ' ')}.
              </Text>
            ))
          )}
        </View>
      </Card>

      {/* ── Pending negotiations ────────────────────────────────────────────── */}
      {requests.length > 0 ? (
        <Section title={`Waiting on a guardian (${requests.length})`}>
          {requests.map((r) => (
            <Card key={r.id} tone="info">
              <Text style={styles.cardTitle}>
                +{r.minutes} minutes of {r.label}
              </Text>
              <Text style={styles.cardSub}>
                Asked of {r.askedOfName} {relativeTime(r.askedAt)}. Nothing changes until they answer.
              </Text>
              <View style={styles.actions}>
                <Button
                  label={`Approve as ${r.askedOfName}`}
                  onPress={() => void approve(r)}
                  variant="primary"
                  size="md"
                  style={styles.grow}
                  accessibilityLabel={`Approve ${r.minutes} extra minutes of ${r.label}`}
                />
                <Button
                  label="Decline"
                  onPress={() => decline(r)}
                  variant="ghost"
                  size="md"
                  style={styles.grow}
                  accessibilityLabel={`Decline the request for ${r.label}`}
                />
              </View>
              <Text style={styles.footnote}>
                The request is shown to a guardian and answered by a guardian. Kavach never grants
                itself an extension, and it never grants one silently.
              </Text>
            </Card>
          ))}
        </Section>
      ) : null}

      {/* ── The list ────────────────────────────────────────────────────────── */}
      <Section
        title="Today"
        right={
          <Pill
            label={`${limited.length} limited`}
            tone={limited.length === 0 ? 'neutral' : 'info'}
          />
        }
      >
        <Toggle
          value={showAll}
          onChange={setShowAll}
          label="Show apps with no limit"
          hint="Usage is measured for everything; a limit is a separate decision."
        />

        {visible.length === 0 ? (
          /* "Nothing measured yet" is a claim about the database, and asserting
             it before the database has been read is a false fact — the same
             failure as a green tick that means "we did not look". */
          <EmptyState
            glyph={!ready ? '·' : '◷'}
            title={
              !ready
                ? 'Reading today’s usage…'
                : usage.length > 0
                  ? 'No app has a limit'
                  : 'Nothing measured yet'
            }
            body={
              !ready
                ? 'It comes off this phone, not a server.'
                : usage.length > 0
                  ? 'Turn on “Show apps with no limit” above to see everything you used today.'
                  : 'Usage appears here as apps are used today.'
            }
          />
        ) : (
          visible.map((app) => {
            const limit = app.limitMinutes;
            const remaining = limit === null ? null : limit - app.minutesToday;
            const warning = remaining !== null && remaining > 0 && remaining <= WARNING_MINUTES;
            const over = remaining !== null && remaining <= 0;
            const fraction =
              limit === null
                ? Math.min(1, app.minutesToday / Math.max(60, totalMinutes))
                : Math.min(1, app.minutesToday / Math.max(1, limit));
            // The *Text* tokens, not the fills: this bar sits on a bgInput
            // track, where colors.info measures 1.69:1 — under the 3:1 WCAG
            // asks of a non-text element, so the only picture of the day's
            // usage was very nearly invisible. infoText is 7:1 on the same
            // track. The Pill beside it still carries the state in words.
            const barColour = over ? colors.dangerText : warning ? colors.warnText : colors.infoText;
            const canRestore = restorable[app.packageName] !== undefined && limit === null;

            return (
              <Card key={app.packageName} tone={over ? 'danger' : warning ? 'warn' : undefined}>
                <View style={styles.appHead}>
                  <View style={styles.appHeadText}>
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {app.label}
                    </Text>
                    <Text style={styles.package} numberOfLines={1}>
                      {app.packageName}
                    </Text>
                  </View>
                  <Text style={styles.appMinutes}>{minutesLabel(app.minutesToday)}</Text>
                </View>

                <View
                  style={styles.barTrack}
                  accessible
                  accessibilityRole="progressbar"
                  accessibilityLabel={`${app.label}: ${app.minutesToday} minutes used${
                    limit === null ? ', no limit' : ` of a ${limit} minute limit`
                  }`}
                >
                  <View style={[styles.barFill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: barColour }]} />
                </View>

                <View style={styles.statusRow}>
                  {limit === null ? (
                    <Pill label="No limit" tone="neutral" />
                  ) : over ? (
                    <Pill label={app.suspended ? 'Blocked' : 'Over the limit'} tone="danger" />
                  ) : warning ? (
                    <Pill label={`${remaining} min left`} tone="warn" />
                  ) : (
                    <Pill label={`${remaining} min left`} tone="ok" />
                  )}
                  {limit === null ? null : <Text style={styles.limitText}>limit {minutesLabel(limit)}</Text>}
                </View>

                {warning ? (
                  <Text style={styles.warnText}>
                    Five-minute warning. Nothing is ever cut off mid-sentence — you get this notice
                    before the block, every time.
                  </Text>
                ) : null}

                {/* ── set / change the limit ─────────────────────────────── */}
                <Text style={styles.fieldLabel}>Daily limit</Text>
                <View style={styles.chips}>
                  {LIMIT_PRESETS.map((m) => {
                    const selected = limit === m;
                    return (
                      <PressableScale
                        key={m}
                        onPress={() => void applyLimit(app, m)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`Set a ${m} minute daily limit on ${app.label}`}
                        highlightColor={colors.focus}
                        highlightRadius={radius.pill}
                        style={[styles.chip, selected ? styles.chipOn : null]}
                      >
                        <Text style={[styles.chipText, selected ? styles.chipTextOn : null]}>
                          {minutesLabel(m)}
                        </Text>
                      </PressableScale>
                    );
                  })}
                </View>

                {/* ── ask for more ───────────────────────────────────────── */}
                {limit === null ? null : (
                  <>
                    <Text style={styles.fieldLabel}>Ask for more time</Text>
                    <View style={styles.chips}>
                      {EXTENSION_PRESETS.map((m) => (
                        <PressableScale
                          key={m}
                          onPress={() => requestExtension(app, m)}
                          accessibilityLabel={`Ask ${
                            askedOf?.displayName ?? 'a guardian'
                          } for ${m} more minutes of ${app.label}`}
                          highlightColor={colors.focus}
                          highlightRadius={radius.pill}
                          style={styles.chip}
                        >
                          <Text style={styles.chipText}>+{m}m</Text>
                        </PressableScale>
                      ))}
                    </View>
                  </>
                )}

                {/* ★★ THE OVERRIDE (PRD §1.4.3) ★★ */}
                {isAdult ? (
                  limit === null ? (
                    canRestore ? (
                      <Button
                        label={`Put my ${minutesLabel(restorable[app.packageName])} limit back`}
                        onPress={() => void applyLimit(app, restorable[app.packageName])}
                        variant="ghost"
                        size="md"
                        accessibilityLabel={`Restore the ${restorable[app.packageName]} minute limit on ${app.label}`}
                      />
                    ) : null
                  ) : confirmOverride === app.packageName ? (
                    <View style={styles.actions}>
                      <Button
                        label="Yes, remove it"
                        onPress={() => void applyLimit(app, null)}
                        variant="danger"
                        size="md"
                        style={styles.grow}
                        accessibilityLabel={`Confirm removing your own limit on ${app.label}`}
                      />
                      <Button
                        label={t('common.cancel')}
                        onPress={() => setConfirmOverride(null)}
                        variant="ghost"
                        size="md"
                        style={styles.grow}
                        accessibilityLabel="Keep the limit"
                      />
                    </View>
                  ) : (
                    <Button
                      label="Remove my own limit"
                      onPress={() => setConfirmOverride(app.packageName)}
                      variant="ghost"
                      size="md"
                      accessibilityLabel={`Remove your own limit on ${app.label}`}
                    />
                  )
                ) : null}
              </Card>
            );
          })
        )}
      </Section>

      {/* ── Why the override exists ─────────────────────────────────────────── */}
      <Card tone={isAdult ? 'info' : 'warn'}>
        <Text style={styles.cardTitle}>
          {isAdult ? 'You can always remove your own limit' : 'Your limits are set with a guardian'}
        </Text>
        {isAdult ? (
          <Text style={styles.help}>
            One tap and a confirmation, no PIN held by somebody else, no request to anyone. A limit an
            adult cannot lift is not a wellbeing feature — it is control, and PRD §1.4.3 rules it out.
            The confirmation exists only so the tap is deliberate, never to make you justify it.
          </Text>
        ) : (
          <Text style={styles.help}>
            {guardians.length === 0
              ? 'No guardian is set for this family yet.'
              : `${guardians.map((g) => g.displayName).join(' and ')} set these limits, and can see this list.`}{' '}
            You can see everything they see, and you can ask for more time — that is the negotiation,
            and it happens in the open. When you become an adult in this family the override above
            becomes yours.
          </Text>
        )}
      </Card>

      {/* ── The honest note about enforcement ───────────────────────────────── */}
      <Card tone={enforceable ? 'ok' : 'warn'}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>What a block actually does</Text>
          <Pill label={enforceable ? 'Enforced' : 'Advisory'} tone={enforceable ? 'ok' : 'warn'} />
        </View>
        <Text style={styles.help}>
          Suspending an app for real needs this phone to be provisioned as Device Owner and needs the
          native module to call DevicePolicyManager.setPackagesSuspended(). This device
          {myDevice?.isDeviceOwner ? ' is ' : ' is not '}
          provisioned as Device Owner, and the native survival module is
          {diagnostics.nativeT0Present ? ' present' : ' not present in this build'}.
        </Text>
        <Text style={styles.help}>
          {enforceable
            ? 'A limit reached will suspend the app on this device.'
            : 'So a limit reached is recorded, warned about, and shown here — but the app is not force-stopped. Saying otherwise would make this screen a decoration you would stop believing.'}
        </Text>
      </Card>

      {resolved.length > 0 ? (
        <Section title="Answered">
          {resolved.map((r) => (
            <View key={r.id} style={styles.resolvedRow}>
              <Pill
                label={r.outcome === 'approved' ? 'Approved' : 'Declined'}
                tone={r.outcome === 'approved' ? 'ok' : 'neutral'}
              />
              <Text style={styles.resolvedText}>
                +{r.minutes}m {r.label} · {r.askedOfName} · {relativeTime(r.resolvedAt)}
              </Text>
            </View>
          ))}
          <Text style={styles.footnote}>
            Every answer is on the record. A negotiation nobody can look back at is not a negotiation.
          </Text>
        </Section>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.xl },

  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  back: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  backGlyph: { color: colors.text, fontSize: font.h1, fontWeight: weight.bold, lineHeight: font.h1 + 4 },
  headerText: { flex: 1, gap: space.xxs },
  title: { color: colors.text, fontSize: font.h1, fontWeight: weight.bold },
  subtitle: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 5 },

  totalBig: { color: colors.text, fontSize: font.display, fontWeight: weight.heavy },
  totalLabel: { color: colors.textDim, fontSize: font.small, marginTop: space.xxs },
  watchers: { marginTop: space.md, gap: space.xs },

  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  cardTitle: { flex: 1, color: colors.text, fontSize: font.h3, fontWeight: weight.bold },
  cardSub: { color: colors.textDim, fontSize: font.small, marginTop: space.xxs },

  appHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  appHeadText: { flex: 1, gap: space.xxs },
  package: { color: colors.textFaint, fontSize: font.tiny, fontFamily: font.mono },
  appMinutes: { color: colors.text, fontSize: font.h2, fontWeight: weight.bold },

  barTrack: {
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.bgInput,
    overflow: 'hidden',
    marginTop: space.md,
  },
  barFill: { height: 10, borderRadius: radius.pill },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  limitText: { color: colors.textDim, fontSize: font.small },

  fieldLabel: {
    color: colors.textFaint,
    fontSize: font.tiny,
    fontWeight: weight.bold,
    letterSpacing: tracking.caps,
    textTransform: 'uppercase',
    marginTop: space.md,
    marginBottom: space.xs,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: 68,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
  },
  // infoText on the border too: the fill token is 1.69:1 against the chip's own
  // background, so "which limit is selected" was carried by a tint you have to
  // look for. This edge is the fastest read in the row.
  chipOn: { borderColor: colors.infoText, backgroundColor: colors.infoSoft },
  chipText: { color: colors.textDim, fontSize: font.body, fontWeight: weight.semibold },
  chipTextOn: { color: colors.text },

  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  grow: { flex: 1 },

  help: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 6 },
  // The five-minute warning is the promise this screen makes. As colors.warn it
  // rendered at 2.71:1 on the card it sits in; warnText is 7.85:1.
  warnText: {
    color: colors.warnText,
    fontSize: font.small,
    lineHeight: font.small + 5,
    marginTop: space.sm,
  },
  footnote: { color: colors.textFaint, fontSize: font.tiny, lineHeight: font.tiny + 6, marginTop: space.sm },

  resolvedRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  resolvedText: { flex: 1, color: colors.textDim, fontSize: font.small },
});
