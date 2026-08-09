/**
 * ★★★ THE MAP THAT IS NOT A MAP ★★★
 *
 * There is no basemap, no tile server and no `react-native-maps` here, for three
 * separate reasons, any one of which would be sufficient:
 *
 *  1. HARD RULE 4 — react-native-maps cannot run in Expo Go, and a family that
 *     cannot open the app cannot rehearse with it.
 *  2. ADR-010 / docs/02 §10.2 — precise location is Class A. Every tile request
 *     is a location disclosure to a third party, made silently, with no consent
 *     grant behind it and no row in the access log. A map that leaks the thing
 *     the consent architecture exists to protect is not a feature.
 *  3. §4.4 — tiles need network. This view must render identically at
 *     ZERO_INFRA, because that is when someone is actually looking at it.
 *
 * So: an equirectangular projection of the points we already hold, drawn to
 * scale, with a metre scale bar so relative distance is still readable without
 * any geographic context. Aspect ratio is preserved on both axes — otherwise the
 * scale bar would be a lie in one direction.
 *
 * ★★★ THE PIN THAT IS NOT DRAWN ★★★
 * A member with no live location grant, or with monitoring paused, is LISTED
 * BELOW THE MAP as "location not shared". They are never drawn at their last
 * known position. Drawing a stale pin is exactly the failure the whole consent
 * design exists to prevent: it converts a revoked grant into a silent, still-
 * working tracker, and it tells a searcher to look in the wrong place. Absence of
 * a signal is rendered as absence (P-008, F-14, P-066).
 *
 * A pin we ARE allowed to draw but which is old is drawn dimmed and dashed with
 * its age spoken in the label — honest about freshness rather than confident.
 */
import React, { useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import type { Member, MemberPresence, UUID } from '../../core/types';
import { relativeTime } from '../../i18n';
import { colors, font, leading, MIN_TOUCH_TARGET, radius, space, tracking, weight } from '../theme';
import { initialsFor, MemberAvatar } from './MemberAvatar';
import { PressableScale } from './PressableScale';

export interface FamilyMapViewProps {
  members: Member[];
  presence: Record<UUID, MemberPresence>;
  incidentAt?: { lat: number; lon: number } | null;
  onSelectMember?: (id: UUID) => void;
  height?: number;
}

const DEFAULT_HEIGHT = 280;
/** Keeps pins and their accuracy discs off the frame edge. */
const PAD = 34;
/** One point carries no span of its own; ~500 m across is a useful default. */
const SINGLE_POINT_SPAN_DEG = 0.0045;
/** Metres per degree of latitude. Longitude is scaled by cos(lat) at the centre. */
const M_PER_DEG_LAT = 111_320;
/** Beyond this a fix is described as old rather than presented as current. */
const STALE_MS = 15 * 60_000;
const PIN_R = 15;
const NICE_METRES = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000];

interface PlottedPoint {
  id: UUID;
  name: string;
  initials: string;
  colour: string;
  lat: number;
  lon: number;
  accuracyM: number;
  at: number;
}

interface HiddenMember {
  id: UUID;
  member: Member;
  reason: string;
}

interface Geometry {
  /** px per degree of latitude, applied to both axes so distance is uniform. */
  scale: number;
  latCentre: number;
  lonCentre: number;
  kx: number;
  cx: number;
  cy: number;
  metresPerPx: number;
}

function buildGeometry(
  pts: { lat: number; lon: number }[],
  w: number,
  h: number,
): Geometry {
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const latCentre = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lonCentre = (Math.min(...lons) + Math.max(...lons)) / 2;
  const kx = Math.max(0.05, Math.cos((latCentre * Math.PI) / 180));

  const rawSpanY = Math.max(...lats) - Math.min(...lats);
  const rawSpanX = (Math.max(...lons) - Math.min(...lons)) * kx;
  const bare = rawSpanX <= 1e-9 && rawSpanY <= 1e-9;

  // 1.3× so no pin sits on the frame; a floor so two people standing together do
  // not get zoomed to street-furniture scale where GPS noise looks like distance.
  const spanY = bare ? SINGLE_POINT_SPAN_DEG : Math.max(rawSpanY * 1.3, SINGLE_POINT_SPAN_DEG * 0.25);
  const spanX = bare ? SINGLE_POINT_SPAN_DEG : Math.max(rawSpanX * 1.3, SINGLE_POINT_SPAN_DEG * 0.25);

  const plotW = Math.max(1, w - PAD * 2);
  const plotH = Math.max(1, h - PAD * 2);
  const scale = Math.min(plotW / spanX, plotH / spanY);

  return {
    scale,
    latCentre,
    lonCentre,
    kx,
    cx: w / 2,
    cy: h / 2,
    metresPerPx: M_PER_DEG_LAT / scale,
  };
}

function project(g: Geometry, lat: number, lon: number): { x: number; y: number } {
  return {
    x: g.cx + (lon - g.lonCentre) * g.kx * g.scale,
    y: g.cy - (lat - g.latCentre) * g.scale,
  };
}

/** Largest "nice" distance that fits in ~30% of the frame. */
function scaleBar(metresPerPx: number, w: number): { metres: number; px: number } {
  const target = w * 0.3 * metresPerPx;
  let chosen = NICE_METRES[0];
  for (const m of NICE_METRES) if (m <= target) chosen = m;
  return { metres: chosen, px: chosen / metresPerPx };
}

function label(metres: number): string {
  return metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
}

export function FamilyMapView({
  members,
  presence,
  incidentAt,
  onSelectMember,
  height = DEFAULT_HEIGHT,
}: FamilyMapViewProps): React.ReactElement {
  const [width, setWidth] = useState(0);
  const now = Date.now();

  const plotted: PlottedPoint[] = [];
  const hidden: HiddenMember[] = [];

  for (const m of members) {
    // Explicitly widened: a member with no presence row at all is the common case
    // on a fresh install and must not be indexed into blindly.
    const p: MemberPresence | undefined = presence[m.id];
    if (p && p.monitoringPaused) {
      // P-066 — a right exercised, stated plainly, not an error.
      hidden.push({ id: m.id, member: m, reason: 'Monitoring paused' });
      continue;
    }
    if (!p || !p.location) {
      hidden.push({ id: m.id, member: m, reason: 'Location not shared' });
      continue;
    }
    plotted.push({
      id: m.id,
      name: m.displayName,
      initials: initialsFor(m),
      colour: m.avatarColor || colors.info,
      lat: p.location.lat,
      lon: p.location.lon,
      accuracyM: p.location.accuracyM,
      at: p.location.at,
    });
  }

  const boundsSource: { lat: number; lon: number }[] = plotted.map((p) => ({ lat: p.lat, lon: p.lon }));
  if (incidentAt) boundsSource.push({ lat: incidentAt.lat, lon: incidentAt.lon });

  // ★ "Still measuring" is NOT "nothing to show" ★
  // The projection needs a width, and the width arrives from onLayout one frame
  // after the first render. Folding that frame into the empty state made the view
  // announce "nobody is sharing a live location" while it was holding live
  // points — the one kind of lie this component's header spends thirty lines
  // forbidding. The frame is now blank instead of wrong.
  const measuring = width === 0 && boundsSource.length > 0;
  const g = width > 0 && boundsSource.length > 0 ? buildGeometry(boundsSource, width, height) : null;
  const bar = g ? scaleBar(g.metresPerPx, width) : null;

  return (
    <View>
      <View
        style={[styles.canvas, { height }]}
        onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width))}
        accessible={false}
      >
        {measuring ? null : g === null || bar === null ? (
          <View style={styles.empty} accessible accessibilityRole="text" accessibilityLabel="Nothing to map">
            <Text style={styles.emptyTitle}>Nothing to map</Text>
            <Text style={styles.emptyBody}>
              {members.length === 0
                ? 'No family members yet.'
                : 'Nobody is sharing a live location right now.'}
            </Text>
          </View>
        ) : (
          <>
            <Svg width={width} height={height}>
              <Rect x={0} y={0} width={width} height={height} fill={colors.bgElevated} />

              {/* Grid. Purely a distance reference — it carries no place names,
                  because we have none and inventing them would be worse. */}
              <G>
                {[1, 2, 3, 4].map((i) => (
                  <Line
                    key={`v${i}`}
                    x1={(width / 5) * i}
                    y1={0}
                    x2={(width / 5) * i}
                    y2={height}
                    stroke={colors.border}
                    strokeWidth={1}
                    opacity={0.55}
                  />
                ))}
                {[1, 2, 3].map((i) => (
                  <Line
                    key={`h${i}`}
                    x1={0}
                    y1={(height / 4) * i}
                    x2={width}
                    y2={(height / 4) * i}
                    stroke={colors.border}
                    strokeWidth={1}
                    opacity={0.55}
                  />
                ))}
              </G>

              {/* North is up: the projection is equirectangular and unrotated. */}
              <SvgText
                x={width - space.md}
                y={space.lg + 2}
                fill={colors.textFaint}
                fontSize={font.tiny}
                fontWeight="700"
                textAnchor="end"
              >
                N ↑
              </SvgText>

              {/* Accuracy discs first, so no disc ever paints over a pin. */}
              {plotted.map((p) => {
                const { x, y } = project(g, p.lat, p.lon);
                const rPx = Math.max(
                  PIN_R + 4,
                  Math.min(p.accuracyM / g.metresPerPx, Math.max(width, height)),
                );
                const stale = now - p.at > STALE_MS;
                return (
                  <Circle
                    key={`acc-${p.id}`}
                    cx={x}
                    cy={y}
                    r={rPx}
                    fill={p.colour}
                    fillOpacity={stale ? 0.05 : 0.11}
                    stroke={p.colour}
                    strokeOpacity={stale ? 0.3 : 0.5}
                    strokeWidth={1.5}
                    strokeDasharray={stale ? [5, 4] : undefined}
                  />
                );
              })}

              {incidentAt ? (
                (() => {
                  const { x, y } = project(g, incidentAt.lat, incidentAt.lon);
                  return (
                    <G key="incident">
                      <Circle
                        cx={x}
                        cy={y}
                        r={PIN_R + 12}
                        fill={colors.danger}
                        fillOpacity={0.16}
                        stroke={colors.danger}
                        strokeWidth={2}
                      />
                      {/* A cross, not just a colour — never colour alone (§6.4). */}
                      <Path
                        d={`M ${x - 9} ${y} H ${x + 9} M ${x} ${y - 9} V ${y + 9}`}
                        stroke={colors.danger}
                        strokeWidth={4}
                        strokeLinecap="round"
                      />
                    </G>
                  );
                })()
              ) : null}

              {plotted.map((p) => {
                const { x, y } = project(g, p.lat, p.lon);
                const stale = now - p.at > STALE_MS;
                return (
                  <G key={`pin-${p.id}`} opacity={stale ? 0.62 : 1}>
                    <Circle
                      cx={x}
                      cy={y}
                      r={PIN_R}
                      fill={p.colour}
                      stroke={colors.bg}
                      strokeWidth={2.5}
                    />
                    <SvgText
                      x={x}
                      y={y + 4}
                      fill={colors.bg}
                      fontSize={font.tiny}
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      {p.initials}
                    </SvgText>
                  </G>
                );
              })}

              {/* Scale bar — the only way to read distance without a basemap. */}
              <G>
                <Line
                  x1={space.md}
                  y1={height - space.xl}
                  x2={space.md + bar.px}
                  y2={height - space.xl}
                  stroke={colors.text}
                  strokeWidth={2.5}
                />
                <Line
                  x1={space.md}
                  y1={height - space.xl - 5}
                  x2={space.md}
                  y2={height - space.xl + 5}
                  stroke={colors.text}
                  strokeWidth={2.5}
                />
                <Line
                  x1={space.md + bar.px}
                  y1={height - space.xl - 5}
                  x2={space.md + bar.px}
                  y2={height - space.xl + 5}
                  stroke={colors.text}
                  strokeWidth={2.5}
                />
                <SvgText
                  x={space.md}
                  y={height - space.sm}
                  fill={colors.text}
                  fontSize={font.tiny}
                  fontWeight="600"
                  textAnchor="start"
                >
                  {label(bar.metres)}
                </SvgText>
              </G>
            </Svg>

            {/* Touch targets live above the SVG, not on it: MIN_TOUCH_TARGET is
                48 dp and a 15 dp circle is not tappable with cold hands. The
                target is invisible at rest and draws a focus ring while held —
                without it, tapping a pin on a crowded map gave no answer at all
                to "which one did I get?" until the next screen had already
                pushed. */}
            {onSelectMember === undefined
              ? null
              : plotted.map((p) => {
                  const { x, y } = project(g, p.lat, p.lon);
                  const age = relativeTime(p.at);
                  return (
                    <PressableScale
                      key={`hit-${p.id}`}
                      onPress={() => onSelectMember(p.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`${p.name}, last fix ${age}, accurate to about ${Math.max(
                        1,
                        Math.round(p.accuracyM),
                      )} metres`}
                      accessibilityHint="Opens this person's details"
                      hitSlop={6}
                      highlightColor={colors.focus}
                      highlightRadius={MIN_TOUCH_TARGET / 2}
                      style={[
                        styles.hit,
                        {
                          left: x - MIN_TOUCH_TARGET / 2,
                          top: y - MIN_TOUCH_TARGET / 2,
                        },
                      ]}
                    />
                  );
                })}
          </>
        )}
      </View>

      {/* ★ The honest list. See the file header — these people are NOT pins. */}
      {hidden.length === 0 ? null : (
        <View style={styles.hiddenBlock}>
          <Text style={styles.hiddenHeading}>Not on the map</Text>
          {hidden.map((h) =>
            onSelectMember === undefined ? (
              <View
                key={h.id}
                style={styles.hiddenRow}
                accessible
                accessibilityRole="text"
                accessibilityLabel={`${h.member.displayName}, ${h.reason}`}
              >
                <MemberAvatar member={h.member} size={30} />
                <Text style={styles.hiddenName} numberOfLines={1}>
                  {h.member.displayName}
                </Text>
                <Text style={styles.hiddenReason} numberOfLines={1}>
                  {h.reason}
                </Text>
              </View>
            ) : (
              <PressableScale
                key={h.id}
                onPress={() => onSelectMember(h.id)}
                accessibilityRole="button"
                accessibilityLabel={`${h.member.displayName}, ${h.reason}`}
                accessibilityHint="Opens this person's details"
                highlightColor={colors.info}
                highlightRadius={radius.md}
                style={styles.hiddenRow}
              >
                <MemberAvatar member={h.member} size={30} />
                <Text style={styles.hiddenName} numberOfLines={1}>
                  {h.member.displayName}
                </Text>
                <Text style={styles.hiddenReason} numberOfLines={1}>
                  {h.reason}
                </Text>
              </PressableScale>
            ),
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    width: '100%',
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.lg,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: font.h3,
    lineHeight: leading.h3,
    fontWeight: weight.semibold,
  },
  emptyBody: {
    color: colors.textDim,
    fontSize: font.small,
    lineHeight: leading.small,
    marginTop: space.xs,
    textAlign: 'center',
  },
  hit: {
    position: 'absolute',
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    borderRadius: MIN_TOUCH_TARGET / 2,
  },
  hiddenBlock: {
    marginTop: space.md,
  },
  hiddenHeading: {
    color: colors.textFaint,
    fontSize: font.tiny,
    lineHeight: leading.tiny,
    fontWeight: weight.bold,
    letterSpacing: tracking.caps,
    textTransform: 'uppercase',
    marginBottom: space.xs,
  },
  hiddenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: space.md,
    marginBottom: space.xs,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
  },
  hiddenName: {
    flex: 1,
    color: colors.text,
    fontSize: font.body,
    lineHeight: leading.body,
    fontWeight: weight.medium,
    marginLeft: space.md,
  },
  hiddenReason: {
    color: colors.textDim,
    fontSize: font.small,
    lineHeight: leading.small,
    marginLeft: space.sm,
  },
});

export default FamilyMapView;
