/**
 * Pill — a small status chip.
 *
 * ★★ P-018 — THE RULE THIS COMPONENT EXISTS TO ENFORCE ★★
 * A Pill ALWAYS renders a glyph next to its text. `glyph` is optional in the
 * props only so callers need not memorise the mapping; when it is omitted a
 * per-tone default is substituted. There is no code path that produces a
 * colour-only chip, because roughly one man in twelve cannot tell this
 * component's `ok` green from its `danger` red, and in this app that difference
 * is "everyone is home" versus "somebody is in trouble".
 *
 * The label renders in `colors.text` rather than in the tone colour: `ok` on
 * `okSoft` measures 6.3:1 and would sit under the ≥7:1 floor theme.ts sets from
 * PRD §6.4. The tone lives in the border and the glyph, where it is a signal
 * rather than a legibility tax.
 *
 * ★ AND THE GLYPH IS STILL TEXT ★
 * "The tone lives in the glyph" is not a licence to paint the glyph in the FILL
 * colour — see TONE_FG below. A mark at 2:1 is a mark that is not there, and a
 * chip whose only non-colour channel has been made invisible is a colour-only
 * chip with extra steps.
 *
 * ★ WHY A PRESSABLE PILL NEEDS 11 dp OF SLOP ★
 * A Pill is ~26 dp tall, and it has to stay that size: a 48 dp chip stops
 * annotating the row it sits in and starts competing with it. MIN_TOUCH_TARGET
 * is about the finger, not the ink, so `hitSlopFor` lifts the touch box back to
 * 48 without touching the layout. The slop is deliberately narrow horizontally —
 * pills sit in gapped rows, and a wide slop lets one chip swallow presses aimed
 * at its neighbour, which is worse than a small target because it acts.
 */
import { memo } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { hitSlopFor } from '../motion';
import { colors, font, radius, space, toneSurface, weight } from '../theme';
import { PressableScale } from './PressableScale';

export type PillTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export interface PillProps {
  label: string;
  tone: PillTone;
  /** Overrides the per-tone default. Never produces an empty glyph. */
  glyph?: string;
  style?: StyleProp<ViewStyle>;
  /** Supplying this turns the chip into a button — with slop, scale and haptic. */
  onPress?: () => void;
  /** Read out after the label when the chip acts; ignored when it does not. */
  accessibilityHint?: string;
}

/** border(1) + paddingVertical(4)×2 + line box(16). Kept next to the styles below. */
const PILL_HEIGHT = 2 + 2 * space.xs + font.small + 3;
const SLOP = { top: hitSlopFor(PILL_HEIGHT), bottom: hitSlopFor(PILL_HEIGHT), left: space.xs, right: space.xs };

/** Plain BMP characters only — an emoji font is not guaranteed on a cheap Android. */
const DEFAULT_GLYPH: Record<PillTone, string> = {
  ok: '✓',
  warn: '⚠',
  danger: '✕',
  info: 'ℹ',
  neutral: '•',
};

/**
 * ★ THE GLYPH IS TEXT, AND ITS COLOUR IS NOT CHOSEN HERE ★
 *
 * These panels were assembled by hand out of the FILL tokens until the audit
 * measured them: ok 2.46:1, warn 2.68:1, danger 3.05:1, info 1.97:1. That is the
 * non-colour channel this whole component exists to provide, rendered at under a
 * third of the floor — the `info` mark was effectively invisible, so a
 * colour-blind reader was left with exactly the colour, which is the one thing
 * P-018 says they cannot have.
 *
 * The fix is not "pick better hexes here"; it is to stop picking. `toneSurface`
 * exists so a tinted panel is never built twice, and theme-contrast.test.ts
 * already asserts that everything it returns clears 7:1. Sourcing the pair from
 * it puts this component permanently inside that assertion.
 */
const TONE_SURFACE: Record<PillTone, { bg: string; fg: string }> = {
  ok: toneSurface('ok'),
  warn: toneSurface('warn'),
  danger: toneSurface('danger'),
  info: toneSurface('info'),
  // Deliberately NOT toneSurface('neutral'): that returns `bgCard`, which is the
  // colour of the card a Pill usually sits on, so a neutral chip would dissolve
  // into its own container. bgElevated with textDim is 9.67:1 and still an
  // object on the page.
  neutral: { bg: colors.bgElevated, fg: colors.textDim },
};

/**
 * The FILL tokens belong on the edge, and only there. Against the page a chip
 * border measures 1.89–3.31:1 depending on tone and surface, so it is NOT
 * carrying the state: the glyph and the label do that, both now past 7:1. The
 * edge is peripheral-vision reinforcement, and the saturated colour is what
 * makes it register as one. `neutral` takes borderStrong so the chip with
 * nothing to say does not end up with the loudest edge on the screen — which is
 * what `textDim` here was doing, at four times the contrast of the danger chip.
 */
const TONE_BORDER: Record<PillTone, string> = {
  ok: colors.ok,
  warn: colors.warn,
  danger: colors.danger,
  info: colors.info,
  neutral: colors.borderStrong,
};

function PillImpl({ label, tone, glyph, style, onPress, accessibilityHint }: PillProps) {
  // An explicitly-passed empty string would silently defeat P-018, so it falls
  // back exactly like `undefined` does.
  const mark = glyph !== undefined && glyph.length > 0 ? glyph : DEFAULT_GLYPH[tone];

  const surface = TONE_SURFACE[tone];

  const skin = [
    styles.pill,
    { backgroundColor: surface.bg, borderColor: TONE_BORDER[tone] },
    style,
  ];

  const body = (
    <>
      <Text
        style={[styles.glyph, { color: surface.fg }]}
        // The glyph is decoration of the label it sits beside; announcing it
        // separately turns every status chip into two utterances.
        importantForAccessibility="no"
        allowFontScaling={false}
      >
        {mark}
      </Text>
      <Text numberOfLines={1} style={styles.label}>
        {label}
      </Text>
    </>
  );

  // A read-only chip stays a `text` node. Promising "button" on a status that
  // does nothing is the same small lie ListItem refuses to tell (PRD §10.6).
  if (onPress === undefined) {
    return (
      <View
        // One node, one label: a screen reader must not read "tick" then "Safe".
        accessible
        accessibilityRole="text"
        accessibilityLabel={label}
        style={skin}
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
      accessibilityHint={accessibilityHint}
      hitSlop={SLOP}
      style={skin}
    >
      {body}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
  },
  glyph: { fontSize: font.small, fontWeight: weight.bold, lineHeight: font.small + 3 },
  label: {
    color: colors.text,
    fontSize: font.small,
    fontWeight: weight.semibold,
  },
});

export const Pill = memo(PillImpl);
export default Pill;
