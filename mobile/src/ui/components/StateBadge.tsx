/**
 * StateBadge — where an incident is in the machine, in one glance.
 *
 * ★ The glyph column is the escalation ladder, spelled out ★
 * `!` → `!!` → `!!!` for ACTIVE_L1 → L2 → L3 encodes the tier in a shape, not a
 * shade. `stateColor()` already returns `danger` for all three, so without this
 * a family member watching an alert climb would see nothing change (P-018,
 * PRD §6.4 "never colour alone").
 *
 * ACTIVE_L1_SILENT is rendered IDENTICALLY to ACTIVE_L1 — same glyph, same
 * colour, same string (i18n gives both 'Family alerted'). F-01: the duress path
 * must be indistinguishable on screen from the ordinary one, and this badge is
 * exactly the kind of component that would leak it.
 */
import { memo } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { t } from '../../i18n';
import type { IncidentState } from '../../t0/stateMachine.generated';
import { colors, font, radius, space, stateColor, weight } from '../theme';

export interface StateBadgeProps {
  state: IncidentState;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Plain BMP characters — no emoji font is guaranteed on a low-end Android. */
const GLYPH: Record<IncidentState, string> = {
  IDLE: '✓',
  WATCH: '◦',
  SUSPECT: '?',
  PROBE: '?',
  PENDING: '⏱',
  FALSE_ALARM: '✓',
  ACTIVE_L1: '!',
  ACTIVE_L1_SILENT: '!',
  ACTIVE_L2: '!!',
  ACTIVE_L3: '!!!',
  OWNED: '→',
  RESOLVING: '→',
  RESOLVED: '✓',
  DORMANT: '—',
};

function StateBadgeImpl({ state, compact = false, style }: StateBadgeProps) {
  // Every IncidentState has a `state.*` entry in the English table, so this key
  // is checked at compile time rather than cast.
  const label = t(`state.${state}`);
  const tint = stateColor(state);

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[
        styles.badge,
        compact ? styles.compact : styles.full,
        { borderColor: tint },
        style,
      ]}
    >
      <Text
        importantForAccessibility="no"
        allowFontScaling={false}
        style={[styles.glyph, compact ? styles.glyphCompact : null, { color: tint }]}
      >
        {GLYPH[state]}
      </Text>
      <Text numberOfLines={1} style={[styles.label, compact ? styles.labelCompact : null]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    // Neutral fill: the tint lives in the border and the glyph so the label
    // keeps the full 17:1 of `text` on `bgElevated` (PRD §6.4).
    backgroundColor: colors.bgElevated,
  },
  full: { paddingVertical: space.xs, paddingHorizontal: space.sm },
  compact: { paddingVertical: 1, paddingHorizontal: space.xs },
  glyph: { fontSize: font.small, fontWeight: weight.heavy, lineHeight: font.small + 3 },
  glyphCompact: { fontSize: font.tiny, lineHeight: font.tiny + 3 },
  label: { color: colors.text, fontSize: font.small, fontWeight: weight.semibold },
  labelCompact: { fontSize: font.tiny, fontWeight: weight.medium },
});

export const StateBadge = memo(StateBadgeImpl);
export default StateBadge;
