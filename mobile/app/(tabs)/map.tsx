/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * MAP — where the family is, and, more importantly, where we are NOT ENTITLED to
 * say they are.
 *
 * ★★ THE RULE THIS SCREEN EXISTS TO ENFORCE (P-008, F-14, ADR-010) ★★
 * A pin is drawn only when a LIVE, UNREVOKED, UNEXPIRED `live_location` grant
 * from that person to me exists. Presence rows can and do carry a last known
 * position — the store keeps one for the panic path — and this screen deliberately
 * throws it away before handing anything to the map when the grant is gone. A
 * revoked grant that still paints a pin is a silent tracker, and a stale pin sends
 * a searcher to the wrong street. So the honest answer, "location not shared", is
 * rendered as text with the reason attached, and never as a dot.
 *
 * ★ ADR-010 — GEOFENCES ARE CLASS A ★
 * Their centres are home, school, the temple, the office: the family's routine,
 * reconstructable into a life. They are evaluated on this device, stored on this
 * device, and `store.addGeofence` has no outbox call at all. The UI says so out
 * loud, because a privacy property nobody can see is a promise nobody can check.
 *
 * There is no basemap here and there never will be — see FamilyMapView's header
 * for the three independent reasons (hard rule 4, ADR-010, §4.4).
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

import type {
  ConsentGrant,
  Device,
  Geofence,
  Member,
  MemberPresence,
  UUID,
} from '../../src/core/types';
import { relativeTime, t } from '../../src/i18n';
import { useKavach } from '../../src/state/store';
import {
  Button,
  Card,
  EmptyState,
  FamilyMapView,
  ListItem,
  MemberAvatar,
  Pill,
  PressableScale,
  Section,
  Toggle,
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

const MAP_HEIGHT = 300;
const RADIUS_CHOICES = [100, 150, 250, 500] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// Sharing status — the only thing that decides whether a pin may be drawn
// ═══════════════════════════════════════════════════════════════════════════════

type ShareStatus =
  | { kind: 'self' }
  | { kind: 'paused' }
  | { kind: 'granted'; grant: ConsentGrant }
  | { kind: 'revoked'; grant: ConsentGrant }
  | { kind: 'expired'; grant: ConsentGrant }
  | { kind: 'none' };

/**
 * P-066 is checked BEFORE the grant: when someone has paused monitoring, that is
 * the true and complete reason there is no position, and reporting a grant state
 * instead would blame the consent system for a choice the person made.
 */
function shareStatusFor(
  member: Member,
  meId: UUID | null,
  presence: MemberPresence | undefined,
  grants: ConsentGrant[],
  now: number,
): ShareStatus {
  if (meId !== null && member.id === meId) return { kind: 'self' };
  if (presence && presence.monitoringPaused) return { kind: 'paused' };

  const relevant = grants
    .filter(
      (g) =>
        g.grantorMemberId === member.id &&
        g.granteeMemberId === meId &&
        g.scope === 'live_location',
    )
    .sort((a, b) => b.grantedAt - a.grantedAt);

  const grant = relevant[0];
  if (!grant) return { kind: 'none' };
  if (grant.revokedAt !== null) return { kind: 'revoked', grant };
  if (grant.expiresAt <= now) return { kind: 'expired', grant };
  return { kind: 'granted', grant };
}

function mayDrawPin(status: ShareStatus): boolean {
  return status.kind === 'self' || status.kind === 'granted';
}

/** Forward-looking counterpart to relativeTime(), for grant expiry. */
function untilText(at: number, now: number): string {
  const ms = at - now;
  if (ms <= 0) return 'already';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function fenceTriggerText(fence: Geofence): string {
  const parts: string[] = [];
  if (fence.notifyOnEnter) parts.push('on arrival');
  if (fence.notifyOnExit) parts.push('on leaving');
  if (fence.dwellS !== null) parts.push(`if still there after ${Math.round(fence.dwellS / 60)} min`);
  return parts.length === 0 ? 'no alerts' : parts.join(' · ');
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// ═══════════════════════════════════════════════════════════════════════════════

export default function MapScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const now = useNow(60_000);

  const bootstrap = useKavach((s) => s.bootstrap);
  const ready = useKavach((s) => s.ready);
  const me = useKavach((s) => s.me);
  const members = useKavach((s) => s.members);
  const devices = useKavach((s) => s.devices);
  const presence = useKavach((s) => s.presence);
  const grants = useKavach((s) => s.grants);
  const geofences = useKavach((s) => s.geofences);
  const activeIncident = useKavach((s) => s.activeIncident);
  // Subscribed for its side effect on rendering: t() reads the locale from module
  // scope, so without this the screen keeps the old language after a change.
  useKavach((s) => s.locale);

  const addGeofence = useKavach((s) => s.addGeofence);
  const removeGeofence = useKavach((s) => s.removeGeofence);
  const findPhone = useKavach((s) => s.findPhone);

  const [selectedId, setSelectedId] = useState<UUID | null>(null);
  const [fenceOpen, setFenceOpen] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const meId = me?.id ?? null;

  const statuses = useMemo<Record<UUID, ShareStatus>>(() => {
    const out: Record<UUID, ShareStatus> = {};
    for (const member of members) {
      out[member.id] = shareStatusFor(member, meId, presence[member.id], grants, now);
    }
    return out;
  }, [members, meId, presence, grants, now]);

  /**
   * ★ The filter. Everything downstream — the pins, the accuracy discs, the
   *   bounds of the projection — sees only positions we are entitled to show.
   *   FamilyMapView then lists the rest as "location not shared", which is the
   *   honest sentence this screen is built around.
   */
  const visiblePresence = useMemo<Record<UUID, MemberPresence>>(() => {
    const out: Record<UUID, MemberPresence> = {};
    for (const member of members) {
      const p = presence[member.id];
      if (!p) continue;
      out[member.id] = mayDrawPin(statuses[member.id]) ? p : { ...p, location: null };
    }
    return out;
  }, [members, presence, statuses]);

  const sharingCount = useMemo(
    () => members.filter((m) => mayDrawPin(statuses[m.id]) && presence[m.id]?.location).length,
    [members, statuses, presence],
  );

  const incidentAt = useMemo(() => {
    const sealed = activeIncident?.sealed;
    return sealed ? { lat: sealed.lat, lon: sealed.lon } : null;
  }, [activeIncident]);

  const selected = useMemo<Member | null>(
    () => members.find((m) => m.id === selectedId) ?? null,
    [members, selectedId],
  );

  const myFix = meId === null ? null : (presence[meId]?.location ?? null);

  /**
   * The title is "Asked", not "Ringing", and the same reasoning as home.tsx
   * applies: `store.findPhone` discards the result of the control-plane POST, so
   * this screen cannot know the handset heard anything. What it can stand behind
   * is that the request was made and the access-log row exists — and awaiting the
   * store is what makes the second one true before the sentence is read.
   */
  const handleRing = useCallback(
    (device: Device, name: string) => {
      void (async () => {
        await findPhone(device.id);
        Alert.alert(
          `Asked ${name}'s phone to ring`,
          `It rings at full volume when the request reaches it, even if the phone is silenced. ${name} sees this in their access log either way.`,
          [{ text: t('common.done') }],
        );
      })();
    },
    [findPhone],
  );

  const handleAddFence = useCallback(
    (input: { label: string; radiusM: number; notifyOnEnter: boolean; notifyOnExit: boolean }) => {
      if (!myFix || meId === null) return;
      setFenceOpen(false);
      void addGeofence({
        label: input.label,
        lat: myFix.lat,
        lon: myFix.lon,
        radiusM: input.radiusM,
        notifyOnEnter: input.notifyOnEnter,
        notifyOnExit: input.notifyOnExit,
        dwellS: null,
        memberIds: [meId],
      });
    },
    [addGeofence, myFix, meId],
  );

  const handleRemoveFence = useCallback(
    (fence: Geofence) => {
      Alert.alert(
        `Delete “${fence.label}”?`,
        'The fence and its coordinates are deleted from this phone. Nothing is deleted from a server, because nothing was ever sent to one.',
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => void removeGeofence(fence.id),
          },
        ],
      );
    },
    [removeGeofence],
  );

  const subtitle = !ready
    ? 'Reading positions off this phone.'
    : members.length === 0
      ? 'No family members yet.'
      : `${sharingCount} of ${members.length} sharing a live position`;

  if (!ready) {
    return (
      <SafeAreaView edges={['top']} style={styles.screen}>
        <View style={styles.content}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.screenTitle}>
              {t('tab.map')}
            </Text>
            <Text style={styles.screenSubtitle}>{subtitle}</Text>
          </View>
          <View style={[styles.skeleton, styles.skeletonMap]} />
          <View style={styles.skeleton} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        // No bottom inset: the tab bar is laid out below this scene and pads the
        // gesture bar itself, so adding it here was dead space. One rule on all
        // five tabs — paddingBottom: space.xl.
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={`${t('tab.map')}. ${subtitle}`}
          style={styles.header}
        >
          <Text style={styles.screenTitle}>{t('tab.map')}</Text>
          <Text style={styles.screenSubtitle}>{subtitle}</Text>
        </View>

        {members.length === 0 ? (
          <EmptyState
            glyph="◎"
            title="Nobody to map"
            body="Enrol a family member and their position appears here — but only while they are sharing it with you."
          />
        ) : (
          <>
            <FamilyMapView
              members={members}
              presence={visiblePresence}
              incidentAt={incidentAt}
              onSelectMember={setSelectedId}
              height={MAP_HEIGHT}
            />

            <Text style={styles.mapNote}>
              No basemap, no tiles, no map server. Drawing this family on someone else’s map would
              disclose where they are to a company nobody in this house agreed to (ADR-010). The
              scale bar is how you read distance instead.
            </Text>

            {/* ── member selector ─────────────────────────────────────────── */}
            <Section title="Who to look at">
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}
              >
                {members.map((member) => {
                  const isSelected = member.id === selectedId;
                  const status = statuses[member.id];
                  return (
                    <PressableScale
                      key={member.id}
                      onPress={() => setSelectedId(isSelected ? null : member.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected }}
                      accessibilityLabel={`${member.displayName}, ${statusShort(status)}`}
                      accessibilityHint="Shows what this phone knows about them"
                      highlightColor={colors.focus}
                      highlightRadius={radius.pill}
                      style={[styles.chip, isSelected ? styles.chipSelected : null]}
                    >
                      <MemberAvatar member={member} size={26} />
                      <Text
                        style={[styles.chipText, isSelected ? styles.chipTextSelected : null]}
                        numberOfLines={1}
                      >
                        {member.asciiShortName}
                      </Text>
                      {/* P-018: the tick, not only the tint, says which one is on. */}
                      {isSelected ? (
                        <Text
                          style={styles.chipTick}
                          allowFontScaling={false}
                          importantForAccessibility="no"
                        >
                          ✓
                        </Text>
                      ) : null}
                    </PressableScale>
                  );
                })}
              </ScrollView>

              {selected === null ? (
                <ListItem
                  glyph="?"
                  title="Pick someone"
                  subtitle="Tap a name, or a pin on the map, to see exactly what this phone knows and why."
                />
              ) : (
                <MemberDetail
                  member={selected}
                  status={statuses[selected.id]}
                  presence={presence[selected.id]}
                  fences={geofences.filter((f) => f.memberIds.includes(selected.id))}
                  now={now}
                  device={devices.find(
                    (d) =>
                      d.memberId === selected.id && (d.platform === 'android' || d.platform === 'ios'),
                  )}
                  isMe={meId !== null && selected.id === meId}
                  onRing={handleRing}
                />
              )}
            </Section>
          </>
        )}

        {/* ── geofences ─────────────────────────────────────────────────────── */}
        <Section title="Geofences" right={`${geofences.length}`}>
          {/* ★ ADR-010 stated where it can actually be read, not buried in a
              privacy policy: this is the claim the code above has to keep. */}
          <Card tone="info">
            <Text style={styles.claimTitle}>Evaluated on this phone</Text>
            <Text style={styles.claimBody}>
              A fence is a circle around a place that matters — home, school, the temple. That
              circle is checked against your own position by this device. The coordinates are never
              uploaded, never synced and never leave the phone, because a list of the places a
              family goes is the family’s routine (ADR-010).
            </Text>
          </Card>

          {geofences.length === 0 ? (
            <EmptyState
              glyph="◌"
              title="No fences yet"
              body="Add one where you are standing. It stays on this phone."
            />
          ) : (
            geofences.map((fence) => (
              <ListItem
                key={fence.id}
                glyph="◎"
                title={fence.label}
                subtitle={`${fence.radiusM} m · ${fenceTriggerText(fence)}${
                  fence.memberIds.length === 0
                    ? ''
                    : ` · ${fence.memberIds
                        .map((id) => members.find((m) => m.id === id)?.asciiShortName ?? '?')
                        .join(', ')}`
                }`}
                right={
                  <PressableScale
                    onPress={() => handleRemoveFence(fence)}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete the ${fence.label} fence`}
                    hitSlop={space.sm}
                    highlightColor={colors.danger}
                    highlightRadius={radius.md}
                    style={styles.iconButton}
                  >
                    <Text style={styles.iconGlyph} allowFontScaling={false}>
                      ✕
                    </Text>
                  </PressableScale>
                }
              />
            ))
          )}

          <Button
            label="Add a fence here"
            icon="+"
            variant="ghost"
            disabled={myFix === null}
            onPress={() => setFenceOpen(true)}
            accessibilityLabel={
              myFix === null
                ? 'Add a fence here. Unavailable until this phone has a position fix.'
                : 'Add a geofence centred on your current position'
            }
          />
          {myFix === null ? (
            <Text style={styles.hint}>
              This phone has no position fix yet, so there is no centre to put a fence around.
            </Text>
          ) : null}
        </Section>
      </ScrollView>

      <FenceSheet
        visible={fenceOpen}
        centre={myFix}
        bottomInset={insets.bottom}
        onSave={handleAddFence}
        onClose={() => setFenceOpen(false)}
      />
    </SafeAreaView>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Member detail — the plain statement of what we know and why
// ═══════════════════════════════════════════════════════════════════════════════

function statusShort(status: ShareStatus): string {
  switch (status.kind) {
    case 'self':
      return 'this phone';
    case 'paused':
      return 'monitoring paused';
    case 'granted':
      return 'sharing location';
    case 'revoked':
      return 'sharing revoked';
    case 'expired':
      return 'grant expired';
    default:
      return 'location not shared';
  }
}

interface MemberDetailProps {
  member: Member;
  status: ShareStatus;
  presence: MemberPresence | undefined;
  fences: Geofence[];
  now: number;
  device: Device | undefined;
  isMe: boolean;
  onRing: (device: Device, name: string) => void;
}

function MemberDetail({
  member,
  status,
  presence,
  fences,
  now,
  device,
  isMe,
  onRing,
}: MemberDetailProps): React.ReactElement {
  // ★ The same gate as the map itself: no grant, no coordinates, not even here.
  const location = mayDrawPin(status) ? (presence?.location ?? null) : null;
  const battery = presence?.batteryPct ?? null;

  const reason: string = (() => {
    switch (status.kind) {
      case 'self':
        return 'This is your own phone. Your position is not a grant you had to be given.';
      case 'paused':
        // P-066 — stated as a right, with no hint of fault.
        return `${t('home.monitoringPaused', { name: member.displayName })}. That is their choice, and it is not a failure.`;
      case 'granted':
        return `Sharing live location with you, ${untilText(status.grant.expiresAt, now)}. ${t(
          'consent.noPermanent',
        )}`;
      case 'revoked':
        return `They revoked this ${relativeTime(status.grant.revokedAt)}. No position is available to you, and the last one this phone held is not shown.`;
      case 'expired':
        return `The grant expired ${relativeTime(status.grant.expiresAt)}. Nothing renews itself — they have to give it again.`;
      default:
        return 'No live location grant to you. Nothing is hidden here; there is simply nothing you are entitled to see.';
    }
  })();

  const tone = status.kind === 'granted' || status.kind === 'self' ? 'ok' : 'neutral';

  return (
    <Card tone={status.kind === 'granted' || status.kind === 'self' ? 'ok' : undefined}>
      <View style={styles.detailHead}>
        {/* healthDot is omitted, not defaulted, when presence is unknown: F-02
            says an unknown agent must never be drawn as a healthy one. */}
        <MemberAvatar member={member} healthDot={presence === undefined ? undefined : presence.agentHealthy} />
        <View style={styles.detailHeadText}>
          <Text style={styles.detailName}>{member.displayName}</Text>
          <Text style={styles.detailRole}>{member.role}</Text>
        </View>
        <Pill label={statusShort(status)} tone={tone} />
      </View>

      <Text style={styles.detailReason}>{reason}</Text>

      {location === null ? (
        <Text style={styles.detailFact}>
          {status.kind === 'granted'
            ? 'Sharing is allowed, but no fix has arrived from that phone yet.'
            : 'Location not shared.'}
        </Text>
      ) : (
        <View style={styles.factBlock}>
          <Text style={styles.detailFact}>
            {`Last fix ${relativeTime(location.at)} · accurate to about ${Math.max(
              1,
              Math.round(location.accuracyM),
            )} m`}
          </Text>
          {presence?.room ? (
            // P-028: indoors, a room name beats a rooftop GPS pin every time.
            <Text style={styles.detailFact}>{`Room: ${presence.room}`}</Text>
          ) : null}
        </View>
      )}

      <Text style={styles.detailFact}>
        {`${t('home.lastSeen', { ago: relativeTime(presence?.lastSeenAt ?? null) })}${
          battery === null ? '' : ` · ${t('home.battery', { pct: Math.round(battery) })}`
        }`}
      </Text>

      {fences.length > 0 ? (
        <Text style={styles.detailFact}>
          {`Watched fences: ${fences.map((f) => f.label).join(', ')} — checked on the phone that owns them.`}
        </Text>
      ) : null}

      {device !== undefined && !isMe ? (
        <Button
          label={t('home.findPhone')}
          icon="♪"
          variant="ghost"
          onPress={() => onRing(device, member.displayName)}
          accessibilityLabel={`Ring ${member.displayName}'s phone. This is recorded in their access log.`}
        />
      ) : null}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Add-fence sheet
// ═══════════════════════════════════════════════════════════════════════════════

interface FenceSheetProps {
  visible: boolean;
  centre: { lat: number; lon: number; accuracyM: number; at: number } | null;
  bottomInset: number;
  onSave: (input: {
    label: string;
    radiusM: number;
    notifyOnEnter: boolean;
    notifyOnExit: boolean;
  }) => void;
  onClose: () => void;
}

function FenceSheet({ visible, centre, bottomInset, onSave, onClose }: FenceSheetProps): React.ReactElement {
  const [label, setLabel] = useState('');
  const [radiusM, setRadiusM] = useState<number>(150);
  const [onEnter, setOnEnter] = useState(true);
  const [onExit, setOnExit] = useState(false);

  const trimmed = label.trim();

  const close = useCallback(() => {
    setLabel('');
    setRadiusM(150);
    setOnEnter(true);
    setOnExit(false);
    onClose();
  }, [onClose]);

  const save = useCallback(() => {
    if (trimmed.length === 0) return;
    const payload = { label: trimmed, radiusM, notifyOnEnter: onEnter, notifyOnExit: onExit };
    setLabel('');
    setRadiusM(150);
    setOnEnter(true);
    setOnExit(false);
    onSave(payload);
  }, [trimmed, radiusM, onEnter, onExit, onSave]);

  return (
    <Modal
      visible={visible}
      transparent
      // No animation outside the cancel countdown ring (theme.ts, PRD §6.4).
      animationType="none"
      // Without this the Android scrim stops at the status bar and the map shows
      // through above it, which reads as a half-drawn sheet.
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
        <ScrollView
          style={styles.sheetScroll}
          contentContainerStyle={[styles.sheet, { paddingBottom: bottomInset + space.lg }]}
          keyboardShouldPersistTaps="handled"
        >
          <Text accessibilityRole="header" style={styles.sheetTitle}>
            Add a fence here
          </Text>
          <Text style={styles.sheetBody}>
            Centred on where this phone is standing. The centre is stored on this device only — it is
            never uploaded (ADR-010).
          </Text>

          <TextInput
            value={label}
            onChangeText={setLabel}
            placeholder="Name it — Home, School, Temple"
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            accessibilityLabel="Fence name"
            maxLength={32}
            returnKeyType="done"
          />

          <Text style={styles.fieldLabel}>Radius</Text>
          <View style={styles.chipRowWrap}>
            {RADIUS_CHOICES.map((choice) => {
              const selected = choice === radiusM;
              return (
                <PressableScale
                  key={choice}
                  onPress={() => setRadiusM(choice)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${choice} metres`}
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
                    {`${choice} m`}
                  </Text>
                </PressableScale>
              );
            })}
          </View>

          <Toggle
            value={onEnter}
            onChange={setOnEnter}
            label="Tell me on arrival"
            hint="A quiet note when this phone enters the circle"
          />
          <Toggle
            value={onExit}
            onChange={setOnExit}
            label="Tell me on leaving"
            hint="A quiet note when this phone leaves the circle"
          />

          {centre === null ? (
            <Text style={styles.hint}>No position fix, so there is nothing to centre on.</Text>
          ) : (
            <Text style={styles.coords}>
              {`${centre.lat.toFixed(5)}, ${centre.lon.toFixed(5)} · ±${Math.round(
                centre.accuracyM,
              )} m · fixed ${relativeTime(centre.at)}`}
            </Text>
          )}

          <Button
            label={t('common.save')}
            variant="primary"
            size="lg"
            disabled={trimmed.length === 0 || centre === null}
            onPress={save}
            accessibilityLabel={
              trimmed.length === 0
                ? 'Name the fence first'
                : `Save the ${trimmed} fence, ${radiusM} metres across your current position`
            }
          />
          <Button label={t('common.cancel')} variant="quiet" onPress={close} />
        </ScrollView>
      </View>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
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
  skeletonMap: { height: MAP_HEIGHT },

  mapNote: {
    color: colors.textFaint,
    fontSize: font.tiny,
    lineHeight: font.tiny + 5,
  },

  // ── the shared chip ─────────────────────────────────────────────────────────
  // Byte-for-byte the geometry on home, incidents and settings. See home.tsx.
  chipRow: { flexDirection: 'row', gap: space.sm, paddingRight: space.lg },
  chipRowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
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

  detailHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  detailHeadText: { flex: 1 },
  detailName: { color: colors.text, fontSize: font.h3, fontWeight: weight.semibold },
  detailRole: { color: colors.textFaint, fontSize: font.small, textTransform: 'capitalize' },
  detailReason: { color: colors.text, fontSize: font.body, lineHeight: font.body + 6 },
  factBlock: { gap: space.xxs },
  detailFact: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 5 },

  claimTitle: { color: colors.text, fontSize: font.h3, fontWeight: weight.semibold },
  claimBody: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 6 },

  iconButton: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgElevated,
  },
  iconGlyph: { color: colors.textDim, fontSize: font.h3 },

  hint: { color: colors.textFaint, fontSize: font.small, lineHeight: font.small + 5 },
  coords: {
    color: colors.textDim,
    fontSize: font.small,
    fontFamily: font.mono,
  },

  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // The theme's own scrim, hue-matched to the surface scale. See home.tsx.
    backgroundColor: colors.bgOverlay,
  },
  sheetScroll: { flexGrow: 0, maxHeight: '90%' },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.md,
  },
  sheetTitle: { color: colors.text, fontSize: font.h2, fontWeight: weight.bold },
  sheetBody: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 6 },

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
});
