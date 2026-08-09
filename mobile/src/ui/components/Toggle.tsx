/**
 * Toggle — an accessible switch row.
 *
 * ★ WHY IT IS NOT RN's <Switch> ★
 * The platform switch signals its state with hue and thumb position only. Every
 * toggle in this app guards something consequential — pause monitoring (P-066),
 * revoke a consent scope (F-14) — and "did I actually turn that off?" must be
 * answerable by someone who cannot separate green from grey. So the thumb
 * carries `✓` when on and `✕` when off: shape first, position second, colour
 * third (P-018, PRD §6.4).
 *
 * The whole row is the target, not just the 52 dp track — MIN_TOUCH_TARGET is a
 * floor, and a one-handed press in the dark should not have to find a switch.
 *
 * ★ WHY THE THUMB TRAVELS INSTEAD OF TELEPORTING ★
 * A switch that jumps between two positions gives no evidence that the jump was
 * caused by the finger; it looks the same as a switch that was already in that
 * position and a redraw. The 23 dp slide is the causal link between the tap and
 * the new state, which is what makes an accidental toggle noticeable rather than
 * discovered three days later when monitoring turns out to have been off. It is
 * a native-thread transform, so the mark swap (`✓`/`✕`) and the colours remain
 * the primary, non-motion carriers of state and the travel is redundancy on top.
 */
import { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { SWITCH_SPRING, useReduceMotion } from '../motion';
import { MIN_TOUCH_TARGET, colors, font, leading, radius, space, weight } from '../theme';
import { PressableScale } from './PressableScale';

export interface ToggleProps {
  value: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

const TRACK_W = 54;
const TRACK_H = 30;
const TRACK_BORDER = 1.5;
const TRACK_PAD = 2;
const THUMB = 24;

/** Derived, never hard-coded: a track resize must not silently desync the thumb. */
const TRAVEL = TRACK_W - 2 * TRACK_BORDER - 2 * TRACK_PAD - THUMB;

function ToggleImpl({ value, onChange, label, hint, disabled = false, style }: ToggleProps) {
  const reduceMotion = useReduceMotion();
  const trackFill = disabled ? colors.bgInput : value ? colors.ok : colors.bgInput;
  const trackEdge = disabled ? colors.border : value ? colors.ok : colors.borderStrong;
  const thumbFill = disabled ? colors.textFaint : value ? colors.white : colors.textDim;
  const markColor = disabled ? colors.bgElevated : value ? colors.okSoft : colors.bg;

  // Seeded from the incoming value so a screen that mounts with monitoring
  // already paused does not animate a state the user did not just choose.
  const offset = useRef<Animated.Value | null>(null);
  if (offset.current === null) offset.current = new Animated.Value(value ? TRAVEL : 0);
  const travel = offset.current;

  useEffect(() => {
    const to = value ? TRAVEL : 0;
    // Reduce-motion is an instant move, never a missing one: the thumb must end
    // up in the right place whatever the OS setting says about travel.
    if (reduceMotion) {
      travel.setValue(to);
      return;
    }
    const anim = Animated.spring(travel, { toValue: to, ...SWITCH_SPRING });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [reduceMotion, travel, value]);

  const thumbMotion = useMemo(() => ({ transform: [{ translateX: travel }] }), [travel]);

  return (
    <PressableScale
      onPress={() => onChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      // `checked` is what a screen reader reads out; without it the row is a
      // button that appears to do nothing.
      accessibilityState={{ checked: value, disabled }}
      style={[styles.row, style]}
    >
      <View style={styles.text}>
        <Text style={[styles.label, disabled ? styles.dim : null]}>{label}</Text>
        {hint === undefined || hint.length === 0 ? null : (
          <Text style={styles.hint}>{hint}</Text>
        )}
      </View>

      <View style={[styles.track, { backgroundColor: trackFill, borderColor: trackEdge }]}>
        <Animated.View style={[styles.thumb, thumbMotion, { backgroundColor: thumbFill }]}>
          <Text
            importantForAccessibility="no"
            allowFontScaling={false}
            style={[styles.mark, { color: markColor }]}
          >
            {value ? '✓' : '✕'}
          </Text>
        </Animated.View>
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  text: { flex: 1, gap: space.xxs },
  label: {
    color: colors.text,
    fontSize: font.body,
    lineHeight: leading.body,
    fontWeight: weight.semibold,
  },
  dim: { color: colors.textFaint },
  // `hint` is where the consequence of the switch is spelled out, so it is the
  // multi-line copy in this component and the one that needs real leading.
  hint: {
    color: colors.textDim,
    fontSize: font.small,
    lineHeight: leading.small,
    fontWeight: weight.regular,
  },
  track: {
    width: TRACK_W,
    height: TRACK_H,
    borderRadius: radius.pill,
    borderWidth: TRACK_BORDER,
    padding: TRACK_PAD,
    flexDirection: 'row',
    // The thumb is placed by a transform, not by layout: `justifyContent` cannot
    // be interpolated, and a layout-driven switch animates on the JS thread.
    justifyContent: 'flex-start',
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mark: { fontSize: font.tiny, fontWeight: weight.heavy, lineHeight: THUMB },
});

export const Toggle = memo(ToggleImpl);
export default Toggle;
