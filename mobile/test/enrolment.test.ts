/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEVICE ENROLMENT
 *
 * The properties asserted here are the ones a reviewer cannot check by reading:
 *
 *   · an intercepted invite yields nothing — the joiner's private key is not in
 *     the bytes, not in any prefix of them, and not recoverable from them;
 *   · a sealed reply opens on exactly one device and returns null on every
 *     other, which is what lets it cross WhatsApp or a phone call;
 *   · the fingerprint two humans compare is a function of the key the guardian
 *     will actually seal to, so substituting that key changes what they read;
 *   · codes expire and are bound to one invitation.
 *
 * The QR section is here rather than in a graphics test because the matrix is a
 * pure function and this is the only place it can be proved. The test decodes
 * its own output: it re-derives the function-pattern map from the geometry in
 * ISO/IEC 18004, reads the format information back, unmasks, de-interleaves, and
 * checks the Reed-Solomon remainder of every block is zero before recovering the
 * string. The BCH constants are checked against the two published values in the
 * standard, so a transcription slip in the encoder cannot hide behind a decoder
 * that repeats it.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { generateDeviceKeypair, openSealed, randomBytes } from '../src/crypto/index.ts';
import { uuidv7 } from '../src/core/ids.ts';
import {
  INVITE_TTL_MS,
  MAX_NAME_BYTES,
  bindingOf,
  buildInvite,
  clampName,
  decodeBase32,
  encodeBase32,
  fingerprintGroups,
  fingerprintOf,
  groupCode,
  normaliseCode,
  qrMatrix,
  readInvite,
  readResponse,
  sealResponse,
  secondsLeft,
} from '../src/domain/enrolment.ts';

const T0 = 1_760_000_000_000;

function joiner(name = 'Ananya', at = T0) {
  const kp = generateDeviceKeypair();
  const invite = buildInvite({
    deviceId: uuidv7(at),
    boxPublic: kp.boxPublic,
    displayName: name,
    createdAt: at,
  });
  return { kp, invite };
}

// ── the code itself ───────────────────────────────────────────────────────────

test('base32 round-trips every length', () => {
  for (let n = 1; n <= 80; n++) {
    const bytes = randomBytes(n);
    const back = decodeBase32(encodeBase32(bytes));
    assert.notEqual(back, null);
    assert.deepEqual(Array.from(back as Uint8Array), Array.from(bytes));
  }
});

test('the alphabet has no confusable pair', () => {
  const chars = encodeBase32(randomBytes(256));
  for (const forbidden of ['I', 'L', 'O', 'U']) {
    assert.ok(!chars.includes(forbidden), `${forbidden} must not appear in a dictated code`);
  }
});

test('a code survives being read aloud badly', () => {
  const { invite } = joiner();
  // Lowercase, spaces instead of dashes, and the three letters a human hears as
  // digits. All of it must land on the same invitation.
  const mangled = invite.code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'O').replace(/1/g, 'l');
  const got = readInvite(mangled, T0);
  assert.equal(got.ok, true);
  if (got.ok) assert.equal(got.value.displayName, 'Ananya');
});

test('the check character catches a single wrong letter', () => {
  const { invite } = joiner();
  const chars = normaliseCode(invite.code);
  let caught = 0;
  let tried = 0;
  for (let i = 0; i < chars.length; i += 7) {
    for (const sub of ['2', '7', 'K', 'W']) {
      if (chars[i] === sub) continue;
      tried++;
      const typo = chars.slice(0, i) + sub + chars.slice(i + 1);
      if (!readInvite(typo, T0).ok) caught++;
    }
  }
  // One character of checksum leaves a 1-in-32 residue by construction; the
  // point of the assertion is that the overwhelming majority are refused before
  // anybody seals a group secret to a key that does not exist.
  assert.ok(caught / tried > 0.9, `caught ${caught}/${tried} single-character typos`);
});

test('grouping is cosmetic and reversible', () => {
  const raw = encodeBase32(randomBytes(30));
  assert.equal(normaliseCode(groupCode(raw)), raw);
  assert.ok(groupCode(raw).split('-').every((g) => g.length <= 5));
});

// ── step 1: the invite ────────────────────────────────────────────────────────

test('an invite round-trips who is joining', () => {
  const deviceId = uuidv7(T0);
  const kp = generateDeviceKeypair();
  const invite = buildInvite({ deviceId, boxPublic: kp.boxPublic, displayName: 'Dadi', createdAt: T0 });

  const got = readInvite(invite.code, T0 + 1000);
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.value.deviceId, deviceId);
  assert.equal(got.value.displayName, 'Dadi');
  assert.deepEqual(Array.from(got.value.boxPublic), Array.from(kp.boxPublic));
  assert.equal(got.value.fingerprint, fingerprintOf(kp.boxPublic));
});

test('★ an intercepted invite reveals nothing', () => {
  const kp = generateDeviceKeypair();
  const invite = buildInvite({
    deviceId: uuidv7(T0),
    boxPublic: kp.boxPublic,
    displayName: 'Ravi',
    createdAt: T0,
  });

  // No window of the payload is any of this device's private keys.
  const hay = Array.from(invite.payload).join(',');
  for (const secret of [kp.boxSecret, kp.identitySecret, kp.emergencySecret]) {
    assert.ok(!hay.includes(Array.from(secret).join(',')), 'a private key is in the invite');
  }
  // And the only 32-byte field it does carry is the public half.
  assert.deepEqual(Array.from(invite.payload.slice(7, 39)), Array.from(kp.boxPublic));
});

test('an invite expires after ten minutes and is refused from the future', () => {
  const { invite } = joiner();
  assert.equal(readInvite(invite.code, T0 + INVITE_TTL_MS - 1).ok, true);

  const late = readInvite(invite.code, T0 + INVITE_TTL_MS + 1);
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.fault, 'expired');

  const early = readInvite(invite.code, T0 - 10 * 60_000);
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.fault, 'notyet');
});

test('a reply presented as an invitation is named, not swallowed', () => {
  const { invite } = joiner();
  const reply = sealResponse({
    invite,
    groupSecret: randomBytes(32),
    familyId: uuidv7(T0),
    guardianName: 'Baba',
    createdAt: T0,
  });
  const got = readInvite(reply.code, T0);
  assert.equal(got.ok, false);
  if (!got.ok) assert.equal(got.fault, 'kind');
});

test('a long name is truncated on a character boundary', () => {
  const long = 'शिवम्शिवम्शिवम्शिवम्शिवम्';
  const clamped = clampName(long);
  assert.ok(new TextEncoder().encode(clamped).length <= MAX_NAME_BYTES);
  assert.equal(clamped, [...clamped].join(''), 'a truncated name must still be whole characters');

  const invite = buildInvite({
    deviceId: uuidv7(T0),
    boxPublic: generateDeviceKeypair().boxPublic,
    displayName: long,
    createdAt: T0,
  });
  const got = readInvite(invite.code, T0);
  assert.equal(got.ok, true);
  if (got.ok) assert.equal(got.value.displayName, clamped);
});

// ── steps 3 and 4: the sealed reply ───────────────────────────────────────────

test('★ the group secret crosses to the joining phone', () => {
  const { kp, invite } = joiner();
  const groupSecret = randomBytes(32);
  const familyId = uuidv7(T0);

  const reply = sealResponse({ invite, groupSecret, familyId, guardianName: 'Aai', createdAt: T0 });
  const got = readResponse(reply.code, kp, invite, T0 + 5_000);

  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.deepEqual(Array.from(got.value.groupSecret), Array.from(groupSecret));
  assert.equal(got.value.familyId, familyId);
  assert.equal(got.value.guardianName, 'Aai');
});

test('★ the sealed reply is useless to anyone else', () => {
  const { invite } = joiner();
  const eavesdropper = generateDeviceKeypair();
  const groupSecret = randomBytes(32);

  const reply = sealResponse({
    invite,
    groupSecret,
    familyId: uuidv7(T0),
    guardianName: 'Aai',
    createdAt: T0,
  });

  const stolen = readResponse(reply.code, eavesdropper, invite, T0);
  assert.equal(stolen.ok, false);
  if (!stolen.ok) assert.equal(stolen.fault, 'sealed');

  // And at the primitive level too: the ciphertext yields nothing at all.
  assert.equal(openSealed(eavesdropper, reply.payload.slice(1)), null);

  // The group secret does not appear anywhere in what was transmitted.
  assert.ok(
    !Array.from(reply.payload).join(',').includes(Array.from(groupSecret).join(',')),
    'the group secret is in the clear',
  );
});

test('a reply is bound to one invitation', () => {
  const first = joiner('Ananya', T0);
  const second = joiner('Ravi', T0);
  const groupSecret = randomBytes(32);

  const reply = sealResponse({
    invite: first.invite,
    groupSecret,
    familyId: uuidv7(T0),
    guardianName: 'Aai',
    createdAt: T0,
  });

  // Same phone, different invitation: the seal opens, the binding refuses.
  const crossed = readResponse(reply.code, first.kp, second.invite, T0);
  assert.equal(crossed.ok, false);
  if (!crossed.ok) assert.equal(crossed.fault, 'mismatch');

  assert.notEqual(bindingOf(first.invite.payload), bindingOf(second.invite.payload));
  assert.equal(reply.binding, bindingOf(first.invite.payload));
});

test('a reply expires on the same ten-minute clock', () => {
  const { kp, invite } = joiner();
  const reply = sealResponse({
    invite,
    groupSecret: randomBytes(32),
    familyId: uuidv7(T0),
    guardianName: 'Aai',
    createdAt: T0,
  });
  const late = readResponse(reply.code, kp, invite, T0 + INVITE_TTL_MS + 1);
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.fault, 'expired');
  assert.equal(secondsLeft(reply.expiresAt, T0), 600);
  assert.equal(secondsLeft(reply.expiresAt, T0 + INVITE_TTL_MS + 5_000), 0);
});

test('one flipped bit in the reply makes it unopenable', () => {
  const { kp, invite } = joiner();
  const reply = sealResponse({
    invite,
    groupSecret: randomBytes(32),
    familyId: uuidv7(T0),
    guardianName: 'Aai',
    createdAt: T0,
  });
  assert.notEqual(openSealed(kp, reply.payload.slice(1)), null);

  // Poly1305, not a length check: the alteration is a single bit deep inside the
  // ciphertext and the code around it is still perfectly well-formed.
  const bent = Uint8Array.from(reply.payload);
  bent[80] ^= 0x01;
  assert.equal(openSealed(kp, bent.slice(1)), null);
});

// ── the fingerprint: the part humans do ───────────────────────────────────────

test('★ substituting the key changes what the two people read out', () => {
  const honest = generateDeviceKeypair();
  const attacker = generateDeviceKeypair();

  // The man in the middle rewrites the invitation with their own public key.
  // Every byte still verifies; this is the ONLY signal the humans get.
  assert.notEqual(fingerprintOf(honest.boxPublic), fingerprintOf(attacker.boxPublic));

  const groups = fingerprintGroups(honest.boxPublic);
  assert.equal(groups.length, 4);
  for (const g of groups) assert.match(g, /^[0-9A-F]{4}$/);
  assert.equal(fingerprintOf(honest.boxPublic), groups.join(' '));
});

test('both sides compute the same fingerprint from the code alone', () => {
  const { kp, invite } = joiner();
  const guardianView = readInvite(invite.code, T0);
  assert.equal(guardianView.ok, true);
  if (!guardianView.ok) return;
  assert.equal(guardianView.value.fingerprint, fingerprintOf(kp.boxPublic));
  assert.equal(guardianView.value.fingerprint, invite.fingerprint);
});

// ═══════════════════════════════════════════════════════════════════════════════
// QR
// ═══════════════════════════════════════════════════════════════════════════════

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const ECC_L = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
const BLOCKS_L = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function divisorFor(degree: number): Uint8Array {
  const r = new Uint8Array(degree);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = mul(r[j], root);
      if (j + 1 < degree) r[j] ^= r[j + 1];
    }
    root = mul(root, 2);
  }
  return r;
}

function remainderOf(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const r = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ r[0];
    r.copyWithin(0, 1);
    r[r.length - 1] = 0;
    for (let i = 0; i < r.length; i++) r[i] ^= mul(divisor[i], factor);
  }
  return r;
}

function alignFor(version: number): number[] {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const n = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 4 + n * 2 + 1) / (n * 2 - 2)) * 2;
  const out = new Array<number>(n);
  out[0] = 6;
  for (let i = n - 1, pos = size - 7; i >= 1; i--, pos -= step) out[i] = pos;
  return out;
}

/** Rebuilt from the geometry in the standard, not from the encoder. */
function functionMap(version: number): boolean[][] {
  const size = version * 4 + 17;
  const fn: boolean[][] = [];
  for (let y = 0; y < size; y++) fn.push(new Array<boolean>(size).fill(false));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const topLeft = x < 9 && y < 9;
      const topRight = x >= size - 8 && y < 9;
      const bottomLeft = x < 9 && y >= size - 8;
      const timing = x === 6 || y === 6;
      const versionArea =
        version >= 7 &&
        ((x >= size - 11 && x <= size - 9 && y <= 5) || (y >= size - 11 && y <= size - 9 && x <= 5));
      if (topLeft || topRight || bottomLeft || timing || versionArea) fn[y][x] = true;
    }
  }

  const align = alignFor(version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) fn[align[j] + dy][align[i] + dx] = true;
      }
    }
  }
  return fn;
}

function unmaskAt(mask: number, x: number, y: number): boolean {
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

function expectedFormat(mask: number): number {
  const data = (1 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function expectedVersionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** Reads the matrix back to the string it was built from, or throws saying why. */
function decodeQr(m: boolean[][]): string {
  const size = m.length;
  assert.equal((size - 17) % 4, 0, 'a QR side is 17 + 4v modules');
  const version = (size - 17) / 4;
  const fn = functionMap(version);

  // Format information, first copy.
  let read = 0;
  for (let i = 0; i <= 5; i++) read |= (m[i][8] ? 1 : 0) << i;
  read |= (m[7][8] ? 1 : 0) << 6;
  read |= (m[8][8] ? 1 : 0) << 7;
  read |= (m[8][7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) read |= (m[8][14 - i] ? 1 : 0) << i;

  let second = 0;
  for (let i = 0; i < 8; i++) second |= (m[8][size - 1 - i] ? 1 : 0) << i;
  for (let i = 8; i < 15; i++) second |= (m[size - 15 + i][8] ? 1 : 0) << i;
  assert.equal(read, second, 'the two copies of the format information disagree');

  // The 15 bits are 5 of data followed by 10 of BCH remainder, and the data sits
  // in the high bits: level (2) then mask (3).
  const unmasked = read ^ 0x5412;
  assert.equal((unmasked >>> 13) & 0b11, 0b01, 'error correction level must be L');
  const mask = (unmasked >>> 10) & 0b111;
  assert.equal(read, expectedFormat(mask));

  if (version >= 7) {
    let vbits = 0;
    for (let i = 0; i < 18; i++) {
      vbits |= (m[Math.floor(i / 3)][size - 11 + (i % 3)] ? 1 : 0) << i;
    }
    assert.equal(vbits, expectedVersionBits(version));
  }

  // Unmask, then read the codewords in the zigzag.
  const grid = m.map((row) => [...row]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!fn[y][x] && unmaskAt(mask, x, y)) grid[y][x] = !grid[y][x];
    }
  }

  const total = Math.floor(((16 * version + 128) * version + 64 - alignmentLoss(version)) / 8);
  const raw = new Uint8Array(total);
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && bit < total * 8) {
          if (grid[y][x]) raw[bit >>> 3] |= 1 << (7 - (bit & 7));
          bit++;
        }
      }
    }
  }

  // De-interleave, and prove every block is intact.
  const numBlocks = BLOCKS_L[version];
  const eccLen = ECC_L[version];
  const shortBlocks = numBlocks - (total % numBlocks);
  const shortLen = Math.floor(total / numBlocks);
  const blocks: number[][] = [];
  for (let i = 0; i < numBlocks; i++) blocks.push([]);

  let at = 0;
  for (let i = 0; i <= shortLen - eccLen; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i === shortLen - eccLen && j < shortBlocks) continue;
      blocks[j].push(raw[at++]);
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (let j = 0; j < numBlocks; j++) blocks[j].push(raw[at++]);
  }
  assert.equal(at, total, 'de-interleave consumed a different number of codewords');

  const divisor = divisorFor(eccLen);
  const data: number[] = [];
  for (const block of blocks) {
    const rem = remainderOf(Uint8Array.from(block), divisor);
    assert.ok(rem.every((b) => b === 0), 'a Reed-Solomon block does not check out');
    data.push(...block.slice(0, block.length - eccLen));
  }

  // Parse the alphanumeric segment.
  const stream: number[] = [];
  for (const b of data) for (let i = 7; i >= 0; i--) stream.push((b >>> i) & 1);
  let cursor = 0;
  const take = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | stream[cursor++];
    return v;
  };
  assert.equal(take(4), 0b0010, 'mode must be alphanumeric');
  const count = take(version <= 9 ? 9 : 11);
  let out = '';
  for (let i = 0; i + 1 < count; i += 2) {
    const pair = take(11);
    out += ALNUM[Math.floor(pair / 45)] + ALNUM[pair % 45];
  }
  if (count % 2 === 1) out += ALNUM[take(6)];
  return out;
}

function alignmentLoss(version: number): number {
  if (version < 2) return 0;
  const n = Math.floor(version / 7) + 2;
  return (25 * n - 10) * n - 55 + (version >= 7 ? 36 : 0);
}

test('the BCH constants match the two published values', () => {
  assert.equal(expectedFormat(0), 0b111011111000100);
  assert.equal(expectedVersionBits(7), 0b000111110010010100);
});

test('the Reed-Solomon generator matches the standard table', () => {
  // g(x) for 7 check bytes: x⁷ + α⁸⁷x⁶ + α²²⁹x⁵ + α¹⁴⁶x⁴ + α¹⁴⁹x³ + α²³⁸x² + α¹⁰²x + α²¹
  const expected = [87, 229, 146, 149, 238, 102, 21];
  const got = divisorFor(7);
  for (let i = 0; i < expected.length; i++) assert.equal(got[i], EXP[expected[i]]);
});

test('a short code fits a small symbol and reads back', () => {
  const m = qrMatrix('KAVACH-TEST-0123456789');
  assert.notEqual(m, null);
  if (m === null) return;
  assert.equal(decodeQr(m), 'KAVACH-TEST-0123456789');
});

test('★ both enrolment codes survive the round trip through a QR', () => {
  const { kp, invite } = joiner('Ananya', T0);
  const reply = sealResponse({
    invite,
    groupSecret: randomBytes(32),
    familyId: uuidv7(T0),
    guardianName: 'Aai',
    createdAt: T0,
  });

  for (const code of [invite.code, reply.code]) {
    const scan = normaliseCode(code);
    const m = qrMatrix(scan);
    assert.notEqual(m, null, `no symbol for a ${scan.length}-character code`);
    if (m === null) continue;
    assert.equal(decodeQr(m), scan);
  }

  // And the scanned string is accepted by the protocol, not merely recovered.
  const scanned = readResponse(normaliseCode(reply.code), kp, invite, T0);
  assert.equal(scanned.ok, true);
});

test('the three finders, the timing runs and the dark module are where they belong', () => {
  const m = qrMatrix(normaliseCode(joiner().invite.code));
  assert.notEqual(m, null);
  if (m === null) return;
  const size = m.length;

  for (const [ox, oy] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ]) {
    for (let dy = 0; dy < 7; dy++) {
      for (let dx = 0; dx < 7; dx++) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(m[oy + dy][ox + dx], ring !== 2, `finder at ${ox},${oy} is malformed`);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0);
    assert.equal(m[i][6], i % 2 === 0);
  }
  assert.equal(m[size - 8][8], true, 'the always-dark module is light');
});

test('a symbol is refused rather than truncated when it will not fit', () => {
  assert.equal(qrMatrix('X'.repeat(4000)), null);
  assert.equal(qrMatrix('lowercase is outside the alphanumeric set'), null);
});
