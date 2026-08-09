/**
 * MemberAvatar — initials on the member's own colour.
 *
 * ★ No photos, ever. ★ `Member` carries no avatar URL and it should not: a family
 * safety app that ships a face image cache is a face image cache that leaks
 * (docs/02 §10.2 keeps Class A data off the wire). `avatarColor` is denormalised
 * onto the member row precisely so the family glance view can render without a
 * network fetch and without a loading state.
 *
 * The foreground is chosen by luminance rather than fixed to white, because
 * avatarColor is user-assignable and PRD §6.4 requires ≥7:1 contrast — a fixed
 * white initial on a pale seed colour fails that silently.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Member } from '../../core/types';
import { colors, weight } from '../theme';

export interface MemberAvatarProps {
  member: Member;
  size?: number;
  /**
   * Agent health, when the caller knows it. `true` = heartbeat healthy,
   * `false` = the safety agent is not running. Omit to draw no dot at all —
   * "unknown" must not be rendered as "fine" (F-02).
   */
  healthDot?: boolean;
}

const DEFAULT_SIZE = 44;

/** Up to two initials, preferring the display name, falling back to the ASCII short name. */
export function initialsFor(member: Member): string {
  const source = member.displayName.trim() || member.asciiShortName.trim();
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** WCAG relative luminance, used only to pick a legible foreground. */
function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false; // a malformed colour falls back to the dark-background case
  const n = parseInt(m[1], 16);
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum =
    0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
  return lum > 0.28;
}

export function MemberAvatar({ member, size = DEFAULT_SIZE, healthDot }: MemberAvatarProps): React.ReactElement {
  const initials = initialsFor(member);
  const background = member.avatarColor || colors.bgCard;
  const foreground = isLight(background) ? colors.textInverse : colors.text;
  const dot = Math.max(9, Math.round(size * 0.26));

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={member.displayName}
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: background,
        },
      ]}
    >
      <Text
        style={[styles.initials, { color: foreground, fontSize: Math.round(size * 0.4) }]}
        allowFontScaling={false}
        numberOfLines={1}
      >
        {initials}
      </Text>

      {healthDot === undefined ? null : (
        <View
          // Never colour alone (PRD §6.4): the dot is a redundant encoding of the
          // pill text in MemberRow, never the only carrier of the fact.
          style={[
            styles.dot,
            {
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: healthDot ? colors.ok : colors.warn,
              borderWidth: Math.max(1.5, dot * 0.16),
            },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
  initials: {
    fontWeight: weight.bold,
    includeFontPadding: false,
    letterSpacing: 0.4,
  },
  dot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    borderColor: colors.bg,
  },
});

export default MemberAvatar;
