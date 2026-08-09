/**
 * MemberRow — one line of the family glance view.
 *
 * ★ P-066 — "MONITORING PAUSED" IS NOT AN ALARM ★
 * An adult turning their own monitoring off is exercising a right, not failing a
 * check. The row must make it VISIBLE (otherwise a paused agent is
 * indistinguishable from a dead one, and the family learns the wrong lesson from
 * silence — F-02) and must make it NEUTRAL (a red badge turns a legitimate choice
 * into a social punishment, and the product becomes the stalkerware it exists to
 * replace). Hence a grey pill, above every other status, with no warning colour.
 *
 * ★ Absent presence is rendered as "no data", never as "okay". ★ The whole point
 * of the consent architecture is that the absence of a signal is honest.
 *
 * ★ `right` TAKES A NODE, AND THAT COSTS THE CALLER THE memo() ★
 * This row is memoised like every other primitive here, but a caller that builds
 * a fresh element for `right` on each render defeats it completely: the element
 * is a new object every time, the shallow compare always fails, and the whole
 * family — rows plus avatars — re-renders on every store write and every
 * minute-tick of the home screen's clock. If you are adding a trailing control,
 * prefer passing the data and a `useCallback`-stable handler over passing a
 * freshly rendered node.
 */
import { memo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { DegradationLevel, DEGRADATION_LABELS, type Member, type MemberPresence } from '../../core/types';
import { relativeTime, t } from '../../i18n';
import {
  colors,
  font,
  leading,
  MIN_TOUCH_TARGET,
  radius,
  space,
  toneSurface,
  tracking,
  weight,
} from '../theme';
import { MemberAvatar } from './MemberAvatar';
import { PressableScale } from './PressableScale';

export interface MemberRowProps {
  member: Member;
  presence?: MemberPresence;
  onPress?: (memberId: string) => void;
  /** Trailing slot — a sparkline, a "find phone" button, a chevron. */
  right?: ReactNode;
}

type Tone = 'neutral' | 'ok' | 'warn' | 'info';

interface Status {
  tone: Tone;
  label: string;
}

/**
 * ★ THIS IS TEXT, SO IT COMES FROM toneSurface(), NOT FROM A HAND-PICKED PAIR ★
 * These carried the FILL colours — 2.46 / 2.68 / 1.97:1 — at font.tiny. This is
 * the line that tells a family whether somebody's agent is alive (F-02) and
 * whether they chose to pause it (P-066), set at 11 px in a colour you cannot
 * read. The neutral row was already correct, which is how you can tell the rest
 * was an oversight and not a decision.
 * theme-contrast.test.ts already asserts every pair `toneSurface` returns clears
 * 7:1, so taking the pair from there is what stops this happening again.
 */
const TONES: Record<Tone, { bg: string; fg: string }> = {
  // Not toneSurface('neutral'): its `bgCard` is the colour of the row itself, so
  // the pill would disappear. bgInput with textDim is 7.92:1 and still a shape.
  neutral: { bg: colors.bgInput, fg: colors.textDim },
  ok: toneSurface('ok'),
  warn: toneSurface('warn'),
  info: toneSurface('info'),
};

/** The single most important ordering decision in this file — see the header. */
function statusFor(presence: MemberPresence | undefined): Status {
  if (!presence) return { tone: 'neutral', label: 'No data' };
  if (presence.monitoringPaused) return { tone: 'neutral', label: 'Monitoring paused' };
  if (!presence.agentHealthy) return { tone: 'warn', label: 'Agent offline' };
  if (presence.degradationLevel < DegradationLevel.FULL) {
    return {
      tone: presence.degradationLevel <= DegradationLevel.SMS_ONLY ? 'warn' : 'info',
      label: DEGRADATION_LABELS[presence.degradationLevel],
    };
  }
  return { tone: 'ok', label: t('state.IDLE') };
}

/** Same rule as TONES: this colours a string, so it never returns a fill token. */
function batteryTone(pct: number | null): string {
  if (pct === null) return colors.textFaint;
  if (pct <= 15) return colors.dangerText;
  if (pct <= 35) return colors.warnText;
  return colors.textDim;
}

function MemberRowImpl({ member, presence, onPress, right }: MemberRowProps) {
  const status = statusFor(presence);
  const tone = TONES[status.tone];
  const ago = relativeTime(presence ? presence.lastSeenAt : null);
  const battery = presence ? presence.batteryPct : null;

  const seenLine = t('home.lastSeen', { ago });
  const batteryLine = battery === null ? null : t('home.battery', { pct: Math.round(battery) });

  // The screen reader gets the row as one sentence; six separate focus stops for
  // one person is unusable when you are scanning a family in a hurry.
  const spoken = [
    member.displayName,
    status.label,
    seenLine,
    batteryLine ?? '',
  ]
    .filter(Boolean)
    .join(', ');

  const body = (
    <View style={styles.row}>
      <MemberAvatar member={member} healthDot={presence ? presence.agentHealthy : undefined} />

      <View style={styles.middle}>
        <Text style={styles.name} numberOfLines={1}>
          {member.displayName}
        </Text>

        <View style={styles.metaLine}>
          <Text style={styles.meta} numberOfLines={1}>
            {seenLine}
          </Text>
          {batteryLine === null ? null : (
            <>
              <Text style={styles.dot}>·</Text>
              <Text style={[styles.meta, { color: batteryTone(battery) }]} numberOfLines={1}>
                {batteryLine}
              </Text>
            </>
          )}
          {presence && presence.room ? (
            <>
              <Text style={styles.dot}>·</Text>
              <Text style={styles.meta} numberOfLines={1}>
                {presence.room}
              </Text>
            </>
          ) : null}
        </View>

        <View style={[styles.pill, { backgroundColor: tone.bg }]}>
          <Text style={[styles.pillText, { color: tone.fg }]} numberOfLines={1}>
            {status.label}
          </Text>
        </View>
      </View>

      {right === undefined ? null : <View style={styles.right}>{right}</View>}
    </View>
  );

  if (!onPress) {
    return (
      <View accessible accessibilityRole="text" accessibilityLabel={spoken} style={styles.container}>
        {body}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={() => onPress(member.id)}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint="Opens this person's details"
      // The same ring ListItem uses, for the same reason: the row is dense with
      // textDim meta, and an outline is the one press signal that changes no
      // pixel behind a glyph. `info` rather than the row's own status tone —
      // "am I touching this?" and "is this person alright?" must not share a
      // channel and answer neither.
      highlightColor={colors.info}
      highlightRadius={radius.md}
      style={styles.container}
    >
      {body}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: MIN_TOUCH_TARGET + space.lg,
    justifyContent: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  middle: {
    flex: 1,
    marginLeft: space.md,
  },
  name: {
    color: colors.text,
    fontSize: font.h3,
    lineHeight: leading.h3,
    fontWeight: weight.semibold,
  },
  metaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.xxs,
    flexWrap: 'wrap',
  },
  meta: {
    color: colors.textDim,
    fontSize: font.small,
    lineHeight: leading.small,
  },
  dot: {
    color: colors.textFaint,
    fontSize: font.small,
    lineHeight: leading.small,
    marginHorizontal: space.xs,
  },
  pill: {
    alignSelf: 'flex-start',
    marginTop: space.sm,
    paddingVertical: space.xxs + 1,
    paddingHorizontal: space.sm,
    borderRadius: radius.pill,
  },
  pillText: {
    fontSize: font.tiny,
    lineHeight: leading.tiny,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tiny,
  },
  right: {
    marginLeft: space.md,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
});

export const MemberRow = memo(MemberRowImpl);
export default MemberRow;
