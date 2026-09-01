/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * KAVACH CRYPTOGRAPHY — Phase 1 "GroupBox" (ADR-021)
 *
 * Finding F-08 resolution. The PRD specifies MLS (RFC 9420) but schedules it at
 * 21 days on the Phase 0 critical path; realistically it is 8–14 weeks including
 * the Delivery Service, epoch recovery and key transparency. That single line
 * item is the most likely cause of never reaching the Phase 1 gate — the twelve
 * weeks that carry 90% of the life-saving value.
 *
 * GroupBox delivers the SAME guarantee against the server (threat T3, the reason
 * E2EE exists here) in ~3 days:
 *
 *   Family Group Secret   32 random bytes, generated on the founding device
 *   Distribution          crypto_box_seal-equivalent (X25519 ECDH + XChaCha20)
 *                         to each enrolled device's identity public key
 *   Content encryption    XChaCha20-Poly1305 under HKDF-derived per-scope keys
 *
 * What it LACKS vs MLS: forward secrecy and post-compromise security. Those
 * address threat T6 (a compromised family device), rated LOW × HIGH — not what
 * blocks shipping. Recorded as ADR-021 with a dated migration commitment.
 *
 * The `scheme` byte prefixing every ciphertext makes the MLS migration additive:
 * old clients keep working (NFR-016 / P-060).
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import 'react-native-get-random-values';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToBase64, base64ToBytes, bytesToHex } from '../core/ids';

export const SCHEME_GROUPBOX = 0x01;
export const SCHEME_MLS = 0x02; // reserved — Phase 2

const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** Constant-time comparison. Used on the duress path — never short-circuit. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ── Device identity ───────────────────────────────────────────────────────────

export interface DeviceKeypair {
  /** Ed25519 signing key. Biometric-gated in the native module. */
  identitySecret: Uint8Array;
  identityPublic: Uint8Array;
  /**
   * ★ THE EMERGENCY SIGNING KEY ★
   * Deliberately NOT biometric-gated. An unconscious person cannot provide a
   * fingerprint; gating this key on biometrics builds a system that works only
   * for conscious people — excluding exactly the people who need it most.
   * Native: setUserAuthenticationRequired(false) + setUnlockedDeviceRequired(false).
   */
  emergencySecret: Uint8Array;
  emergencyPublic: Uint8Array;
  /** X25519 key agreement key, for receiving the sealed group secret. */
  boxSecret: Uint8Array;
  boxPublic: Uint8Array;
}

export function generateDeviceKeypair(): DeviceKeypair {
  const identitySecret = ed25519.utils.randomSecretKey();
  const emergencySecret = ed25519.utils.randomSecretKey();
  const boxSecret = x25519.utils.randomSecretKey();
  return {
    identitySecret,
    identityPublic: ed25519.getPublicKey(identitySecret),
    emergencySecret,
    emergencyPublic: ed25519.getPublicKey(emergencySecret),
    boxSecret,
    boxPublic: x25519.getPublicKey(boxSecret),
  };
}

export function signEmergency(payload: Uint8Array, kp: DeviceKeypair): Uint8Array {
  return ed25519.sign(payload, kp.emergencySecret);
}

export function verifyEmergency(
  sig: Uint8Array,
  payload: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed25519.verify(sig, payload, publicKey);
  } catch {
    return false;
  }
}

// ── Group secret distribution (sealed box) ────────────────────────────────────

/**
 * Seal a payload to a recipient's X25519 public key using an ephemeral sender
 * key (libsodium crypto_box_seal construction). The recipient needs no prior
 * knowledge of the sender.
 *
 * Wire: [ephemeralPub 32][nonce 24][ciphertext+tag]
 */
export function sealTo(recipientBoxPublic: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const ephSecret = x25519.utils.randomSecretKey();
  const ephPublic = x25519.getPublicKey(ephSecret);
  const shared = x25519.getSharedSecret(ephSecret, recipientBoxPublic);
  // Bind the key to both public keys so a swapped ephemeral cannot be replayed.
  const key = hkdf(sha256, shared, concat(ephPublic, recipientBoxPublic), enc.encode('kavach-seal'), 32);
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return concat(ephPublic, nonce, ct);
}

export function openSealed(kp: DeviceKeypair, sealed: Uint8Array): Uint8Array | null {
  try {
    const ephPublic = sealed.slice(0, 32);
    const nonce = sealed.slice(32, 56);
    const ct = sealed.slice(56);
    const shared = x25519.getSharedSecret(kp.boxSecret, ephPublic);
    const key = hkdf(sha256, shared, concat(ephPublic, kp.boxPublic), enc.encode('kavach-seal'), 32);
    return xchacha20poly1305(key, nonce).decrypt(ct);
  } catch {
    return null;
  }
}

// ── Content encryption ────────────────────────────────────────────────────────

/**
 * Derive a scoped content key from the family group secret.
 *
 * F-19: MLS is the wrong primitive for a 1 Hz location stream — one ratchet per
 * point per recipient. Instead we derive a Location Stream Key per 5-minute
 * window and seal each point with a cheap AEAD under a counter nonce. Identical
 * construction for the Incident Content Key.
 */
export function deriveKey(groupSecret: Uint8Array, label: string, context: string): Uint8Array {
  return hkdf(sha256, groupSecret, enc.encode(context), enc.encode(`kavach-${label}`), 32);
}

export function locationWindowId(atMs: number = Date.now()): number {
  return Math.floor(atMs / 300_000); // 5-minute windows
}

export function incidentContentKey(groupSecret: Uint8Array, incidentId: string): Uint8Array {
  return deriveKey(groupSecret, 'inc', incidentId);
}

export function locationStreamKey(groupSecret: Uint8Array, windowId: number): Uint8Array {
  return deriveKey(groupSecret, 'loc', String(windowId));
}

/**
 * ★ Spec D1/E1 (6-D-7) — the key a Family Watch session's signalling is sealed
 * under. Identical construction to the two above; the context is the session
 * id, so two concurrent sessions in one family share no key material and a
 * relayed signal cannot be replayed into a different session (`sealJson`'s AAD
 * binds it to the same id a second time).
 *
 * It seals SDP and ICE, not media. The media itself is encrypted by DTLS-SRTP
 * inside WebRTC, a different mechanism entirely — this key never touches a
 * video frame.
 */
export function watchSessionKey(groupSecret: Uint8Array, sessionId: string): Uint8Array {
  return deriveKey(groupSecret, 'watch', sessionId);
}

/**
 * Seal an object. Output: base64( [scheme 1][nonce 24][ciphertext+tag] ).
 * The server stores and routes this; it can never read it.
 */
export function sealJson(key: Uint8Array, value: unknown, aad?: string): string {
  const nonce = randomBytes(24);
  const pt = enc.encode(JSON.stringify(value));
  const aead = xchacha20poly1305(key, nonce, aad ? enc.encode(aad) : undefined);
  const ct = aead.encrypt(pt);
  const out = new Uint8Array(1 + 24 + ct.length);
  out[0] = SCHEME_GROUPBOX;
  out.set(nonce, 1);
  out.set(ct, 25);
  return bytesToBase64(out);
}

export function openJson<T>(key: Uint8Array, sealedB64: string, aad?: string): T | null {
  try {
    const raw = base64ToBytes(sealedB64);
    const scheme = raw[0];
    if (scheme !== SCHEME_GROUPBOX) return null; // MLS payload — Phase 2 client
    const nonce = raw.slice(1, 25);
    const ct = raw.slice(25);
    const aead = xchacha20poly1305(key, nonce, aad ? enc.encode(aad) : undefined);
    return JSON.parse(dec.decode(aead.decrypt(ct))) as T;
  } catch {
    return null;
  }
}

// ── BLE mesh HMAC (offline peer verification) ─────────────────────────────────

/**
 * Rotating family pseudonym: HMAC(group_secret, floor(unix_time / 900)).
 *
 * F-12: scanners MUST accept windows {n-1, n, n+1}. Two devices whose clocks
 * differ by seconds across a 15-minute boundary would otherwise stop recognising
 * each other — at exactly the moment one of them is in distress.
 */
export function blePseudonym(groupSecret: Uint8Array, windowIndex: number): Uint8Array {
  return hmac(sha256, groupSecret, enc.encode(`kavach-ble:${windowIndex}`)).slice(0, 8);
}

export function bleWindow(atMs: number = Date.now()): number {
  return Math.floor(atMs / 900_000);
}

export function acceptableBleWindows(atMs: number = Date.now()): number[] {
  const n = bleWindow(atMs);
  return [n - 1, n, n + 1];
}

export function bleTag(groupSecret: Uint8Array, body: Uint8Array): Uint8Array {
  return hmac(sha256, groupSecret, body).slice(0, 8);
}

export function verifyBleTag(groupSecret: Uint8Array, body: Uint8Array, tag: Uint8Array): boolean {
  return timingSafeEqual(bleTag(groupSecret, body), tag);
}

// ── SMS integrity tag ─────────────────────────────────────────────────────────

/** 8 base64url chars of HMAC-SHA256, as budgeted in the 160-char SMS payload. */
export function smsTag(groupSecret: Uint8Array, payload: string): string {
  const mac = hmac(sha256, groupSecret, enc.encode(payload));
  return bytesToBase64(mac.slice(0, 6)).replace(/\+/g, '-').replace(/\//g, '_').slice(0, 8);
}

// ── Shamir 2-of-3 for the vault (independent of the group secret) ─────────────
// GF(256) secret sharing. The vault must survive total loss of all devices, so
// its key is NEVER derived from the group secret — different threat model,
// different key (PRD §10.3).

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  // Canonical Reed-Solomon construction: generator 2 over the primitive
  // polynomial 0x11d. Generator 3 is NOT primitive under this polynomial — using
  // it produces a log table with collisions, which silently makes every share
  // identical. (Caught by the "reconstructs from ANY two shares" invariant test;
  // a bug here would have been invisible until an actual key-recovery drill.)
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);
const gfDiv = (a: number, b: number) => (a === 0 ? 0 : GF_EXP[GF_LOG[a] + 255 - GF_LOG[b]]);

export interface ShamirShare {
  index: number; // 1..255
  data: Uint8Array;
}

/** Split a secret into `shares` pieces, any `threshold` of which reconstruct it. */
export function shamirSplit(secret: Uint8Array, shares: number, threshold: number): ShamirShare[] {
  if (threshold < 2 || threshold > shares || shares > 255) throw new Error('bad shamir params');
  const out: ShamirShare[] = [];
  for (let i = 1; i <= shares; i++) out.push({ index: i, data: new Uint8Array(secret.length) });
  for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
    const coeffs = new Uint8Array(threshold);
    coeffs[0] = secret[byteIdx];
    const rnd = randomBytes(threshold - 1);
    for (let i = 1; i < threshold; i++) coeffs[i] = rnd[i - 1];
    for (const share of out) {
      let acc = 0;
      for (let p = threshold - 1; p >= 0; p--) acc = gfMul(acc, share.index) ^ coeffs[p];
      share.data[byteIdx] = acc;
    }
  }
  return out;
}

/** Lagrange interpolation at x=0. Runs ON-DEVICE only — shares never meet on a server. */
export function shamirCombine(shares: ShamirShare[]): Uint8Array {
  if (shares.length < 2) throw new Error('need at least 2 shares');
  const len = shares[0].data.length;
  const out = new Uint8Array(len);
  for (let byteIdx = 0; byteIdx < len; byteIdx++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        num = gfMul(num, shares[j].index);
        den = gfMul(den, shares[i].index ^ shares[j].index);
      }
      acc ^= gfMul(shares[i].data[byteIdx], gfDiv(num, den));
    }
    out[byteIdx] = acc;
  }
  return out;
}

// ── utils ─────────────────────────────────────────────────────────────────────
export function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function fingerprint(pub: Uint8Array): string {
  return bytesToHex(sha256(pub).slice(0, 8));
}

export { bytesToBase64, base64ToBytes };
