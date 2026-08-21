/**
 * ★ FOUR TABS AND A CENTRE SOS BUTTON — Spec B (phase6-pull-forward) · P-018 · §6.4
 *
 * The visible bar is `src/ui/TabBar` — a custom `tabBar`, because a raised 66 dp
 * SOS button cannot come from the default bar (it clips its children) and the SOS
 * surface must open as the root-Stack fullScreenModal, never as a tab route. This
 * file now only declares the four destinations and hands the navigator that bar.
 *
 * Consent moved OUT of the tab bar (Spec B1 / 6.7): five tabs plus a centre button
 * is a crowded thumb target, and Consent is reached from Settings › Privacy now.
 * It is a root-Stack route (app/consent.tsx), registered in app/_layout.tsx.
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
      <Tabs.Screen name="map" options={{ title: t('tab.map') }} />
      <Tabs.Screen name="incidents" options={{ title: t('tab.incidents') }} />
      <Tabs.Screen name="settings" options={{ title: t('tab.settings') }} />
    </Tabs>
  );
}
