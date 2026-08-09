/**
 * PressableScale — the one place a press is turned into feedback.
 *
 * Every pressable in this library — Button, ListItem, Toggle, a tappable Pill,
 * MemberRow, the two controls on BigCoordinates, Call112Button, FamilyMapView's
 * pins and its "not on the map" rows — renders through this, so "did my tap
 * register?" is answered identically on every surface, and a screen author gets
 * that for free by reaching for a primitive rather than a raw Pressable. The
 * 14-year-old expects the screen to respond like a game;
 * the 81-year-old needs proof that a tap landed before they press again and
 * double-fire the action. A ~3 % spring scale plus a light haptic answers both,
 * and a third static channel — an opacity step, or an outline when
 * `highlightColor` is given — answers it again for anyone who has reduce-motion
 * on or no vibrator at all (P-018 — never one channel only).
 *
 * ★ SINGLE NODE, ON PURPOSE ★
 * This renders `Animated.createAnimatedComponent(Pressable)`, not an
 * Animated.View wrapping a Pressable. Callers pass layout styles through `style`
 * (`flex: 1`, `alignSelf: 'stretch'`, width) and a wrapper node would swallow
 * them, silently changing the layout of screens this component is dropped into.
 * One node means the style contract is byte-for-byte what a plain Pressable had.
 *
 * ★ PANIC PATH ★
 * Pass `motion={NO_MOTION}` on anything that lives on the dispatch path: the
 * haptic and the opacity step survive, the movement does not (PRD §6.4). Button
 * does this automatically for `size="panic"`.
 */
import { memo, useMemo, type ReactNode } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  type AccessibilityRole,
  type AccessibilityState,
  type Insets,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { usePressScale, type PressMotionPreset } from '../motion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * ★ WHY THE HIGHLIGHT IS A RING AND NOT A FILL ★
 * The obvious press highlight is a translucent white wash, and it spends
 * contrast the ≥7:1 floor from PRD §6.4 does not have to give. `colors.textDim`
 * on `colors.bgCard` is 8.87:1; a white wash drags it to 8.13 at 3 %, 7.69 at
 * 5 %, and under the floor by 8 % — so the wash strengths that are actually
 * *visible* on a near-black surface are the ones that break every subtitle in
 * the app for as long as a finger is down. An outline changes no pixel behind
 * any glyph, so the row can light up at zero cost — and it is a shape change,
 * not a hue change, which is the same reason Pill and Card tint their borders
 * (P-018).
 */
const HIGHLIGHT_WIDTH = 2;

export interface PressableScaleProps {
  /** Optional: a bare hit target (FamilyMapView's pins) draws nothing of its own. */
  children?: ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /** NO_MOTION drops the scale, keeps the haptic and the opacity step. */
  motion?: PressMotionPreset;
  /** False where a haptic would machine-gun (a horizontal strip of chips). */
  haptic?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Use `hitSlopFor(height)` from motion.ts for anything under 48 dp tall. */
  hitSlop?: number | Insets;
  /**
   * Colour of the outline drawn while held. Supplying it switches the press from
   * "dim" to "outline": the row gains an edge instead of fading, which reads as
   * *you are touching this* rather than as *this is unavailable* on a long list.
   */
  highlightColor?: string;
  /** Must match the container's radius or the ring shows square corners. */
  highlightRadius?: number;
  accessible?: boolean;
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  testID?: string;
}

function PressableScaleImpl({
  children,
  onPress,
  onLongPress,
  disabled = false,
  motion,
  haptic = true,
  style,
  hitSlop,
  highlightColor,
  highlightRadius = 0,
  accessible = true,
  accessibilityRole = 'button',
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  testID,
}: PressableScaleProps) {
  const highlighted = highlightColor !== undefined;
  const press = usePressScale({
    preset: motion,
    haptic,
    disabled,
    pressedOpacity: highlighted ? 1 : undefined,
  });

  // Same Animated.Value as the scale, so the ring and the shrink are one native
  // animation and cannot drift apart under load.
  const overlayStyle = useMemo(
    () => ({ opacity: press.progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) }),
    [press.progress],
  );

  return (
    <AnimatedPressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      disabled={disabled}
      hitSlop={hitSlop}
      accessible={accessible}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={accessibilityState}
      testID={testID}
      // A disabled control gives no feedback at all — a scale on something that
      // will not act is a lie about availability.
      style={[style, disabled ? null : press.style]}
    >
      {highlighted && !disabled ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.overlay,
            overlayStyle,
            { borderColor: highlightColor, borderRadius: highlightRadius },
          ]}
        />
      ) : null}
      {children}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    // Spelled out rather than StyleSheet.absoluteFillObject: RN 0.86's types no
    // longer expose that member (see CountdownRing.tsx for the same note).
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: HIGHLIGHT_WIDTH,
  },
});

export const PressableScale = memo(PressableScaleImpl);
export default PressableScale;
