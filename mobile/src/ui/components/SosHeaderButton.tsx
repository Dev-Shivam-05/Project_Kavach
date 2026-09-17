/**
 * SosHeaderButton — the quiet per-screen SOS entry point.
 * ★ Spec A3 / Phase 6-D-1b (phase6b-redesign-and-family-watch, 29 Aug)
 *
 * 6-D-1 removed the raised centre SOS tab, which dropped Map/Incidents/
 * Settings/Watch from "SOS reachable in zero taps" to "one tab away". This
 * restores that reachability with a small outline icon in each of those
 * screens' own header — same target as the old FAB (`router.push('/panic')`),
 * identical hold-to-fire/cancel-countdown flow, zero change to `panic.tsx`.
 * Home is untouched: its full-width footer button is the PRD §6.4 hard
 * requirement (≥88dp) this icon was never meant to replace.
 *
 * Outline, no fill, on transparent — alarm red (`colors.danger`, filled)
 * stays reserved for an actually active incident, never a resting nav
 * element (A3, §6.4). `alert-triangle` is THIS button's glyph (A3) and the
 * warn chip's; the Incidents tab deliberately uses a different one, so the
 * most consequential tap in the app is not shape-identical to "browse
 * history" (P-018).
 */
import { Feather } from '@expo/vector-icons';
import { memo } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';

import { t } from '../../i18n';
import { colors, space } from '../theme';
import { PressableScale } from './PressableScale';

const SIZE = 44;
const ICON_SIZE = 20;

function SosHeaderButtonImpl({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <PressableScale
      onPress={() => router.push('/panic')}
      accessibilityRole="button"
      accessibilityLabel={t('tab.sos')}
      accessibilityHint={t('tab.sosHint')}
      // 44 dp visual + 4 dp per side = the 48 dp floor, and no more: this sits
      // beside a title, and a wide slop would let it swallow a press on the text.
      hitSlop={space.xs}
      style={[styles.button, style]}
    >
      <Feather name="alert-triangle" size={ICON_SIZE} color={colors.dangerText} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 1.5,
    borderColor: colors.dangerText,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export const SosHeaderButton = memo(SosHeaderButtonImpl);
export default SosHeaderButton;
