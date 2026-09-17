/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * NOTIFICATION PERMISSION — THE HONEST-FAILURE BRANCHES · ★ P-031 (`notificationsEnabled`)
 *
 * `initNotifications()` returns whether this phone may post notifications, and
 * the diagnostics report prints that answer, because a safety app that cannot
 * notify must say so out loud instead of assuming. The "yes" branch was covered
 * by every other test in this suite for free — the expo-notifications stub
 * always granted. The branches that decide whether a family phone rings when
 * the OS has said no were unreachable:
 *
 *   · denied but askable       → the prompt is shown; ITS answer is the verdict
 *   · denied, cannot ask again → false, and no prompt (asking would throw or no-op)
 *   · iOS provisional          → counts as granted, no prompt
 *   · the permission API throws → false, never an exception into bootstrap
 *
 * A regression that reports notifications as enabled when they are denied is
 * silent everywhere else: no error, no log, a diagnostics screen that ticks a
 * box it cannot prove. This file is the only place it becomes visible.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
// @ts-expect-error — resolved to a controllable stub by test/shim.mjs. The
// directive must sit on the line the specifiers are on (see push-token.test.ts).
import { __requestCount, __resetPermissions, __setPermissions, __setRequestResult } from 'expo-notifications';
import { initNotifications } from '../src/state/notifications';

afterEach(() => {
  __resetPermissions();
});

test('already granted → true, and the prompt is not shown', async () => {
  __setPermissions({ granted: true, canAskAgain: true });
  assert.equal(await initNotifications(), true);
  assert.equal(__requestCount(), 0, 'a granted permission must not re-prompt');
});

test('denied but askable → the prompt is shown, and a refusal there is the verdict', async () => {
  __setPermissions({ granted: false, canAskAgain: true });
  __setRequestResult({ granted: false });
  assert.equal(await initNotifications(), false);
  assert.equal(__requestCount(), 1, 'the user must actually be asked');
});

test('denied but askable → the prompt is shown, and consent there is the verdict', async () => {
  __setPermissions({ granted: false, canAskAgain: true });
  __setRequestResult({ granted: true });
  assert.equal(await initNotifications(), true);
  assert.equal(__requestCount(), 1);
});

test('denied and cannot ask again → false, without prompting', async () => {
  // Android after two refusals, or a device-policy block: requesting again is a
  // no-op at best. The honest answer is "no", said immediately.
  __setPermissions({ granted: false, canAskAgain: false });
  __setRequestResult({ granted: true }); // must never be consulted
  assert.equal(await initNotifications(), false);
  assert.equal(__requestCount(), 0, 'must not prompt when the OS says it cannot ask');
});

test('iOS provisional authorisation (status 2) counts as granted, no prompt', async () => {
  __setPermissions({ granted: false, canAskAgain: true, ios: { status: 2 } });
  assert.equal(await initNotifications(), true);
  assert.equal(__requestCount(), 0);
});

test('a throwing permission API is false, never an exception into boot', async () => {
  // Expo Go, or a notifications module that is absent from the build. Bootstrap
  // calls this in the safe() wrapper, but the function's own contract is to
  // answer, not to throw.
  __setPermissions({ granted: false, canAskAgain: true });
  __setRequestResult(new Error('notifications unavailable'));
  assert.equal(await initNotifications(), false);
});
