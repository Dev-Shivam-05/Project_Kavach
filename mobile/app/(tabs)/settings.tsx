/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SETTINGS — including the parts a safety app would rather you did not read.
 *
 * ★ PRD §5.4 — THE RESTRICTION LIST IS AN ETHICAL REQUIREMENT, NOT A FEATURE ★
 * Kavach can hold Device Owner on a family phone. That is the same privilege an
 * enterprise MDM holds, and the same privilege every commercial stalkerware
 * product wants. The one thing that separates the two is whether the person
 * holding the phone can see, at any moment and without asking anyone, the
 * complete list of what is being enforced on them. So the list below is
 * assembled from live state, is never behind a confirmation, is never
 * summarised, and says plainly when it is empty.
 *
 * ★ F-18 — THE SHORT NAME IS NOT COSMETIC ★
 * asciiShortName goes into the emergency SMS. One non-ASCII character turns the
 * message from GSM-7 to UCS-2 and cuts it from 160 characters to 70 (P-033 /
 * ADR-020), and two people sharing a short name makes "PRIYA NEEDS HELP"
 * ambiguous at the exact moment ambiguity costs the most. Both rules are
 * enforced here and both are explained in the words of the consequence.
 *
 * ★ P-066 — PAUSING IS A RIGHT, AND IT IS VISIBLE ★
 * An adult may switch monitoring off. The app's only job is to make sure that
 * reads differently to the family than a dead agent does, because conflating the
 * two teaches everyone to ignore both.
 *
 * ★ ONBOARDING IS NOT A ONE-WAY DOOR ★
 * "Run setup again" exists because the checklist in PRD Appendix E.4 is not a
 * tour that is finished once. Its last step — fire a real SOS and cancel it
 * unaided — is the single best predictor that the system will work when it
 * matters, it is deliberately skippable (a person trapped on step six has NO
 * panic button, which is strictly worse than one who has not rehearsed), and a
 * rehearsal from a year ago is not a rehearsal. So the way back in is a plain
 * action in Settings rather than a reinstall.
 *
 * ★ THE ABOUT BOX TELLS THE TRUTH ★
 * "This is not a substitute for calling 112. It may fail. It is a second layer,
 * not the first." A safety product that oversells itself gets someone killed by
 * making them wait for it.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

import { CONFIG, STORAGE_KEYS } from '../../src/core/config';
import type { Locale, Member } from '../../src/core/types';
import { memberRepo } from '../../src/db/repos';
import { DEMO_CANCEL_PIN, DEMO_DURESS_PIN, isDemo } from '../../src/domain/demo';
import { LOCALES, relativeTime, t } from '../../src/i18n';
import { useNodes } from '../../src/state/nodeStore';
import { useKavach } from '../../src/state/store';
import { failingChecks } from '../../src/t0/diagnostics';
import { setPins } from '../../src/t0/triggerRouter';
import {
  Button,
  Card,
  ListItem,
  MemberAvatar,
  Pill,
  PressableScale,
  Section,
  Toggle,
  type PillTone,
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

/** F-18: ASCII letters and digits, 1–8 characters. Nothing else survives GSM-7. */
const SHORT_NAME_RE = /^[A-Za-z0-9]{1,8}$/;
/** Long enough to resist a shoulder-surfer, short enough to type under adrenaline. */
const PIN_RE = /^\d{4,6}$/;

interface Restriction {
  title: string;
  detail: string;
  tone: PillTone;
  badge: string;
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function SettingsScreen(): ReactElement {
  const router = useRouter();

  const ready = useKavach((s) => s.ready);
  const me = useKavach((s) => s.me);
  const members = useKavach((s) => s.members);
  const devices = useKavach((s) => s.devices);
  const deviceId = useKavach((s) => s.deviceId);
  const familyId = useKavach((s) => s.familyId);
  const locale = useKavach((s) => s.locale);
  const presence = useKavach((s) => s.presence);
  const grants = useKavach((s) => s.grants);
  const geofences = useKavach((s) => s.geofences);
  const usage = useKavach((s) => s.usage);
  const vault = useKavach((s) => s.vault);
  const drills = useKavach((s) => s.drills);
  const journeys = useKavach((s) => s.journeys);
  const diagnostics = useKavach((s) => s.diagnostics);
  const lastCanaryAt = useKavach((s) => s.lastCanaryAt);
  const rehearsalSkipped = useKavach((s) => s.rehearsalSkipped);
  const changeLocale = useKavach((s) => s.changeLocale);
  const pauseMonitoring = useKavach((s) => s.pauseMonitoring);
  const resetOnboarding = useKavach((s) => s.resetOnboarding);

  // ── Profile ───────────────────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState<string>(me?.displayName ?? '');
  const [shortName, setShortName] = useState<string>(me?.asciiShortName ?? '');
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSavedAt, setProfileSavedAt] = useState<number | null>(null);

  // The store finishes booting after the first render; adopt the real values the
  // moment they land, without clobbering something already being typed.
  const [adopted, setAdopted] = useState<boolean>(false);
  useEffect(() => {
    if (adopted || !me) return;
    setDisplayName(me.displayName);
    setShortName(me.asciiShortName);
    setAdopted(true);
  }, [adopted, me]);

  const saveProfile = (): void => {
    if (!me) {
      setProfileError('This device has no member record yet, so there is nothing to save to.');
      return;
    }
    const name = displayName.trim();
    const short = shortName.trim();

    if (name.length === 0) {
      setProfileError('A name is needed — it is what your family sees when you need help.');
      return;
    }
    if (!SHORT_NAME_RE.test(short)) {
      setProfileError(
        'The short name must be 1–8 plain English letters or digits. One accented or Gujarati character shrinks an emergency SMS from 160 characters to 70.',
      );
      return;
    }
    const clash = members.find(
      (m) => m.id !== me.id && m.asciiShortName.toLowerCase() === short.toLowerCase(),
    );
    if (clash) {
      setProfileError(
        `${clash.displayName} already uses “${clash.asciiShortName}”. Two people with the same short name make an emergency SMS ambiguous about who needs help.`,
      );
      return;
    }

    const updated: Member = { ...me, displayName: name, asciiShortName: short };
    setProfileError(null);
    void (async () => {
      try {
        await memberRepo.upsert(updated);
      } catch {
        setProfileError('Could not write to this phone’s database. Nothing was changed.');
        return;
      }
      useKavach.setState((prev) => ({
        me: updated,
        members: prev.members.map((m) => (m.id === updated.id ? updated : m)),
      }));
      setProfileSavedAt(Date.now());
    })();
  };

  // ── PINs ──────────────────────────────────────────────────────────────────
  const [cancelPin, setCancelPin] = useState<string>('');
  const [duressPin, setDuressPin] = useState<string>('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinState, setPinState] = useState<{ cancelSet: boolean; duressSet: boolean; demoDefaults: boolean }>({
    cancelSet: false,
    duressSet: false,
    demoDefaults: false,
  });

  useEffect(() => {
    let dropped = false;
    void (async () => {
      try {
        const c = await SecureStore.getItemAsync(STORAGE_KEYS.cancelPin);
        const d = await SecureStore.getItemAsync(STORAGE_KEYS.duressPin);
        if (dropped) return;
        setPinState({
          cancelSet: c !== null && c.length > 0,
          duressSet: d !== null && d.length > 0,
          // Only claim the demo PINs are in force if they actually are.
          demoDefaults: isDemo() && c === DEMO_CANCEL_PIN && d === DEMO_DURESS_PIN,
        });
      } catch {
        // A phone with no keystore still runs; it simply has no PIN set.
      }
    })();
    return () => {
      dropped = true;
    };
  }, []);

  const savePinsNow = (): void => {
    if (!PIN_RE.test(cancelPin)) {
      setPinError('The cancel PIN must be 4 to 6 digits.');
      return;
    }
    if (!PIN_RE.test(duressPin)) {
      setPinError('The duress PIN must be 4 to 6 digits.');
      return;
    }
    if (cancelPin === duressPin) {
      setPinError('The two PINs must differ. If they are the same there is no duress path at all.');
      return;
    }
    setPinError(null);
    void (async () => {
      try {
        // Same accessibility class the store uses for the emergency key: an
        // unconscious person cannot supply a fingerprint (F-17).
        const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
        await SecureStore.setItemAsync(STORAGE_KEYS.cancelPin, cancelPin, options);
        await SecureStore.setItemAsync(STORAGE_KEYS.duressPin, duressPin, options);
      } catch {
        setPinError('This phone refused to store the PINs securely. Nothing was changed.');
        return;
      }
      // Rotate them inside T0 without a restart, so the very next trigger uses
      // the new numbers rather than the ones loaded at boot.
      setPins(cancelPin, duressPin);
      setPinState({ cancelSet: true, duressSet: true, demoDefaults: false });
      // Never leave a duress PIN sitting in a field for the next person who
      // picks the phone up.
      setCancelPin('');
      setDuressPin('');
      Alert.alert(
        'PINs saved',
        'Both PINs are stored on this phone only. Nobody — not your family, not a server — can read them back.',
        [{ text: t('common.done') }],
      );
    })();
  };

  // ── Monitoring (P-066) ────────────────────────────────────────────────────
  const paused = me ? (presence[me.id]?.monitoringPaused ?? false) : false;

  const onPause = (next: boolean): void => {
    if (!next) {
      void pauseMonitoring(false);
      return;
    }
    Alert.alert(
      'Pause monitoring?',
      'Fall, crash and missed check-in detection stop for you. The panic button keeps working.\n\nYour family is shown that you paused it. They are not shown that you are fine — a pause and a dead phone must never look the same.',
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: 'Pause',
          style: 'destructive',
          onPress: () => {
            void pauseMonitoring(true);
          },
        },
      ],
    );
  };

  // ── Setup, re-entered on purpose (PRD Appendix E.4) ───────────────────────
  /**
   * Clearing the persisted flag is the whole mechanism: the entry route reads
   * `onboarded` from the store, so replacing to '/' after it flips lands on the
   * checklist rather than the tabs. Nothing is deleted on the way — keys,
   * enrolment, PINs, medical card and history all survive, because a person who
   * only wants to re-practise the test SOS must not have to pay for it with
   * everything else they already set up.
   */
  const onRunSetupAgain = (): void => {
    Alert.alert(
      'Run setup again?',
      'The six steps start over: what Kavach is and is not, the family agreement, permissions, both PINs, your medical card, and a test SOS you fire and cancel yourself.\n\nNothing is deleted. Your keys, your family, your history and your current PINs stay exactly as they are unless you change them.',
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: 'Run setup',
          onPress: () => {
            void (async () => {
              await resetOnboarding();
              router.replace('/');
            })();
          },
        },
      ],
    );
  };

  // ── Device management (PRD §5.4) ──────────────────────────────────────────
  const thisDevice = useMemo(() => devices.find((d) => d.id === deviceId) ?? null, [devices, deviceId]);

  /**
   * ★ EVERY active restriction, assembled from live state rather than a curated
   *   list. If the app starts enforcing something new, it appears here because
   *   the state it enforces from is the state this reads.
   */
  const restrictions = useMemo<Restriction[]>(() => {
    const now = Date.now();
    const out: Restriction[] = [];
    const meId = me?.id ?? '';

    for (const u of usage) {
      if (u.suspended) {
        out.push({
          title: `${u.label} is blocked right now`,
          detail: `${u.minutesToday} minutes used today against a ${u.limitMinutes ?? 0} minute limit. The app stays suspended until the limit resets.`,
          tone: 'danger',
          badge: 'Blocked',
        });
      } else if (u.limitMinutes !== null) {
        out.push({
          title: `${u.label} is limited to ${u.limitMinutes} minutes a day`,
          detail: `${u.minutesToday} minutes used so far today.`,
          tone: 'warn',
          badge: 'Limited',
        });
      }
    }

    for (const g of grants) {
      if (g.grantorMemberId !== meId) continue;
      if (g.grantedVia === 'self') continue; // you set that one yourself
      if (g.revokedAt !== null || g.expiresAt <= now) continue;
      const grantee = members.find((m) => m.id === g.granteeMemberId)?.displayName ?? 'Someone';
      out.push({
        title: `${grantee} can see your ${g.scope.replace(/_/g, ' ')}`,
        detail: `Set under ${g.grantedVia.replace(/_/g, ' ')} rather than by you. It expires on its own. You can revoke it now on the Privacy tab.`,
        tone: 'warn',
        badge: 'Policy',
      });
    }

    for (const f of geofences) {
      if (!f.memberIds.includes(meId)) continue;
      const triggers = [
        f.notifyOnEnter ? 'arriving' : null,
        f.notifyOnExit ? 'leaving' : null,
        f.dwellS !== null ? `staying over ${Math.round(f.dwellS / 60)} minutes` : null,
      ].filter((x): x is string => x !== null);
      out.push({
        title: `“${f.label}” watches you`,
        detail:
          triggers.length === 0
            ? 'No alert is configured for this area.'
            : `Your family is told when you are ${triggers.join(' or ')}. The area is checked on this phone; its coordinates never leave it.`,
        tone: 'info',
        badge: 'Geofence',
      });
    }

    return out;
  }, [usage, grants, geofences, members, me]);

  // ── Link counters ─────────────────────────────────────────────────────────
  /**
   * The unpractised test SOS counts as a failing check here for the same reason
   * it does on the diagnostics screen (P-031): if the two screens disagreed
   * about how many problems this phone has, the smaller number is the one people
   * would believe.
   */
  const failing = useMemo(
    () => failingChecks(diagnostics).length + (rehearsalSkipped ? 1 : 0),
    [diagnostics, rehearsalSkipped],
  );
  const activeJourneys = useMemo(() => journeys.filter((j) => j.state === 'active').length, [journeys]);
  const limitedApps = useMemo(
    () => usage.filter((u) => u.limitMinutes !== null || u.suspended).length,
    [usage],
  );
  // Subscribed with a selector so the settings screen re-renders on node count
  // alone, not on every motion event the viewer streams.
  const nodeCount = useNodes((s) => s.nodes.length);
  const medical = useKavach((s) => s.medical);
  const version = Constants.expoConfig?.version ?? '1.0.0';

  const subtitle = !ready
    ? 'Reading this phone’s settings.'
    : 'Your profile, your PINs, and everything this phone enforces on you.';

  if (!ready) {
    return (
      <SafeAreaView edges={['top']} style={styles.screen}>
        <View style={styles.content}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.screenTitle}>
              {t('tab.settings')}
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
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={`${t('tab.settings')}. ${subtitle}`}
          style={styles.header}
        >
          <Text style={styles.screenTitle}>{t('tab.settings')}</Text>
          <Text style={styles.screenSubtitle}>{subtitle}</Text>
        </View>

        {/* ── Profile ────────────────────────────────────────────────────────── */}
        <Section title="Profile">
          <Card>
            {me ? (
              <View style={styles.identityRow}>
                <MemberAvatar member={me} size={52} healthDot />
                <View style={styles.identityText}>
                  <Text style={styles.h3}>{me.displayName}</Text>
                  <Text style={styles.meta}>
                    {me.role} · {me.phoneE164 ?? 'no phone number on file'}
                  </Text>
                </View>
              </View>
            ) : (
              // Boot finished and there is still no member row. Saying so here
              // beats letting someone fill two fields and only find out when Save
              // refuses them.
              <Text style={styles.error}>
                This device has no member record yet, so nothing can be saved to it. Finish setup, or
                add this phone to a family, and this comes back.
              </Text>
            )}

            <Text style={styles.label}>Name your family sees</Text>
            <TextInput
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="Full name"
              placeholderTextColor={colors.textFaint}
              accessibilityLabel="Your display name"
              accessibilityHint="The name your family sees on an alert"
              style={styles.input}
            />

            <Text style={styles.label}>Short name for emergency SMS</Text>
            <TextInput
              value={shortName}
              onChangeText={setShortName}
              placeholder="e.g. Rohan"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={8}
              accessibilityLabel="Your ASCII short name"
              accessibilityHint="Plain English letters and digits, eight characters at most, unique in your family"
              style={[styles.input, styles.mono]}
            />
            {/* F-18 + P-033 stated as consequences, not as validation rules. */}
            <Text style={styles.meta}>
              Plain English letters and digits, 8 characters at most, and different from everyone
              else in the family. When every data leg is down, your emergency goes out as a 160
              character SMS and this is the part of it that says who needs help. A single accented,
              Hindi or Gujarati character would cut that message to 70 characters; a duplicate would
              make it ambiguous.
            </Text>

            {profileError !== null ? <Text style={styles.error}>{profileError}</Text> : null}

            <View style={styles.actionRow}>
              <Button
                label={t('common.save')}
                onPress={saveProfile}
                accessibilityLabel="Save your profile"
                style={styles.grow}
              />
              {profileSavedAt !== null && profileError === null ? (
                <Pill label={`Saved ${relativeTime(profileSavedAt)}`} tone="ok" />
              ) : null}
            </View>
          </Card>

          <Card>
            <Text style={styles.h3}>Language</Text>
            <Text style={styles.meta}>
              A preference of yours, not of this phone. It follows you to a new device, and every
              other member keeps their own.
            </Text>
            <View style={styles.chipRow}>
              {LOCALES.map((l) => {
                const selected = locale === l.code;
                return (
                  <PressableScale
                    key={l.code}
                    onPress={() => {
                      void changeLocale(l.code as Locale);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${l.label}`}
                    accessibilityState={{ selected }}
                    highlightColor={colors.focus}
                    highlightRadius={radius.pill}
                    style={[styles.chip, selected ? styles.chipSelected : null]}
                  >
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
                      {l.native}
                    </Text>
                  </PressableScale>
                );
              })}
            </View>
            <Text style={styles.meta}>
              The emergency SMS itself stays in ASCII English whatever you pick here — that is what
              keeps it to one message instead of three.
            </Text>
          </Card>
        </Section>

        {/* ── Safety ─────────────────────────────────────────────────────────── */}
        <Section title="Safety">
          <Card>
            <View style={styles.headRow}>
              <Text style={styles.h3}>Cancel PIN</Text>
              <Pill
                label={pinState.cancelSet ? 'Set' : 'Not set'}
                tone={pinState.cancelSet ? 'ok' : 'danger'}
              />
            </View>
            <Text style={styles.meta}>
              Typed during the countdown to stop an alert before your family is woken. Without one,
              nothing can be cancelled.
            </Text>
            <TextInput
              value={cancelPin}
              onChangeText={setCancelPin}
              placeholder="4 to 6 digits"
              placeholderTextColor={colors.textFaint}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
              accessibilityLabel="New cancel PIN"
              accessibilityHint="Four to six digits"
              style={[styles.input, styles.mono]}
            />

            <View style={styles.headRow}>
              <Text style={styles.h3}>Duress PIN</Text>
              <Pill
                label={pinState.duressSet ? 'Set' : 'Not set'}
                tone={pinState.duressSet ? 'ok' : 'danger'}
              />
            </View>
            {/* ★ F-01 in plain language. Someone has to be able to explain this
                to a frightened person in one breath. */}
            <Text style={styles.body}>
              A second PIN for when somebody is standing over you making you cancel.
            </Text>
            <Text style={styles.meta}>
              Type it and this phone behaves exactly as if you had typed the real one: same words on
              screen, the siren stops at the same moment, nothing flashes, nothing buzzes, no extra
              wait. What actually happens is that your family is told, silently, that the alert was
              cancelled under pressure — and they are told where you are. Nobody watching the screen
              can tell which PIN you used. Do not write it anywhere and do not tell anyone it exists.
            </Text>
            <TextInput
              value={duressPin}
              onChangeText={setDuressPin}
              placeholder="4 to 6 digits, different from the cancel PIN"
              placeholderTextColor={colors.textFaint}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
              accessibilityLabel="New duress PIN"
              accessibilityHint="Four to six digits, different from the cancel PIN"
              style={[styles.input, styles.mono]}
            />

            {pinError !== null ? <Text style={styles.error}>{pinError}</Text> : null}

            <Button
              label="Save both PINs"
              onPress={savePinsNow}
              accessibilityLabel="Save the cancel PIN and the duress PIN"
            />

            {pinState.demoDefaults ? (
              <Text style={styles.warnLine}>
                This build is still using the demo PINs — cancel {DEMO_CANCEL_PIN}, duress{' '}
                {DEMO_DURESS_PIN}. They exist so the duress path can be practised before you rely on
                it. Replace both before this phone protects anyone.
              </Text>
            ) : null}
          </Card>
        </Section>

        {/* ── Monitoring (P-066) ─────────────────────────────────────────────── */}
        <Section title="Monitoring">
          <Toggle
            value={paused}
            onChange={onPause}
            label="Pause automatic monitoring"
            hint="Your choice, and your family can see that you made it."
          />
          <Text style={styles.meta}>
            While paused, fall, crash, no-motion and missed check-in detection stop for you. The
            panic button, the emergency SMS and everything on the Privacy tab keep working. Your
            family sees “monitoring paused” next to your name — never “everything is fine”, and
            never the same thing a dead phone shows.
          </Text>
        </Section>

        {/* ── Device management (PRD §5.4) ───────────────────────────────────── */}
        <Section title="This device">
          <Card tone={thisDevice?.isDeviceOwner === true ? 'warn' : undefined}>
            <View style={styles.headRow}>
              <Text style={styles.h3}>Device Owner</Text>
              <Pill
                label={thisDevice?.isDeviceOwner === true ? 'Held' : 'Not held'}
                tone={thisDevice?.isDeviceOwner === true ? 'warn' : 'neutral'}
              />
            </View>
            <Text style={styles.body}>
              {thisDevice?.isDeviceOwner === true
                ? 'Kavach holds Device Owner on this phone. That is the same privilege a company MDM holds: it can suspend apps, block its own uninstall and keep permissions from being revoked. Everything it is currently doing with that privilege is listed below, in full.'
                : 'Kavach does not hold Device Owner on this phone. It cannot suspend apps, block its own removal or stop a permission being taken away. Anything below is enforced by agreement, not by the operating system.'}
            </Text>
            <Text style={styles.meta}>
              {thisDevice?.model ?? 'Unknown model'} · {thisDevice?.manufacturer ?? 'unknown maker'} ·
              Android {thisDevice?.osVersion ?? '?'} · last heartbeat{' '}
              {relativeTime(thisDevice?.lastHeartbeatAt ?? null)}
            </Text>
          </Card>

          <Card>
            <Text style={styles.h3}>Everything being enforced on you right now</Text>
            {restrictions.length === 0 ? (
              <Text style={styles.body}>
                Nothing. No app is blocked or limited, no area is watching you, and no grant against
                you was made by anyone but you.
              </Text>
            ) : (
              restrictions.map((r) => (
                <ListItem
                  key={`${r.badge}:${r.title}`}
                  title={r.title}
                  subtitle={r.detail}
                  right={<Pill label={r.badge} tone={r.tone} />}
                />
              ))
            )}
            <Text style={styles.meta}>
              This list is never shortened, never hidden behind a password, and never needs anyone’s
              permission to open. If something is being done to this phone and is not written here,
              that is a bug worth reporting.
            </Text>
          </Card>
        </Section>

        {/* ── The rest of the app ────────────────────────────────────────────── */}
        <Section title="More">
          <ListItem
            glyph="✚"
            title={t('diag.title')}
            subtitle={
              failing === 0
                ? t('diag.healthy')
                : `${t('diag.problems', { n: failing })} · checked ${relativeTime(diagnostics.lastCheckedAt)}`
            }
            right={<Pill label={failing === 0 ? 'Passing' : `${failing}`} tone={failing === 0 ? 'ok' : 'warn'} />}
            danger={failing > 0}
            onPress={() => router.push('/diagnostics')}
          />
          {/*
            §10.4 layer 1. The card is read off a locked phone by a stranger, so
            the only time it can be corrected is now — long before it is needed.
          */}
          <ListItem
            glyph="✚"
            title={t('medical.title')}
            subtitle={
              medical.bloodGroup.length > 0
                ? `${medical.bloodGroup} · ${medical.allergies.length} allergies · ${medical.iceContacts.length} emergency contacts`
                : 'Empty. A blood group and two numbers are what a stranger needs first.'
            }
            danger={medical.bloodGroup.length === 0}
            onPress={() => router.push('/medical-card')}
          />
          <ListItem
            glyph="▤"
            title="Vault"
            subtitle={`${vault.length} sealed ${vault.length === 1 ? 'item' : 'items'} · ${vault.filter((v) => v.quorumRequired).length} need two guardians to open`}
            onPress={() => router.push('/vault')}
          />
          <ListItem
            glyph="◎"
            title="Drills"
            subtitle={`${drills.length} recorded · last silent canary ${relativeTime(lastCanaryAt)}`}
            onPress={() => router.push('/drills')}
          />
          <ListItem
            glyph="→"
            title="Journeys"
            subtitle={
              activeJourneys === 0
                ? 'Nobody is travelling right now'
                : `${activeJourneys} in progress`
            }
            onPress={() => router.push('/journeys')}
          />
          <ListItem
            glyph="⏱"
            title="Screen time"
            subtitle={
              limitedApps === 0 ? 'No app is limited' : `${limitedApps} apps limited or blocked`
            }
            onPress={() => router.push('/screen-time')}
          />
          {/*
            §3.3 item 0.15. Without this row the family key is generated on this
            phone and sealed to nobody, so "family" is a single-device word and
            every fan-out above it has one recipient.
          */}
          <ListItem
            glyph="⇄"
            title="Add a phone to this family"
            subtitle="Two phones, one code read across the room. No internet needed. Everyone who joins shares one key, which is what lets an alarm on one phone reach all the others."
            onPress={() => router.push('/enrol')}
          />
          {/*
            P-024. Two separate entries on purpose. Watching a room and being the
            room being watched are different acts with different consent, and a
            single "Camera" row would let someone arm this phone while thinking
            they were only looking at another one.
          */}
          <ListItem
            glyph="▣"
            title="Family cameras"
            subtitle={
              nodeCount === 0
                ? 'No spare phone is watching anything'
                : `${nodeCount} node${nodeCount === 1 ? '' : 's'} · anyone in the family can switch one off`
            }
            onPress={() => router.push('/camera-view')}
          />
          <ListItem
            glyph="◉"
            title="Use this phone as a camera"
            subtitle="Turns THIS device into a monitoring node. It refuses a bedroom or a bathroom, and stops itself the moment anyone is home."
            onPress={() => router.push('/camera-node')}
          />
          {/* Appendix E.4 — the checklist you are allowed to walk back into. */}
          <ListItem
            glyph="↻"
            title="Run setup again"
            subtitle={
              rehearsalSkipped
                ? 'This phone has never practised a test SOS. Step six is that practice — nothing else is deleted.'
                : 'The six setup steps from the start: the agreement, permissions, both PINs, your medical card, and a test SOS you cancel yourself. Nothing is deleted.'
            }
            right={rehearsalSkipped ? <Pill label="Never rehearsed" tone="warn" /> : undefined}
            danger={rehearsalSkipped}
            onPress={onRunSetupAgain}
          />
        </Section>

        {/* ── About ──────────────────────────────────────────────────────────── */}
        <Section title="About">
          <Card tone="danger">
            <Text style={styles.h3}>What this is not</Text>
            {/* The exact sentence, unhedged. */}
            <Text style={styles.honest}>
              This is not a substitute for calling 112. It may fail. It is a second layer, not the
              first.
            </Text>
            <Text style={styles.body}>
              If you can call {CONFIG.emergencyNumber}, call {CONFIG.emergencyNumber}. This app
              exists for the minute before that is possible and for the case where nobody knows to
              call at all.
            </Text>
            <Text style={styles.meta}>
              It can be killed by your phone’s battery manager. It can be beaten by a dead battery,
              a broken screen, no signal in a basement, or a family that has silenced its
              notifications. It does not contact the police, it does not dispatch an ambulance, and
              it cannot make anybody come. It tells the people who already care, faster and with
              better information than a phone call would, and it keeps saying so until one of them
              answers.
            </Text>
          </Card>

          <ListItem title={CONFIG.appName} subtitle={`Version ${version}`} right={isDemo() ? <Pill label="Demo data" tone="info" /> : undefined} />
          <ListItem
            title="Identifiers"
            subtitle={`Family ${familyId.slice(0, 8) || 'unknown'} · device ${deviceId.slice(0, 8) || 'unknown'} · ${members.length} members · ${devices.length} devices`}
          />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    // The tab bar pads its own inset. One rule on all five tabs.
    paddingBottom: space.xl,
    gap: space.lg,
  },

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

  skeleton: {
    height: 72,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
  },
  skeletonTall: { height: 160 },

  h3: { color: colors.text, fontSize: font.h3, fontWeight: weight.semibold },
  body: { color: colors.text, fontSize: font.body, fontWeight: weight.regular, lineHeight: leading.body },
  meta: { color: colors.textDim, fontSize: font.small, fontWeight: weight.regular, lineHeight: leading.small },
  // ★ The *Text* tokens. `error` is every validation message on this screen and
  //   `warnLine` is the demo-PIN warning — "Replace both before this phone
  //   protects anyone", arguably the most safety-critical sentence in Settings.
  //   As fills they measured 2.76:1 and 2.71:1 on bgCard — dark red and dark
  //   brown on dark grey. As text tokens they are 7.95:1 and 7.85:1.
  error: { color: colors.dangerText, fontSize: font.small, fontWeight: weight.semibold, lineHeight: leading.small },
  warnLine: { color: colors.warnText, fontSize: font.small, fontWeight: weight.medium, lineHeight: leading.small },
  honest: { color: colors.text, fontSize: font.h3, fontWeight: weight.bold, lineHeight: leading.h3 },
  label: { color: colors.textDim, fontSize: font.small, fontWeight: weight.semibold, letterSpacing: 0.6 },

  identityRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  identityText: { flex: 1, gap: space.xxs },

  input: {
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgInput,
    color: colors.text,
    fontSize: font.body,
  },
  mono: { fontFamily: font.mono, letterSpacing: 1 },

  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  grow: { flex: 1 },

  // ── the shared chip ─────────────────────────────────────────────────────────
  // Byte-for-byte the geometry on home, map and incidents. See home.tsx.
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
