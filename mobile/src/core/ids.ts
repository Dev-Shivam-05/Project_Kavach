/**
 * UUIDv7 + Hybrid Logical Clocks.
 *
 * PRD P-053: incident_id is a CLIENT-generated UUIDv7. Time-sortable, globally
 * unique, and it makes every ingest endpoint perfectly idempotent — fire the
 * request five times over five transports and the server deduplicates.
 * ★ The server NEVER allocates an incident id. ★
 *
 * PRD P-052: device clocks drift and lie. Every event carries an HLC so that a
 * timeline reconstructed across devices is causally correct even under skew.
 */
import 'react-native-get-random-values';

const HEX = '0123456789abcdef';

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 15];
  return s;
}

export function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Flush point, in output characters. Bounds every intermediate string. */
const B64_FLUSH = 8192;

/**
 * ★ This runs over things that are hundreds of kilobytes, not over a 32-byte key.
 * The black-box seal (t0/blackbox) base64s a ~190 KiB sealed window on every
 * trigger, and the camera node (state/nodeStore) base64s a 19 200-byte frame per
 * motion event at up to 3 Hz. The obvious implementation — one `+=` per byte into
 * a single string, then btoa — builds one rope node per byte and flattens the
 * whole thing at the end, which is the allocation spike that shows up as a
 * dropped frame in the countdown ring.
 *
 * Encoding straight from the bytes skips the intermediate binary string entirely
 * (4 output chars per 3 input bytes instead of 1 per byte) and flushing every
 * 8 KiB keeps each rope short enough to flatten cheaply. Output is byte-identical
 * to btoa, padding included.
 */
export function bytesToBase64(b: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  const n = b.length;
  const rem = n % 3;
  const main = n - rem;
  for (let i = 0; i < main; i += 3) {
    const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    chunk +=
      B64_ALPHABET[(v >> 18) & 63] +
      B64_ALPHABET[(v >> 12) & 63] +
      B64_ALPHABET[(v >> 6) & 63] +
      B64_ALPHABET[v & 63];
    if (chunk.length >= B64_FLUSH) {
      parts.push(chunk);
      chunk = '';
    }
  }
  if (rem === 1) {
    const v = b[main] << 16;
    chunk += `${B64_ALPHABET[(v >> 18) & 63]}${B64_ALPHABET[(v >> 12) & 63]}==`;
  } else if (rem === 2) {
    const v = (b[main] << 16) | (b[main + 1] << 8);
    chunk += `${B64_ALPHABET[(v >> 18) & 63]}${B64_ALPHABET[(v >> 12) & 63]}${B64_ALPHABET[(v >> 6) & 63]}=`;
  }
  if (chunk.length > 0) parts.push(chunk);
  return parts.join('');
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = globalThis.atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * UUIDv7: 48-bit big-endian Unix ms, 4-bit version, 12 bits random,
 * 2-bit variant, 62 bits random. Lexicographically sortable by creation time.
 */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b[0] = (now / 2 ** 40) & 0xff;
  b[1] = (now / 2 ** 32) & 0xff;
  b[2] = (now / 2 ** 24) & 0xff;
  b[3] = (now / 2 ** 16) & 0xff;
  b[4] = (now / 2 ** 8) & 0xff;
  b[5] = now & 0xff;
  b[6] = 0x70 | (b[6] & 0x0f); // version 7
  b[8] = 0x80 | (b[8] & 0x3f); // variant 10
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The 8-character base36 incident prefix carried in the SMS payload (§6.2.5).
 * F-09: the server resolves this against a prefix index to avoid creating a
 * duplicate incident when the same emergency arrives by SMS and by HTTP.
 */
export function inc8(incidentId: string): string {
  const hex = incidentId.replace(/-/g, '').slice(0, 16);
  let v = BigInt('0x' + hex);
  let out = '';
  while (out.length < 8) {
    out = '0123456789abcdefghijklmnopqrstuvwxyz'[Number(v % 36n)] + out;
    v /= 36n;
  }
  return out.slice(-8);
}

// ── Hybrid Logical Clock ──────────────────────────────────────────────────────
// Wire format: 12 bytes = 48-bit physical ms ‖ 16-bit logical counter ‖ 32-bit node id.
//
// NOTE: PRD §9.3 describes this as "12 bytes: 48-bit physical, 16-bit logical,
// 48-bit node" — which is 14 bytes, not 12. We keep the stated 12-byte wire size
// and narrow the node id to 32 bits. At family scale (6–30 devices) a 32-bit
// node id has a collision probability far below the noise floor, and the node id
// is only a tiebreaker for events that already share a millisecond AND a logical
// counter.
const HLC_NODE_BYTES = 4;

let lastPhysical = 0;
let logical = 0;
let nodeId: Uint8Array = randomBytes(HLC_NODE_BYTES);

export function setHlcNodeId(id: Uint8Array): void {
  const n = new Uint8Array(HLC_NODE_BYTES);
  n.set(id.slice(0, HLC_NODE_BYTES));
  nodeId = n;
}

export interface Hlc {
  physical: number;
  logical: number;
  hex: string;
}

export function nowHlc(wallClock: number = Date.now()): Hlc {
  if (wallClock > lastPhysical) {
    lastPhysical = wallClock;
    logical = 0;
  } else {
    // Clock went backwards or same ms — advance the logical counter instead.
    logical = (logical + 1) & 0xffff;
    if (logical === 0) lastPhysical += 1;
  }
  const b = new Uint8Array(12);
  const p = lastPhysical;
  b[0] = (p / 2 ** 40) & 0xff;
  b[1] = (p / 2 ** 32) & 0xff;
  b[2] = (p / 2 ** 24) & 0xff;
  b[3] = (p / 2 ** 16) & 0xff;
  b[4] = (p / 2 ** 8) & 0xff;
  b[5] = p & 0xff;
  b[6] = (logical >> 8) & 0xff;
  b[7] = logical & 0xff;
  b.set(nodeId, 8);
  return { physical: lastPhysical, logical, hex: bytesToHex(b) };
}

/** Merge a remote HLC so our clock never falls behind a peer we have heard from. */
export function observeHlc(remoteHex: string): void {
  if (remoteHex.length < 16) return;
  const b = hexToBytes(remoteHex.slice(0, 16));
  const rp =
    b[0] * 2 ** 40 + b[1] * 2 ** 32 + b[2] * 2 ** 24 + b[3] * 2 ** 16 + b[4] * 2 ** 8 + b[5];
  const rl = (b[6] << 8) | b[7];
  if (rp > lastPhysical) {
    lastPhysical = rp;
    logical = rl;
  } else if (rp === lastPhysical && rl > logical) {
    logical = rl;
  }
}

/** Total order across devices. Timelines render from this, never from wall clock. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** H3-like coarse cell. Deliberately ~1 km — too coarse to identify a home (§10.2). */
export function coarseCell(lat: number, lon: number): string {
  const la = Math.floor(lat * 100) / 100; // ≈1.1 km latitude
  const lo = Math.floor(lon * 100) / 100;
  return `c7:${la.toFixed(2)}:${lo.toFixed(2)}`;
}

/** Finer cell used in the 6-byte BLE advertisement (≈180 m). */
export function bleCell(lat: number, lon: number): string {
  return `c9:${(Math.floor(lat * 1000) / 1000).toFixed(3)}:${(Math.floor(lon * 1000) / 1000).toFixed(3)}`;
}
