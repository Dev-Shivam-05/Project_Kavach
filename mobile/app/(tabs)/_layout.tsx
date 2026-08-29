/**
 * ★ FIVE FLAT TABS — Spec A (phase6b-redesign-and-family-watch, 29 Aug)
 *
 * The visible bar is `src/ui/TabBar` — a custom `tabBar` so it can draw its own
 * icons and the unacked-incidents badge. No tab is raised or otherwise weighted
 * above the others; the SOS button that used to sit here is gone (see TabBar's
 * own header for where it went).
 *
 * Consent is reached from Settings › Privacy (Spec B1/6.7, 21 Aug) — it is a
 * root-Stack route (app/consent.tsx), registered in app/_layout.tsx.
 */
import { Tabs } from 'expo-router/js-tabs';

import { t } from '../../src/i18n';
import { countUnacked, useKavach } from '../../src/state/store';
import { colors } from '../../src/ui/theme';
import { TabBar } from '../../src/ui/TabBar';

export default function TabsLayout() {
  /**
   * ★ PRD §12.1 — the badge counts incidents that are LIVE and that NOBODY has
   *   acknowledged. `countUnacked` subscribes on a number rather than a freshly
   *   filtered array, so a store write cannot re-render the whole bar. The count
   *   is handed to the custom TabBar, which draws the badge on the Incidents tab.
   */
  const unacked = useKavach((s) => countUnacked(s));

  return (
    <Tabs
      tabBar={() => <TabBar unacked={unacked} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="home" options={{ title: t('tab.home') }} />
      <Tabs.Screen name="watch" options={{ title: t('tab.watch') }} />
      <Tabs.Screen name="map" options={{ title: t('tab.map') }} />
      <Tabs.Screen name="incidents" options={{ title: t('tab.incidents') }} />
      <Tabs.Screen name="settings" options={{ title: t('tab.settings') }} />
    </Tabs>
  );
}
