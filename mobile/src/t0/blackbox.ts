/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * T0 · PRE-INCIDENT BLACK BOX  (FR-007, P-043)
 *
 * A 60 s rolling window of sensor data, sealed the instant a trigger fires. It
 * answers the question the responder always asks and nobody can otherwise
 * answer: what happened in the minute BEFORE the alarm?
 *
 * ★ P-043 — THE FULL-DISK FAILURE ★
 * The phone is at 100% storage. The incident write fails. Nobody notices until
 * the after-action report is empty. So the storage is claimed ONCE at init:
 * `RESERVE_SLOTS` files of exactly `RESERVE_BYTES` each, pre-filled with padding.
 * Sealing REWRITES a slot at exactly the same length — the file never grows, so
 * a full disk cannot refuse the write. Test T-214 is precisely this scenario.
 *
 * ★ ALLOCATION-FREE HOT PATH ★
 * `pushSample` runs up to 50×/second for the life of the process. It writes into
 * pre-allocated typed arrays and allocates nothing, so it never triggers a GC
 * pause in the middle of the fall it is supposed to be recording.
 *
 * ★ NON-BLOCKING SEAL — AND WHAT THAT ACTUALLY REQUIRES ★
 * §2.3 gives the seal ≤30 ms of the 500 ms t0→t2 budget. "Fire and forget" is not
 * enough on its own: an `async` function with no `await` before its work runs
 * that work SYNCHRONOUSLY at the call site, so `void sealBlackBox(id)` inside the
 * trigger path would still insert the pack + encrypt + base64 + 384 KiB write
 * straight into the middle of the budget. So two things hold here:
 *   1. `sealBlackBox` yields to the task queue BEFORE it touches the ring, and
 *   2. the trigger router schedules it as a macrotask AFTER `fanOut()`.
 * Either alone would be enough; both together mean a future caller cannot
 * reintroduce the stall by accident.
 *
 * ★ THE RESERVE IS CLAIMED OFF THE BOOT PATH ★
 * `initBlackBox` used to write 1.5 MiB synchronously while `app/index.tsx` was
 * still showing a blank view. It now returns immediately — `sealBlackBox` only
 * needs the group secret — and provisions the slots after interactions, one at a
 * time. A seal that arrives before provisioning finishes degrades exactly as
 * P-043 already intends: `blackBoxStats().reserveBytesClaimed` reports the
 * shortfall and the window is dropped rather than half-written.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { InteractionManager } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import { CONFIG } from '../core/config';
import { incidentContentKey, openJson, sealJson } from '../crypto';
import type { UUID } from '../core/types';

export interface BlackBoxSample {
  atMs: number;
  /** Accelerometer, g. */
  ax: number;
  ay: number;
  az: number;
  /** Gyroscope, rad/s. */
  gx: number;
  gy: number;
  gz: number;
  /** Ambient light, lux. Android only; -1 when unavailable. */
  lux?: number;
  /** Ground speed, m/s, from the last location fix. -1 when unknown. */
  speedMps?: number;
}

/** What `readSealed` gives back: the window, decoded, in chronological order. */
export interface BlackBoxWindow {
  v: 1;
  incidentId: UUID;
  /** Epoch ms of the oldest retained sample. */
  t0: number;
  samples: BlackBoxSample[];
  /** >1 when the window was decimated to fit the reserve slot. */
  decimation: number;
}

const CAPACITY = Math.max(
  60,
  Math.ceil((CONFIG.blackBoxWindowMs / 1000) * CONFIG.blackBoxHz),
);
const RESERVE_SLOTS = 4;
/** 384 KiB per slot: comfortably above a 3000-sample sealed window. */
const RESERVE_BYTES = 384 * 1024;
const REF_PREFIX = 'kvbb1';
const PAD_CHAR = '.';
/**
 * Nine quantised integer columns per sample, ~6 characters each including the
 * separator, plus the ~1.34× cost of sealing and base64. Used only to pick the
 * STARTING decimation so the common case seals exactly once — a wrong estimate
 * costs a retry, never a lost window.
 */
const EST_SEALED_BYTES_PER_SAMPLE = 80;

// ── Pre-allocated ring ────────────────────────────────────────────────────────

const ringT = new Float64Array(CAPACITY);
const ringAx = new Float32Array(CAPACITY);
const ringAy = new Float32Array(CAPACITY);
const ringAz = new Float32Array(CAPACITY);
const ringGx = new Float32Array(CAPACITY);
const ringGy = new Float32Array(CAPACITY);
const ringGz = new Float32Array(CAPACITY);
const ringLux = new Float32Array(CAPACITY);
const ringSpeed = new Float32Array(CAPACITY);

let head = 0; // next write index
let filled = 0; // number of valid samples, ≤ CAPACITY
let totalPushed = 0;
let droppedSeals = 0;
let sealCount = 0;
let lastSealRef: string | null = null;
let nextSlot = 0;
let ready = false;
let reserveBytesClaimed = 0;
let groupSecret: Uint8Array | null = null;

export interface InitBlackBoxOptions {
  /** Family Group Secret (ADR-021). Without it the window cannot be sealed. */
  groupSecret: Uint8Array;
}

function boxDir(): Directory {
  const dir = new Directory(Paths.document, 'kavach-blackbox');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function slotFile(slot: number): File {
  return new File(boxDir(), `bb-${slot}.slot`);
}

function ringFile(): File {
  return new File(boxDir(), 'bb-ring.json');
}

/** Yield the thread to the task queue. A microtask would not: it runs in this tick. */
function yieldToQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The slot ring survives the process.
 *
 * `nextSlot` used to be plain module state, so slot 0 was the first overwritten
 * after every launch — a phone that opens one incident per restart destroyed the
 * previous window while three slots sat free. The reserve exists to hold the
 * minute before an impact; recycling it early throws away the only copy.
 */
function loadRing(): void {
  try {
    const f = ringFile();
    if (!f.exists) return;
    const parsed = JSON.parse(f.textSync()) as { next?: unknown };
    if (typeof parsed.next === 'number' && Number.isInteger(parsed.next)) {
      nextSlot = ((parsed.next % RESERVE_SLOTS) + RESERVE_SLOTS) % RESERVE_SLOTS;
    }
  } catch {
    // An unreadable ring pointer costs at most one overwritten window.
  }
}

function saveRing(): void {
  try {
    const f = ringFile();
    if (!f.exists) f.create({ intermediates: true, overwrite: true });
    f.write(JSON.stringify({ next: nextSlot }));
  } catch {
    // See loadRing().
  }
}

/**
 * Claim the disk while the phone is calm, not during the incident — but NOT while
 * the entry route is still blank. One slot per task so the thread is free between
 * writes; four 384 KiB writes back to back is a visible stall on a ₹6,000 phone.
 */
async function provisionSlots(): Promise<void> {
  const padding = PAD_CHAR.repeat(RESERVE_BYTES);
  for (let slot = 0; slot < RESERVE_SLOTS; slot++) {
    try {
      const file = slotFile(slot);
      if (!file.exists) {
        file.create({ intermediates: true, overwrite: true });
        file.write(padding);
      } else if (file.size !== RESERVE_BYTES) {
        // A truncated slot from a crash mid-write is worse than no slot: it
        // would silently fail the next seal. Restore it to full length.
        file.write(padding);
      }
      reserveBytesClaimed += RESERVE_BYTES;
      ready = true;
    } catch {
      // Out of space at install time. We still run: the RAM ring works, and
      // diagnostics surfaces the shortfall through blackBoxStats().
    }
    await yieldToQueue();
  }
}

/**
 * Everything `sealBlackBox` needs is the group secret, so that is all this does
 * synchronously. The one piece of I/O left is the ~20-byte ring pointer, and it
 * stays here deliberately: a trigger in the first moments after launch must not
 * overwrite the window a previous run sealed. The 1.5 MiB reserve is claimed
 * afterwards, off the boot path.
 */
export function initBlackBox(options: InitBlackBoxOptions): void {
  groupSecret = options.groupSecret;
  reserveBytesClaimed = 0;
  ready = false;
  loadRing();
  InteractionManager.runAfterInteractions(() => {
    void provisionSlots();
  });
}

/** O(1), allocation-free. Safe to call before `initBlackBox`. */
export function pushSample(s: BlackBoxSample): void {
  const i = head;
  ringT[i] = s.atMs;
  ringAx[i] = s.ax;
  ringAy[i] = s.ay;
  ringAz[i] = s.az;
  ringGx[i] = s.gx;
  ringGy[i] = s.gy;
  ringGz[i] = s.gz;
  ringLux[i] = s.lux ?? -1;
  ringSpeed[i] = s.speedMps ?? -1;
  head = i + 1 === CAPACITY ? 0 : i + 1;
  if (filled < CAPACITY) filled++;
  totalPushed++;
}

/** Oldest-first index of the k-th retained sample. */
function indexOf(k: number): number {
  const start = filled === CAPACITY ? head : 0;
  const i = start + k;
  return i >= CAPACITY ? i - CAPACITY : i;
}

interface PackedWindow {
  v: 1;
  inc: UUID;
  t0: number;
  n: number;
  dec: number;
  /** ms offsets from t0. */
  dt: number[];
  ax: number[];
  ay: number[];
  az: number[];
  gx: number[];
  gy: number[];
  gz: number[];
  lx: number[];
  sp: number[];
}

/**
 * Quantised integer columns rather than an array of objects: roughly 4× smaller
 * than the naive encoding, which is what lets a 3000-sample window fit inside a
 * fixed reserve slot with room to spare.
 */
function packWindow(incidentId: UUID, decimation: number): PackedWindow {
  const step = Math.max(1, Math.floor(decimation));
  const t0 = filled > 0 ? ringT[indexOf(0)] : Date.now();
  const dt: number[] = [];
  const ax: number[] = [];
  const ay: number[] = [];
  const az: number[] = [];
  const gx: number[] = [];
  const gy: number[] = [];
  const gz: number[] = [];
  const lx: number[] = [];
  const sp: number[] = [];
  for (let k = 0; k < filled; k += step) {
    const i = indexOf(k);
    dt.push(Math.round(ringT[i] - t0));
    ax.push(Math.round(ringAx[i] * 1000));
    ay.push(Math.round(ringAy[i] * 1000));
    az.push(Math.round(ringAz[i] * 1000));
    gx.push(Math.round(ringGx[i] * 1000));
    gy.push(Math.round(ringGy[i] * 1000));
    gz.push(Math.round(ringGz[i] * 1000));
    lx.push(Math.round(ringLux[i]));
    sp.push(Math.round(ringSpeed[i] * 100));
  }
  return { v: 1, inc: incidentId, t0, n: dt.length, dec: step, dt, ax, ay, az, gx, gy, gz, lx, sp };
}

/**
 * Seal the window under the Incident Content Key and write it into the next
 * reserve slot. Returns a ref of the form `kvbb1:<slot>:<incidentId>`, or an
 * empty string when there is nothing to seal or no key to seal it with — the
 * caller then simply omits `blackBoxRef` from the sealed payload.
 */
export async function sealBlackBox(incidentId: UUID): Promise<string> {
  if (!groupSecret || filled === 0) {
    droppedSeals++;
    return '';
  }

  // ★ The yield that makes "fired, never awaited" true. Without it every line
  //   below runs inside the caller's tick, i.e. inside the t0→t2 budget.
  await yieldToQueue();
  if (!groupSecret || filled === 0) {
    droppedSeals++;
    return '';
  }

  const key = incidentContentKey(groupSecret, incidentId);
  // Start where the window is expected to fit rather than at 1:1 and halving:
  // the retry costs a second full pack + encrypt + base64 of ~190 KiB, which is
  // the most expensive thing this module does.
  const budget = RESERVE_BYTES - 512;
  let decimation = Math.max(1, Math.ceil((filled * EST_SEALED_BYTES_PER_SAMPLE) / budget));
  let body = '';
  let header = '';

  // Decimate rather than truncate: halving the rate keeps the whole 60 s of
  // context, while truncation would throw away either the impact or the
  // stillness that follows it — and we do not know in advance which matters.
  for (let attempt = 0; attempt < 4; attempt++) {
    const sealed = sealJson(key, packWindow(incidentId, decimation), incidentId);
    header = JSON.stringify({ v: 1, inc: incidentId, n: sealed.length, at: Date.now() });
    if (header.length + 1 + sealed.length <= RESERVE_BYTES) {
      body = sealed;
      break;
    }
    decimation *= 2;
  }

  if (body === '') {
    droppedSeals++;
    return '';
  }

  const slot = nextSlot;
  const payload = `${header}\n${body}`;
  const padded = payload + PAD_CHAR.repeat(RESERVE_BYTES - payload.length);

  try {
    const file = slotFile(slot);
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    // Same byte count every time — the write cannot need a single new block.
    file.write(padded);
  } catch {
    droppedSeals++;
    return '';
  }

  // Only advance the ring on a write that landed: a failed seal must not burn
  // the slot that still holds a readable window.
  nextSlot = (nextSlot + 1) % RESERVE_SLOTS;
  saveRing();
  sealCount++;
  lastSealRef = `${REF_PREFIX}:${slot}:${incidentId}`;
  return lastSealRef;
}

/**
 * Read a sealed window back. Returns null when the ref is malformed, when the
 * slot has since been recycled by a newer incident, or when the ciphertext does
 * not authenticate under this family's key.
 */
export function readSealed(ref: string): BlackBoxWindow | null {
  if (!groupSecret) return null;
  const parts = ref.split(':');
  if (parts.length !== 3 || parts[0] !== REF_PREFIX) return null;
  const slot = Number(parts[1]);
  const incidentId = parts[2];
  if (!Number.isInteger(slot) || slot < 0 || slot >= RESERVE_SLOTS) return null;

  let text: string;
  try {
    const file = slotFile(slot);
    if (!file.exists) return null;
    text = file.textSync();
  } catch {
    return null;
  }

  const nl = text.indexOf('\n');
  if (nl <= 0) return null;
  let meta: { v?: number; inc?: string; n?: number };
  try {
    meta = JSON.parse(text.slice(0, nl)) as { v?: number; inc?: string; n?: number };
  } catch {
    return null;
  }
  // The slot ring recycles; a mismatched id means this window was overwritten.
  if (meta.inc !== incidentId || typeof meta.n !== 'number') return null;

  const body = text.slice(nl + 1, nl + 1 + meta.n);
  const packed = openJson<PackedWindow>(incidentContentKey(groupSecret, incidentId), body, incidentId);
  if (!packed || packed.v !== 1) return null;

  const samples: BlackBoxSample[] = [];
  for (let i = 0; i < packed.n; i++) {
    samples.push({
      atMs: packed.t0 + packed.dt[i],
      ax: packed.ax[i] / 1000,
      ay: packed.ay[i] / 1000,
      az: packed.az[i] / 1000,
      gx: packed.gx[i] / 1000,
      gy: packed.gy[i] / 1000,
      gz: packed.gz[i] / 1000,
      lux: packed.lx[i],
      speedMps: packed.sp[i] / 100,
    });
  }
  return { v: 1, incidentId, t0: packed.t0, samples, decimation: packed.dec };
}

export interface BlackBoxStats {
  ready: boolean;
  capacity: number;
  count: number;
  windowMs: number;
  oldestAtMs: number | null;
  newestAtMs: number | null;
  totalPushed: number;
  sealCount: number;
  droppedSeals: number;
  lastSealRef: string | null;
  reserveSlots: number;
  reserveBytes: number;
  /** Bytes actually claimed on disk. Less than the target means P-043 bit us. */
  reserveBytesClaimed: number;
}

export function blackBoxStats(): BlackBoxStats {
  return {
    ready,
    capacity: CAPACITY,
    count: filled,
    windowMs: CONFIG.blackBoxWindowMs,
    oldestAtMs: filled > 0 ? ringT[indexOf(0)] : null,
    newestAtMs: filled > 0 ? ringT[indexOf(filled - 1)] : null,
    totalPushed,
    sealCount,
    droppedSeals,
    lastSealRef,
    reserveSlots: RESERVE_SLOTS,
    reserveBytes: RESERVE_SLOTS * RESERVE_BYTES,
    reserveBytesClaimed,
  };
}

/** Drop the in-memory window. Used when the subject pauses monitoring (P-066). */
export function clearBlackBox(): void {
  head = 0;
  filled = 0;
}
