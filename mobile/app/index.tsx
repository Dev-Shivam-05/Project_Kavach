/**
 * The entry route. It decides ONE thing and then gets out of the way.
 *
 * ★ THE BUG THIS FILE USED TO HAVE ★
 * It decided on the FIRST FRAME, from `ready === false` and `me === null` — the
 * state every launch begins in, because bootstrap() is async. So it redirected to
 * onboarding before the database had been opened, and nothing ever navigated back
 * out. A fully enrolled device was walked through all six steps, PIN creation and
 * the medical card on EVERY LAUNCH.
 *
 * The fix is to wait for the one signal that means "the answer is knowable":
 * `ready`. Bootstrap is entirely local — open SQLite, read the keystore, load
 * rows — so this is a few hundred milliseconds with no network in it.
 *
 * ★ WHY RENDERING NOTHING HERE IS NOT A "LOADING STATE" ★
 * PRD §11.1 forbids loading states because it forbids waiting on the NETWORK.
 * There is no spinner below, no progress text and no way for this to persist:
 * it is the app's own background colour for the duration of a local disk read,
 * and the splash screen is still up over the top of it anyway. What §11.1
 * actually prohibits — a screen that can sit there because a server is slow —
 * cannot happen here.
 *
 * ★ AND WHY IT GATES ON A PERSISTED FLAG, NOT ON INFERENCE ★
 * "Has this person been onboarded" is a fact about the past. Re-deriving it from
 * whether a member row happens to exist means any future change to seeding,
 * migrations or demo mode silently resurrects the loop. The flag is written by
 * completeOnboarding() and read back in bootstrap().
 */
import { View } from 'react-native';
import { Redirect } from 'expo-router';

import { useKavach } from '../src/state/store';
import { colors } from '../src/ui/theme';

export default function Index() {
  const ready = useKavach((s) => s.ready);
  const onboarded = useKavach((s) => s.onboarded);

  // Not yet knowable. Hold for the local read — never decide from a default.
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;

  if (!onboarded) return <Redirect href="/onboarding" />;
  return <Redirect href="/(tabs)/home" />;
}
