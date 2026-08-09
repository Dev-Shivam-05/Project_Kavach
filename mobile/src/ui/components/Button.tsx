/**
 * Button — the only pressable primitive in Kavach.
 *
 * ★ WHY THE COLOURS ARE NOT THE OBVIOUS ONES ★
 * theme.ts encodes PRD §6.4 as "contrast ≥ 7:1". White on `colors.danger`
 * measures 5.80:1 — over the 4.5 bar large text answers to, under the 7:1 body
 * text needs — so a saturated-red fill cannot carry a readable *label*. The
 * `danger` skin therefore fills with `dangerDark` (white label = 9.41:1) and
 * carries a 2 dp `danger` border, which keeps the saturated red signal at the
 * edge where recognition happens while the text stays legible to someone with
 * adrenaline-narrowed vision.
 *
 * ★ AND THIS IS WHY THE FIGURES ARE RE-MEASURED, NOT INHERITED ★
 * `primary` labelled in pure black on a lighter `info` blue, back when that
 * token was #4A9BE8 and the pairing was 7.14:1. `info` is now #12507F — a fill,
 * on the dark side of the fill/text split — and black on it is 2.48:1. The
 * comment stayed true-sounding while the button it described became the least
 * readable control in the product, on the default variant, on every screen.
 * White is 8.47:1 and is what it takes now.
 *
 * P-018 / §6.4: the label is always a word. A button that communicates only by
 * its colour is unusable for the colour-blind grandparent this app is for.
 *
 * ★ MOTION ★
 * Press feedback comes from PressableScale: a ~3 % spring scale, a light haptic,
 * and the same opacity step this component always had. `size="panic"` is
 * hard-wired to NO_MOTION and cannot be talked out of it — that size exists only
 * for the dispatch trigger on app/panic.tsx and app/index.tsx, and PRD §6.4
 * permits no motion there except the cancel countdown ring. The haptic and the
 * opacity step still fire, so the press is still confirmed.
 */
import { memo, type ReactNode } from 'react';
import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { NO_MOTION } from '../motion';
import {
  MIN_TOUCH_TARGET,
  PANIC_BUTTON_HEIGHT,
  colors,
  font,
  leading,
  radius,
  space,
  weight,
} from '../theme';
import { PressableScale } from './PressableScale';

export type ButtonVariant = 'primary' | 'danger' | 'ghost' | 'quiet';
export type ButtonSize = 'md' | 'lg' | 'panic';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  /** A glyph string, or any node. Strings are wrapped — RN cannot render bare text. */
  icon?: ReactNode;
}

interface Skin {
  fill: string;
  border: string;
  borderWidth: number;
  label: string;
}

function skinFor(variant: ButtonVariant, disabled: boolean): Skin {
  // A disabled control is exempt from the contrast floor (WCAG 1.4.3), and it
  // must read as *unavailable* rather than as a different action.
  if (disabled) {
    return {
      fill: colors.bgElevated,
      border: colors.border,
      borderWidth: 1,
      label: colors.textFaint,
    };
  }
  switch (variant) {
    case 'danger':
      return { fill: colors.dangerDark, border: colors.danger, borderWidth: 2, label: colors.white };
    case 'ghost':
      return { fill: colors.transparent, border: colors.borderStrong, borderWidth: 1.5, label: colors.text };
    case 'quiet':
      return { fill: colors.transparent, border: colors.transparent, borderWidth: 0, label: colors.textDim };
    case 'primary':
    default:
      return { fill: colors.info, border: colors.info, borderWidth: 0, label: colors.white };
  }
}

function ButtonImpl({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  accessibilityLabel,
  style,
  icon,
}: ButtonProps) {
  const skin = skinFor(variant, disabled);
  const sizeStyle =
    size === 'panic' ? styles.panic : size === 'lg' ? styles.lg : styles.md;
  const labelSize =
    size === 'panic' ? styles.labelPanic : size === 'lg' ? styles.labelLg : styles.labelMd;

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      // ★ Load-bearing §6.4 guard, not a style preference. See the header.
      motion={size === 'panic' ? NO_MOTION : 'scale'}
      // The panic button is pressed by someone who cannot aim; a slop ring costs
      // nothing and converts a near-miss into a press (PRD §6.4).
      hitSlop={size === 'md' ? space.sm : 0}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      style={[
        styles.base,
        sizeStyle,
        {
          backgroundColor: skin.fill,
          borderColor: skin.border,
          borderWidth: skin.borderWidth,
        },
        style,
      ]}
    >
      {icon === undefined || icon === null ? null : typeof icon === 'string' ||
        typeof icon === 'number' ? (
        <Text style={[styles.icon, labelSize, { color: skin.label }]}>{icon}</Text>
      ) : (
        icon
      )}
      <Text
        numberOfLines={2}
        style={[styles.label, labelSize, { color: skin.label }]}
      >
        {label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
  },
  md: { minHeight: MIN_TOUCH_TARGET, paddingVertical: space.sm },
  lg: { minHeight: 64, paddingVertical: space.md, alignSelf: 'stretch' },
  panic: {
    // ★ Load-bearing: PRD §6.4 puts the primary action at ≥88 dp, full width.
    minHeight: PANIC_BUTTON_HEIGHT,
    width: '100%',
    alignSelf: 'stretch',
    borderRadius: radius.lg,
    paddingVertical: space.lg,
  },
  label: { textAlign: 'center' },
  // Labels wrap to two lines, and a two-line button label set solid is the
  // cramped copy `leading` exists to fix.
  labelMd: { fontSize: font.body, lineHeight: leading.body, fontWeight: weight.semibold },
  labelLg: { fontSize: font.h3, lineHeight: leading.h3, fontWeight: weight.bold },
  labelPanic: {
    fontSize: font.h2,
    lineHeight: leading.h2,
    fontWeight: weight.bold,
    letterSpacing: 0.5,
  },
  icon: { textAlign: 'center' },
});

export const Button = memo(ButtonImpl);
export default Button;
