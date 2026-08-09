/**
 * ListItem — one row: glyph, title, subtitle, trailing slot.
 *
 * A row without `onPress` renders as a View and is NOT announced as a button.
 * Half the rows in this app are read-only facts (a battery level, an access-log
 * entry), and a screen reader promising "button" on a fact is the kind of small
 * lie that makes someone stop trusting the whole surface (PRD §10.6).
 *
 * `danger` tints the left edge, but the title stays in `text`: the ≥7:1 floor
 * from PRD §6.4 applies to every row of a list the same way it applies to a
 * headline, and `danger` on `bgCard` is 2.76:1. The glyph obeys the same rule —
 * it is text, so it takes `dangerText` (7.95:1 on bgCard, 8.77:1 on dangerSoft).
 * It is the leading marker for the destructive rows on Home, Settings, Incidents
 * and Drills, and a marker at 2.76:1 is a marker a low-vision reader will not
 * see before they press.
 *
 * ★ THE PRESS HIGHLIGHT IS AN OUTLINE, NOT A WASH ★
 * `subtitle` is `textDim` on `bgCard` = 8.87:1, so a wash has 1.87 of headroom
 * and crosses under the ≥7:1 floor at about 8 % white — enough room to be
 * tempting, and still the wrong trade. An outline changes no pixel behind any
 * glyph, so the cost is exactly zero rather than merely affordable, and it is a
 * shape change rather than a hue change, which is what a colour-blind reader
 * needs (P-018). The ring is one of three simultaneous channels — outline, ~3 %
 * scale, haptic — because any single one of them is exactly what an 81-year-old
 * with a numb fingertip or a muted phone misses.
 */
import { memo, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { MIN_TOUCH_TARGET, colors, font, leading, radius, space, weight } from '../theme';
import { PressableScale } from './PressableScale';

export interface ListItemProps {
  title: string;
  subtitle?: string;
  /** Leading glyph. Plain BMP text — no emoji font is guaranteed. */
  glyph?: string;
  /** Trailing slot: a Pill, a StateBadge, a value. Strings are wrapped for RN. */
  right?: ReactNode;
  onPress?: () => void;
  danger?: boolean;
  style?: StyleProp<ViewStyle>;
}

function ListItemImpl({
  title,
  subtitle,
  glyph,
  right,
  onPress,
  danger = false,
  style,
}: ListItemProps) {
  // Text token, never the fill — the row border below is where `danger` belongs.
  const tint = danger ? colors.dangerText : colors.textDim;

  const body = (
    <>
      {glyph === undefined || glyph.length === 0 ? null : (
        <Text
          importantForAccessibility="no"
          allowFontScaling={false}
          style={[styles.glyph, { color: tint }]}
        >
          {glyph}
        </Text>
      )}
      <View style={styles.text}>
        <Text numberOfLines={2} style={styles.title}>
          {title}
        </Text>
        {subtitle === undefined || subtitle.length === 0 ? null : (
          <Text numberOfLines={3} style={styles.subtitle}>
            {subtitle}
          </Text>
        )}
      </View>
      {right === undefined || right === null ? null : typeof right === 'string' ||
        typeof right === 'number' ? (
        <Text numberOfLines={1} style={styles.rightText}>
          {right}
        </Text>
      ) : (
        <View style={styles.rightSlot}>{right}</View>
      )}
    </>
  );

  // One accessible node per row: the title and subtitle are one thought, and
  // splitting them makes a list of six family members take twelve swipes.
  const label = subtitle !== undefined && subtitle.length > 0 ? `${title}. ${subtitle}` : title;

  if (onPress === undefined) {
    return (
      <View
        accessible
        accessibilityRole="text"
        accessibilityLabel={label}
        style={[styles.row, danger ? styles.rowDanger : null, style]}
      >
        {body}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      // `info` even on a danger row: the ring answers "am I touching this?", and
      // reusing the row's own semantic colour would make the two questions share
      // one signal and answer neither.
      highlightColor={colors.info}
      highlightRadius={radius.md}
      style={[styles.row, danger ? styles.rowDanger : null, style]}
    >
      {body}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    // Never below the 48 dp floor, whatever the content is (theme.ts).
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowDanger: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  glyph: { fontSize: font.h3, lineHeight: leading.h3, width: 26, textAlign: 'center' },
  text: { flex: 1, gap: space.xxs },
  // `leading`, not a hand-picked number: `title` wraps to two lines and
  // `subtitle` to three, and cramped wrapped copy is the exact failure the token
  // exists to prevent.
  title: {
    color: colors.text,
    fontSize: font.body,
    lineHeight: leading.body,
    fontWeight: weight.semibold,
  },
  subtitle: {
    color: colors.textDim,
    fontSize: font.small,
    lineHeight: leading.small,
    fontWeight: weight.regular,
  },
  rightText: { color: colors.textDim, fontSize: font.small, lineHeight: leading.small, fontWeight: weight.medium },
  rightSlot: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});

export const ListItem = memo(ListItemImpl);
export default ListItem;
