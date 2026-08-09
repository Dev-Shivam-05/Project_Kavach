/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ONBOARDING · ROUTE SHELL
 *
 * One route, six steps held in local state — deliberately NOT six routes.
 *
 * ★ WHY ★ Onboarding is a single transaction: PINs, the medical card and the
 * test SOS only mean anything together. Separate routes hand the user a back
 * gesture and a deep link into the middle of that transaction, which is how a
 * family ends up with a duress PIN set and a cancel PIN that was never written
 * (PRD Appendix E.4 treats the checklist as one unit, not as five screens).
 *
 * `gestureEnabled: false` is the same rule enforced by the navigator: the only
 * way backwards is the Back control the step itself renders, which knows what it
 * has to undo.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { Stack } from 'expo-router';

import { colors } from '../../src/ui/theme';

export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        // Without this the navigator flashes its own white background between
        // frames, which on a dark-only product reads as a crash (hard rule 3).
        contentStyle: { backgroundColor: colors.bg },
      }}
    />
  );
}
