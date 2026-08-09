/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * INVARIANT TESTS
 *
 * These are not ordinary unit tests. Each one asserts a property from
 * docs/01-Analysis-and-Core-Requirements.md §1.4 that, if violated anywhere in
 * the codebase, means the system is broken and someone can be hurt.
 *
 * They exist because "a design principle with an executable test is worth ten
 * without one."
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nextState,
  fold,
  isActive,
  isTerminal,
  TRANSITIONS,
  INCIDENT_STATES,
  timeoutsFor,
} from '../src/t0/stateMachine.generated.ts';
import fixtures from '../src/t0/__generated__/fixtures.json' with { type: 'json' };
import { encodeSms, decodeSms, isPureAscii, toAsciiShortName, SMS_MAX } from '../src/t0/smsPayload.ts';
import {
  buildSignedEnvelope,
  canonicalise,
  padEnvelope,
  FIXED_ENVELOPE_SIZE,
  EnvelopeSizeError,
} from '../src/t0/envelope.ts';
import {
  generateDeviceKeypair,
  signEmergency,
  verifyEmergency,
  sealTo,
  openSealed,
  sealJson,
  openJson,
  incidentContentKey,
  locationStreamKey,
  shamirSplit,
  shamirCombine,
  blePseudonym,
  acceptableBleWindows,
  timingSafeEqual,
  randomBytes,
  smsTag,
} from '../src/crypto/index.ts';
import { uuidv7, inc8, nowHlc, observeHlc, compareHlc, coarseCell } from '../src/core/ids.ts';
import { DEFAULT_POLICY, effectiveCancelWindowS, ladderFor } from '../src/core/policy.ts';

const GROUP = new Uint8Array(32).fill(9);

// ═══════════════════════════════════════════════════════════════════════════════
// I-8 / P-053 · Client-generated UUIDv7, time-sortable, server never allocates
// ═══════════════════════════════════════════════════════════════════════════════
test('uuidv7 is well-formed, version 7, variant 10', () => {
  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('uuidv7 is lexicographically time-sortable', () => {
  const a = uuidv7(1_700_000_000_000);
  const b = uuidv7(1_700_000_001_000);
  assert.ok(a < b, 'later timestamp must sort after earlier');
});

test('uuidv7 is unique across a tight loop', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) seen.add(uuidv7());
  assert.equal(seen.size, 5000);
});

test('inc8 is 8 base36 chars and stable for a given id', () => {
  const id = uuidv7();
  assert.equal(inc8(id).length, 8);
  assert.equal(inc8(id), inc8(id));
  assert.match(inc8(id), /^[0-9a-z]{8}$/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// P-052 · Hybrid Logical Clocks survive a lying clock
// ═══════════════════════════════════════════════════════════════════════════════
test('HLC is monotonic even when the wall clock goes backwards', () => {
  const a = nowHlc(1_700_000_000_000);
  const b = nowHlc(1_699_999_000_000); // clock jumped 1000s BACKWARDS
  const c = nowHlc(1_699_999_000_000);
  assert.ok(compareHlc(a.hex, b.hex) < 0, 'HLC must not go backwards');
  assert.ok(compareHlc(b.hex, c.hex) < 0, 'same-ms events must still order');
});

test('HLC absorbs a peer clock that is ahead of ours', () => {
  const far = nowHlc(1_800_000_000_000);
  observeHlc(far.hex);
  const mine = nowHlc(1_700_000_000_000);
  assert.ok(compareHlc(far.hex, mine.hex) < 0, 'our clock must advance past the peer');
});

// ═══════════════════════════════════════════════════════════════════════════════
// State machine — the TS side of the SAME fixtures the Go side runs.
// If these two ever disagree, the implementations have diverged (PRD §7.5).
// ═══════════════════════════════════════════════════════════════════════════════
type Fixture = {
  name: string;
  from: string;
  expect: string;
  steps: { event: string; guards: string[] }[];
};

for (const f of fixtures as Fixture[]) {
  test(`state machine · ${f.name}`, () => {
    const events = f.steps.map((s) => ({
      event: s.event as never,
      guards: Object.fromEntries(s.guards.map((g) => [g, true])),
    }));
    assert.equal(fold(events, f.from as never), f.expect);
  });
}

test('unknown events never mutate state and never throw', () => {
  for (const s of INCIDENT_STATES) {
    assert.equal(nextState(s, 'NOT_A_REAL_EVENT' as never), null);
  }
});

test('no ambiguous (from,event,guard) triple exists', () => {
  const seen = new Map<string, string>();
  for (const t of TRANSITIONS) {
    const k = `${t.from}|${t.on}|${t.guard ?? ''}`;
    assert.equal(seen.has(k), false, `ambiguous: ${k}`);
    seen.set(k, t.to);
  }
});

test('every active state has a route out (no dead end during an emergency)', () => {
  for (const s of INCIDENT_STATES) {
    if (!isActive(s)) continue;
    const outs = TRANSITIONS.filter((t) => t.from === s);
    assert.ok(outs.length > 0, `${s} has no exit transition`);
  }
});

test('F-02 · every active state can reach DORMANT via auto-quiesce', () => {
  // Without this, a forgotten incident freezes deploys forever and leaves
  // escalation timers armed, draining the battery of the person who needs it.
  for (const s of INCIDENT_STATES) {
    if (!isActive(s) || s === 'PENDING' || s === 'RESOLVING') continue;
    assert.equal(nextState(s, 'AUTO_QUIESCE'), 'DORMANT', `${s} cannot quiesce`);
  }
});

test('terminal states are truly terminal', () => {
  for (const s of INCIDENT_STATES) {
    if (!isTerminal(s)) continue;
    assert.equal(TRANSITIONS.filter((t) => t.from === s).length, 0, `${s} is not terminal`);
  }
});

test('the duress path reaches the same tiers as the normal path', () => {
  // ACTIVE_L1_SILENT must escalate identically to ACTIVE_L1 — a duress incident
  // that stalls at L1 would be worse than useless.
  assert.equal(nextState('ACTIVE_L1_SILENT', 'NO_ACK'), 'ACTIVE_L2');
  assert.equal(nextState('ACTIVE_L1_SILENT', 'CLAIM'), 'OWNED');
});

test('timeouts are declared for every state that needs one', () => {
  assert.ok(timeoutsFor('ACTIVE_L1').some((t) => t.on === 'NO_ACK' && t.afterS === 90));
  assert.ok(timeoutsFor('ACTIVE_L2').some((t) => t.on === 'NO_ACK' && t.afterS === 180));
  assert.ok(timeoutsFor('OWNED').some((t) => t.on === 'PROGRESS_WATCHDOG' && t.afterS === 300));
});

// ═══════════════════════════════════════════════════════════════════════════════
// ★ INVARIANT I-2 · THE SMS PAYLOAD IS PURE ASCII AND ≤160 CHARS ★
// P-033: one Devanagari character converts GSM-7 → UCS-2 and cuts the limit
// from 160 to SEVENTY. This is the test the PRD explicitly demands.
// ═══════════════════════════════════════════════════════════════════════════════
const smsBase = {
  incidentId: uuidv7(),
  trigger: 'CRASH' as const,
  lat: 20.945123,
  lon: 72.932011,
  accuracyM: 12,
  batteryPct: 43,
  atMs: 1_700_000_000_000,
  groupSecret: GROUP,
};

test('I-2 · SMS payload is pure ASCII and within 160 chars', () => {
  const out = encodeSms({ ...smsBase, asciiShortName: 'PRIYA' });
  assert.ok(out.isAscii, 'payload must be pure ASCII');
  assert.ok(out.length <= SMS_MAX, `payload is ${out.length} chars, max ${SMS_MAX}`);
  for (let i = 0; i < out.text.length; i++) {
    const c = out.text.charCodeAt(i);
    assert.ok(c >= 32 && c <= 126, `non-GSM7 char at ${i}: ${c}`);
  }
});

test('I-2 · a Devanagari or Gujarati name cannot leak into the payload', () => {
  for (const name of ['प्रिया', 'પ્રિયા', '日本語', 'Ωμέγα', 'Priyà']) {
    const out = encodeSms({ ...smsBase, asciiShortName: toAsciiShortName(name) });
    assert.ok(out.isAscii, `"${name}" produced a non-ASCII payload`);
    assert.ok(out.length <= SMS_MAX);
  }
});

test('I-2 · holds for every trigger type and extreme coordinates', () => {
  const triggers = ['MANUAL', 'CRASH', 'FALL', 'NO_MOTION', 'DEADMAN', 'GEOFENCE',
    'SENSOR_HOME', 'DEVICE_SILENCED', 'BLE_FOB', 'VOICE_PHRASE', 'RELAY', 'DRILL'] as const;
  for (const trigger of triggers) {
    for (const [lat, lon] of [[-89.999999, -179.999999], [89.999999, 179.999999], [0, 0]]) {
      const out = encodeSms({
        ...smsBase, trigger, lat, lon, asciiShortName: 'ABCDEFGH',
        accuracyM: 9999, batteryPct: 100,
      });
      assert.ok(out.isAscii && out.length <= SMS_MAX,
        `${trigger} @ ${lat},${lon} → ${out.length} chars, ascii=${out.isAscii}`);
    }
  }
});

test('SMS round-trips and the HMAC verifies', () => {
  const out = encodeSms({ ...smsBase, asciiShortName: 'PRIYA' });
  const back = decodeSms(out.text, GROUP);
  assert.ok(back, 'must decode');
  assert.equal(back!.verified, true, 'HMAC must verify');
  assert.ok(Math.abs(back!.lat - smsBase.lat) < 1e-5);
  assert.ok(Math.abs(back!.lon - smsBase.lon) < 1e-5);
  assert.equal(back!.inc8, inc8(smsBase.incidentId));
});

test('ADR-018 · a tampered SMS still decodes, flagged unverified — never dropped', () => {
  const out = encodeSms({ ...smsBase, asciiShortName: 'PRIYA' });
  const tampered = out.text.replace('20.945123', '20.945124');
  const back = decodeSms(tampered, GROUP);
  assert.ok(back, 'fail open: a tampered payload is still an incident');
  assert.equal(back!.verified, false, 'but it must be flagged');
});

test('the human-readable tail repeats the coordinates as plain text (P-051)', () => {
  // Carriers strip and filter links. The raw lat,lon pair IS the payload.
  const out = encodeSms({ ...smsBase, asciiShortName: 'PRIYA' });
  const occurrences = out.text.split('20.945123').length - 1;
  assert.ok(occurrences >= 2, 'coordinates must appear in both the machine part and the tail');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ★ INVARIANT I-7 · DURESS IS INDISTINGUISHABLE ON THE WIRE ★
// Finding F-01: the PRD's constant-size claim rested on a false premise about
// proto3 (a `false` bool is omitted entirely). Here we assert the property
// directly — this is chaos test T-213, automated.
// ═══════════════════════════════════════════════════════════════════════════════
const envBase = {
  incidentId: uuidv7(),
  familyId: uuidv7(),
  deviceId: uuidv7(),
  memberId: uuidv7(),
  trigger: 'MANUAL' as const,
  confidencePct: 100,
  riskContext: 2 as const,
  isDrill: false,
  policyVersion: 1,
  coarseCell: coarseCell(20.94, 72.93),
  batteryPct: 43,
  sealedPayload: 'x'.repeat(200),
};

test('I-7 · a duress envelope is byte-for-byte the same size as a normal one', () => {
  const kp = generateDeviceKeypair();
  const normal = buildSignedEnvelope({ ...envBase, duress: false }, kp);
  const duress = buildSignedEnvelope({ ...envBase, duress: true }, kp);
  const n = new TextEncoder().encode(normal.body).length;
  const d = new TextEncoder().encode(duress.body).length;
  assert.equal(n, FIXED_ENVELOPE_SIZE);
  assert.equal(d, FIXED_ENVELOPE_SIZE);
  assert.equal(n, d, 'duress must not be distinguishable by size');
});

test('I-7 · holds across 200 randomised envelopes', () => {
  const kp = generateDeviceKeypair();
  for (let i = 0; i < 200; i++) {
    const duress = i % 2 === 0;
    const e = buildSignedEnvelope(
      { ...envBase, incidentId: uuidv7(), duress, sealedPayload: 'y'.repeat(50 + (i % 300)) },
      kp,
    );
    assert.equal(new TextEncoder().encode(e.body).length, FIXED_ENVELOPE_SIZE);
  }
});

test('I-7 · the duress field is ALWAYS serialised, both values (F-01)', () => {
  const forFalse = canonicalise({ ...envBase, v: 1, duress: false, clientTsMs: 0, hlc: '', flags: 0, pad: '' } as never);
  const forTrue = canonicalise({ ...envBase, v: 1, duress: true, clientTsMs: 0, hlc: '', flags: 0, pad: '' } as never);
  assert.ok(forFalse.includes('"duress":false'), 'false must appear on the wire');
  assert.ok(forTrue.includes('"duress":true'));
});

test('F-01 · padding fails CLOSED when the payload cannot fit', () => {
  // A mis-padded envelope silently leaks the duress bit, so we would rather
  // refuse to build it than emit a variable-size one.
  const kp = generateDeviceKeypair();
  assert.throws(
    () => buildSignedEnvelope({ ...envBase, duress: true, sealedPayload: 'z'.repeat(5000) }, kp),
    EnvelopeSizeError,
  );
  assert.equal(padEnvelope({ ...envBase, v: 1, duress: true, clientTsMs: 0, hlc: '', flags: 0, pad: '', sealedPayload: 'z'.repeat(5000) } as never), null);
});

test('the envelope signature verifies with the emergency key', () => {
  const kp = generateDeviceKeypair();
  const e = buildSignedEnvelope({ ...envBase, duress: false }, kp);
  const body = new TextEncoder().encode(e.body);
  const sig = Uint8Array.from(atob(e.signature), (c) => c.charCodeAt(0));
  assert.equal(verifyEmergency(sig, body, kp.emergencyPublic), true);
});

test('P-007 · the emergency key is separate from the identity key', () => {
  // An unconscious person cannot provide a fingerprint. The emergency key is
  // deliberately NOT biometric-gated, so it must be a DIFFERENT key.
  const kp = generateDeviceKeypair();
  assert.notDeepEqual(kp.emergencyPublic, kp.identityPublic);
  const msg = new TextEncoder().encode('incident');
  const sig = signEmergency(msg, kp);
  assert.equal(verifyEmergency(sig, msg, kp.emergencyPublic), true);
  assert.equal(verifyEmergency(sig, msg, kp.identityPublic), false);
});

// ═══════════════════════════════════════════════════════════════════════════════
// I-3 / T3 · The server sees ciphertext. GroupBox (ADR-021).
// ═══════════════════════════════════════════════════════════════════════════════
test('sealed content is opaque and round-trips', () => {
  const key = incidentContentKey(GROUP, 'incident-1');
  const secret = { lat: 20.945123, lon: 72.932011, note: 'home address' };
  const sealed = sealJson(key, secret);
  assert.ok(!sealed.includes('20.94'), 'plaintext must not survive in the ciphertext');
  assert.deepEqual(openJson(key, sealed), secret);
});

test('a wrong key cannot open sealed content, and fails soft', () => {
  const sealed = sealJson(incidentContentKey(GROUP, 'a'), { x: 1 });
  assert.equal(openJson(incidentContentKey(GROUP, 'b'), sealed), null);
  assert.equal(openJson(new Uint8Array(32), 'not-even-base64!!'), null);
});

test('AAD binding rejects a payload replayed into another context', () => {
  const key = incidentContentKey(GROUP, 'a');
  const sealed = sealJson(key, { x: 1 }, 'incident-a');
  assert.deepEqual(openJson(key, sealed, 'incident-a'), { x: 1 });
  assert.equal(openJson(key, sealed, 'incident-b'), null);
});

test('F-19 · location stream keys rotate per 5-minute window', () => {
  const w1 = locationStreamKey(GROUP, 1000);
  const w2 = locationStreamKey(GROUP, 1001);
  assert.notDeepEqual(w1, w2);
  assert.deepEqual(w1, locationStreamKey(GROUP, 1000), 'must be deterministic');
});

test('sealed-box distribution of the group secret works device-to-device', () => {
  const alice = generateDeviceKeypair();
  const sealed = sealTo(alice.boxPublic, GROUP);
  assert.deepEqual(openSealed(alice, sealed), GROUP);
  assert.equal(openSealed(generateDeviceKeypair(), sealed), null, 'another device must fail');
});

// ═══════════════════════════════════════════════════════════════════════════════
// P-010 · Key loss must not destroy everything. Shamir 2-of-3.
// ═══════════════════════════════════════════════════════════════════════════════
test('Shamir 2-of-3 reconstructs from ANY two shares', () => {
  const secret = randomBytes(32);
  const shares = shamirSplit(secret, 3, 2);
  assert.equal(shares.length, 3);
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
    assert.deepEqual(shamirCombine([shares[i], shares[j]]), secret, `shares ${i}+${j} failed`);
  }
});

test('Shamir · a single share reveals nothing', () => {
  const secret = new Uint8Array(32).fill(0xab);
  const shares = shamirSplit(secret, 3, 2);
  for (const s of shares) assert.notDeepEqual(s.data, secret);
});

test('Shamir works for a 4th offsite share (2-of-4)', () => {
  const secret = randomBytes(32);
  const shares = shamirSplit(secret, 4, 2);
  assert.deepEqual(shamirCombine([shares[1], shares[3]]), secret);
});

// ═══════════════════════════════════════════════════════════════════════════════
// F-12 · BLE pseudonym must tolerate clock skew at window boundaries
// ═══════════════════════════════════════════════════════════════════════════════
test('F-12 · scanners accept the previous, current and next BLE window', () => {
  const at = 1_700_000_000_000;
  const windows = acceptableBleWindows(at);
  assert.equal(windows.length, 3);
  // A device 1 second across the boundary must still be recognised.
  const justAfterBoundary = Math.ceil(at / 900_000) * 900_000 + 1000;
  const theirWindow = Math.floor(justAfterBoundary / 900_000);
  assert.ok(
    windows.includes(theirWindow),
    'a peer just across a 15-minute boundary must still be recognised',
  );
});

test('BLE pseudonyms are deterministic per window and unlinkable across them', () => {
  assert.deepEqual(blePseudonym(GROUP, 100), blePseudonym(GROUP, 100));
  assert.notDeepEqual(blePseudonym(GROUP, 100), blePseudonym(GROUP, 101));
  assert.notDeepEqual(blePseudonym(GROUP, 100), blePseudonym(new Uint8Array(32).fill(1), 100));
});

// ═══════════════════════════════════════════════════════════════════════════════
// Constant-time comparison (the duress PIN path)
// ═══════════════════════════════════════════════════════════════════════════════
test('timingSafeEqual is correct for equal, unequal and different-length inputs', () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
  assert.equal(timingSafeEqual(new Uint8Array(0), new Uint8Array(0)), true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// §10.2 · The coarse cell must be too coarse to identify a home
// ═══════════════════════════════════════════════════════════════════════════════
test('coarseCell collapses ~1 km of movement to one identifier', () => {
  const home = coarseCell(20.9463, 72.9520);
  assert.equal(coarseCell(20.9469, 72.9528), home, 'sub-100m movement must not change the cell');
  assert.notEqual(coarseCell(20.9863, 72.9520), home, '~4km away must differ');
  assert.ok(!home.includes('20.9463'), 'the precise coordinate must not survive');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Escalation policy — data, not code (ADR-013)
// ═══════════════════════════════════════════════════════════════════════════════
test('a child geofence breach is the slowest, quietest policy and never reaches neighbours', () => {
  const g = DEFAULT_POLICY.scenarios.GEOFENCE;
  assert.equal(g.allowNeighbours, false, 'a child breach must NEVER reach neighbours');
  assert.ok(g.cancelWindowS >= 300, 'deliberately slow');
  assert.ok(
    g.cancelWindowS > DEFAULT_POLICY.scenarios.MANUAL.cancelWindowS,
    'must be slower than a manual panic',
  );
});

test('risk context shortens the cancel window (PRD §13.5)', () => {
  const calm = effectiveCancelWindowS(DEFAULT_POLICY, 'MANUAL', 0);
  const tense = effectiveCancelWindowS(DEFAULT_POLICY, 'MANUAL', 4);
  assert.ok(tense < calm, `risk 4 (${tense}s) must be shorter than risk 0 (${calm}s)`);
  assert.ok(tense >= 5, 'but never below a floor a human can react within');
});

test('P-017 · repeated false positives LENGTHEN the window for that device', () => {
  const base = effectiveCancelWindowS(DEFAULT_POLICY, 'MANUAL', 2, 0);
  const afterFps = effectiveCancelWindowS(DEFAULT_POLICY, 'MANUAL', 2, 3);
  assert.ok(afterFps > base, 'an accident-prone device gets more time to cancel');
});

test('the ladder is monotonically increasing in time and reaches tier 3', () => {
  const ladder = ladderFor(DEFAULT_POLICY, 'MANUAL');
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(ladder[i].atS >= ladder[i - 1].atS, 'ladder steps must not go backwards');
  }
  assert.equal(ladder[ladder.length - 1].tier, 3);
});

test('every trigger type has a policy — no scenario falls through undefined', () => {
  const triggers = ['MANUAL', 'CRASH', 'FALL', 'NO_MOTION', 'DEADMAN', 'GEOFENCE',
    'SENSOR_HOME', 'DEVICE_SILENCED', 'BLE_FOB', 'VOICE_PHRASE', 'RELAY', 'DRILL'] as const;
  for (const t of triggers) {
    assert.ok(DEFAULT_POLICY.scenarios[t], `${t} has no policy`);
    assert.ok(DEFAULT_POLICY.scenarios[t].l2AfterS > 0);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SMS tag stability (the server must recompute it identically)
// ═══════════════════════════════════════════════════════════════════════════════
test('smsTag is deterministic, 8 chars, and URL-safe', () => {
  const tag = smsTag(GROUP, 'K1|abc|PRIYA|SOS|20.9,72.9|10|50|xyz');
  assert.equal(tag.length, 8);
  assert.equal(tag, smsTag(GROUP, 'K1|abc|PRIYA|SOS|20.9,72.9|10|50|xyz'));
  assert.match(tag, /^[A-Za-z0-9\-_]{8}$/);
});
