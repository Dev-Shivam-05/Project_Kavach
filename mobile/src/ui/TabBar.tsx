/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE TAB BAR — four destinations and the centre SOS button that is not one.
 * ★ Spec B (phase6-pull-forward) · P-018 · PRD §6.4
 *
 * A raised 66 dp SOS button cannot come from the default bottom bar: that bar has
 * a fixed height and clips its children, and the SOS surface has to open as the
 * root-Stack fullScreenModal (app/panic.tsx), never as a tab route that would
 * render inside the navigator and lose the lock. So this is a custom `tabBar`:
 * four labelled destinations, and between the middle two a red circle lifted above
 * the bar that pushes /panic — the identical call every other SOS entry point in
 * the app already makes (home.tsx). Nothing about the panic flow changes here.
 *
 * ★ GLYPH AND LABEL, ALWAYS (P-018). Every destination and the SOS button carries
 * a word under its glyph. The active destination turns the brand teal (A2); the
 * SOS button stays alarm red so it is the one loud control on the surface, and
 * colour is never the only thing that separates two states.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '../i18n';
import {
  colors,
  font,
  MIN_TOUCH_TARGET,
  shadow,
  SOS_FAB_DIAMETER,
  space,
  tracking,
  weight,
} from './theme';

/** The four tab destinations, in bar order. The SOS button is rendered between
 *  the second and third and is deliberately NOT one of these — it is a Stack
 *  modal, not a tab route. */
type Dest = { href: '/home' | '/map' | '/incidents' | '/settings'; glyph: string; label: string };

const DESTS: readonly Dest[] = [
  { href: '/home', glyph: '⌂', label: t('tab.home') },
  { href: '/map', glyph: '◎', label: t('tab.map') },
  { href: '/incidents', glyph: '⚠', label: t('tab.incidents') },
  { href: '/settings', glyph: '⚙', label: t('tab.settings') },
];

const BAR_HEIGHT = 60;

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
          <Text allowFontScaling={false} style={[styles.glyph, { color: tint }]}>
            {d.glyph}
          </Text>
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
      <Destination d={DESTS[0]} />
      <Destination d={DESTS[1]} />

      <View style={styles.fabSlot}>
        <Pressable
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          onPress={() => router.push('/panic')}
          accessibilityRole="button"
          accessibilityLabel={t('tab.sos')}
          accessibilityHint={t('tab.sosHint')}
          hitSlop={10}
        >
          <Text allowFontScaling={false} style={styles.fabGlyph}>
            ◉
          </Text>
        </Pressable>
        <Text allowFontScaling={false} style={styles.fabLabel}>
          {t('tab.sos')}
        </Text>
      </View>

      <Destination d={DESTS[2]} />
      <Destination d={DESTS[3]} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.bgElevated,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    // The FAB is lifted above the top edge; the bar must not clip it.
    overflow: 'visible',
    paddingTop: space.sm,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 2,
    minHeight: MIN_TOUCH_TARGET,
  },
  glyph: { fontSize: 22, textAlign: 'center', includeFontPadding: false },
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
  fabSlot: { flex: 1, alignItems: 'center' },
  fab: {
    width: SOS_FAB_DIAMETER,
    height: SOS_FAB_DIAMETER,
    borderRadius: SOS_FAB_DIAMETER / 2,
    marginTop: -(SOS_FAB_DIAMETER * 0.42),
    backgroundColor: colors.danger,
    borderWidth: 3,
    borderColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.raised,
  },
  fabPressed: { opacity: 0.85 },
  fabGlyph: { fontSize: 26, color: colors.white, fontWeight: weight.heavy },
  fabLabel: {
    marginTop: 2,
    fontSize: font.tiny,
    color: colors.dangerText,
    fontWeight: weight.bold,
    letterSpacing: tracking.caps,
  },
});
