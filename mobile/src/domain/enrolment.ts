/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEVICE ENROLMENT — how a second phone joins the family (Phase 0 §3.3, ADR-021)
 *
 * Until this file existed, `crypto.sealTo()` had no caller and `loadKeyMaterial()`
 * minted a fresh 32-byte group secret whenever one was missing, so every install
 * founded its own family of one. The fan-out, the consent graph and the BLE mesh
 * all address "the family" and the family had exactly one member.
 *
 * The exchange, in four steps:
 *   1. The joining phone builds an INVITE carrying its X25519 PUBLIC key, its
 *      device id and the name a human will recognise.
 *   2. The guardian reads or scans it, sees who is asking, and confirms.
 *   3. The guardian seals the group secret TO that public key and hands back a
 *      RESPONSE.
 *   4. The joining phone opens it and now shares the family key.
 *
 * ★★★ THE FOUR PROPERTIES, AND WHERE EACH IS ENFORCED ★★★
 *
 *   · The invite is public. `buildInvite` writes `boxPublic` and never touches
 *     `boxSecret`. Intercepting an invite gives an attacker a public key they
 *     could have asked for.
 *   · The response is sealed to one key. `sealResponse` calls `sealTo`, whose
 *     output only the holder of that box private key can open. That is why the
 *     response may cross an untrusted channel — dictated over a phone line,
 *     pasted into WhatsApp, photographed — without leaking the group secret.
 *   · Neither of the above authenticates ANYONE. A man in the middle who swaps
 *     the invite's public key for their own receives the group secret and joins
 *     the family, and every byte still verifies. The only defence is the two
 *     humans comparing `fingerprintOf(boxPublic)` out of band — `readInvite`
 *     deliberately does not and cannot decide this, so the confirmation belongs
 *     in the UI and the UI must say what the comparison is for.
 *   · Codes expire (`INVITE_TTL_MS`) and are single-use. Expiry is enforced here
 *     against a caller-supplied clock; single-use is a ledger the guardian keeps
 *     (`bindingOf`), because "already spent" is state and this module holds none.
 *
 * The code alphabet is Crockford base32 — no I, L, O or U — grouped in fives with
 * one check character. It is long, because an X25519 public key is 32 bytes and
 * no encoding shrinks that. Grouping and a confusable-free alphabet make
 * dictation survivable; the QR makes it instant when both phones are in the same
 * room; and the thing humans actually read to each other is the 16-character
 * fingerprint, not the code.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { sha256 } from '@noble/hashes/sha2.js';

import type { UUID } from '../core/types';
import { bytesToHex, hexToBytes } from '../core/ids';
import { fingerprint, openSealed, sealTo, type DeviceKeypair } from '../crypto';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Ten minutes. Long enough to walk to the other room, short enough to matter. */
export const INVITE_TTL_MS = 10 * 60_000;

/**
 * Two devices in the same room can still disagree by a few seconds, and a code
 * minted "in the future" would otherwise be refused outright.
 */
export const CLOCK_SKEW_MS = 90_000;

export const CODE_VERSION = 1;
export const KIND_INVITE = 1;
export const KIND_RESPONSE = 2;

/** Names are shown, not parsed. 24 bytes holds any realistic given name. */
export const MAX_NAME_BYTES = 24;

const GROUP_SECRET_BYTES = 32;
const BOX_PUBLIC_BYTES = 32;
const UUID_BYTES = 16;
const BINDING_BYTES = 16;
/** ephemeral public (32) + nonce (24) + Poly1305 tag (16) — see crypto.sealTo. */
const SEAL_OVERHEAD = 72;

const INVITE_FIXED = 1 + 6 + BOX_PUBLIC_BYTES + UUID_BYTES + 1;
const RESPONSE_PLAIN_FIXED = GROUP_SECRET_BYTES + UUID_BYTES + 6 + BINDING_BYTES + 1;

// ═══════════════════════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════════════════════

export type EnrolFault =
  | 'empty'
  | 'checksum'
  | 'malformed'
  | 'version'
  | 'kind'
  | 'expired'
  | 'notyet'
  | 'sealed'
  | 'mismatch';

export interface EnrolFailure {
  ok: false;
  fault: EnrolFault;
  /** Shown verbatim to a person who has never done a key exchange. */
  message: string;
}

export type EnrolResult<T> = { ok: true; value: T } | EnrolFailure;

function fail(fault: EnrolFault, message: string): EnrolFailure {
  return { ok: false, fault, message };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Crockford base32 with a check character
// ═══════════════════════════════════════════════════════════════════════════════

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** O reads as zero, I and L read as one — on paper and out loud both. */
const CONFUSABLE: Record<string, string> = { O: '0', I: '1', L: '1' };

const B32_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B32.length; i++) m[B32[i]] = i;
  return m;
})();

export function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let held = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    held += 8;
    while (held >= 5) {
      held -= 5;
      out += B32[(acc >>> held) & 31];
    }
  }
  if (held > 0) out += B32[(acc << (5 - held)) & 31];
  return out;
}

/**
 * Strict inverse. Trailing bits must be zero: a string that decodes to the right
 * bytes from characters nobody wrote is a string the check character would
 * silently bless.
 */
export function decodeBase32(chars: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor((chars.length * 5) / 8));
  let acc = 0;
  let held = 0;
  let at = 0;
  for (let i = 0; i < chars.length; i++) {
    const v = B32_INDEX[chars[i]];
    if (v === undefined) return null;
    acc = (acc << 5) | v;
    held += 5;
    if (held >= 8) {
      held -= 8;
      out[at++] = (acc >>> held) & 0xff;
    }
  }
  if (held > 0 && (acc & ((1 << held) - 1)) !== 0) return null;
  return at === out.length ? out : null;
}

/** Uppercase, drop separators, fold the three confusable letters. */
export function normaliseCode(input: string): string {
  let out = '';
  for (const raw of input.toUpperCase()) {
    const ch = CONFUSABLE[raw] ?? raw;
    if (B32_INDEX[ch] !== undefined) out += ch;
  }
  return out;
}

/** Groups of five. The eye loses its place in an unbroken run of a hundred. */
export function groupCode(chars: string): string {
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += 5) parts.push(chars.slice(i, i + 5));
  return parts.join('-');
}

function checkChar(payload: Uint8Array): string {
  return B32[sha256(payload)[0] & 31];
}

function toCode(payload: Uint8Array): string {
  return groupCode(encodeBase32(payload) + checkChar(payload));
}

/**
 * A mistyped code has one chance in 32 of passing this. It then decodes to a
 * public key nobody holds, the seal goes nowhere, and the joining phone reports
 * that the reply did not open — so the failure is loud and nothing is exposed.
 */
function fromCode(text: string): EnrolResult<Uint8Array> {
  const chars = normaliseCode(text);
  if (chars.length < 2) return fail('empty', 'There is no code here yet.');
  const body = chars.slice(0, -1);
  const payload = decodeBase32(body);
  if (payload === null || payload.length === 0) {
    return fail('malformed', 'That code is not complete. Check it and type it again.');
  }
  if (chars[chars.length - 1] !== checkChar(payload)) {
    return fail('checksum', 'One character is wrong. Read it out again, five at a time.');
  }
  return { ok: true, value: payload };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Field helpers
// ═══════════════════════════════════════════════════════════════════════════════

function writeMs48(target: Uint8Array, at: number, ms: number): void {
  target[at] = (ms / 2 ** 40) & 0xff;
  target[at + 1] = (ms / 2 ** 32) & 0xff;
  target[at + 2] = (ms / 2 ** 24) & 0xff;
  target[at + 3] = (ms / 2 ** 16) & 0xff;
  target[at + 4] = (ms / 2 ** 8) & 0xff;
  target[at + 5] = ms & 0xff;
}

function readMs48(src: Uint8Array, at: number): number {
  return (
    src[at] * 2 ** 40 +
    src[at + 1] * 2 ** 32 +
    src[at + 2] * 2 ** 24 +
    src[at + 3] * 2 ** 16 +
    src[at + 4] * 2 ** 8 +
    src[at + 5]
  );
}

function uuidToBytes(id: UUID): Uint8Array {
  const hex = id.replace(/-/g, '');
  if (hex.length !== 32 || /[^0-9a-fA-F]/.test(hex)) return new Uint8Array(UUID_BYTES);
  return hexToBytes(hex.toLowerCase());
}

function bytesToUuid(b: Uint8Array): UUID {
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Truncate on a UTF-8 boundary — half a Devanagari codepoint renders as tofu. */
export function clampName(name: string, maxBytes: number = MAX_NAME_BYTES): string {
  const trimmed = name.trim();
  let out = '';
  let used = 0;
  for (const ch of trimmed) {
    const size = enc.encode(ch).length;
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

function expiryCheck(createdAt: number, now: number, noun: string): EnrolFailure | null {
  if (createdAt > now + CLOCK_SKEW_MS) {
    return fail('notyet', `That ${noun} was made in the future. Check the clock on both phones.`);
  }
  if (now - createdAt > INVITE_TTL_MS) {
    return fail('expired', `That ${noun} has expired. Make a new one — they last ten minutes.`);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Fingerprint — the only part of this protocol a human is asked to read
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 64 bits of SHA-256 over the public key, in four groups of four.
 *
 * ★ This IS the authentication. ★ Everything else in this file is confidential
 * but anonymous: a man in the middle who substitutes their own public key gets a
 * perfectly valid enrolment and the family key. The substitution changes this
 * string, so two people saying it aloud and finding it identical is the step
 * that closes the hole. Both screens must show it, and neither may treat any
 * automatic check as a substitute for it.
 */
export function fingerprintGroups(boxPublic: Uint8Array): string[] {
  const hex = fingerprint(boxPublic).toUpperCase();
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12, 16)];
}

export function fingerprintOf(boxPublic: Uint8Array): string {
  return fingerprintGroups(boxPublic).join(' ');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Step 1 — the invite
// ═══════════════════════════════════════════════════════════════════════════════

export interface InviteDraft {
  deviceId: UUID;
  boxPublic: Uint8Array;
  displayName: string;
  createdAt?: number;
}

export interface Invite {
  deviceId: UUID;
  boxPublic: Uint8Array;
  displayName: string;
  createdAt: number;
  expiresAt: number;
  /** Canonical bytes. The typed code and the QR carry exactly these. */
  payload: Uint8Array;
  /** Grouped, check-charactered, ready to read aloud or print. */
  code: string;
  fingerprint: string;
}

/**
 * Layout — header ‖ createdAt(48) ‖ boxPublic(32) ‖ deviceId(16) ‖ len ‖ name.
 *
 * `boxSecret` is not a parameter of this function and cannot be reached from it.
 * That is the "the invite reveals nothing" property, stated as an argument list
 * rather than as a promise.
 */
export function buildInvite(draft: InviteDraft): Invite {
  if (draft.boxPublic.length !== BOX_PUBLIC_BYTES) {
    throw new Error('enrolment: boxPublic must be 32 bytes');
  }
  const createdAt = draft.createdAt ?? Date.now();
  const displayName = clampName(draft.displayName);
  const name = enc.encode(displayName);

  const payload = new Uint8Array(INVITE_FIXED + name.length);
  payload[0] = (CODE_VERSION << 4) | KIND_INVITE;
  writeMs48(payload, 1, createdAt);
  payload.set(draft.boxPublic, 7);
  payload.set(uuidToBytes(draft.deviceId), 39);
  payload[55] = name.length;
  payload.set(name, 56);

  return {
    deviceId: draft.deviceId,
    boxPublic: draft.boxPublic,
    displayName,
    createdAt,
    expiresAt: createdAt + INVITE_TTL_MS,
    payload,
    code: toCode(payload),
    fingerprint: fingerprintOf(draft.boxPublic),
  };
}

export function readInvite(text: string, now: number = Date.now()): EnrolResult<Invite> {
  const decoded = fromCode(text);
  if (!decoded.ok) return decoded;
  const payload = decoded.value;

  if (payload.length < INVITE_FIXED) {
    return fail('malformed', 'That code is too short to be an invitation.');
  }
  if (payload[0] >> 4 !== CODE_VERSION) {
    return fail('version', 'That code came from a different version of Kavach. Update both phones.');
  }
  if ((payload[0] & 0x0f) !== KIND_INVITE) {
    return fail('kind', 'That is a reply code, not an invitation. Swap the two phones around.');
  }
  const nameLen = payload[55];
  if (payload.length !== INVITE_FIXED + nameLen || nameLen > MAX_NAME_BYTES) {
    return fail('malformed', 'That invitation is damaged. Ask for a fresh one.');
  }

  const createdAt = readMs48(payload, 1);
  const stale = expiryCheck(createdAt, now, 'invitation');
  if (stale !== null) return stale;

  const boxPublic = payload.slice(7, 39);
  return {
    ok: true,
    value: {
      deviceId: bytesToUuid(payload.slice(39, 55)),
      boxPublic,
      displayName: dec.decode(payload.slice(56, 56 + nameLen)),
      createdAt,
      expiresAt: createdAt + INVITE_TTL_MS,
      payload,
      code: toCode(payload),
      fingerprint: fingerprintOf(boxPublic),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Steps 3 and 4 — the sealed response
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The guardian's single-use ledger key: 16 bytes of SHA-256 over the invite.
 *
 * It is also carried INSIDE the sealed reply, so a reply built for one invite
 * cannot be presented against another — which is what stops an old reply, kept
 * from a previous enrolment, being replayed at a phone that is asking again.
 */
export function bindingOf(invitePayload: Uint8Array): string {
  return bytesToHex(sha256(invitePayload).slice(0, BINDING_BYTES));
}

export interface ResponseDraft {
  invite: Invite;
  groupSecret: Uint8Array;
  familyId: UUID;
  guardianName: string;
  createdAt?: number;
}

export interface EnrolResponse {
  payload: Uint8Array;
  code: string;
  createdAt: number;
  expiresAt: number;
  /** Matches `bindingOf(invite.payload)`. The ledger entry to write. */
  binding: string;
}

export interface AcceptedFamily {
  groupSecret: Uint8Array;
  familyId: UUID;
  guardianName: string;
  createdAt: number;
}

/**
 * Seal the group secret to the invited device.
 *
 * `sealTo` derives an ephemeral X25519 shared secret against `invite.boxPublic`
 * and encrypts under it, so the output is readable by exactly one private key in
 * the world. Everything the family would rather not publish — the family id, the
 * guardian's name, the binding — goes INSIDE that envelope rather than beside
 * it, which is why the outer payload is one header byte and a ciphertext.
 */
export function sealResponse(draft: ResponseDraft): EnrolResponse {
  if (draft.groupSecret.length !== GROUP_SECRET_BYTES) {
    throw new Error('enrolment: groupSecret must be 32 bytes');
  }
  const createdAt = draft.createdAt ?? Date.now();
  const guardianName = clampName(draft.guardianName);
  const name = enc.encode(guardianName);

  const plain = new Uint8Array(RESPONSE_PLAIN_FIXED + name.length);
  plain.set(draft.groupSecret, 0);
  plain.set(uuidToBytes(draft.familyId), 32);
  writeMs48(plain, 48, createdAt);
  plain.set(hexToBytes(bindingOf(draft.invite.payload)), 54);
  plain[70] = name.length;
  plain.set(name, 71);

  const sealed = sealTo(draft.invite.boxPublic, plain);
  const payload = new Uint8Array(1 + sealed.length);
  payload[0] = (CODE_VERSION << 4) | KIND_RESPONSE;
  payload.set(sealed, 1);

  return {
    payload,
    code: toCode(payload),
    createdAt,
    expiresAt: createdAt + INVITE_TTL_MS,
    binding: bindingOf(draft.invite.payload),
  };
}

/**
 * Open a reply on the joining phone.
 *
 * Three separate refusals, and each one is a different attack:
 *   · `openSealed` returns null — the reply was sealed to somebody else's key,
 *     or tampered with. Poly1305 decides this, not us.
 *   · the binding does not match — a reply from a different invitation,
 *     including an old one of our own.
 *   · the clock says it is stale — replay outside the ten-minute window.
 */
export function readResponse(
  text: string,
  keypair: DeviceKeypair,
  invite: Invite,
  now: number = Date.now(),
): EnrolResult<AcceptedFamily> {
  const decoded = fromCode(text);
  if (!decoded.ok) return decoded;
  const payload = decoded.value;

  if (payload.length < 1 + SEAL_OVERHEAD + RESPONSE_PLAIN_FIXED) {
    return fail('malformed', 'That reply is too short. Ask for the whole code.');
  }
  if (payload[0] >> 4 !== CODE_VERSION) {
    return fail('version', 'That code came from a different version of Kavach. Update both phones.');
  }
  if ((payload[0] & 0x0f) !== KIND_RESPONSE) {
    return fail('kind', 'That is an invitation, not a reply. This phone is the one joining.');
  }

  const plain = openSealed(keypair, payload.slice(1));
  if (plain === null) {
    return fail(
      'sealed',
      'That reply was not meant for this phone. Only the phone that showed the invitation can open it.',
    );
  }
  if (plain.length < RESPONSE_PLAIN_FIXED) {
    return fail('malformed', 'That reply is damaged. Ask for a fresh one.');
  }
  const nameLen = plain[70];
  if (plain.length !== RESPONSE_PLAIN_FIXED + nameLen || nameLen > MAX_NAME_BYTES) {
    return fail('malformed', 'That reply is damaged. Ask for a fresh one.');
  }

  if (bytesToHex(plain.slice(54, 70)) !== bindingOf(invite.payload)) {
    return fail(
      'mismatch',
      'That reply answers a different invitation. Show the code on this screen and try again.',
    );
  }

  const createdAt = readMs48(plain, 48);
  const stale = expiryCheck(createdAt, now, 'reply');
  if (stale !== null) return stale;

  return {
    ok: true,
    value: {
      groupSecret: plain.slice(0, 32),
      familyId: bytesToUuid(plain.slice(32, 48)),
      guardianName: dec.decode(plain.slice(71, 71 + nameLen)),
      createdAt,
    },
  };
}

/** Whole seconds left, floored at zero. Drives the countdown on both screens. */
export function secondsLeft(expiresAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((expiresAt - now) / 1000));
}

// ═══════════════════════════════════════════════════════════════════════════════
// QR — the same bytes, for when both phones are in the same room
// ═══════════════════════════════════════════════════════════════════════════════
//
// ISO/IEC 18004 alphanumeric mode at error-correction level L, versions 1–10.
// Alphanumeric because the code alphabet is already inside that character set,
// and it packs two characters into 11 bits where byte mode spends 16. Level L
// because a phone screen held 20 cm from a phone camera is not a damaged label —
// the capacity buys headroom the reply code genuinely needs.
//
// The matrix is a pure function of the string, which is what makes it testable:
// test/enrolment.test.ts reads its own codewords back out, checks the
// Reed-Solomon remainder of every block is zero, and compares the recovered
// string with the input.

const QR_ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const QR_MAX_VERSION = 10;

/** Indexed by version. Level L only. */
const ECC_PER_BLOCK_L = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const BLOCKS_L = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];

const PENALTY_RUN = 3;
const PENALTY_BLOCK = 3;
const PENALTY_FINDER = 40;
const PENALTY_BALANCE = 10;

// GF(256) under the primitive polynomial 0x11d. The identical table in
// src/crypto/index.ts is module-private; exporting it would widen the crypto
// surface to serve a barcode.
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Total module capacity in bits, less the function patterns. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function totalCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8);
}

function dataCodewords(version: number): number {
  return totalCodewords(version) - ECC_PER_BLOCK_L[version] * BLOCKS_L[version];
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
  const out = new Array<number>(numAlign);
  out[0] = 6;
  for (let i = numAlign - 1, pos = size - 7; i >= 1; i--, pos -= step) out[i] = pos;
  return out;
}

function charCountBits(version: number): number {
  return version <= 9 ? 9 : 11;
}

function alnumBits(length: number): number {
  return 11 * Math.floor(length / 2) + (length % 2 === 1 ? 6 : 0);
}

function chooseVersion(length: number): number {
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    if (4 + charCountBits(v) + alnumBits(length) <= dataCodewords(v) * 8) return v;
  }
  return 0;
}

/** Generator polynomial coefficients, highest-order term implied. */
function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (let d = 0; d < data.length; d++) {
    const factor = data[d] ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function addEccAndInterleave(version: number, data: Uint8Array): Uint8Array {
  const numBlocks = BLOCKS_L[version];
  const eccLen = ECC_PER_BLOCK_L[version];
  const raw = totalCodewords(version);
  const shortBlocks = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(eccLen);

  const blocks: Uint8Array[] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const datLen = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const block = new Uint8Array(shortLen + 1);
    block.set(dat, 0);
    block.set(rsRemainder(dat, divisor), block.length - eccLen);
    blocks.push(block);
  }

  const out = new Uint8Array(raw);
  for (let i = 0, k = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < numBlocks; j++) {
      // Short blocks have no byte at the padding index; skipping it is what makes
      // the interleave reversible without a length table.
      if (i !== shortLen - eccLen || j >= shortBlocks) out[k++] = blocks[j][i];
    }
  }
  return out;
}

/** BCH(15,5) under 0x537, masked with 0x5412. (L, mask 0) must be 0b111011111000100. */
function formatBits(mask: number): number {
  const data = (1 << 3) | mask; // 01 = level L
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** BCH(18,6) under 0x1F25. Version 7 must be 0b000111110010010100. */
function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

interface Canvas {
  size: number;
  modules: boolean[][];
  reserved: boolean[][];
}

function blankCanvas(size: number): Canvas {
  const modules: boolean[][] = [];
  const reserved: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    modules.push(new Array<boolean>(size).fill(false));
    reserved.push(new Array<boolean>(size).fill(false));
  }
  return { size, modules, reserved };
}

function setFunction(c: Canvas, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  c.modules[y][x] = dark;
  c.reserved[y][x] = true;
}

function drawFinder(c: Canvas, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(c, cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(c: Canvas, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunction(c, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFormat(c: Canvas, mask: number): void {
  const bits = formatBits(mask);
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setFunction(c, 8, i, bit(i));
  setFunction(c, 8, 7, bit(6));
  setFunction(c, 8, 8, bit(7));
  setFunction(c, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(c, 14 - i, 8, bit(i));

  for (let i = 0; i < 8; i++) setFunction(c, c.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(c, 8, c.size - 15 + i, bit(i));
  setFunction(c, 8, c.size - 8, true); // the module that is always dark
}

function drawFunctionPatterns(c: Canvas, version: number): void {
  for (let i = 0; i < c.size; i++) {
    setFunction(c, 6, i, i % 2 === 0);
    setFunction(c, i, 6, i % 2 === 0);
  }
  drawFinder(c, 3, 3);
  drawFinder(c, c.size - 4, 3);
  drawFinder(c, 3, c.size - 4);

  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0);
      if (!corner) drawAlignment(c, align[i], align[j]);
    }
  }

  drawFormat(c, 0); // reserves the area; rewritten once the mask is chosen
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = c.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(c, a, b, dark);
      setFunction(c, b, a, dark);
    }
  }
}

function drawCodewords(c: Canvas, codewords: Uint8Array): void {
  let i = 0;
  for (let right = c.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column carries no data
    for (let vert = 0; vert < c.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? c.size - 1 - vert : vert;
        if (!c.reserved[y][x] && i < codewords.length * 8) {
          c.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(c: Canvas, mask: number): void {
  for (let y = 0; y < c.size; y++) {
    for (let x = 0; x < c.size; x++) {
      if (!c.reserved[y][x] && maskAt(mask, x, y)) c.modules[y][x] = !c.modules[y][x];
    }
  }
}

/** The 1:1:3:1:1 finder proportion with its quiet run, in either direction. */
const FINDER_RUN = [true, false, true, true, true, false, true, false, false, false, false];

function matchesAt(line: boolean[], at: number, pattern: boolean[]): boolean {
  for (let i = 0; i < pattern.length; i++) if (line[at + i] !== pattern[i]) return false;
  return true;
}

function linePenalty(line: boolean[]): number {
  let score = 0;
  let run = 1;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === line[i - 1]) {
      run++;
      if (run === 5) score += PENALTY_RUN;
      else if (run > 5) score++;
    } else {
      run = 1;
    }
  }
  const reversed = [...FINDER_RUN].reverse();
  for (let i = 0; i + FINDER_RUN.length <= line.length; i++) {
    if (matchesAt(line, i, FINDER_RUN)) score += PENALTY_FINDER;
    if (matchesAt(line, i, reversed)) score += PENALTY_FINDER;
  }
  return score;
}

function penalty(c: Canvas): number {
  let score = 0;
  for (let y = 0; y < c.size; y++) score += linePenalty(c.modules[y]);
  for (let x = 0; x < c.size; x++) {
    const column: boolean[] = [];
    for (let y = 0; y < c.size; y++) column.push(c.modules[y][x]);
    score += linePenalty(column);
  }
  for (let y = 0; y + 1 < c.size; y++) {
    for (let x = 0; x + 1 < c.size; x++) {
      const v = c.modules[y][x];
      if (v === c.modules[y][x + 1] && v === c.modules[y + 1][x] && v === c.modules[y + 1][x + 1]) {
        score += PENALTY_BLOCK;
      }
    }
  }
  let dark = 0;
  for (let y = 0; y < c.size; y++) for (let x = 0; x < c.size; x++) if (c.modules[y][x]) dark++;
  const total = c.size * c.size;
  score += Math.floor(Math.abs((dark * 100) / total - 50) / 5) * PENALTY_BALANCE;
  return score;
}

/**
 * The matrix, without a quiet zone — the renderer supplies the margin, because a
 * caller drawing on a dark card needs the border to be its own colour.
 *
 * Returns null when the text will not fit in version 10 or uses a character the
 * alphanumeric set has no room for. Both screens fall back to the written code,
 * which is always readable.
 */
export function qrMatrix(text: string): boolean[][] | null {
  const values: number[] = [];
  for (const ch of text) {
    const v = QR_ALNUM.indexOf(ch);
    if (v < 0) return null;
    values.push(v);
  }
  const version = chooseVersion(values.length);
  if (version === 0) return null;

  const bits: number[] = [];
  const push = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0010, 4);
  push(values.length, charCountBits(version));
  let at = 0;
  for (; at + 1 < values.length; at += 2) push(values[at] * 45 + values[at + 1], 11);
  if (at < values.length) push(values[at], 6);

  const capacity = dataCodewords(version) * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  for (let i = 0; bits.length < capacity; i++) push(i % 2 === 0 ? 0xec : 0x11, 8);

  const data = new Uint8Array(capacity / 8);
  for (let i = 0; i < bits.length; i++) data[i >>> 3] |= bits[i] << (7 - (i & 7));

  const c = blankCanvas(version * 4 + 17);
  drawFunctionPatterns(c, version);
  drawCodewords(c, addEccAndInterleave(version, data));

  let best = 0;
  let bestScore = Number.MAX_SAFE_INTEGER;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(c, mask);
    drawFormat(c, mask);
    const score = penalty(c);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
    applyMask(c, mask); // XOR is its own inverse; this restores the unmasked grid
  }
  applyMask(c, best);
  drawFormat(c, best);
  return c.modules;
}
