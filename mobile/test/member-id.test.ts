/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * memberIdForDevice — the agreement two paired phones never have to reach
 * (6-D-7c · D-033)
 *
 * The SAS pairing envelope carries a device id and no member id, and there is no
 * room in its binary layout for one. So both phones DERIVE the member id from
 * the device id instead: the guardian to register the joiner, the joiner to
 * recognise its own id in an inbound `watch.signal`. If these two ever disagree,
 * the failure is silent — every invite addressed to the joiner is dropped by
 * `handleWatchSignal`'s `toMemberId !== ctx.meId` guard and the Camera button
 * simply does nothing, with no error anywhere. That is why determinism is
 * pinned here rather than assumed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memberIdForDevice, uuidv7 } from '../src/core/ids';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('the same device id always yields the same member id', () => {
  const device = uuidv7();
  assert.equal(memberIdForDevice(device), memberIdForDevice(device));
});

test('it is a well-formed UUID, version 5, RFC 4122 variant', () => {
  const id = memberIdForDevice('018f2b1c-0000-7000-8000-000000000001');
  assert.match(id, UUID_RE);
  assert.equal(id[14], '5', 'version nibble must say name-based');
  assert.ok('89ab'.includes(id[19]), `variant nibble ${id[19]} is not RFC 4122`);
});

test('different devices get different members', () => {
  const ids = new Set(
    ['dev-a', 'dev-b', 'dev-c', 'dev-d'].map((d) => memberIdForDevice(d)),
  );
  assert.equal(ids.size, 4);
});

test('it does not simply echo the device id back', () => {
  // A derivation that returned its input would still be "deterministic" and
  // would still pass every test above, while quietly making the member id a
  // second name for the device id.
  const device = '018f2b1c-0000-7000-8000-000000000001';
  assert.notEqual(memberIdForDevice(device), device);
});

test('a one-character change in the device id changes the member id', () => {
  const a = memberIdForDevice('018f2b1c-0000-7000-8000-000000000001');
  const b = memberIdForDevice('018f2b1c-0000-7000-8000-000000000002');
  assert.notEqual(a, b);
});

test('the value is FROZEN, not merely deterministic within one run', () => {
  // ★ This literal is the actual contract. Determinism inside a single process
  // is not enough: the two phones that must agree may be on different app
  // versions, and changing the label or the hash would silently give them
  // different ids for the same device. The symptom is a Camera button that
  // does nothing — `handleWatchSignal` drops every invite whose `toMemberId`
  // is not this device's — with every other test in this file still green.
  // If you are here because this failed: you changed the derivation, and every
  // already-paired family will stop seeing each other. That needs a migration,
  // not a new expectation.
  assert.equal(memberIdForDevice('kavach-fixture-device'), 'eb356255-eccf-576e-969b-0ed6cdfddb77');
});
