/**
 * Card — the container every panel on every screen sits in.
 *
 * `tone` tints the BORDER, never the fill. PRD §6.4 requires ≥7:1 on text, and
 * a card whose background carries the semantic colour drags every string inside
 * it down with it. Tinting the 1.5 dp edge instead leaves body copy at the full
 * 17:1 of `text` on `bgCard` while still giving peripheral vision something to
 * catch — and the caller is expected to put a Pill or a StateBadge inside, so
 * the tone is never the only carrier of meaning (P-018).
 *
 * ★ ENTRANCE MOTION IS OPT-IN, AND app/panic.tsx / app/probe.tsx MUST NOT OPT IN ★
 * `enter` defaults to NO_MOTION, so every one of the ~40 existing call sites is
 * static and a screen author who never thinks about PRD §6.4 still ships the
 * compliant thing. §6.4 permits exactly one animation on the panic path — the
 * cancel countdown ring — because a card fading in while a dispatch is pending
 * is indistinguishable from a card still loading, and that ambiguity costs
 * seconds the user does not have. Neither of those two screens may pass `enter`.
 * Use it on calm, browsable surfaces (settings, incident history, journeys)
 * where a 180 ms rise tells a 14-year-old the list is alive and tells an
 * 81-year-old which block just appeared.
 */
import { memo, type ReactNode } from 'react';
import { Animated, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { NO_MOTION, useEntrance, type EntranceMotionPreset } from '../motion';
import { colors, radius, shadow, space } from '../theme';

export type CardTone = 'danger' | 'warn' | 'ok' | 'info';

export interface CardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tone?: CardTone;
  /**
   * `fade` | `rise` | NO_MOTION (default). Collapses to an instant appearance
   * when the OS reduce-motion switch is on — the card still arrives, it just
   * does not travel. Runs on the native animation thread: no JS frame work, and
   * no re-render after mount.
   */
  enter?: EntranceMotionPreset;
}

function toneBorder(tone: CardTone | undefined): string {
  switch (tone) {
    case 'danger':
      return colors.danger;
    case 'warn':
      return colors.warn;
    case 'ok':
      return colors.ok;
    case 'info':
      return colors.info;
    default:
      return colors.border;
  }
}

/**
 * The faintest possible wash — chosen so that `text` on it still measures well
 * past 7:1. It is a hint, not the message.
 */
function toneFill(tone: CardTone | undefined): string {
  switch (tone) {
    case 'danger':
      return colors.dangerSoft;
    case 'warn':
      return colors.warnSoft;
    case 'ok':
      return colors.okSoft;
    case 'info':
      return colors.infoSoft;
    default:
      return colors.bgCard;
  }
}

function CardImpl({ children, style, tone, enter = NO_MOTION }: CardProps) {
  // Returns null for NO_MOTION, so the default card carries no animated node at
  // all — the panic path pays nothing for a feature it is forbidden to use.
  const entrance = useEntrance(enter);

  return (
    <Animated.View
      style={[
        styles.card,
        { borderColor: toneBorder(tone), backgroundColor: toneFill(tone) },
        // A toned card is an exception on the screen; the extra edge weight is
        // what makes it findable without reading (PRD §6.4, ≤4 words per glance).
        tone !== undefined ? styles.toned : null,
        style,
        entrance,
      ]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: space.lg,
    gap: space.md,
    ...shadow.card,
  },
  toned: { borderWidth: 1.5 },
});

export const Card = memo(CardImpl);
export default Card;
