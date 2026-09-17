/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE TAB BAR — five flat, equal-weight destinations.
 * ★ Spec A/B (phase6b-redesign-and-family-watch, 29 Aug) · P-018 · NFR-020
 *
 * The raised centre SOS button from the 21 Aug spec is gone (A1/A3, superseding
 * B1–B5 of phase6-pull-forward): a 66 dp red circle dominating every screen was
 * the single biggest contributor to the "bhari bhari" (visually heavy) complaint
 * that drove this redesign. SOS is not removed from the product — `app/panic.tsx`
 * and everything under it are untouched — it moves to a small outline icon on
 * each screen's own header (6-D-1b) plus the full-width footer button `home.tsx`
 * already carries, which is the PRD §6.4 hard requirement (≥88dp, bottom third)
 * this bar's old FAB was always redundant with, not a replacement for.
 *
 * ★ GLYPH AND LABEL, ALWAYS (P-018). Every destination carries a word under its
 * icon. The active destination turns the brand teal (A2); colour is never the
 * only thing that separates two states.
 *
 * ★ LABELS ARE KEYS, RESOLVED AT RENDER (NFR-020) ★
 * `DESTS` holds i18n KEYS, not strings. The old table called `t()` at module
 * load, which Metro runs while `i18n.current` is still 'en' — so the Hindi and
 * Gujarati tab labels existed in the tables and were unreachable for ever, on
 * the one strip of chrome every member sees on every screen. The bar also
 * subscribes to the store's `locale` so a change on Settings re-renders it.
 *
 * ★ `Destination` LIVES AT MODULE SCOPE ★
 * It used to be declared inside `TabBar`'s body, which made it a NEW component
 * type on every render: React reconciles by type identity, so all five tabs
 * unmounted and remounted on every path change — and a TalkBack user who had
 * just activated a tab had the focused node destroyed under them.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { Feather } from '@expo/vector-icons';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t, type StringKey } from '../i18n';
import { useKavach } from '../state/store';
import { colors, font, leading, MIN_TOUCH_TARGET, radius, space, tracking, weight } from './theme';

type Href = '/home' | '/watch' | '/map' | '/incidents' | '/settings';

type Dest = {
  href: Href;
  icon: keyof typeof Feather.glyphMap;
  labelKey: StringKey;
};

/**
 * `list` for Incidents, not `alert-triangle`: that glyph is the SOS header
 * button (spec A3) and the `warn` chip's mark, and P-018 says SHAPE carries
 * meaning — "start an emergency" and "browse what happened" must not share
 * one glyph with only colour and position to tell them apart.
 */
const DESTS: readonly Dest[] = [
  { href: '/home', icon: 'home', labelKey: 'tab.home' },
  { href: '/watch', icon: 'users', labelKey: 'tab.watch' },
  { href: '/map', icon: 'map-pin', labelKey: 'tab.map' },
  { href: '/incidents', icon: 'list', labelKey: 'tab.incidents' },
  { href: '/settings', icon: 'settings', labelKey: 'tab.settings' },
];

const BAR_HEIGHT = 56;
const ICON_SIZE = 22;

/**
 * Vertical slop only. The five tabs already touch edge to edge and stand
 * MIN_TOUCH_TARGET tall, so a horizontal slop could only extend each one INTO
 * its neighbours — Pill.tsx documents the same hazard: a wide slop lets one
 * control swallow presses aimed at the next, which is worse than a small
 * target because it acts. On this bar the neighbours of Incidents are Watch
 * and Settings.
 */
const TAB_SLOP = { top: space.sm, bottom: space.sm, left: 0, right: 0 };

const Destination = memo(function Destination({
  d,
  on,
  unacked,
}: {
  d: Dest;
  on: boolean;
  /** Only the Incidents tab draws it; passed as a number so memo stays cheap. */
  unacked: number;
}) {
  const tint = on ? colors.accentText : colors.textFaint;
  const label = t(d.labelKey);
  const badge = d.href === '/incidents' && unacked > 0;
  return (
    <Pressable
      style={styles.tab}
      onPress={() => router.navigate(d.href)}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      accessibilityLabel={badge ? `${label}. ${t('tab.unacked', { n: unacked })}` : label}
      hitSlop={TAB_SLOP}
    >
      <View>
        <Feather name={d.icon} size={ICON_SIZE} color={tint} />
        {badge ? (
          <View style={styles.badge}>
            <Text allowFontScaling={false} style={styles.badgeText}>
              {unacked > 99 ? '99+' : unacked}
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={[styles.label, { color: tint, fontWeight: on ? weight.bold : weight.semibold }]}
      >
        {label}
      </Text>
    </Pressable>
  );
});

export function TabBar({ unacked }: { unacked: number }) {
  const insets = useSafeAreaInsets();
  const path = usePathname();
  // Not read — subscribed so a language change on Settings re-renders the
  // labels (i18n keeps the locale in module scope). Same pattern as home/map.
  useKavach((s) => s.locale);

  const active = (href: string) => path === href || (href !== '/home' && path.startsWith(href));

  return (
    <View style={[styles.bar, { height: BAR_HEIGHT + insets.bottom, paddingBottom: insets.bottom }]}>
      {DESTS.map((d) => (
        <Destination key={d.href} d={d} on={active(d.href)} unacked={unacked} />
      ))}
    </View>
  );
}

/** The badge is one `leading.tiny` line box — the smallest size the type scale admits. */
const BADGE_SIZE = leading.tiny;

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.bgElevated,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: space.sm,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: space.xxs,
    minHeight: MIN_TOUCH_TARGET,
  },
  label: { fontSize: font.tiny, letterSpacing: tracking.tiny },
  badge: {
    position: 'absolute',
    top: -space.xs,
    right: -space.md,
    minWidth: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: radius.pill,
    paddingHorizontal: space.xs,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // font.tiny, not 10: 11 px is the floor the scale was built around for
  // over-sixties readers, and a count is information, not decoration.
  badgeText: { color: colors.white, fontSize: font.tiny, lineHeight: leading.tiny, fontWeight: weight.bold },
});
