/**
 * EmptyState — what a list says when it has nothing in it.
 *
 * In this app "empty" is usually the GOOD outcome: no active incidents, nobody
 * viewing your location, no open journeys. So the copy is a statement of fact,
 * never an apology and never a nudge to generate content (PRD §10.6 — the
 * privacy surfaces must not sell against themselves).
 *
 * `action` accepts either a descriptor `{ label, onPress }` or a ready-made
 * node, because half the screens want the standard Button and half already have
 * a bespoke control; a component that forced either would push a placeholder
 * into the other half.
 */
import { Feather } from '@expo/vector-icons';
import { memo, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, font, leading, space, weight } from '../theme';
import { Button } from './Button';

export interface EmptyStateAction {
  label: string;
  onPress: () => void;
}

export interface EmptyStateProps {
  /** Plain BMP text — no emoji font is guaranteed on a low-end Android. Omit when `icon` is given. */
  glyph?: string;
  /** Leading Feather icon. Wins over `glyph` if both are given. */
  icon?: keyof typeof Feather.glyphMap;
  title: string;
  body?: string;
  action?: EmptyStateAction | ReactNode;
  style?: StyleProp<ViewStyle>;
}

function isActionDescriptor(a: unknown): a is EmptyStateAction {
  return (
    typeof a === 'object' &&
    a !== null &&
    typeof (a as EmptyStateAction).label === 'string' &&
    typeof (a as EmptyStateAction).onPress === 'function'
  );
}

function EmptyStateImpl({ glyph, icon, title, body, action, style }: EmptyStateProps) {
  return (
    <View style={[styles.wrap, style]}>
      {icon !== undefined ? (
        <Feather
          name={icon}
          size={40}
          color={colors.textFaint}
          // The icon repeats what the title says; announcing it doubles the
          // utterance for no added information.
          importantForAccessibility="no"
          style={styles.icon}
        />
      ) : (
        <Text
          // The glyph repeats what the title says; announcing it doubles the
          // utterance for no added information.
          importantForAccessibility="no"
          allowFontScaling={false}
          style={styles.glyph}
        >
          {glyph}
        </Text>
      )}
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {body === undefined || body.length === 0 ? null : (
        <Text style={styles.body}>{body}</Text>
      )}
      {action === undefined || action === null ? null : isActionDescriptor(action) ? (
        <Button
          label={action.label}
          onPress={action.onPress}
          variant="ghost"
          size="md"
          style={styles.action}
        />
      ) : (
        <View style={styles.action}>{action as ReactNode}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.xxl,
    paddingHorizontal: space.lg,
  },
  glyph: { color: colors.textFaint, fontSize: font.display, lineHeight: leading.display },
  icon: { marginBottom: space.xxs },
  title: {
    color: colors.text,
    fontSize: font.h3,
    lineHeight: leading.h3,
    fontWeight: weight.semibold,
    textAlign: 'center',
  },
  body: {
    color: colors.textDim,
    fontSize: font.body,
    lineHeight: leading.body,
    fontWeight: weight.regular,
    textAlign: 'center',
    maxWidth: 320,
  },
  action: { marginTop: space.sm },
});

export const EmptyState = memo(EmptyStateImpl);
export default EmptyState;
