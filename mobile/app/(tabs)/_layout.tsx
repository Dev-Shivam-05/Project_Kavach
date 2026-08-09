/**
 * The five tabs.
 *
 * ★ GLYPH *AND* LABEL, ALWAYS ★
 * P-018 / PRD §6.4. This app is used by a grandparent who has never seen a
 * hamburger menu and by someone whose vision has narrowed to the middle of the
 * screen. A bare icon is a puzzle in both cases, and colour is never allowed to
 * be the only difference between two states — so the active tab changes its
 * label colour AND keeps its word.
 *
 * The glyphs are plain BMP characters for the same reason the rest of the
 * component library uses them: an emoji font is not guaranteed on a ₹6,000
 * Android, and a tab bar of empty boxes is a dead navigation surface.
 */
import { StyleSheet, Text, type ColorValue } from 'react-native';
// SDK 57 deprecated the `Tabs` re-export on the package root in favour of this
// subpath; taking the new one now keeps the tab bar off a removal schedule.
import { Tabs } from 'expo-router/js-tabs';

import { t } from '../../src/i18n';
import { countUnacked, useKavach } from '../../src/state/store';
import { colors, font, weight } from '../../src/ui/theme';

/** Reinforcement only — the label underneath carries the meaning. */
const GLYPH = {
  home: '⌂',
  map: '◎',
  incidents: '⚠',
  consent: '⊘',
  settings: '⚙',
} as const;

function glyph(name: keyof typeof GLYPH) {
  return ({ color, size }: { color: ColorValue; size: number }) => (
    <Text
      style={[styles.glyph, { color, fontSize: Math.max(18, size - 4) }]}
      // A tab glyph that grows with the system font size overflows the bar and
      // pushes the label out; the label is the accessible affordance, not this.
      allowFontScaling={false}
    >
      {GLYPH[name]}
    </Text>
  );
}

export default function TabsLayout() {
  /**
   * ★ PRD §12.1 — the badge counts incidents that are LIVE and that NOBODY has
   *   acknowledged. Not "unread": an incident five people have seen and one has
   *   claimed is being handled, and badging it teaches the family to ignore the
   *   badge that matters. `countUnacked` subscribes on a number rather than a
   *   freshly filtered array, so a store write cannot re-render the whole tab bar.
   */
  const unacked = useKavach((s) => countUnacked(s));

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.bg },
        tabBarStyle: styles.bar,
        tabBarLabelStyle: styles.label,
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarBadgeStyle: styles.badge,
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: t('tab.home'),
          tabBarLabel: t('tab.home'),
          tabBarIcon: glyph('home'),
          tabBarAccessibilityLabel: t('tab.home'),
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          title: t('tab.map'),
          tabBarLabel: t('tab.map'),
          tabBarIcon: glyph('map'),
          tabBarAccessibilityLabel: t('tab.map'),
        }}
      />
      <Tabs.Screen
        name="incidents"
        options={{
          title: t('tab.incidents'),
          tabBarLabel: t('tab.incidents'),
          tabBarIcon: glyph('incidents'),
          tabBarBadge: unacked > 0 ? unacked : undefined,
          // The count must reach a screen reader too, not just the eye.
          tabBarAccessibilityLabel:
            unacked > 0 ? `${t('tab.incidents')}. ${t('panic.nobodyResponded')}` : t('tab.incidents'),
        }}
      />
      <Tabs.Screen
        name="consent"
        options={{
          title: t('tab.consent'),
          tabBarLabel: t('tab.consent'),
          tabBarIcon: glyph('consent'),
          tabBarAccessibilityLabel: t('tab.consent'),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tab.settings'),
          tabBarLabel: t('tab.settings'),
          tabBarIcon: glyph('settings'),
          tabBarAccessibilityLabel: t('tab.settings'),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.bgElevated,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  label: { fontSize: font.tiny, fontWeight: weight.semibold },
  glyph: { textAlign: 'center', includeFontPadding: false },
  badge: {
    backgroundColor: colors.danger,
    color: colors.white,
    fontSize: font.tiny,
    fontWeight: weight.bold,
  },
});
