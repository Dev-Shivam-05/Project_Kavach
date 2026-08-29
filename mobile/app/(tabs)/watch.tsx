/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WATCH — one glance at the whole family, in list form.
 * ★ Spec A2/B (phase6b-redesign-and-family-watch, 29 Aug)
 *
 * This is the home for what the user actually asked this app to do at a glance:
 * "kisi ki location dekhna, camera access, mic access" in one place. Phase 6-D-1
 * ships the honest part that already exists — location, gated by the same rule
 * Map enforces (`src/domain/consentStatus.ts`) — and stops there. Camera and
 * Listen buttons are NOT in this screen yet: they need a `camera` consent scope
 * that does not exist until 6-D-4, and a live transport that does not exist
 * until 6-D-7. Shipping a disabled button for a feature with no scope to gate it
 * would be a fake control, which this codebase does not ship (G, 22 Aug).
 *
 * No new backend call exists here — same store selectors as `map.tsx`, so this
 * screen can never show a fact the map would not also stand behind.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Member, UUID } from '../../src/core/types';
import {
  mayDrawPin,
  shareStatusFor,
  statusShort,
  untilText,
  type ShareStatus,
} from '../../src/domain/consentStatus';
import { relativeTime, t } from '../../src/i18n';
import { useKavach } from '../../src/state/store';
import { Card, MemberAvatar, Pill, Section, SosHeaderButton } from '../../src/ui/components';
import { colors, font, leading, space, tracking, weight } from '../../src/ui/theme';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
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
                </Card>
              );
            })
          )}
        </Section>

        <Text style={styles.footnote}>
          Camera and listen access are coming in a later update — they need their own consent
          grant, separate from location, so a member can allow one without the other.
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

  footnote: {
    color: colors.textFaint,
    fontSize: font.tiny,
    lineHeight: leading.tiny + 4,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: space.md,
  },
});
