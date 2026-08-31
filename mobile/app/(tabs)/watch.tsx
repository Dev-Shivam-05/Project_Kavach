/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WATCH — one glance at the whole family, in list form.
 * ★ Spec A2/B (phase6b-redesign-and-family-watch, 29 Aug)
 *
 * This is the home for what the user actually asked this app to do at a glance:
 * "kisi ki location dekhna, camera access, mic access" in one place. Phase 6-D-1
 * shipped the honest part that already existed — location, gated by the same
 * rule Map enforces (`src/domain/consentStatus.ts`). 6-D-5 adds the Camera and
 * Listen icon-buttons (B1–B3), driven by 6-D-4's `grantStatusFor('camera'|
 * 'audio', ...)` — each renders disabled with the exact B3/F4 copy
 * (`disabledReasonFor`) until a real grant exists. What is still NOT here: the
 * live-view/listen screens themselves (D1–E4) need `react-native-webrtc` and a
 * TURN relay, neither of which exists until 6-D-7 — tapping an *enabled* button
 * says so honestly instead of opening a session (or writing an access-log row)
 * that has not actually happened.
 *
 * No new backend call exists here — same store selectors as `map.tsx`, so this
 * screen can never show a fact the map would not also stand behind.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React, { useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import type { ConsentScope, Member, UUID } from '../../src/core/types';
import {
  disabledReasonFor,
  grantStatusFor,
  mayDrawPin,
  shareStatusFor,
  statusShort,
  untilText,
  type ShareStatus,
} from '../../src/domain/consentStatus';
import { relativeTime, t } from '../../src/i18n';
import { useKavach } from '../../src/state/store';
import {
  Card,
  MemberAvatar,
  Pill,
  PressableScale,
  Section,
  SosHeaderButton,
} from '../../src/ui/components';
import { colors, font, leading, space, tracking, weight } from '../../src/ui/theme';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * ★ Spec D1/E1 (6-D-5 shell) — the honest thing to say when a grant exists but
 * the transport that would open a real session (6-D-7) does not. No session
 * starts, so no `AccessLogEntry` (D5/E4) is written here — writing one for a
 * session that never opened would be the exact fabrication this app's honest-
 * empty-state rule forbids.
 */
function alertWatchActionNotBuilt(member: Member, scope: Extract<ConsentScope, 'camera' | 'audio'>): void {
  const title = scope === 'camera' ? 'Camera view isn’t built yet' : 'Listening isn’t built yet';
  const verb = scope === 'camera' ? 'viewing' : 'listening';
  Alert.alert(
    title,
    `${member.displayName} has granted you this, but live ${verb} needs a feature this build doesn’t have yet. Nothing was sent to their phone.`,
    [{ text: t('common.done') }],
  );
}

function WatchActionButton({
  icon,
  label,
  disabled,
  reason,
  onPress,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  disabled: boolean;
  /** Read to a screen-reader user on this button specifically — the same B3/F4 copy the sighted reason line under the row shows. */
  reason: string | null;
  onPress: () => void;
}): React.ReactElement {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={reason ?? undefined}
      accessibilityState={{ disabled }}
      hitSlop={space.xs}
      style={[styles.actionButton, { borderColor: disabled ? colors.border : colors.borderStrong }]}
    >
      <Feather name={icon} size={18} color={disabled ? colors.textFaint : colors.text} />
    </PressableScale>
  );
}

function locationLine(status: ShareStatus, now: number, member: Member): string {
  switch (status.kind) {
    case 'self':
      return 'This phone.';
    case 'paused':
      return 'Monitoring paused — their choice, not a fault.';
    case 'granted':
      return `Sharing with you, ${untilText(status.grant.expiresAt, now)}.`;
    case 'revoked':
      return `Sharing revoked ${relativeTime(status.grant.revokedAt)}.`;
    case 'expired':
      return `Grant expired ${relativeTime(status.grant.expiresAt)} — nothing renews itself.`;
    default:
      return `${member.displayName} has not shared location with you.`;
  }
}

export default function WatchScreen(): React.ReactElement {
  const now = useNow(30_000);

  const me = useKavach((s) => s.me);
  const members = useKavach((s) => s.members);
  const presence = useKavach((s) => s.presence);
  const grants = useKavach((s) => s.grants);
  useKavach((s) => s.locale);

  const meId = me?.id ?? null;

  const statuses = useMemo<Record<UUID, ShareStatus>>(() => {
    const out: Record<UUID, ShareStatus> = {};
    for (const member of members) {
      out[member.id] = shareStatusFor(member, meId, presence[member.id], grants, now);
    }
    return out;
  }, [members, meId, presence, grants, now]);

  const others = useMemo(() => members.filter((m) => m.id !== meId), [members, meId]);

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.screenTitle}>
              {t('tab.watch')}
            </Text>
            <Text style={styles.screenSubtitle}>{t('watch.subtitle')}</Text>
          </View>
          <SosHeaderButton />
        </View>

        <Section title={t('tab.watch')} right={`${others.length}`}>
          {others.length === 0 ? (
            <Card>
              <Text style={styles.body}>Nobody else has joined this family yet.</Text>
            </Card>
          ) : (
            others.map((member) => {
              const status = statuses[member.id];
              const p = presence[member.id];
              const hasFix = mayDrawPin(status) && p?.location;
              const tone = status.kind === 'granted' ? 'ok' : undefined;

              // ★ Spec F1/HANDOFF note — camera/audio don't gate on
              // `monitoringPaused` the way location does, so `presence` is
              // deliberately passed as `undefined` here, not `p`.
              const cameraStatus = grantStatusFor('camera', member, meId, undefined, grants, now);
              const audioStatus = grantStatusFor('audio', member, meId, undefined, grants, now);
              const cameraReason = disabledReasonFor(cameraStatus, member);
              const audioReason = disabledReasonFor(audioStatus, member);
              // B1 shows one reason line; F1 lets camera/audio diverge (a
              // member can revoke one and keep the other). Dedupe so the
              // common case (both blocked for the same reason) still reads
              // as one line, and only show two when the reasons truly differ.
              const actionReasons = [cameraReason, audioReason].filter(
                (r, i, arr): r is string => r !== null && arr.indexOf(r) === i,
              );

              return (
                <Card key={member.id} tone={tone}>
                  <View style={styles.row}>
                    <MemberAvatar
                      member={member}
                      healthDot={p === undefined ? undefined : p.agentHealthy}
                    />
                    <View style={styles.middle}>
                      <Text style={styles.name} numberOfLines={1}>
                        {member.displayName}
                      </Text>
                      <Text style={styles.meta}>{locationLine(status, now, member)}</Text>
                      {hasFix && p?.location ? (
                        <Text style={styles.meta}>
                          {`Last fix ${relativeTime(p.location.at)} · accurate to about ${Math.max(
                            1,
                            Math.round(p.location.accuracyM),
                          )} m`}
                        </Text>
                      ) : null}
                    </View>
                    <Pill label={statusShort(status)} tone={status.kind === 'granted' || status.kind === 'self' ? 'ok' : 'neutral'} />
                  </View>

                  <View style={styles.actionsRow}>
                    <WatchActionButton
                      icon="video"
                      label={`View ${member.displayName}'s camera`}
                      disabled={cameraReason !== null}
                      reason={cameraReason}
                      onPress={() => alertWatchActionNotBuilt(member, 'camera')}
                    />
                    <WatchActionButton
                      icon="mic"
                      label={`Listen to ${member.displayName}`}
                      disabled={audioReason !== null}
                      reason={audioReason}
                      onPress={() => alertWatchActionNotBuilt(member, 'audio')}
                    />
                  </View>
                  {actionReasons.map((reason) => (
                    <Text key={reason} style={styles.actionReason}>
                      {reason}
                    </Text>
                  ))}
                </Card>
              );
            })
          )}
        </Section>

        <Text style={styles.footnote}>
          Camera and Listen use the same automatic family consent as this list — no separate
          approval per session. The live view/listen screens themselves are coming in a later
          update.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xl, gap: space.lg },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.md },
  header: { flex: 1, gap: space.xxs },
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

  body: { color: colors.text, fontSize: font.body, lineHeight: leading.body },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  middle: { flex: 1, gap: space.xxs },
  name: { color: colors.text, fontSize: font.h3, fontWeight: weight.semibold },
  meta: { color: colors.textDim, fontSize: font.small, lineHeight: leading.small },

  actionsRow: { flexDirection: 'row', gap: space.sm },
  actionButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionReason: { color: colors.textFaint, fontSize: font.tiny, lineHeight: leading.tiny },

  footnote: {
    color: colors.textFaint,
    fontSize: font.tiny,
    lineHeight: leading.tiny + 4,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: space.md,
  },
});
