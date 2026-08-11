/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * PUSH TOKEN ACQUISITION — W10 · 1.35
 *
 * These assertions are about ONE decision: what counts as a usable FCM
 * registration token, and what is treated as "this phone has no push address".
 *
 * It looks like a triviality and is not. Every failure mode here is silent by
 * construction — a token that is undefined, empty, or from the wrong platform
 * produces no error, no log and no symptom, right up until the night the family
 * needs the phone to ring and it does not. The only way that failure becomes
 * visible is if this function reports null honestly, so the server records
 * KV-NOTOKEN and the delivery matrix says "unreachable by push" out loud.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
// @ts-expect-error — resolved to a controllable stub by test/shim.mjs. The
// directive must sit on the line the specifiers are on: tsc reports an unknown
// export per specifier, so a trailing comment inside the braces suppresses
// nothing and silently leaves this file failing `tsc --noEmit`.
import { __emitPushToken, __listenerCount, __setDevicePushToken } from 'expo-notifications';
import { acquireDevicePushToken, subscribePushTokenChanges } from '../src/state/notifications';

afterEach(() => {
  __setDevicePushToken(null);
});

test('a native android token is returned verbatim', async () => {
  __setDevicePushToken({ type: 'android', data: 'fcm-token-abc123' });
  assert.equal(await acquireDevicePushToken(), 'fcm-token-abc123');
});

test('an empty token string is null, not an empty address', async () => {
  // FCM has been observed handing back an empty string rather than failing.
  // Registering it would give the server an address it will happily "deliver"
  // to forever.
  __setDevicePushToken({ type: 'android', data: '' });
  assert.equal(await acquireDevicePushToken(), null);
});

test('a token of the wrong shape is null', async () => {
  for (const bad of [
    null,
    undefined,
    { type: 'ios', data: 'apns-token' },
    { type: 'android' },
    { type: 'android', data: 42 },
    {},
  ]) {
    __setDevicePushToken(bad);
    assert.equal(await acquireDevicePushToken(), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a throwing native module is null, never an exception into boot', async () => {
  // The real case: a build with no google-services.json, or Expo Go. Bootstrap
  // calls this fire-and-forget; a throw here must not reach it.
  __setDevicePushToken(new Error('Default FirebaseApp is not initialized'));
  assert.equal(await acquireDevicePushToken(), null);
});

test('a rolled token reaches the subscriber, and unsubscribing really detaches', () => {
  const seen: string[] = [];
  const unsubscribe = subscribePushTokenChanges((tok) => seen.push(tok));

  __emitPushToken({ type: 'android', data: 'fcm-rolled-1' });
  assert.deepEqual(seen, ['fcm-rolled-1']);

  // Junk from the platform must not be forwarded as an address.
  __emitPushToken({ type: 'android', data: '' });
  __emitPushToken({ type: 'ios', data: 'apns' });
  assert.deepEqual(seen, ['fcm-rolled-1']);

  unsubscribe();
  assert.equal(__listenerCount(), 0, 'the listener survived unsubscribe');
  __emitPushToken({ type: 'android', data: 'fcm-rolled-2' });
  assert.deepEqual(seen, ['fcm-rolled-1']);
});
