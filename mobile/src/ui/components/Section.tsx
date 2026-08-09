/**
 * Section — a titled block.
 *
 * The header is deliberately small, dim and uppercase: PRD §6.4 caps a glance at
 * ≤4 words, so the *content* must win the eye, not the label above it. The
 * heading still carries `accessibilityRole="header"` so a screen-reader user
 * gets the structure a sighted user gets from the weight contrast.
 */
import { memo, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, font, leading, space, tracking, weight } from '../theme';

export interface SectionProps {
  title: string;
  children: ReactNode;
  /** Trailing slot — a Pill, a count, a quiet Button. Strings are wrapped for RN. */
  right?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

function SectionImpl({ title, children, right, style }: SectionProps) {
  return (
    <View style={[styles.section, style]}>
      <View style={styles.header}>
        <Text
          accessibilityRole="header"
          style={styles.title}
          numberOfLines={2}
        >
          {title}
        </Text>
        {right === undefined || right === null ? null : typeof right === 'string' ||
          typeof right === 'number' ? (
          <Text style={styles.rightText}>{right}</Text>
        ) : (
          <View style={styles.rightSlot}>{right}</View>
        )}
      </View>
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    minHeight: 20,
  },
  title: {
    flexShrink: 1,
    color: colors.textDim,
    fontSize: font.small,
    lineHeight: leading.small,
    fontWeight: weight.semibold,
    // The one tracking value every uppercase label in the product uses. A
    // section header and the field labels directly under it disagreeing on their
    // tracking is visible as a wobble long before anyone can name it.
    letterSpacing: tracking.caps,
    textTransform: 'uppercase',
  },
  rightText: {
    color: colors.textDim,
    fontSize: font.small,
    lineHeight: leading.small,
    fontWeight: weight.medium,
  },
  rightSlot: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  body: { gap: space.sm },
});

export const Section = memo(SectionImpl);
export default Section;
