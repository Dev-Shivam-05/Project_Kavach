/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE FALLBACK PATH OF THE KEY FACADE (F-17, P-031, ADR-018)
 *
 * `crypto/hardware.ts` decides which key signs an SOS. On the phones this
 * product ships to, the interesting branch is not the happy one — it is every
 * way the keystore can decline, because each of those has to end with a
 * signature anyway and with `keyBackingStatus()` admitting what happened.
 *
 * The native module is absent here by construction: the facade takes its native
 * leg by injection, so these tests drive it with a stub and never load React
 * Native. The Kotlin is not under test — it cannot be, from Node — which is
 * exactly why the JS side must fail safely against every shape it may return.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEY_ALIAS,
  setHardwareKeyBackend,
  setSoftwareKeys,
  prepareKeys,
  keyBackingStatus,
  signWithEmergencyKey,
  emergencySigningPublicKey,
  type HardwareKeyBackend,
  type KeyStatus,
  type NativeKeyInfo,
} from '../src/crypto/hardware.ts';
import {
  generateDeviceKeypair,
  verifyEmergency,
  bytesToBase64,
  base64ToBytes,
} from '../src/crypto/index.ts';

function nativeInfo(alias: string, over: Partial<NativeKeyInfo> = {}): NativeKeyInfo {
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
    ...over,
  };
}

/** A stub vault. `sign` echoes its argument so the encoding is observable. */
function stubBackend(over: Partial<HardwareKeyBackend> = {}): HardwareKeyBackend {
  return {
    ensure: async (alias) => nativeInfo(alias),
    info: async (alias) => nativeInfo(alias),
    sign: async (_alias, payloadBase64) => payloadBase64,
    publicKey: async () => bytesToBase64(new Uint8Array(64).fill(3)),
    ...over,
  };
}

function emergency(): KeyStatus {
  const s = keyBackingStatus().find((k) => k.role === 'emergency');
  assert.ok(s, 'keyBackingStatus must always report the emergency key');
  return s;
}

/** Every test starts from a known wiring; the module holds process state. */
async function withVault(
  backend: HardwareKeyBackend | null,
  keys: ReturnType<typeof generateDeviceKeypair> | null,
): Promise<void> {
  setHardwareKeyBackend(backend);
  setSoftwareKeys(keys);
  await prepareKeys();
}

// ═══════════════════════════════════════════════════════════════════════════════
// No native module at all — Expo Go, iOS, and every test runner
// ═══════════════════════════════════════════════════════════════════════════════

test('with no native vault the emergency signature is the software Ed25519 key', async () => {
  const kp = generateDeviceKeypair();
  await withVault(null, kp);

  const s = emergency();
  assert.equal(s.backing, 'js_heap');
  assert.equal(s.alg, 'ed25519');
  assert.equal(s.alias, null);

  const payload = new TextEncoder().encode('incident open');
  const signed = await signWithEmergencyKey(payload);
  assert.ok(signed, 'a software key must still produce a signature');
  assert.equal(signed.alg, 'ed25519');
  assert.equal(signed.backing, 'js_heap');
  assert.ok(
    verifyEmergency(signed.signature, payload, kp.emergencyPublic),
    'the fallback signature must verify under the software emergency public key',
  );
});

test('a software key is never described as hardware, and says where it lives', async () => {
  await withVault(null, generateDeviceKeypair());
  for (const s of keyBackingStatus()) {
    assert.notEqual(s.backing, 'strongbox');
    assert.notEqual(s.backing, 'tee');
    assert.match(
      s.reason,
      /JS heap/,
      'the fallback reason must name the JS heap — an unexplained "software" tells nobody what the risk is',
    );
  }
});

test('both keys are reported, always, so nothing can quietly go unmeasured', async () => {
  await withVault(null, generateDeviceKeypair());
  const roles = keyBackingStatus().map((s) => s.role).sort();
  assert.deepEqual(roles, ['emergency', 'identity']);
});

// ═══════════════════════════════════════════════════════════════════════════════
// A native module that answers — and never gets to over-claim
// ═══════════════════════════════════════════════════════════════════════════════

test('a StrongBox report is carried through as StrongBox', async () => {
  await withVault(
    stubBackend({
      ensure: async (alias) =>
        nativeInfo(alias, { strongBox: true, tee: false, securityLevel: 'strongbox' }),
    }),
    generateDeviceKeypair(),
  );
  const s = emergency();
  assert.equal(s.backing, 'strongbox');
  assert.equal(s.alg, 'ecdsa-p256');
  assert.equal(s.alias, KEY_ALIAS.emergency);
});

test('a TEE key is reported as TEE and not promoted to StrongBox', async () => {
  await withVault(stubBackend(), generateDeviceKeypair());
  const s = emergency();
  assert.equal(s.backing, 'tee');
  assert.match(s.reason, /no StrongBox on this device/);
});

test('a keystore-software key is distinguished from a JS-heap key', async () => {
  // Both are "software" in casual speech and they are not the same risk: one
  // private key is outside this process and the other is inside it.
  await withVault(
    stubBackend({
      ensure: async (alias) => nativeInfo(alias, { tee: false, securityLevel: 'software' }),
    }),
    generateDeviceKeypair(),
  );
  assert.equal(emergency().backing, 'keystore_software');
});

test('the payload crosses the bridge as base64 and returns as bytes', async () => {
  await withVault(stubBackend(), generateDeviceKeypair());
  const payload = new Uint8Array([0, 1, 250, 255, 128, 64]);
  const signed = await signWithEmergencyKey(payload);
  assert.ok(signed);
  assert.equal(signed.alg, 'ecdsa-p256');
  assert.deepEqual(
    Array.from(signed.signature),
    Array.from(payload),
    'the echo stub proves the round trip: encode → native → decode, byte-exact',
  );
});

test('the hardware public key is returned with the algorithm that verifies it', async () => {
  const raw = new Uint8Array(91).fill(9);
  await withVault(
    stubBackend({ publicKey: async () => bytesToBase64(raw) }),
    generateDeviceKeypair(),
  );
  const pub = await emergencySigningPublicKey();
  assert.ok(pub);
  assert.equal(pub.alg, 'ecdsa-p256');
  assert.deepEqual(Array.from(pub.key), Array.from(raw));
});

test('the unmeasured-flag from the native side survives to the caller', async () => {
  await withVault(
    stubBackend({
      ensure: async (alias) => nativeInfo(alias, { unlockedDeviceRequiredMeasured: false }),
    }),
    generateDeviceKeypair(),
  );
  assert.equal(
    emergency().measured,
    false,
    'a value the platform could not be read back for must not arrive looking measured',
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// F-17 — the emergency key is unusable if anything gates it on a person
// ═══════════════════════════════════════════════════════════════════════════════

test('★ a hardware emergency key gated on user auth is refused, not used', async () => {
  const kp = generateDeviceKeypair();
  await withVault(
    stubBackend({ ensure: async (alias) => nativeInfo(alias, { userAuthRequired: true }) }),
    kp,
  );
  const s = emergency();
  assert.equal(s.backing, 'js_heap');
  assert.match(s.reason, /lock screen/);

  const payload = new TextEncoder().encode('unconscious');
  const signed = await signWithEmergencyKey(payload);
  assert.ok(signed, 'declining the gated key must not cost us the signature');
  assert.ok(verifyEmergency(signed.signature, payload, kp.emergencyPublic));
});

test('★ a hardware emergency key gated on an unlocked device is refused too', async () => {
  // P-035: T0 signs after LOCKED_BOOT_COMPLETED, before anyone types a PIN.
  await withVault(
    stubBackend({ ensure: async (alias) => nativeInfo(alias, { unlockedDeviceRequired: true }) }),
    generateDeviceKeypair(),
  );
  assert.equal(emergency().backing, 'js_heap');
});

test('the identity key may be gated — that is the whole point of having two', async () => {
  await withVault(
    stubBackend({ ensure: async (alias) => nativeInfo(alias, { userAuthRequired: true }) }),
    generateDeviceKeypair(),
  );
  const identity = keyBackingStatus().find((k) => k.role === 'identity');
  assert.ok(identity);
  assert.equal(identity.backing, 'tee');
  assert.equal(identity.userAuthRequired, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADR-018 — the safety path fails OPEN, at every step
// ═══════════════════════════════════════════════════════════════════════════════

test('a keystore that cannot create the key falls back and names the alias', async () => {
  const kp = generateDeviceKeypair();
  await withVault(
    stubBackend({
      ensure: async () => {
        throw new Error('StrongBox timed out');
      },
    }),
    kp,
  );
  const s = emergency();
  assert.equal(s.backing, 'js_heap');
  assert.match(s.reason, new RegExp(KEY_ALIAS.emergency));

  const payload = new TextEncoder().encode('keystore down');
  const signed = await signWithEmergencyKey(payload);
  assert.ok(signed);
  assert.ok(verifyEmergency(signed.signature, payload, kp.emergencyPublic));
});

test('a vault that reports the key absent is not trusted to sign with it', async () => {
  await withVault(
    stubBackend({ ensure: async (alias) => nativeInfo(alias, { present: false }) }),
    generateDeviceKeypair(),
  );
  assert.equal(emergency().backing, 'js_heap');
});

test('★ a hardware key that refuses mid-incident drops to software and admits it', async () => {
  const kp = generateDeviceKeypair();
  await withVault(
    stubBackend({
      sign: async () => {
        throw new Error('keystore is busy');
      },
    }),
    kp,
  );
  assert.equal(emergency().backing, 'tee', 'the key looked fine until it was asked');

  const payload = new TextEncoder().encode('3am');
  const signed = await signWithEmergencyKey(payload);
  assert.ok(signed, 'a refusal at signing time must not cost the incident its signature');
  assert.equal(signed.alg, 'ed25519');
  assert.ok(verifyEmergency(signed.signature, payload, kp.emergencyPublic));
  assert.equal(
    emergency().backing,
    'js_heap',
    'the reported backing must follow what actually signed, not what was planned',
  );
  assert.match(emergency().reason, /refused to sign/);
});

test('an undecodable signature from the native side is treated as no signature', async () => {
  const kp = generateDeviceKeypair();
  await withVault(stubBackend({ sign: async () => '' }), kp);
  const payload = new TextEncoder().encode('garbage in');
  const signed = await signWithEmergencyKey(payload);
  assert.ok(signed);
  assert.equal(signed.alg, 'ed25519');
  assert.ok(verifyEmergency(signed.signature, payload, kp.emergencyPublic));
});

test('with neither a hardware key nor software keys, signing returns null and never throws', async () => {
  await withVault(null, null);
  const signed = await signWithEmergencyKey(new TextEncoder().encode('nothing to sign with'));
  assert.equal(signed, null, 'the trigger path reads null as "send unsigned", not as a crash');
  assert.equal(await emergencySigningPublicKey(), null);
});

test('a native leg that rejects on every call leaves the facade usable', async () => {
  const kp = generateDeviceKeypair();
  const broken: HardwareKeyBackend = {
    ensure: async () => {
      throw new Error('boom');
    },
    info: async () => {
      throw new Error('boom');
    },
    sign: async () => {
      throw new Error('boom');
    },
    publicKey: async () => {
      throw new Error('boom');
    },
  };
  await withVault(broken, kp);
  const pub = await emergencySigningPublicKey();
  assert.ok(pub);
  assert.equal(pub.alg, 'ed25519');
  assert.deepEqual(Array.from(pub.key), Array.from(kp.emergencyPublic));
});

// ═══════════════════════════════════════════════════════════════════════════════
// The bridge contract the Kotlin has to satisfy
// ═══════════════════════════════════════════════════════════════════════════════

test('the two aliases are distinct and stable', async () => {
  // They are versioned strings baked into a keystore. Changing one orphans the
  // key on every phone already carrying it, and the server keeps verifying
  // against a public key nothing can sign for any more.
  assert.notEqual(KEY_ALIAS.emergency, KEY_ALIAS.identity);
  assert.equal(KEY_ALIAS.emergency, 'kavach_emergency_sign_v1');
  assert.equal(KEY_ALIAS.identity, 'kavach_identity_sign_v1');
});

test('the alias asked for is the alias signed under', async () => {
  const seen: string[] = [];
  await withVault(
    stubBackend({
      sign: async (alias, payload) => {
        seen.push(alias);
        return payload;
      },
    }),
    generateDeviceKeypair(),
  );
  await signWithEmergencyKey(base64ToBytes(bytesToBase64(new Uint8Array([7]))));
  assert.deepEqual(seen, [KEY_ALIAS.emergency], 'the identity key must never sign an SOS');
});
