/**
 * Emits cross-language conformance vectors.
 *
 * The client (TypeScript) builds and signs the emergency envelope; the server
 * (Go) verifies it. Both sides implement canonicalisation independently, and
 * NOTHING has ever proven they agree byte-for-byte.
 *
 * If they diverge by so much as a space, the Ed25519 signature fails on every
 * real incident. And because the ingest path fails OPEN by design (ADR-018), it
 * would not error — it would silently flag 100% of genuine emergencies
 * UNVERIFIED and keep going. That is the worst possible failure shape: invisible
 * in testing, invisible in production, and it defeats the entire signature layer
 * exactly when it matters.
 *
 * The same applies to the SMS payload (the T0 encoder here, the aggregator
 * webhook parser there) and to the inc8 prefix that reconciles an SMS-originated
 * incident with its HTTP twin (F-09).
 *
 * Run:  npm run gen:vectors
 *
 * The file is written with fs, NOT via shell redirection: PowerShell's `>`
 * prepends a UTF-8 BOM, and Go's encoding/json rejects a leading BOM with
 * "invalid character 'ï'". A build step whose correctness depends on which
 * shell invoked it is a build step that breaks on someone else's machine.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSignedEnvelope, FIXED_ENVELOPE_SIZE } from '../src/t0/envelope.ts';
import { encodeSms, TRIGGER_CODE } from '../src/t0/smsPayload.ts';
import { generateDeviceKeypair, bytesToBase64, smsTag } from '../src/crypto/index.ts';
import { inc8, coarseCell } from '../src/core/ids.ts';
import type { TriggerType } from '../src/core/types.ts';

// Fixed inputs — deterministic so the Go side can assert exact equality.
const GROUP = new Uint8Array(32);
for (let i = 0; i < 32; i++) GROUP[i] = i * 7;

const FAMILY = '11111111-1111-7111-8111-111111111111';
const DEVICE = '33333333-3333-7333-8333-333333333333';
const MEMBER = '22222222-2222-7222-8222-222222222222';

const kp = generateDeviceKeypair();

interface EnvelopeVector {
  name: string;
  body: string;
  signature: string;
  publicKey: string;
  duress: boolean;
  byteLength: number;
}

const envelopes: EnvelopeVector[] = [];

// Both duress values, and a range of payload sizes, because the constant-size
// property (F-01 / threat T4) is the thing most likely to break under refactor.
const cases: { name: string; duress: boolean; sealed: string; trigger: TriggerType }[] = [
  { name: 'manual-normal', duress: false, sealed: 'x'.repeat(200), trigger: 'MANUAL' },
  { name: 'manual-duress', duress: true, sealed: 'x'.repeat(200), trigger: 'MANUAL' },
  { name: 'crash-empty-payload', duress: false, sealed: '', trigger: 'CRASH' },
  { name: 'fall-large-payload', duress: false, sealed: 'y'.repeat(500), trigger: 'FALL' },
  { name: 'duress-large-payload', duress: true, sealed: 'y'.repeat(500), trigger: 'MANUAL' },
  { name: 'unicode-in-sealed', duress: false, sealed: 'sealed-“quoted”-\\slash\\-ünïcøde', trigger: 'BLE_FOB' },
];

for (const [i, c] of cases.entries()) {
  const incidentId = `0192d4a0-0000-7000-8000-0000000000${(i + 10).toString(16).padStart(2, '0')}`;
  const signed = buildSignedEnvelope(
    {
      incidentId,
      familyId: FAMILY,
      deviceId: DEVICE,
      memberId: MEMBER,
      trigger: c.trigger,
      confidencePct: 100,
      riskContext: 2,
      duress: c.duress,
      isDrill: false,
      policyVersion: 1,
      coarseCell: coarseCell(20.9463, 72.952),
      batteryPct: 43,
      sealedPayload: c.sealed,
    },
    kp,
  );
  envelopes.push({
    name: c.name,
    body: signed.body,
    signature: signed.signature,
    publicKey: bytesToBase64(kp.emergencyPublic),
    duress: c.duress,
    byteLength: new TextEncoder().encode(signed.body).length,
  });
}

// SMS vectors — the T0 encoder against the server-side parser.
const smsCases: { name: string; shortName: string; trigger: TriggerType; lat: number; lon: number }[] = [
  { name: 'navsari-crash', shortName: 'PRIYA', trigger: 'CRASH', lat: 20.945123, lon: 72.932011 },
  { name: 'negative-coords', shortName: 'ROHAN', trigger: 'MANUAL', lat: -33.865143, lon: -151.2099 },
  { name: 'max-name', shortName: 'ABCDEFGH', trigger: 'FALL', lat: 89.999999, lon: 179.999999 },
  { name: 'zero-island', shortName: 'DADA', trigger: 'DEADMAN', lat: 0, lon: 0 },
];

const sms = smsCases.map((c, i) => {
  const incidentId = `0192d4a0-0000-7000-8000-0000000001${i.toString(16).padStart(2, '0')}`;
  const out = encodeSms({
    incidentId,
    asciiShortName: c.shortName,
    trigger: c.trigger,
    lat: c.lat,
    lon: c.lon,
    accuracyM: 12,
    batteryPct: 43,
    atMs: 1_700_000_000_000,
    groupSecret: GROUP,
  });
  return {
    name: c.name,
    text: out.text,
    length: out.length,
    incidentId,
    inc8: inc8(incidentId),
    expectedCode: TRIGGER_CODE[c.trigger],
    lat: c.lat,
    lon: c.lon,
  };
});

// inc8 vectors — the F-09 reconciliation key must agree across languages or an
// SMS-originated incident forks into a duplicate of its own HTTP twin.
const inc8Vectors = [
  '0192d4a0-0000-7000-8000-00000000fa11',
  '11111111-1111-7111-8111-111111111111',
  'ffffffff-ffff-7fff-8fff-ffffffffffff',
  '00000000-0000-7000-8000-000000000000',
].map((id) => ({ incidentId: id, inc8: inc8(id) }));

// A tag over a known body, so the Go SMSTag implementation is pinned too.
const tagVector = {
  groupSecretB64: bytesToBase64(GROUP),
  payload: 'K1|abcdefgh|PRIYA|SOS|20.945123,72.932011|12|43|kzqk9c',
  tag: smsTag(GROUP, 'K1|abcdefgh|PRIYA|SOS|20.945123,72.932011|12|43|kzqk9c'),
};

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../backend/internal/envelope/testdata/vectors.json',
);
mkdirSync(dirname(OUT), { recursive: true });

writeFileSync(
  OUT,
  JSON.stringify(
    {
      _comment:
        'Generated by mobile/test/emit-crosslang-vectors.ts. Regenerate if the ' +
        'canonical form changes on purpose; a diff here means client and server ' +
        'have silently diverged.',
      fixedEnvelopeSize: FIXED_ENVELOPE_SIZE,
      groupSecretB64: bytesToBase64(GROUP),
      envelopes,
      sms,
      inc8: inc8Vectors,
      smsTag: tagVector,
    },
    null,
    2,
  ) + '\n',
  { encoding: 'utf8' },
);

process.stdout.write(
  `wrote ${envelopes.length} envelope, ${sms.length} SMS and ${inc8Vectors.length} inc8 vectors → ${OUT}\n`,
);
