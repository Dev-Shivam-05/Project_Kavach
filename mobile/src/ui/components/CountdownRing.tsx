/**
 * ★ THE ONLY ANIMATION IN KAVACH ★
 *
 * PRD §6.4 forbids animation everywhere else: motion during an emergency reads as
 * "the app is loading / the app is broken" and measurably increases panic. The
 * cancel countdown is the one exception, because here the motion IS the
 * information — it answers "how long have I got?" without requiring the user to
 * read a number under adrenaline.
 *
 * ★ THIS COMPONENT OWNS NO TIMER. ★
 * The cancel window belongs to T0 (t0/triggerRouter, 500 ms budget); the store
 * projects it as `pendingUntil`. A second clock living inside a view would drift
 * away from the clock that actually fires the dispatch, and the ring would then
 * lie about the deadline. `remainingMs` is a prop for that reason — do not add a
 * setInterval here.
 *
 * No Animated / Reanimated either: the ring is re-rendered from the prop, so what
 * is drawn is always what T0 believes, never an interpolation of it.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { colors, font, weight } from '../theme';

export interface CountdownRingProps {
  /** Full length of the cancel window, ms. */
  totalMs: number;
  /** Time left, ms. Owned and ticked by the parent (usually from `pendingUntil`). */
  remainingMs: number;
  size?: number;
  colour?: string;
}

const DEFAULT_SIZE = 168;

export function CountdownRing({
  totalMs,
  remainingMs,
  size = DEFAULT_SIZE,
  colour = colors.danger,
}: CountdownRingProps): React.ReactElement {
  const stroke = Math.max(8, Math.round(size * 0.075));
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;

  // A zero/negative window is not an error state — it is "the dispatch is going
  // out now", so the ring reads empty rather than full.
  const fraction = totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 0;
  const offset = circumference * (1 - fraction);

  // Latin digits, unconditionally (P-059): a countdown is read by whoever is
  // holding the phone, who may not read the subject's script.
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const label = String(seconds);

  return (
    <View
      style={[styles.wrap, { width: size, height: size }]}
      accessible
      accessibilityRole="timer"
      accessibilityLabel={`${seconds} seconds left to cancel`}
      accessibilityLiveRegion="polite"
    >
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Track. Always visible, so the ring reads as "depleting" and never as
            "loading" — an arc on an empty background is the ambiguous case. */}
        <Circle cx={c} cy={c} r={r} stroke={colors.border} strokeWidth={stroke} fill="none" />
        <Circle
          cx={c}
          cy={c}
          r={r}
          stroke={colour}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          // Deplete from 12 o'clock clockwise; SVG arcs start at 3 o'clock.
          rotation={-90}
          originX={c}
          originY={c}
        />
      </Svg>

      <View style={styles.centre} pointerEvents="none">
        <Text
          style={[styles.numeral, { fontSize: Math.round(size * 0.34), color: colour }]}
          allowFontScaling={false}
          maxFontSizeMultiplier={1}
        >
          {label}
        </Text>
        <Text style={styles.unit} allowFontScaling={false}>
          s
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  centre: {
    // Spelled out rather than StyleSheet.absoluteFillObject: RN 0.86's types no
    // longer expose that member, and the panic path must not depend on a typing
    // quirk to centre its countdown.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  numeral: {
    // Tabular-ish stability matters more than beauty: the numeral must not jitter
    // sideways every tick while someone is trying to read it.
    fontVariant: ['tabular-nums'],
    fontWeight: weight.heavy,
    includeFontPadding: false,
  },
  unit: {
    color: colors.textDim,
    fontSize: font.h3,
    fontWeight: weight.semibold,
    marginLeft: 2,
  },
});

export default CountdownRing;
