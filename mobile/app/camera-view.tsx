/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CAMERA VIEW — every camera in the family, and the switch that kills it (P-024)
 *
 * ★★★ WHY THE KILL SWITCH IS THE POINT OF THIS SCREEN ★★★
 * A home camera controlled only by whoever installed it is not a security
 * product, it is a power imbalance with a lens on it. The person most likely to
 * be filmed by a camera in a family home is a family member, and the person
 * least likely to have set it up is the one who most needs to be able to stop
 * it. So this screen is not primarily a monitoring dashboard — it is the place
 * where anybody in the family, with no role check, no owner check, no quorum and
 * no explanation, switches a camera off.
 *
 * The asymmetry is deliberate and is enforced in nodeStore.ts: switching a
 * camera OFF works from any phone, instantly. Switching it back ON only works on
 * the phone that is the camera, which somebody has to physically walk to. An
 * objection can never be overruled from another room.
 *
 * ★★★ IT WORKS WITH NO BACKEND ★★★
 * Everything here is local node state. A kill applied to a node on
 * another phone is recorded as an instruction rather than reported as done — the
 * screen says which it is, because "switched off" and "asked to switch off" are
 * not the same sentence to somebody who does not want to be filmed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SNAPSHOT_RETENTION_DAYS, formatCelsius } from '../src/domain/cctv';
import { useKavach } from '../src/state/store';
import {
  describeRuntime,
  sinceLabel,
  useNodes,
  type MotionEvent,
  type NodeStatus,
} from '../src/state/nodeStore';
import { Button, Card, EmptyState, Pill, PressableScale, Section } from '../src/ui/components';
import { MIN_TOUCH_TARGET, colors, font, radius, space, weight } from '../src/ui/theme';
import type { PillTone } from '../src/ui/components';

const RECENT_EVENTS = 12;

export default function CameraViewScreen() {
  const insets = useSafeAreaInsets();

  const ready = useNodes((s) => s.ready);
  const hydrate = useNodes((s) => s.hydrate);
  const nodes = useNodes((s) => s.nodes);
  const events = useNodes((s) => s.events);
  const selfNodeId = useNodes((s) => s.selfNodeId);
  const disableNode = useNodes((s) => s.disableNode);
  const purgeSnapshots = useNodes((s) => s.purgeSnapshots);

  const me = useKavach((s) => s.me);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(handle);
  }, []);

  const recent = useMemo(
    () => [...events].sort((a, b) => b.at - a.at).slice(0, RECENT_EVENTS),
    [events],
  );

  /**
   * ★ No guard. Not `if (me.role === 'guardian')`, not `if (node.ownerMemberId
   *   === me.id)`. Every member, every camera, always. A confirmation dialog is
   *   the ONLY thing between the tap and the camera stopping, and that exists to
   *   prevent an accident, not to ask permission.
   */
  const confirmKill = useCallback(
    (node: NodeStatus) => {
      const isLocal = node.id === selfNodeId;
      Alert.alert(
        'Switch this camera off?',
        isLocal
          ? `"${node.placement}" stops immediately. Only this phone can turn it back on.`
          : `"${node.placement}" runs on ${node.ownerName}'s phone. It will stop as soon as that phone sees this, and only that phone can turn it back on.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Switch it off',
            style: 'destructive',
            onPress: () =>
              void disableNode(node.id, {
                memberId: me?.id ?? '',
                name: me?.displayName ?? 'A family member',
                at: Date.now(),
              }),
          },
        ],
      );
    },
    [disableNode, me, selfNodeId],
  );

  const confirmPurge = useCallback(
    (node: NodeStatus) => {
      const isLocal = node.id === selfNodeId;
      Alert.alert(
        'Delete every snapshot?',
        isLocal
          ? 'Every stored snapshot from this camera is deleted now. This cannot be undone.'
          : `The snapshots are held on ${node.ownerName}'s phone. They are deleted as soon as that phone sees this request.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => void purgeSnapshots(node.id) },
        ],
      );
    },
    [purgeSnapshots, selfNodeId],
  );

  const pad = { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xl };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, pad]}>
      <View style={styles.header}>
        <PressableScale
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/home'))}
          accessibilityLabel="Back"
          style={styles.back}
          hitSlop={space.sm}
          highlightColor={colors.borderStrong}
          highlightRadius={radius.md}
        >
          <Text style={styles.backGlyph} allowFontScaling={false}>
            ‹
          </Text>
        </PressableScale>
        <Text accessibilityRole="header" style={styles.h1}>
          Family cameras
        </Text>
      </View>

      <Card tone="info">
        <Text style={styles.body}>
          Anyone in the family can switch any of these off, at any moment, without asking the person
          who set it up. Nothing here needs your reason.
        </Text>
        <Text style={styles.dim}>
          Cameras switch themselves off whenever someone is detected at home. Snapshots are
          encrypted with the family key and deleted after {SNAPSHOT_RETENTION_DAYS} days.
        </Text>
      </Card>

      {/* Same shape as the empty state below it, deliberately: "we are still
          reading" and "there is nothing" are two answers to the same question
          and should not look like two different screens. Neither one is a bare
          line of grey text the eye slides past. */}
      {!ready ? (
        <EmptyState
          glyph="·"
          title="Looking for cameras…"
          body="Reading this phone’s own list. Nothing is fetched from a server, so this is quick."
        />
      ) : nodes.length === 0 ? (
        <EmptyState
          glyph="▣"
          title="No cameras"
          body="A spare Android phone, plugged in and pointed at a door, becomes a motion alarm for the hours the house is empty."
          action={{
            label: 'Use this phone as a camera',
            onPress: () => router.push('/camera-node'),
          }}
        />
      ) : (
        <Section title="Cameras" right={<Pill label={`${nodes.length}`} tone="neutral" glyph="▣" />}>
          {nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              now={now}
              isLocal={node.id === selfNodeId}
              onKill={() => confirmKill(node)}
              onPurge={() => confirmPurge(node)}
            />
          ))}
        </Section>
      )}

      {recent.length === 0 ? null : (
        <Section title="Recent motion">
          <Card>
            {recent.map((e) => (
              <EventRow key={e.id} event={e} nodes={nodes} now={now} />
            ))}
            <Text style={styles.dim}>
              A snapshot is a 160×120 grey thumbnail — enough to see that somebody crossed the room,
              not enough to read what they were holding. The full-size picture is never kept.
            </Text>
          </Card>
        </Section>
      )}

      <Button
        label="Use this phone as a camera"
        onPress={() => router.push('/camera-node')}
        variant="ghost"
      />

      <Text style={styles.legal}>
        A camera may never be placed in or pointed at a bedroom, a bathroom or a changing room.
        Capturing images of a person there without their consent is an offence under section 66E of
        the Information Technology Act, 2000.
      </Text>
    </ScrollView>
  );
}

function thermalTone(node: NodeStatus): PillTone {
  switch (node.thermalTier) {
    case 'nominal':
      return 'ok';
    case 'hot':
      return 'warn';
    case 'critical':
      return 'danger';
    case 'unknown':
    default:
      return 'warn';
  }
}

function NodeCard({
  node,
  now,
  isLocal,
  onKill,
  onPurge,
}: {
  node: NodeStatus;
  now: number;
  isLocal: boolean;
  onKill: () => void;
  onPurge: () => void;
}) {
  const state = describeRuntime(node);
  const killed = node.runtime === 'disabled-by-family';

  return (
    <Card tone={state.tone === 'neutral' ? undefined : state.tone}>
      <View style={styles.rowTop}>
        <Text style={styles.nodeTitle} numberOfLines={2}>
          {node.placement}
        </Text>
        <Pill label={state.label} tone={state.tone} />
      </View>

      <Text style={styles.dim}>
        {isLocal ? 'This phone' : `${node.ownerName}'s phone`} · heard from{' '}
        {sinceLabel(node.lastHeardAt, now)}
      </Text>

      <Text style={styles.body}>{state.detail}</Text>

      <View style={styles.pills}>
        <Pill
          label={
            node.lastMotionAt === null
              ? 'No motion yet'
              : `Motion ${sinceLabel(node.lastMotionAt, now)}`
          }
          tone={node.lastMotionAt === null ? 'neutral' : 'info'}
          glyph="↯"
        />
        <Pill
          label={formatCelsius(node.temperatureC)}
          tone={thermalTone(node)}
          glyph={node.thermalTier === 'unknown' ? '?' : '°'}
        />
        <Pill
          label={node.batteryPct === null ? 'Battery unknown' : `${node.batteryPct}%${node.charging ? ' ⚡' : ''}`}
          tone={
            node.batteryPct === null
              ? 'neutral'
              : node.batteryPct <= 15 && !node.charging
                ? 'danger'
                : node.batteryPct <= 35 && !node.charging
                  ? 'warn'
                  : 'ok'
          }
          glyph="▮"
        />
        <Pill label={`${node.snapshotCount} snapshots`} tone="neutral" glyph="▤" />
      </View>

      {node.motionEvents24h > 0 ? (
        <Text style={styles.dim}>{node.motionEvents24h} motion events in the last 24 hours.</Text>
      ) : null}

      {node.maintenance === null ? null : (
        <Text style={styles.warn} accessibilityLiveRegion="polite">
          {node.maintenance}
        </Text>
      )}

      {node.purgeRequestedAt === null ? null : (
        <Text style={styles.dim}>
          Snapshot deletion requested {sinceLabel(node.purgeRequestedAt, now)} — it applies the next
          time that phone runs the camera screen.
        </Text>
      )}

      <View style={styles.actions}>
        {killed ? (
          <Text style={styles.ok}>
            Off since {sinceLabel(node.disabledBy?.at ?? null, now)}. Only{' '}
            {isLocal ? 'this phone' : `${node.ownerName}'s phone`} can restart it.
          </Text>
        ) : (
          /* ★ The kill switch. Full width, danger, always the largest control on
             the card — never behind a menu, never smaller than the thing it
             stops (PRD §6.4). */
          <Button label="Switch this camera off" onPress={onKill} variant="danger" size="lg" />
        )}
        <Button label="Delete its snapshots" onPress={onPurge} variant="quiet" />
      </View>
    </Card>
  );
}

function EventRow({
  event,
  nodes,
  now,
}: {
  event: MotionEvent;
  nodes: readonly NodeStatus[];
  now: number;
}) {
  const node = nodes.find((n) => n.id === event.nodeId);
  return (
    <View style={styles.eventRow}>
      <Text style={styles.eventWhen}>{sinceLabel(event.at, now)}</Text>
      <View style={styles.eventBody}>
        <Text style={styles.eventTitle} numberOfLines={1}>
          {node?.placement ?? 'A camera'}
        </Text>
        <Text style={styles.dim}>
          {event.hotBlocks} of 300 blocks changed ·{' '}
          {event.snapshot === null ? 'no snapshot kept' : 'snapshot sealed'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: space.lg, gap: space.lg },

  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  back: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backGlyph: { color: colors.text, fontSize: font.display, fontWeight: weight.bold },
  h1: { flex: 1, color: colors.text, fontSize: font.h1, fontWeight: weight.bold },

  body: { color: colors.text, fontSize: font.body, lineHeight: font.body + 7 },
  dim: { color: colors.textDim, fontSize: font.small, lineHeight: font.small + 6 },
  // ★ Text tokens, not fills. `warn` carries the maintenance sentence and `ok`
  // carries "off since …, only that phone can restart it" — the line that tells
  // somebody their objection was honoured. At colors.warn / colors.ok those are
  // 2.71:1 and 2.43:1 on the card; the *Text variants are 7.85 and 7.92.
  warn: { color: colors.warnText, fontSize: font.small, fontWeight: weight.semibold, lineHeight: font.small + 6 },
  ok: { color: colors.okText, fontSize: font.small, fontWeight: weight.semibold, lineHeight: font.small + 6 },

  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  nodeTitle: { flex: 1, color: colors.text, fontSize: font.h3, fontWeight: weight.semibold },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  actions: { gap: space.sm, marginTop: space.xs },

  eventRow: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'flex-start',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: space.sm,
  },
  // minWidth, not width: "3 minutes ago" at 150 % system font does not fit 84 pt
  // and wrapped to three lines beside a one-line title. flexShrink 0 stops the
  // body column clawing the space back and reproducing the same ragged column.
  eventWhen: {
    minWidth: 84,
    flexShrink: 0,
    color: colors.textDim,
    fontSize: font.small,
    fontWeight: weight.semibold,
  },
  eventBody: { flex: 1, gap: space.xxs },
  eventTitle: { color: colors.text, fontSize: font.small, fontWeight: weight.semibold },

  legal: {
    color: colors.textFaint,
    fontSize: font.tiny,
    lineHeight: font.tiny + 6,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: space.md,
    borderRadius: radius.sm,
  },
});
