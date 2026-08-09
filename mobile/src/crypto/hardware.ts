/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHICH KEY SIGNED IT — HARDWARE FIRST, SOFTWARE ADMITTED (F-17, P-031)
 *
 * `crypto/index.ts` generates the emergency signing key with @noble and hands it
 * back as bytes. Those bytes live in the JS heap for the whole life of the
 * process and are readable by any code in that runtime. The emergency key is
 * what proves an SOS came from this device, so that is a real vulnerability, not
 * a theoretical one.
 *
 * This module picks the AndroidKeyStore key when the native plane is there and
 * the existing software key when it is not (Expo Go, iOS, a device whose
 * keystore refuses), and `keyBackingStatus()` says which — by name, per key.
 * A software key reported as hardware is exactly the lie P-031 exists to
 * prevent, so every fallback below carries the reason it happened.
 *
 * ★ WHY THE HARDWARE KEY IS P-256 AND THE SOFTWARE KEY STAYS Ed25519 ★
 * Android Keystore gained Curve25519 at API 33. Kavach ships to API 26 and the
 * phones it exists for are mid-range Android sold in India, where Ed25519 in
 * hardware is simply not present. So the hardware path is EC P-256 signed
 * SHA256withECDSA and the software path is Ed25519, unchanged.
 *
 * The consequence is that the signature algorithm is a property of the KEY, not
 * of the protocol. The same family can hold an Ed25519 device and a P-256 device
 * at the same time, and one device changes algorithm across a reinstall on newer
 * hardware. ★ The server must verify BOTH ★ and choose by looking at the key it
 * has on file for that device id. The envelope format does not change: the body
 * is still the same canonical fixed-size JSON (F-01); only the signature bytes
 * and the algorithm label beside them differ.
 *
 * ★ WHERE THIS IS CONSUMED (not from here — this file only exports the API) ★
 *  · `src/state/store.ts` `loadKeyMaterial()` — after it has the software
 *    DeviceKeypair: `setSoftwareKeys(kp)`, `setHardwareKeyBackend(keyVault)`
 *    from `src/t0/native.ts`, then `await prepareKeys()`.
 *  · `src/t0/envelope.ts` `buildSignedEnvelope()` — sign through
 *    `signWithEmergencyKey()` and carry the returned `alg` next to the
 *    signature so ingest knows which verifier to reach for.
 *  · `app/diagnostics.tsx` — render `keyBackingStatus()` alongside the other
 *    P-031 checks. `t0SigningAvailablePredawn` already probes the same alias.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { signEmergency, bytesToBase64, base64ToBytes, type DeviceKeypair } from './index';

export type KeyRole = 'emergency' | 'identity';

/**
 * Four values, not two. `keystore_software` is an AndroidKeyStore key the
 * platform kept in software — weaker than the TEE, but the private half still
 * never enters this process. `js_heap` is the one that is a vulnerability.
 */
export type KeyBacking = 'strongbox' | 'tee' | 'keystore_software' | 'js_heap';

export type SignatureAlg = 'ed25519' | 'ecdsa-p256';

/** Must match the two aliases `KeyVault.kt` accepts; it rejects every other. */
export const KEY_ALIAS: Record<KeyRole, string> = {
  emergency: 'kavach_emergency_sign_v1',
  identity: 'kavach_identity_sign_v1',
};

/** What the native side reports back. Mirrors `KeyVaultInfo` in the module. */
export interface NativeKeyInfo {
  alias: string;
  present: boolean;
  strongBox: boolean;
  tee: boolean;
  userAuthRequired: boolean;
  unlockedDeviceRequired: boolean;
  unlockedDeviceRequiredMeasured: boolean;
  securityLevel: 'strongbox' | 'tee' | 'software' | 'unknown';
  createdAt: number;
}

/**
 * The native leg, injected rather than imported.
 *
 * `src/t0/native.ts` implements this and store.ts wires it in. Keeping the
 * import out of this file is what lets the fallback logic — the part that
 * decides whether an emergency signature exists at all — be tested off-device,
 * with no React Native in the graph.
 *
 * Every method resolves to null on failure instead of rejecting: a throw on the
 * safety path is fatal (ADR-018, fail OPEN).
 */
export interface HardwareKeyBackend {
  ensure(alias: string): Promise<NativeKeyInfo | null>;
  info(alias: string): Promise<NativeKeyInfo | null>;
  sign(alias: string, payloadBase64: string): Promise<string | null>;
  publicKey(alias: string): Promise<string | null>;
}

export interface KeyStatus {
  role: KeyRole;
  backing: KeyBacking;
  alg: SignatureAlg;
  /** The keystore alias, or null when this key is software. */
  alias: string | null;
  present: boolean;
  userAuthRequired: boolean;
  unlockedDeviceRequired: boolean;
  /**
   * False means `unlockedDeviceRequired` is the value the key was ASKED for
   * rather than one read back off it. Render the difference; do not smooth it.
   */
  measured: boolean;
  /** Plain-language reason this key has this backing. Safe to show verbatim. */
  reason: string;
}

export interface SignatureResult {
  signature: Uint8Array;
  alg: SignatureAlg;
  backing: KeyBacking;
}

export interface PublicKeyRef {
  /** Raw Ed25519 (32 bytes) or X.509 SubjectPublicKeyInfo DER for P-256. */
  key: Uint8Array;
  alg: SignatureAlg;
  backing: KeyBacking;
}

const ROLES: readonly KeyRole[] = ['emergency', 'identity'];

const JS_HEAP_WARNING =
  'the private key is bytes in the JS heap and any code in this runtime can read it';

let backend: HardwareKeyBackend | null = null;
let software: DeviceKeypair | null = null;

function pending(role: KeyRole): KeyStatus {
  return {
    role,
    backing: 'js_heap',
    alg: 'ed25519',
    alias: null,
    present: false,
    userAuthRequired: false,
    unlockedDeviceRequired: false,
    measured: true,
    reason: 'keys have not been prepared yet',
  };
}

let status: Record<KeyRole, KeyStatus> = {
  emergency: pending('emergency'),
  identity: pending('identity'),
};

// ── Wiring ────────────────────────────────────────────────────────────────────

/** Pass null to force the software path — that is also how the tests run. */
export function setHardwareKeyBackend(next: HardwareKeyBackend | null): void {
  backend = next;
}

/** The @noble keypair store.ts already owns. Null means there is no fallback. */
export function setSoftwareKeys(kp: DeviceKeypair | null): void {
  software = kp;
}

// ── Resolution ────────────────────────────────────────────────────────────────

function softwareStatus(role: KeyRole, why: string): KeyStatus {
  return {
    role,
    backing: 'js_heap',
    alg: 'ed25519',
    alias: null,
    present: software !== null,
    // Nothing gates a key that is sitting in a variable, and we know that for
    // certain rather than having asked the platform — hence measured: true.
    userAuthRequired: false,
    unlockedDeviceRequired: false,
    measured: true,
    reason: `${why} — ${JS_HEAP_WARNING}`,
  };
}

function backingOf(info: NativeKeyInfo): KeyBacking {
  if (info.strongBox) return 'strongbox';
  if (info.tee) return 'tee';
  return 'keystore_software';
}

function hardwareReason(backing: KeyBacking): string {
  switch (backing) {
    case 'strongbox':
      return 'held in StrongBox — a separate secure element, not the app process';
    case 'tee':
      // Named as TEE and not as StrongBox on purpose: most mid-range phones have
      // no StrongBox, and claiming one we did not get is the failure this whole
      // module exists to make impossible.
      return 'held in the TEE — no StrongBox on this device, which is the common case';
    default:
      return 'held by AndroidKeyStore in software — weaker than the TEE, still outside this process';
  }
}

async function resolve(role: KeyRole): Promise<KeyStatus> {
  const alias = KEY_ALIAS[role];
  if (!backend) {
    return softwareStatus(role, 'no native key vault on this platform');
  }

  let info: NativeKeyInfo | null = null;
  try {
    info = await backend.ensure(alias);
  } catch {
    info = null;
  }
  if (!info || !info.present) {
    return softwareStatus(role, `the keystore did not produce ${alias}`);
  }

  // ★ F-17. A hardware emergency key that needs the lock screen answered is
  // worse than no hardware key at all: it refuses at the one moment it is
  // asked, by a person who is unconscious. We decline it and say why.
  if (role === 'emergency' && (info.userAuthRequired || info.unlockedDeviceRequired)) {
    return softwareStatus(role, 'the keystore gated the emergency key on the lock screen');
  }

  const backing = backingOf(info);
  return {
    role,
    backing,
    alg: 'ecdsa-p256',
    alias,
    present: true,
    userAuthRequired: info.userAuthRequired,
    unlockedDeviceRequired: info.unlockedDeviceRequired,
    measured: info.unlockedDeviceRequiredMeasured,
    reason: hardwareReason(backing),
  };
}

/**
 * Create or adopt both keys and record what we got. Safe to call repeatedly —
 * `ensure` never regenerates an existing alias. Never throws.
 */
export async function prepareKeys(): Promise<KeyStatus[]> {
  const next: Record<KeyRole, KeyStatus> = {
    emergency: status.emergency,
    identity: status.identity,
  };
  for (const role of ROLES) {
    try {
      next[role] = await resolve(role);
    } catch {
      next[role] = softwareStatus(role, 'preparing the hardware key failed outright');
    }
  }
  status = next;
  return keyBackingStatus();
}

/** The honest answer, per key, for the diagnostics screen. */
export function keyBackingStatus(): KeyStatus[] {
  return ROLES.map((role) => ({ ...status[role] }));
}

// ── Signing ───────────────────────────────────────────────────────────────────

/**
 * Sign with the emergency key, whichever key that turned out to be.
 *
 * Returns null — never throws — when there is no usable key at all. A caller on
 * the trigger path must treat null as "send it unsigned and let ingest set
 * FLAG_UNVERIFIED" (ADR-018), not as a reason to abandon the incident.
 */
export async function signWithEmergencyKey(payload: Uint8Array): Promise<SignatureResult | null> {
  const current = status.emergency;
  if (backend && current.backing !== 'js_heap' && current.alias) {
    let encoded: string | null = null;
    try {
      encoded = await backend.sign(current.alias, bytesToBase64(payload));
    } catch {
      encoded = null;
    }
    if (encoded) {
      try {
        return { signature: base64ToBytes(encoded), alg: 'ecdsa-p256', backing: current.backing };
      } catch {
        // A signature we cannot decode is a signature we do not have.
      }
    }
    // The keystore refused mid-incident. Drop to the software key and downgrade
    // the reported backing in the same breath, so the next diagnostics read
    // shows what actually signed rather than what was supposed to.
    status.emergency = softwareStatus('emergency', 'the hardware key refused to sign');
  }

  const kp = software;
  if (!kp) return null;
  return { signature: signEmergency(payload, kp), alg: 'ed25519', backing: 'js_heap' };
}

/**
 * The public half to register with the server, and the algorithm it verifies
 * under. Ed25519 is 32 raw bytes; P-256 is X.509 SubjectPublicKeyInfo DER —
 * different lengths and different parsers, which is why `alg` travels with it.
 */
export async function emergencySigningPublicKey(): Promise<PublicKeyRef | null> {
  const current = status.emergency;
  if (backend && current.backing !== 'js_heap' && current.alias) {
    let encoded: string | null = null;
    try {
      encoded = await backend.publicKey(current.alias);
    } catch {
      encoded = null;
    }
    if (encoded) {
      try {
        return { key: base64ToBytes(encoded), alg: 'ecdsa-p256', backing: current.backing };
      } catch {
        // Fall through to the software key rather than publish garbage.
      }
    }
  }
  const kp = software;
  if (!kp) return null;
  return { key: kp.emergencyPublic, alg: 'ed25519', backing: 'js_heap' };
}
