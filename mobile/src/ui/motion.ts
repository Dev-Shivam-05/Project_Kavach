/**
 * KAVACH MOTION PRIMITIVES
 *
 * ★★ READ THIS BEFORE ADDING MOTION ANYWHERE ★★
 *
 * PRD §6.4: on the panic path the ONLY permitted animation is the cancel
 * countdown ring (src/ui/components/CountdownRing.tsx). Anything else that moves
 * while a dispatch is pending is read as "the app is loading / the app is
 * broken", and that measurably raises panic in exactly the seconds where the
 * user must stay able to act. `app/panic.tsx` and `app/probe.tsx` therefore must
 * never pass an entrance preset to a Card or any other surface — they leave
 * `enter` unset, which resolves to NO_MOTION.
 *
 * Motion here is opt-in, not opt-out: every entrance API in this file defaults
 * to NO_MOTION, so a screen that forgets to think about §6.4 gets the safe answer
 * by omission rather than by discipline. Button additionally hard-wires
 * `size="panic"` to NO_MOTION, because that size is only ever the dispatch
 * trigger and a scaling emergency button is precisely the thing §6.4 forbids.
 *
 * ★ WHY THE RN Animated API AND NOT REANIMATED ★
 * Both are installed. Every animation in this file is a pure `transform` /
 * `opacity` change, which `useNativeDriver: true` serialises to the platform
 * animation thread once at start — after which not a single frame touches JS.
 * That is the same "does not stutter while JS is busy" property worklets buy,
 * without adding a worklet-transform dependency to every leaf primitive in the
 * app: babel.config.js registers the Reanimated plugin CONDITIONALLY (it degrades
 * to no transform when react-native-worklets is not materialised by an install),
 * and a component library that silently drops to JS-thread animation under a
 * partial install is worse than one that never had the option. There is no
 * `setState` per frame anywhere in this file; the only re-render any of it can
 * cause is when the OS reduce-motion flag itself flips.
 *
 * P-018 / §6.4 still apply on top of everything here: motion is *additional*
 * feedback. No state in this app is signalled by movement alone, exactly as none
 * is signalled by colour alone.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';
import * as Haptics from 'expo-haptics';

import { MIN_TOUCH_TARGET } from './theme';

/**
 * ★ THE PANIC-PATH GUARD ★
 * Passed (or defaulted) wherever a surface must not animate. It is a value, not
 * a boolean flag, so a call site reads `enter={NO_MOTION}` and greps as an
 * intentional §6.4 decision rather than as a missing prop.
 */
export const NO_MOTION = 'none' as const;

/** Entrance presets. `rise` is a fade plus an 8 dp lift — never a slide across. */
export type EntranceMotionPreset = typeof NO_MOTION | 'fade' | 'rise';

/** Press-feedback presets. `NO_MOTION` keeps the haptic and the opacity step. */
export type PressMotionPreset = typeof NO_MOTION | 'scale';

/**
 * 0.97 and not 0.90: at arm's length on a 6.1" phone a 3 % shrink is felt more
 * than seen, which is what an 81-year-old needs from press feedback. A deeper
 * scale starts to read as the button "falling away" and invites a second press.
 */
export const PRESS_SCALE = 0.97;

/** Retained from the pre-motion design so reduce-motion loses nothing visible. */
export const PRESSED_OPACITY = 0.72;

/** Critically-ish damped: settles in ~120 ms with no visible overshoot wobble. */
export const PRESS_SPRING = {
  stiffness: 420,
  damping: 34,
  mass: 1,
  useNativeDriver: true,
} as const;

/**
 * Slightly softer than PRESS_SPRING: the switch thumb travels 23 dp rather than
 * shrinking 3 %, and at press stiffness that distance reads as a twitch. Still
 * zero overshoot — a thumb that bounces past its stop looks like it might come
 * back, and "did that actually stay off?" is the one question this control exists
 * to answer (P-066, F-14).
 */
export const SWITCH_SPRING = {
  stiffness: 300,
  damping: 28,
  mass: 1,
  useNativeDriver: true,
} as const;

export const ENTRANCE_MS = 180;
export const ENTRANCE_RISE = 8;

// ── reduce-motion ─────────────────────────────────────────────────────────────
//
// One process-wide subscription, not one per component. A family list can mount
// forty pressables at once and forty native `reduceMotionChanged` listeners is a
// real cost on the cheap Android this app targets. The subscription is never
// torn down on purpose: it outlives every screen and costs one callback.

let reduceMotionNow = false;
let subscribed = false;
const subscribers = new Set<(value: boolean) => void>();

function publishReduceMotion(next: boolean): void {
  if (next === reduceMotionNow) return;
  reduceMotionNow = next;
  for (const notify of subscribers) notify(next);
}

function subscribeReduceMotionOnce(): void {
  if (subscribed) return;
  subscribed = true;
  // Fails soft: a platform that cannot answer leaves motion on, which is the
  // pre-existing behaviour and never a broken screen (HARD RULE 4).
  AccessibilityInfo.isReduceMotionEnabled().then(publishReduceMotion).catch(() => {});
  AccessibilityInfo.addEventListener('reduceMotionChanged', publishReduceMotion);
}

/**
 * Last known value of the OS reduce-motion flag, readable during render.
 * Used only to pick an animation's *initial* value so a reduce-motion user never
 * sees the one frame at opacity 0 that a post-paint effect would leave.
 */
export function reduceMotionSnapshot(): boolean {
  return reduceMotionNow;
}

/** Re-renders only when the OS flag itself changes — never per frame. */
export function useReduceMotion(): boolean {
  const [enabled, setEnabled] = useState<boolean>(reduceMotionNow);

  useEffect(() => {
    subscribeReduceMotionOnce();
    // The async probe may have resolved between this render and this effect.
    setEnabled(reduceMotionNow);
    subscribers.add(setEnabled);
    return () => {
      subscribers.delete(setEnabled);
    };
  }, []);

  return enabled;
}

// ── haptics ───────────────────────────────────────────────────────────────────

/**
 * The tap confirmation. Light, not Medium: this fires on every button in the
 * app, and a heavier pulse becomes noise that users disable — at which point the
 * panic path's Heavy pulses (src/t0/alarm.ts) lose their meaning too.
 *
 * Deliberately NOT suppressed under reduce-motion: that setting is about
 * vestibular discomfort from movement, and stripping the haptic would remove the
 * one confirmation channel that still works for a low-vision user.
 */
export function tapHaptic(): void {
  // Never throws into the UI: an emulator or a device with no vibrator rejects.
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

// ── press feedback ────────────────────────────────────────────────────────────

type AnimatedNumber = Animated.AnimatedInterpolation<number>;

export interface PressScaleStyle {
  opacity: AnimatedNumber;
  transform: { scale: AnimatedNumber }[];
}

export interface PressScale {
  /** Spread onto the Animated pressable. Contains no layout properties. */
  readonly style: PressScaleStyle;
  /**
   * 0 at rest, 1 while held. Exposed so a component can hang a second native
   * channel off the same animation (ListItem's highlight ring) instead of
   * starting a competing one.
   */
  readonly progress: Animated.Value;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
}

export interface PressScaleOptions {
  /** NO_MOTION keeps the opacity step and the haptic, drops the scale. */
  preset?: PressMotionPreset;
  /** Set false where a haptic would fire in a burst (a row of chips). */
  haptic?: boolean;
  disabled?: boolean;
  /**
   * Held-state opacity. Pass 1 on a surface that signals the press by brightening
   * instead — dimming and brightening the same node cancel each other out.
   */
  pressedOpacity?: number;
}

/**
 * One Animated.Value drives both scale and opacity, so a press is a single
 * native animation rather than two competing ones.
 */
export function usePressScale(options: PressScaleOptions = {}): PressScale {
  const {
    preset = 'scale',
    haptic = true,
    disabled = false,
    pressedOpacity = PRESSED_OPACITY,
  } = options;
  const reduceMotion = useReduceMotion();

  const progress = useRef<Animated.Value | null>(null);
  if (progress.current === null) progress.current = new Animated.Value(0);
  const value = progress.current;

  const style = useMemo<PressScaleStyle>(() => {
    const scaleTo = preset === NO_MOTION ? 1 : PRESS_SCALE;
    return {
      opacity: value.interpolate({ inputRange: [0, 1], outputRange: [1, pressedOpacity] }),
      transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, scaleTo] }) }],
    };
  }, [preset, pressedOpacity, value]);

  const handlers = useMemo(() => {
    const settle = (to: number): void => {
      // Reduce-motion is an INSTANT state change, not an absence of feedback:
      // the pressed look still happens, it just does not travel there.
      if (reduceMotion || preset === NO_MOTION) {
        value.setValue(to);
        return;
      }
      Animated.spring(value, { toValue: to, ...PRESS_SPRING }).start();
    };
    return {
      onPressIn: (): void => {
        if (disabled) return;
        settle(1);
        // On press-in, not on press: an elderly user needs to know the finger
        // landed, before they find out what the button did.
        if (haptic) tapHaptic();
      },
      onPressOut: (): void => {
        settle(0);
      },
    };
  }, [disabled, haptic, preset, reduceMotion, value]);

  return {
    style,
    progress: value,
    onPressIn: handlers.onPressIn,
    onPressOut: handlers.onPressOut,
  };
}

// ── entrance ──────────────────────────────────────────────────────────────────

export interface EntranceStyle {
  opacity: AnimatedNumber;
  transform: { translateY: AnimatedNumber }[];
}

/**
 * Returns null for NO_MOTION so the caller renders a completely static node —
 * the panic path pays nothing at all, not even an interpolation.
 *
 * ★ Do not call this from app/panic.tsx or app/probe.tsx with anything but the
 * default. See the file header: PRD §6.4.
 */
export function useEntrance(preset: EntranceMotionPreset = NO_MOTION): EntranceStyle | null {
  const reduceMotion = useReduceMotion();
  const active = preset !== NO_MOTION;

  const progress = useRef<Animated.Value | null>(null);
  if (progress.current === null) {
    progress.current = new Animated.Value(!active || reduceMotionSnapshot() ? 1 : 0);
  }
  const value = progress.current;

  useEffect(() => {
    if (!active || reduceMotion) {
      value.setValue(1);
      return;
    }
    const anim = Animated.timing(value, {
      toValue: 1,
      duration: ENTRANCE_MS,
      // Decelerating only. An ease-in-out entrance reads as a transition the user
      // has to wait out; this one is over before it can be waited on.
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    anim.start();
    return () => {
      anim.stop();
    };
  }, [active, reduceMotion, value]);

  return useMemo<EntranceStyle | null>(() => {
    if (!active) return null;
    const rise = preset === 'rise' ? ENTRANCE_RISE : 0;
    return {
      opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
      transform: [
        { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [rise, 0] }) },
      ],
    };
  }, [active, preset, value]);
}

// ── touch targets ─────────────────────────────────────────────────────────────

/**
 * Slop that lifts a visually smaller control up to the 48 dp floor theme.ts sets.
 * A status chip is 26 dp tall because a 48 dp chip would dominate the row it
 * annotates; the finger target still has to be 48 (PRD §6.4, P-004).
 */
export function hitSlopFor(visualSize: number): number {
  return Math.max(0, Math.ceil((MIN_TOUCH_TARGET - visualSize) / 2));
}
