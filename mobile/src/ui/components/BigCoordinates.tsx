/**
 * ★★★ THE L0 FLOOR ★★★
 *
 * This is what remains when everything else has failed: no server, no data, no
 * SMS, a dead agent, a stranger holding the phone who has never seen this app.
 * They must be able to read these numbers to a 112 operator over a voice call.
 * That is the entire job (PRD §4.4 ZERO_INFRA, docs/02 §4.4).
 *
 * Consequences that are NOT stylistic:
 *   · font.hugeCoord — legible at arm's length, in rain, held by shaking hands.
 *   · ★ Latin digits ALWAYS, whatever the locale (P-059). Devanagari digits are
 *     correct Hindi and useless to a Tamil paramedic. `toFixed` is
 *     locale-independent by specification; never route these through
 *     Intl.NumberFormat or toLocaleString.
 *   · Six decimals — ~0.1 m. Fewer loses a building; more is noise a human
 *     cannot read aloud without losing their place.
 *   · Grouped as `dd.ddd ddd` so a person reading aloud has a resting point and
 *     does not double-read a digit. Digits only — no spelt-out words: a spoken
 *     transliteration would be one more thing to mistranslate.
 *
 * No animation, no loading state, no network. Everything here is already known.
 * The two buttons press through PressableScale with `motion={NO_MOTION}`, which
 * is the §6.4-compliant half of it: a static edge and a haptic, no travel.
 */
import React, { useCallback, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { NO_MOTION } from '../motion';
import {
  colors,
  font,
  leading,
  MIN_TOUCH_TARGET,
  radius,
  space,
  tracking,
  weight,
} from '../theme';
import { PressableScale } from './PressableScale';

export interface BigCoordinatesProps {
  lat: number;
  lon: number;
  accuracyM?: number;
  /** Receives the plain `lat, lon` string. Omit to hide the copy control entirely. */
  onCopy?: (text: string) => void;
}

/**
 * ★ THE DIGITS SHRINK; THE LINE NEVER BREAKS ★
 * `23.022 505` is ten characters, ~264 pt at 44 px mono. Inside panic.tsx's body
 * padding a 320 dp phone offers 254 pt, and a negative or three-digit coordinate
 * ("-179.999 999", twelve characters) overruns a 360 dp phone as well. A wrapped
 * coordinate is a misread coordinate: the reader's eye loses the group boundary
 * and a digit gets doubled or dropped on its way to a 112 operator.
 *
 * 0.7 covers the worst case — twelve characters need ~35 px on the narrowest
 * phone, and 44 × 0.7 = 30.8 — so the ellipsis is unreachable and no digit is
 * ever silently truncated. iOS honours this floor directly; Android autosizes
 * against its own 4 dp floor, which is far below anything we can reach here, so
 * both platforms shrink rather than cut.
 */
const COORD_MIN_SCALE = 0.7;

/** Fixed six decimals, Latin digits, sign preserved. */
export function formatCoord(v: number): string {
  return Number.isFinite(v) ? v.toFixed(6) : '0.000000';
}

/** `23.022 505` — the read-aloud grouping. */
export function groupCoord(v: number): string {
  const parts = formatCoord(v).split('.');
  const frac = parts[1];
  return `${parts[0]}.${frac.slice(0, 3)} ${frac.slice(3)}`;
}

export function BigCoordinates({ lat, lon, accuracyM, onCopy }: BigCoordinatesProps): React.ReactElement {
  const [note, setNote] = useState<string | null>(null);

  const plain = `${formatCoord(lat)}, ${formatCoord(lon)}`;

  const openMaps = useCallback(() => {
    // The documented geo: URI first. Both fallbacks are LOCAL app hand-offs —
    // precise location is Class A (docs/02 §10.2) and must not be handed to a web
    // search URL just because no map app answered.
    const geo = `geo:${formatCoord(lat)},${formatCoord(lon)}?q=${formatCoord(lat)},${formatCoord(lon)}`;
    Linking.openURL(geo).catch(() => {
      Linking.openURL(`maps:0,0?q=${formatCoord(lat)},${formatCoord(lon)}`).catch(() => {
        setNote('No maps app on this phone. Read the numbers aloud.');
      });
    });
  }, [lat, lon]);

  const copy = useCallback(() => {
    if (!onCopy) return;
    onCopy(plain);
    setNote('Coordinates copied.');
  }, [onCopy, plain]);

  return (
    <View style={styles.card}>
      <View style={styles.block}>
        <Text style={styles.label} allowFontScaling={false}>
          LAT
        </Text>
        <Text
          style={styles.coord}
          allowFontScaling={false}
          accessibilityLabel={`Latitude ${groupCoord(lat)}`}
          selectable
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={COORD_MIN_SCALE}
        >
          {groupCoord(lat)}
        </Text>
      </View>

      <View style={styles.block}>
        <Text style={styles.label} allowFontScaling={false}>
          LON
        </Text>
        <Text
          style={styles.coord}
          allowFontScaling={false}
          accessibilityLabel={`Longitude ${groupCoord(lon)}`}
          selectable
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={COORD_MIN_SCALE}
        >
          {groupCoord(lon)}
        </Text>
      </View>

      {accuracyM === undefined ? null : (
        <Text style={styles.accuracy} allowFontScaling={false}>
          {`Accurate to about ${Math.max(1, Math.round(accuracyM))} m`}
        </Text>
      )}

      {/* Both controls press with a focus-coloured edge and a haptic and nothing
          else. NO_MOTION is the §6.4 requirement — this card is on the panic
          screen — but the haptic is not optional either way: the person holding
          the phone may be a stranger who has never seen this app, and "did that
          register?" must not be a question they have to ask twice. */}
      <View style={styles.actions}>
        <PressableScale
          onPress={openMaps}
          accessibilityRole="button"
          accessibilityLabel="Open these coordinates in a maps app"
          motion={NO_MOTION}
          highlightColor={colors.focus}
          highlightRadius={radius.md}
          style={styles.action}
        >
          <Text style={styles.actionText}>Open in maps</Text>
        </PressableScale>

        {onCopy === undefined ? null : (
          <PressableScale
            onPress={copy}
            accessibilityRole="button"
            accessibilityLabel="Copy coordinates as text"
            motion={NO_MOTION}
            highlightColor={colors.focus}
            highlightRadius={radius.md}
            style={styles.action}
          >
            <Text style={styles.actionText}>Copy</Text>
          </PressableScale>
        )}
      </View>

      {note === null ? null : (
        <Text style={styles.note} accessibilityLiveRegion="polite">
          {note}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    padding: space.lg,
  },
  block: {
    marginBottom: space.md,
  },
  label: {
    color: colors.textFaint,
    fontSize: font.tiny,
    lineHeight: leading.tiny,
    fontWeight: weight.bold,
    // Three letters have two gaps to track; `caps` would vanish (see theme.ts).
    letterSpacing: tracking.capsWide,
    marginBottom: space.xxs,
  },
  coord: {
    color: colors.text,
    fontSize: font.hugeCoord,
    // No `leading.hugeCoord` here, deliberately: this is the one Text in the
    // product that autosizes, the line box does not scale with the shrunk glyphs,
    // and a fixed lineHeight interacting with autosize is not something the L0
    // floor should be the place to find out about. One line, natural leading.
    fontWeight: weight.heavy,
    fontFamily: font.mono,
    includeFontPadding: false,
    // Buys back ~5 pt on a twelve-character coordinate before the autosize floor
    // has to do anything, at a mono advance the eye still separates cleanly.
    letterSpacing: -0.5,
  },
  accuracy: {
    color: colors.textDim,
    fontSize: font.small,
    lineHeight: leading.small,
    marginBottom: space.md,
  },
  actions: {
    flexDirection: 'row',
    marginTop: space.xs,
  },
  action: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    marginRight: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.bgCard,
  },
  actionText: {
    color: colors.text,
    fontSize: font.body,
    lineHeight: leading.body,
    fontWeight: weight.semibold,
  },
  note: {
    color: colors.textDim,
    fontSize: font.small,
    lineHeight: leading.small,
    marginTop: space.md,
  },
});

export default BigCoordinates;
