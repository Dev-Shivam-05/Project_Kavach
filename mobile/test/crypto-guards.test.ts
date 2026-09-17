/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRYPTO GUARDS · three places where the honest answer was missing
 *
 *  1. Shamir (P-010): two shares with the same index used to reconstruct a
 *     plausible 32-byte key that opened nothing — GF(256) division by zero
 *     returned the numerator — with no error for the guardian to act on.
 *  2. The SMS tag (F-09): the phone MACed under the group secret, which the
 *     server must never hold, so `sig8` could never verify. It now MACs under a
 *     purpose-derived key both sides can hold.
 *  3. Which key signs the envelope (P-031, F-17): the keystore key is prepared
 *     and reported, the software key signs. The status must say which is which,
 *     and the public key handed to the server must be the one that signed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateDeviceKeypair,
  randomBytes,
  shamirCombine,
  shamirSplit,
  smsHmacKey,
  smsTag,
  verifyEmergency,
  bytesToBase64,
} from '../src/crypto/index.ts';
import {
  envelopeSigningPublicKey,
  keyBackingStatus,
  prepareKeys,
  setHardwareKeyBackend,
  setSoftwareKeys,
  type HardwareKeyBackend,
  type NativeKeyInfo,
} from '../src/crypto/hardware.ts';
import { encodeSms } from '../src/t0/smsPayload.ts';
import { buildSignedEnvelope } from '../src/t0/envelope.ts';
import { uuidv7, coarseCell } from '../src/core/ids.ts';

// ── 1. Shamir ─────────────────────────────────────────────────────────────────

test('★ t0-18 · shamirCombine refuses a duplicated share instead of returning garbage', () => {
  const secret = randomBytes(32);
  const shares = shamirSplit(secret, 3, 2);
  assert.deepEqual(shamirCombine([shares[0], shares[2]]), secret, 'the valid case still works');
  assert.throws(() => shamirCombine([shares[1], shares[1]]), /appears twice/);
  assert.throws(() => shamirCombine([shares[1], { ...shares[1] }]), /appears twice/);
});

test('shamirCombine refuses an index outside 1..255 and shares of different lengths', () => {
  const shares = shamirSplit(randomBytes(16), 3, 2);
  assert.throws(() => shamirCombine([{ index: 0, data: shares[0].data }, shares[1]]), /outside 1\.\.255/);
  assert.throws(() => shamirCombine([{ index: 256, data: shares[0].data }, shares[1]]), /outside 1\.\.255/);
  assert.throws(() => shamirCombine([{ index: 1.5, data: shares[0].data }, shares[1]]), /outside 1\.\.255/);
  assert.throws(() => shamirCombine([shares[0], { index: 2, data: shares[1].data.slice(0, 8) }]), /differ in length/);
});

// ── 2. The SMS key ────────────────────────────────────────────────────────────

const GROUP = new Uint8Array(32).fill(9);

test('★ security-16 · the SMS tag is computed under the derived key, not the group secret', () => {
  const key = smsHmacKey(GROUP);
  assert.equal(key.length, 32);
  assert.notDeepEqual(key, GROUP, 'holding the SMS key must reveal nothing about the group secret');
  assert.deepEqual(smsHmacKey(GROUP), key, 'deterministic, so every joiner derives the same one');
  assert.notDeepEqual(smsHmacKey(new Uint8Array(32).fill(10)), key);

  const out = encodeSms({
    incidentId: uuidv7(),
    asciiShortName: 'PRIYA',
    trigger: 'MANUAL',
    lat: 20.945123,
    lon: 72.932011,
    accuracyM: 12,
    batteryPct: 43,
    atMs: 1_700_000_000_000,
    groupSecret: GROUP,
  });
  const machine = out.text.split(' ')[0];
  const parts = machine.split('|');
  const sig = parts[8];
  const body = parts.slice(0, 8).join('|');
  assert.equal(sig, smsTag(key, body), 'the server verifies with family.sms_hmac_key = this derived key');
  assert.notEqual(sig, smsTag(GROUP, body), 'and never with the secret it must not have');
});

// ── 3. Which key signs ────────────────────────────────────────────────────────

function nativeInfo(alias: string): NativeKeyInfo {
  return {
    alias,
    present: true,
    strongBox: false,
    tee: true,
    userAuthRequired: false,
    unlockedDeviceRequired: false,
    unlockedDeviceRequiredMeasured: true,
    securityLevel: 'tee',
    createdAt: 1,
  };
}

const vault: HardwareKeyBackend = {
  ensure: async (alias) => nativeInfo(alias),
  info: async (alias) => nativeInfo(alias),
  sign: async (_alias, payload) => payload,
  publicKey: async () => bytesToBase64(new Uint8Array(91).fill(3)),
};

const envBase = {
  familyId: uuidv7(),
  deviceId: uuidv7(),
  memberId: uuidv7(),
  trigger: 'MANUAL' as const,
  confidencePct: 100,
  riskContext: 0 as const,
  duress: false,
  isDrill: false,
  policyVersion: 1,
  coarseCell: coarseCell(20.94, 72.93),
  batteryPct: 50,
  sealedPayload: '',
};

test('★ t0-5 · with a TEE key prepared, the status admits the software key still signs the envelope', async () => {
  const kp = generateDeviceKeypair();
  setHardwareKeyBackend(vault);
  setSoftwareKeys(kp);
  await prepareKeys();

  const emergency = keyBackingStatus().find((s) => s.role === 'emergency');
  assert.ok(emergency);
  assert.equal(emergency.backing, 'tee', 'where the key LIVES is reported as before');
  assert.equal(emergency.signsEnvelope, false, 'but it does not sign anything yet');
  assert.match(emergency.reason, /NOT yet used to sign the SOS envelope/);
  const identity = keyBackingStatus().find((s) => s.role === 'identity');
  assert.equal(identity?.signsEnvelope, false, 'the identity key never signs an SOS');

  // The key the server must verify envelopes with is the one that produced the signature.
  const ref = envelopeSigningPublicKey();
  assert.ok(ref);
  assert.equal(ref.alg, 'ed25519');
  assert.equal(ref.backing, 'js_heap');
  const e = buildSignedEnvelope({ ...envBase, incidentId: uuidv7() }, kp);
  const sig = Uint8Array.from(atob(e.signature), (c) => c.charCodeAt(0));
  assert.equal(verifyEmergency(sig, new TextEncoder().encode(e.body), ref.key), true);
});

test('with no vault the software key is reported as the signer, and with no keys there is none', async () => {
  const kp = generateDeviceKeypair();
  setHardwareKeyBackend(null);
  setSoftwareKeys(kp);
  await prepareKeys();
  const emergency = keyBackingStatus().find((s) => s.role === 'emergency');
  assert.equal(emergency?.backing, 'js_heap');
  assert.equal(emergency?.signsEnvelope, true);
  assert.deepEqual(Array.from(envelopeSigningPublicKey()?.key ?? []), Array.from(kp.emergencyPublic));

  setSoftwareKeys(null);
  assert.equal(envelopeSigningPublicKey(), null);
});
