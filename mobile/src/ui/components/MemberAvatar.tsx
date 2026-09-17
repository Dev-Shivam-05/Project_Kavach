/**
 * MemberAvatar — initials on the member's own colour.
 *
 * ★ No photos, ever. ★ `Member` carries no avatar URL and it should not: a family
 * safety app that ships a face image cache is a face image cache that leaks
 * (docs/02 §10.2 keeps Class A data off the wire). `avatarColor` is denormalised
 * onto the member row precisely so the family glance view can render without a
 * network fetch and without a loading state.
 *
 * ★ THE COLOUR IS DERIVED WHEN NOTHING ASSIGNED ONE ★
 * Nothing in the app ever writes `avatarColor` (see crest.ts), so the "own
 * colour" this header promised was `bgCard` for everyone. `avatarBackgroundFor`
 * keeps a stored colour when one exists and otherwise hashes the member id into
 * the crest palette — the same colour on every phone, with nothing to sync.
 *
 * The foreground is chosen by measured contrast rather than fixed to white,
 * because avatarColor may arrive from a server and PRD §6.4 requires ≥7:1 — a
 * fixed white initial on a pale seed colour fails that silently.
 */
import React, { memo } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { Member } from '../../core/types';
import { avatarColorFor, initialsFromName, legibleForegroundOn } from '../crest';
import { colors, tracking, weight } from '../theme';

export interface MemberAvatarProps {
  member: Member;
  size?: number;
  /**
   * Agent health, when the caller knows it. `true` = heartbeat healthy,
   * `false` = the safety agent is not running. Omit to draw no dot at all —
   * "unknown" must not be rendered as "fine" (F-02).
   */
  healthDot?: boolean;
  style?: StyleProp<ViewStyle>;
}

const DEFAULT_SIZE = 44;

/** Up to two initials (grapheme clusters, so Devanagari/Gujarati names keep their vowel signs). */
export function initialsFor(member: Member): string {
  const source = member.displayName.trim() || member.asciiShortName.trim();
  return initialsFromName(source) || '?';
}

/** The stored colour when one exists, else the member's derived one. Shared with the map's pins. */
export function avatarBackgroundFor(member: Member): string {
  return member.avatarColor || avatarColorFor(member.id);
}

function MemberAvatarImpl({ member, size = DEFAULT_SIZE, healthDot, style }: MemberAvatarProps): React.ReactElement {
  const initials = initialsFor(member);
  const background = avatarBackgroundFor(member);
  const foreground = legibleForegroundOn(background);
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
        style,
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
    // Two upper-case letters: `caps` is the one tracking every uppercase
    // label in the product uses (theme.ts).
    letterSpacing: tracking.caps,
  },
  dot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    borderColor: colors.bg,
  },
});

export const MemberAvatar = memo(MemberAvatarImpl);
export default MemberAvatar;
