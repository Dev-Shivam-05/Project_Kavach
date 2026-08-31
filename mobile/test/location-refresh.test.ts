/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ON-DEMAND LOCATION REFRESH — the 8s budget (6-D-6 · spec C2)
 *
 * expo-location's getCurrentPositionAsync has no built-in timeout option (Expo
 * SDK 57 docs: "You must implement your own timeout using Promise.race() if
 * needed"). acquireOneShotFix's race IS the 8-second budget C2 promises, so
 * this pins that it actually bounds the wait rather than trusting a native
 * call to behave, and that a fix which does arrive is not thrown away.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error — resolved to a controllable stub by test/shim.mjs
import { __setHang, __setNextError, __setNextFix } from 'expo-location';
import { acquireOneShotFix } from '../src/state/locationRefresh';

const RAW_FIX = {
  coords: { latitude: 19.076, longitude: 72.8777, accuracy: 12.5 },
  timestamp: 1_700_000_000_000,
};

test('a fix that arrives well within budget is returned, shaped for sealJson', async () => {
  __setNextFix(RAW_FIX);
  const fix = await acquireOneShotFix(200);
  assert.deepEqual(fix, { lat: 19.076, lon: 72.8777, accuracyM: 12.5, at: 1_700_000_000_000 });
});

test('a call that never resolves is bounded by the timeout, not left hanging', async () => {
  __setHang();
  const started = Date.now();
  const fix = await acquireOneShotFix(50);
  assert.equal(fix, null);
  assert.ok(Date.now() - started < 1000, 'acquireOneShotFix waited far longer than its own timeout');
});

test('a permission refusal or GPS-off error degrades to null, never a throw', async () => {
  __setNextError(new Error('Location services are disabled'));
  const fix = await acquireOneShotFix(50);
  assert.equal(fix, null);
});

test('a missing accuracy field falls back to the same sentinel triggerRouter uses', async () => {
  __setNextFix({ coords: { latitude: 1, longitude: 2, accuracy: null }, timestamp: 1 });
  const fix = await acquireOneShotFix(50);
  assert.equal(fix?.accuracyM, 9999);
});
