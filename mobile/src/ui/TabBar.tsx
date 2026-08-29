/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE TAB BAR — five flat, equal-weight destinations.
 * ★ Spec A/B (phase6b-redesign-and-family-watch, 29 Aug) · P-018
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
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '../i18n';
import { colors, font, MIN_TOUCH_TARGET, space, tracking, weight } from './theme';

type Dest = {
  href: '/home' | '/watch' | '/map' | '/incidents' | '/settings';
  icon: keyof typeof Feather.glyphMap;
  label: string;
};

const DESTS: readonly Dest[] = [
  { href: '/home', icon: 'home', label: t('tab.home') },
  { href: '/watch', icon: 'users', label: t('tab.watch') },
  { href: '/map', icon: 'map-pin', label: t('tab.map') },
  { href: '/incidents', icon: 'alert-triangle', label: t('tab.incidents') },
  { href: '/settings', icon: 'settings', label: t('tab.settings') },
];

const BAR_HEIGHT = 56;
const ICON_SIZE = 22;

export function TabBar({ unacked }: { unacked: number }) {
  const insets = useSafeAreaInsets();
  const path = usePathname();

  const active = (href: string) => path === href || (href !== '/home' && path.startsWith(href));

  function Destination({ d }: { d: Dest }) {
    const on = active(d.href);
    const tint = on ? colors.accentText : colors.textFaint;
    const badge = d.href === '/incidents' && unacked > 0;
    return (
      <Pressable
        style={styles.tab}
        onPress={() => router.navigate(d.href)}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        accessibilityLabel={badge ? `${d.label}. ${unacked} ${t('panic.nobodyResponded')}` : d.label}
        hitSlop={8}
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
          {d.label}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={[styles.bar, { height: BAR_HEIGHT + insets.bottom, paddingBottom: insets.bottom }]}>
      {DESTS.map((d) => (
        <Destination key={d.href} d={d} />
      ))}
    </View>
  );
}

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
    gap: 2,
    minHeight: MIN_TOUCH_TARGET,
  },
  label: { fontSize: font.tiny, letterSpacing: tracking.tiny },
  badge: {
    position: 'absolute',
    top: -5,
    right: -11,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.white, fontSize: 10, fontWeight: weight.bold },
});
