/**
 * Sparkline — a shape, not a chart.
 *
 * Used for battery decay and heartbeat latency in the family glance view. There
 * are deliberately no axes, no gridlines and no labels: PRD §6.4 caps an element
 * at ~4 words, and a reader glancing at a family list needs "is this going down
 * fast?", not a number they must interpret.
 *
 * ★ It is never the only carrier of a fact. ★ The row that owns it also states the
 * value in text (MemberRow renders "Battery 42%"), because a trend line alone
 * fails both the contrast rule and every screen reader.
 *
 * No animation (PRD §6.4) — the polyline is recomputed from props and drawn.
 */
import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

import { colors } from '../theme';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  colour?: string;
}

const DEFAULT_WIDTH = 120;
const DEFAULT_HEIGHT = 32;
const PAD = 3;

export function Sparkline({
  values,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  colour = colors.info,
}: SparklineProps): React.ReactElement {
  const usable = values.filter((v) => Number.isFinite(v));
  const innerW = Math.max(1, width - PAD * 2);
  const innerH = Math.max(1, height - PAD * 2);

  // No data is drawn as a flat dim rule rather than an empty box: an empty box
  // reads as "still loading", which is the one impression this app never gives.
  if (usable.length === 0) {
    return (
      <View accessible accessibilityRole="image" accessibilityLabel="No trend data">
        <Svg width={width} height={height}>
          <Line
            x1={PAD}
            y1={height / 2}
            x2={width - PAD}
            y2={height / 2}
            stroke={colors.border}
            strokeWidth={1.5}
            strokeDasharray={[3, 3]}
          />
        </Svg>
      </View>
    );
  }

  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const span = max - min;

  const x = (i: number): number =>
    usable.length === 1 ? width / 2 : PAD + (i / (usable.length - 1)) * innerW;
  // A flat series sits on the centre line instead of collapsing onto the floor,
  // which would read as "zero" rather than "unchanging".
  const y = (v: number): number => (span === 0 ? height / 2 : PAD + (1 - (v - min) / span) * innerH);

  const last = usable[usable.length - 1];
  const points = usable.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');

  const spoken =
    usable.length === 1
      ? `Trend, single reading ${Math.round(last)}`
      : `Trend, ${usable.length} readings, from ${Math.round(usable[0])} to ${Math.round(last)}`;

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={spoken}>
      <Svg width={width} height={height}>
        {usable.length > 1 ? (
          <Polyline
            points={points}
            fill="none"
            stroke={colour}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}
        {/* The latest reading is the one that matters; mark it so the eye lands there. */}
        <Circle cx={x(usable.length - 1)} cy={y(last)} r={2.75} fill={colour} />
      </Svg>
    </View>
  );
}

export default Sparkline;
