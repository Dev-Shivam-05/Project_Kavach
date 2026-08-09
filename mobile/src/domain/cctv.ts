/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CCTV — the spare-phone monitoring node (PRD P-024 / FR-046, thermal P-032)
 *
 * ★★★ WHY THIS FILE HAS NO IMPORTS FROM expo-* ★★★
 * Every rule in a monitoring node that can hurt somebody — when it decides
 * something moved, when it decides the phone is too hot to keep running, when a
 * recording expires, whether the room it is pointed at is a lawful one — is a
 * pure function here. The screens do the I/O; this file does the deciding, so
 * every decision is reproducible on a laptop with `node --test` and none of them
 * depend on a camera being present.
 *
 * ★★★ THE HONEST STATEMENT ABOUT FRAMES (read this before changing anything) ★★★
 * expo-camera in SDK 57 has NO frame processor. There is no `useFrameProcessor`,
 * no YUV buffer callback, no `onFrame`. The ONLY pixel data a JS runtime can get
 * out of it is a JPEG, from `takePictureAsync`. So this module does not pretend
 * to have a video pipeline. It takes stills at 1–3 fps and extracts real pixels
 * from them the cheapest correct way that exists:
 *
 *   `decodeJpegLumaDc` is a baseline-JPEG entropy decoder that keeps ONLY the DC
 *   coefficient of each 8×8 luma block and throws every AC coefficient away.
 *   That is not a shortcut with an asterisk — the inverse DCT of a DC-only block
 *   is a constant equal to DC·q/8, so the DC plane IS the image box-filtered to
 *   exactly 1/8 scale. A 1280×960 capture therefore yields a 160×120 greyscale
 *   frame for free, which is precisely the working resolution this detector
 *   wants, and we never run an IDCT, never allocate a full-size bitmap, and
 *   never hold a full-resolution picture of somebody's living room in memory.
 *
 * ★★★ THE PRIVACY OBLIGATIONS ARE CODE, NOT COPY (PRD §10.2, P-024) ★★★
 * A camera inside a home is the most sensitive Class-A source in this product.
 * Five obligations are encoded here rather than promised in a settings screen:
 *   1. `checkPlacement` refuses a bedroom or a bathroom. Recording either is an
 *      offence under s.66E of the Information Technology Act, 2000 (capturing
 *      images of the private area of a person without consent) regardless of who
 *      owns the phone or who agreed to what during setup.
 *   2. `membersDetectedHome` + `pickHomeFence` drive AUTO-DISABLE: the moment any
 *      family member is detectably home, the node stops. A house with people in
 *      it is not a site under surveillance.
 *   3. `pickHomeFence` returning null is a HARD BLOCK, not a warning — a node
 *      that cannot detect that somebody came home cannot honour obligation 2, so
 *      it is not allowed to arm at all.
 *   4. `snapshotsToDelete` enforces 7-day retention and a hard object cap.
 *   5. The kill switch is a store action with no role check anywhere near it —
 *      see state/nodeStore.ts.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import type { Geofence, Member, MemberPresence, UUID } from '../core/types';
import { haversineM } from './geofence';

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 · Working frame geometry
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 160×120 greyscale. Small enough that a full-frame pass is ~19 k byte
 * subtractions (sub-millisecond in Hermes), large enough that a person at the
 * far end of a room still lights up several blocks.
 */
export const GREY_W = 160;
export const GREY_H = 120;
export const GREY_PIXELS = GREY_W * GREY_H;

/** 8×8 analysis blocks → a 20×15 grid. Matches the JPEG block grid exactly. */
export const BLOCK = 8;
export const BLOCKS_X = GREY_W / BLOCK;
export const BLOCKS_Y = GREY_H / BLOCK;
export const BLOCK_COUNT = BLOCKS_X * BLOCKS_Y;

/**
 * A phone that offers a 4000×3000 still would cost ~190 k Huffman-decoded blocks
 * per frame and blow the frame budget. Above this we decline the size rather
 * than silently stall the loop.
 */
export const MAX_DECODE_PIXELS = 2_100_000;

/**
 * 1280×960 is the sweet spot: its luma DC plane is exactly 160×120, so the
 * detector runs at native resolution with no resampling error at all.
 */
export const TARGET_CAPTURE_W = 1280;
export const TARGET_CAPTURE_H = 960;

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 · Baseline JPEG luma-DC decoder
// ═══════════════════════════════════════════════════════════════════════════════

export interface LumaPlane {
  /** One byte per 8×8 luma block of the source, i.e. the image at 1/8 scale. */
  data: Uint8Array;
  width: number;
  height: number;
}

export type DecodeFailure =
  | 'not-jpeg'
  | 'progressive'
  | 'unsupported'
  | 'truncated'
  | 'too-large'
  | 'no-frame';

export type DecodeResult = { ok: true; plane: LumaPlane } | { ok: false; reason: DecodeFailure };

/** Plain-English text for a decode failure. Shown on the node screen verbatim. */
export function describeDecodeFailure(reason: DecodeFailure): string {
  switch (reason) {
    case 'not-jpeg':
      return 'The camera returned something that is not a JPEG.';
    case 'progressive':
      return 'This camera produces progressive JPEGs, which this detector cannot read.';
    case 'unsupported':
      return 'This camera uses a JPEG variant this detector cannot read.';
    case 'truncated':
      return 'The frame arrived incomplete.';
    case 'too-large':
      return 'The smallest picture size this camera offers is too large to analyse in time.';
    case 'no-frame':
      return 'The camera returned no image data.';
  }
}

interface HuffTable {
  mincode: Int32Array;
  maxcode: Int32Array;
  valptr: Int32Array;
  vals: Uint8Array;
}

interface JpegComponent {
  id: number;
  h: number;
  v: number;
  tq: number;
  dcTable: number;
  acTable: number;
  pred: number;
}

interface JpegFrame {
  width: number;
  height: number;
  maxH: number;
  maxV: number;
  mcusPerLine: number;
  mcusPerColumn: number;
  components: JpegComponent[];
}

/**
 * Canonical Huffman table, in the maxcode/mincode/valptr form of the DECODE
 * procedure in ITU-T T.81 Annex F. Compact and allocation-free per symbol.
 */
function buildHuffTable(counts: Uint8Array, vals: Uint8Array): HuffTable {
  const mincode = new Int32Array(17);
  const maxcode = new Int32Array(17);
  const valptr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = counts[l - 1];
    valptr[l] = k;
    mincode[l] = code;
    code += n;
    k += n;
    // -1 means "no code of this length": DECODE must keep lengthening.
    maxcode[l] = n === 0 ? -1 : code - 1;
    code <<= 1;
  }
  return { mincode, maxcode, valptr, vals };
}

/**
 * Decode one baseline JPEG and return the luma DC plane.
 *
 * Returns a reason rather than throwing, ever: this runs inside a capture loop
 * on an unattended phone and a thrown error there is a node that silently stops
 * watching the house (ADR-018 — the safety path fails open, never fatal).
 */
export function decodeJpegLumaDc(bytes: Uint8Array): DecodeResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { ok: false, reason: 'not-jpeg' };
  }

  const quant: (Int32Array | null)[] = [null, null, null, null];
  const dcTables: (HuffTable | null)[] = [null, null, null, null];
  const acTables: (HuffTable | null)[] = [null, null, null, null];
  let frame: JpegFrame | null = null;
  let restartInterval = 0;

  // ── entropy-coded segment bit reader ───────────────────────────────────────
  let bp = 0;
  let bitBuf = 0;
  let bitCount = 0;
  let starved = false;

  function nextBit(): number {
    if (bitCount === 0) {
      if (bp >= bytes.length) {
        starved = true;
        return 0;
      }
      const b = bytes[bp++];
      if (b === 0xff) {
        const follower = bp < bytes.length ? bytes[bp] : 0xd9;
        if (follower === 0x00) {
          bp++; // stuffed zero — the 0xFF is literal data
        } else {
          // A real marker. Rewind so restart resynchronisation can find it.
          bp--;
          starved = true;
          return 0;
        }
      }
      bitBuf = b;
      bitCount = 8;
    }
    bitCount--;
    return (bitBuf >> bitCount) & 1;
  }

  function receive(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | nextBit();
    return v;
  }

  function extend(v: number, n: number): number {
    if (n === 0) return 0;
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  }

  function huffDecode(table: HuffTable): number {
    let code = nextBit();
    let l = 1;
    while (l <= 16 && code > table.maxcode[l]) {
      code = (code << 1) | nextBit();
      l++;
      if (starved) return -1;
    }
    if (l > 16) return -1;
    const index = table.valptr[l] + code - table.mincode[l];
    if (index < 0 || index >= table.vals.length) return -1;
    return table.vals[index];
  }

  /** Byte-align and swallow the next RSTn marker. False = the scan is over. */
  function syncRestart(): boolean {
    bitCount = 0;
    starved = false;
    while (bp + 1 < bytes.length) {
      if (bytes[bp] === 0xff) {
        const m = bytes[bp + 1];
        if (m >= 0xd0 && m <= 0xd7) {
          bp += 2;
          return true;
        }
        if (m !== 0x00 && m !== 0xff) return false;
      }
      bp++;
    }
    return false;
  }

  /** Decodes one 8×8 block, keeps the DC, discards every AC coefficient. */
  function decodeBlockDc(c: JpegComponent): number {
    const dcT = dcTables[c.dcTable];
    const acT = acTables[c.acTable];
    if (dcT === null || acT === null) {
      starved = true;
      return c.pred;
    }
    const t = huffDecode(dcT);
    if (t < 0 || t > 15) {
      starved = true;
      return c.pred;
    }
    c.pred += t === 0 ? 0 : extend(receive(t), t);
    const dc = c.pred;

    // The AC bits still have to be consumed — they are interleaved in the same
    // bitstream, so "skipping" them means decoding them and dropping the value.
    let k = 1;
    while (k < 64) {
      const rs = huffDecode(acT);
      if (rs < 0) {
        starved = true;
        break;
      }
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r === 15) {
          k += 16;
          continue;
        }
        break; // EOB
      }
      k += r + 1;
      receive(s);
    }
    return dc;
  }

  // ── marker walk ────────────────────────────────────────────────────────────
  let p = 2;
  while (p + 1 < bytes.length) {
    if (bytes[p] !== 0xff) {
      p++;
      continue;
    }
    let marker = bytes[p + 1];
    while (marker === 0xff && p + 2 < bytes.length) {
      p++;
      marker = bytes[p + 1];
    }
    p += 2;

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (marker === 0xd9) break;
    if (p + 2 > bytes.length) return { ok: false, reason: 'truncated' };

    const length = (bytes[p] << 8) | bytes[p + 1];
    const segStart = p + 2;
    const segEnd = p + length;
    if (length < 2 || segEnd > bytes.length) return { ok: false, reason: 'truncated' };

    if (marker === 0xdb) {
      let q = segStart;
      while (q < segEnd) {
        const pq = bytes[q] >> 4;
        const tq = bytes[q] & 15;
        q++;
        if (tq > 3) return { ok: false, reason: 'unsupported' };
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          if (pq === 1) {
            table[i] = (bytes[q] << 8) | bytes[q + 1];
            q += 2;
          } else {
            table[i] = bytes[q];
            q += 1;
          }
        }
        quant[tq] = table;
      }
    } else if (marker === 0xc4) {
      let q = segStart;
      while (q < segEnd) {
        const tc = bytes[q] >> 4;
        const th = bytes[q] & 15;
        q++;
        if (th > 3 || tc > 1) return { ok: false, reason: 'unsupported' };
        const counts = bytes.slice(q, q + 16);
        q += 16;
        let total = 0;
        for (let i = 0; i < 16; i++) total += counts[i];
        const vals = bytes.slice(q, q + total);
        q += total;
        const table = buildHuffTable(counts, vals);
        if (tc === 0) dcTables[th] = table;
        else acTables[th] = table;
      }
    } else if (marker === 0xdd) {
      restartInterval = (bytes[segStart] << 8) | bytes[segStart + 1];
    } else if (marker === 0xc0 || marker === 0xc1) {
      const height = (bytes[segStart + 1] << 8) | bytes[segStart + 2];
      const width = (bytes[segStart + 3] << 8) | bytes[segStart + 4];
      const nf = bytes[segStart + 5];
      if (nf < 1 || width < 8 || height < 8) return { ok: false, reason: 'unsupported' };
      if (width * height > MAX_DECODE_PIXELS) return { ok: false, reason: 'too-large' };
      const components: JpegComponent[] = [];
      let maxH = 1;
      let maxV = 1;
      for (let i = 0; i < nf; i++) {
        const o = segStart + 6 + i * 3;
        const h = bytes[o + 1] >> 4;
        const v = bytes[o + 1] & 15;
        if (h < 1 || h > 4 || v < 1 || v > 4) return { ok: false, reason: 'unsupported' };
        components.push({ id: bytes[o], h, v, tq: bytes[o + 2], dcTable: 0, acTable: 0, pred: 0 });
        if (h > maxH) maxH = h;
        if (v > maxV) maxV = v;
      }
      frame = {
        width,
        height,
        maxH,
        maxV,
        mcusPerLine: Math.ceil(width / (8 * maxH)),
        mcusPerColumn: Math.ceil(height / (8 * maxV)),
        components,
      };
    } else if (marker === 0xc2) {
      // Progressive. Every Android camera2 JPEG encoder emits baseline, but if
      // one does not we say so instead of returning a garbage frame.
      return { ok: false, reason: 'progressive' };
    } else if (
      marker === 0xc3 ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { ok: false, reason: 'unsupported' }; // lossless / arithmetic / hierarchical
    } else if (marker === 0xda) {
      if (frame === null) return { ok: false, reason: 'truncated' };
      const ns = bytes[segStart];
      const scan: JpegComponent[] = [];
      for (let i = 0; i < ns; i++) {
        const cs = bytes[segStart + 1 + i * 2];
        const tt = bytes[segStart + 2 + i * 2];
        const comp = frame.components.find((c) => c.id === cs);
        if (comp === undefined) return { ok: false, reason: 'unsupported' };
        comp.dcTable = tt >> 4;
        comp.acTable = tt & 15;
        comp.pred = 0;
        scan.push(comp);
      }
      const luma = frame.components[0];
      if (!scan.includes(luma)) return { ok: false, reason: 'unsupported' };
      const lumaQuant = quant[luma.tq];
      if (lumaQuant === null) return { ok: false, reason: 'truncated' };
      const q0 = lumaQuant[0];

      bp = segStart + 1 + ns * 2 + 3;
      bitBuf = 0;
      bitCount = 0;
      starved = false;

      const interleaved = scan.length > 1;
      const dcW = interleaved
        ? frame.mcusPerLine * luma.h
        : Math.ceil(Math.ceil((frame.width * luma.h) / frame.maxH) / 8);
      const dcH = interleaved
        ? frame.mcusPerColumn * luma.v
        : Math.ceil(Math.ceil((frame.height * luma.v) / frame.maxV) / 8);
      if (dcW < 1 || dcH < 1) return { ok: false, reason: 'unsupported' };

      const out = new Uint8Array(dcW * dcH);
      const unitsPerLine = interleaved ? frame.mcusPerLine : dcW;
      const totalUnits = interleaved ? frame.mcusPerLine * frame.mcusPerColumn : dcW * dcH;
      let done = 0;

      while (done < totalUnits) {
        if (restartInterval > 0 && done > 0 && done % restartInterval === 0) {
          for (const c of scan) c.pred = 0;
          if (!syncRestart()) break;
        }
        const ux = done % unitsPerLine;
        const uy = (done / unitsPerLine) | 0;

        if (interleaved) {
          for (const c of scan) {
            for (let v = 0; v < c.v; v++) {
              for (let h = 0; h < c.h; h++) {
                const dc = decodeBlockDc(c);
                if (c === luma) {
                  const bx = ux * luma.h + h;
                  const by = uy * luma.v + v;
                  if (bx < dcW && by < dcH) {
                    // IDCT of a DC-only block is the constant DC·q/8, then the
                    // JPEG level shift of +128 puts it back in 0..255.
                    const s = (dc * q0) / 8 + 128;
                    out[by * dcW + bx] = s < 0 ? 0 : s > 255 ? 255 : s | 0;
                  }
                }
              }
            }
          }
        } else {
          const dc = decodeBlockDc(luma);
          const s = (dc * q0) / 8 + 128;
          out[uy * dcW + ux] = s < 0 ? 0 : s > 255 ? 255 : s | 0;
        }

        done++;
        if (starved) break;
      }

      // A frame that lost its tail is still usable — the detector compares
      // against a background of the same shape — but a frame that lost most of
      // itself would read as motion everywhere. 60% is the line.
      if (done * 5 < totalUnits * 3) return { ok: false, reason: 'truncated' };
      return { ok: true, plane: { data: out, width: dcW, height: dcH } };
    }

    p = segEnd;
  }

  return { ok: false, reason: 'truncated' };
}

/**
 * Area-average resample to the detector's working size.
 *
 * When the source is already 160×120 (a 1280×960 capture) every destination
 * pixel maps to exactly one source pixel and this is a memcpy.
 */
export function resampleGrey(plane: LumaPlane, dw: number = GREY_W, dh: number = GREY_H): Uint8Array | null {
  const { data, width: sw, height: sh } = plane;
  if (sw < 1 || sh < 1 || data.length < sw * sh) return null;
  if (sw === dw && sh === dh) return Uint8Array.from(data);

  const out = new Uint8Array(dw * dh);
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor((dy * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * sh) / dh));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor((dx * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * sw) / dw));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < sh; y++) {
        const row = y * sw;
        for (let x = x0; x < x1 && x < sw; x++) {
          sum += data[row + x];
          n++;
        }
      }
      out[dy * dw + dx] = n === 0 ? 0 : (sum / n) | 0;
    }
  }
  return out;
}

/**
 * Choose a `pictureSize` for CameraView from what the device actually offers.
 *
 * Preference is for 1280×960 because its DC plane is exactly the detector's
 * working frame; anything above MAX_DECODE_PIXELS is excluded outright because
 * decoding it would take longer than the frame interval and the loop would eat
 * itself.
 */
export function pickPictureSize(sizes: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of sizes) {
    const m = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(s.trim());
    if (m === null) continue;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (w < 320 || h < 240) continue;
    if (w * h > MAX_DECODE_PIXELS) continue;
    const score = Math.abs(w - TARGET_CAPTURE_W) + Math.abs(h - TARGET_CAPTURE_H);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 · Motion detection
// ═══════════════════════════════════════════════════════════════════════════════

export interface MotionTuning {
  /** Mean absolute difference, in grey levels, for a block to count as hot. */
  blockMad: number;
  /** How many hot blocks make a frame "moving". 4/300 ≈ a person at 6 m. */
  minHotBlocks: number;
  /** Above this the whole scene changed — a light, not an intruder. */
  lightingBlocks: number;
  /** Frames folded into the background before any detection is believed. */
  warmupFrames: number;
  /** ★ Debounce: a curtain in a fan flickers; a person crosses several frames. */
  consecutiveFrames: number;
  /** ★ One event per this window, whatever else happens. */
  cooldownMs: number;
  /** Background adaptation for a quiet block (fast — follows daylight). */
  alphaStill: number;
  /** Background adaptation for a hot block (slow — do not absorb the intruder). */
  alphaMoving: number;
}

export const DEFAULT_MOTION_TUNING: MotionTuning = {
  blockMad: 12,
  minHotBlocks: 4,
  lightingBlocks: Math.round(BLOCK_COUNT * 0.7),
  warmupFrames: 3,
  consecutiveFrames: 3,
  cooldownMs: 30_000,
  alphaStill: 0.08,
  alphaMoving: 0.01,
};

export interface MotionModel {
  /**
   * Rolling background, one float per pixel. Float rather than byte because an
   * IIR with α = 0.01 quantised to integers never moves at all — the update
   * rounds back to where it started and the background freezes.
   */
  background: Float32Array;
  /** Reused across frames; also handed to the UI as a privacy-safe heat map. */
  hotBlocks: Uint8Array;
  framesSeen: number;
  consecutive: number;
  lastEventAt: number | null;
  lastLightingChangeAt: number | null;
}

export function createMotionModel(): MotionModel {
  return {
    background: new Float32Array(GREY_PIXELS),
    hotBlocks: new Uint8Array(BLOCK_COUNT),
    framesSeen: 0,
    consecutive: 0,
    lastEventAt: null,
    lastLightingChangeAt: null,
  };
}

export interface MotionResult {
  /** False when the frame was the wrong shape — never throws at the caller. */
  valid: boolean;
  /** True while the background model is still being learned. */
  warmingUp: boolean;
  hotCount: number;
  totalBlocks: number;
  peakMad: number;
  /** This frame exceeded the spatial threshold. */
  moving: boolean;
  /** The whole scene shifted at once: a light switch, not a person. */
  lightingChange: boolean;
  /** ★ Debounce and cooldown both satisfied — capture a snapshot. */
  event: boolean;
  consecutive: number;
  cooldownRemainingMs: number;
  /** 20×15 map, 1 = block changed. Safe to render: it contains no image. */
  hotBlockMap: Uint8Array;
}

/**
 * Fold one frame into the model and decide whether anything happened.
 *
 * The model is mutated in place on purpose: at 3 fps for days on end, allocating
 * a fresh 19 200-element Float32Array per frame is 230 kB/s of garbage on a
 * phone that must stay cool (P-032). The function is still deterministic — same
 * model, same frame, same result — which is all a test needs.
 */
export function stepMotion(
  model: MotionModel,
  frame: Uint8Array,
  nowMs: number,
  tuning: MotionTuning = DEFAULT_MOTION_TUNING,
): MotionResult {
  const base = {
    valid: false,
    warmingUp: model.framesSeen < tuning.warmupFrames,
    hotCount: 0,
    totalBlocks: BLOCK_COUNT,
    peakMad: 0,
    moving: false,
    lightingChange: false,
    event: false,
    consecutive: model.consecutive,
    cooldownRemainingMs: cooldownRemaining(model, nowMs, tuning),
    hotBlockMap: model.hotBlocks,
  };
  if (frame.length !== GREY_PIXELS) return base;

  const bg = model.background;

  // First frame: the background IS the frame. Reporting motion here would fire
  // on the moment the node was switched on, every single time.
  if (model.framesSeen === 0) {
    for (let i = 0; i < GREY_PIXELS; i++) bg[i] = frame[i];
    model.framesSeen = 1;
    model.hotBlocks.fill(0);
    return { ...base, valid: true, warmingUp: true };
  }

  let hotCount = 0;
  let peakMad = 0;
  for (let by = 0; by < BLOCKS_Y; by++) {
    for (let bx = 0; bx < BLOCKS_X; bx++) {
      let sum = 0;
      for (let y = 0; y < BLOCK; y++) {
        const row = (by * BLOCK + y) * GREY_W + bx * BLOCK;
        for (let x = 0; x < BLOCK; x++) {
          const d = frame[row + x] - bg[row + x];
          sum += d < 0 ? -d : d;
        }
      }
      const mad = sum / (BLOCK * BLOCK);
      if (mad > peakMad) peakMad = mad;
      const hot = mad >= tuning.blockMad;
      model.hotBlocks[by * BLOCKS_X + bx] = hot ? 1 : 0;
      if (hot) hotCount++;
    }
  }

  // ★ A ceiling light coming on changes every block at once. Treating that as
  //   motion is how a monitoring node fills a phone with snapshots of an empty
  //   room at dusk. Re-seed and say nothing.
  if (hotCount >= tuning.lightingBlocks) {
    for (let i = 0; i < GREY_PIXELS; i++) bg[i] = frame[i];
    model.consecutive = 0;
    model.framesSeen++;
    model.lastLightingChangeAt = nowMs;
    return {
      ...base,
      valid: true,
      warmingUp: model.framesSeen < tuning.warmupFrames,
      hotCount,
      peakMad,
      lightingChange: true,
      consecutive: 0,
    };
  }

  // Adapt: quiet blocks track the room (sun moving across a wall), hot blocks
  // barely move so somebody who stops still does not dissolve into the wall.
  for (let by = 0; by < BLOCKS_Y; by++) {
    for (let bx = 0; bx < BLOCKS_X; bx++) {
      const alpha = model.hotBlocks[by * BLOCKS_X + bx] === 1 ? tuning.alphaMoving : tuning.alphaStill;
      for (let y = 0; y < BLOCK; y++) {
        const row = (by * BLOCK + y) * GREY_W + bx * BLOCK;
        for (let x = 0; x < BLOCK; x++) {
          const i = row + x;
          bg[i] += alpha * (frame[i] - bg[i]);
        }
      }
    }
  }

  model.framesSeen++;
  const warmingUp = model.framesSeen < tuning.warmupFrames;
  const moving = !warmingUp && hotCount >= tuning.minHotBlocks;
  model.consecutive = moving ? model.consecutive + 1 : 0;

  const cooled = model.lastEventAt === null || nowMs - model.lastEventAt >= tuning.cooldownMs;
  const event = model.consecutive >= tuning.consecutiveFrames && cooled;
  if (event) model.lastEventAt = nowMs;

  return {
    valid: true,
    warmingUp,
    hotCount,
    totalBlocks: BLOCK_COUNT,
    peakMad,
    moving,
    lightingChange: false,
    event,
    consecutive: model.consecutive,
    cooldownRemainingMs: cooldownRemaining(model, nowMs, tuning),
    hotBlockMap: model.hotBlocks,
  };
}

function cooldownRemaining(model: MotionModel, nowMs: number, tuning: MotionTuning): number {
  if (model.lastEventAt === null) return 0;
  const left = tuning.cooldownMs - (nowMs - model.lastEventAt);
  return left > 0 ? left : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 · Thermal policy (P-032 — a SAFETY requirement)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ★★★ WHY THIS IS NOT A NICETY ★★★
 * The deployment this feature describes is a phone left on a charger, unattended,
 * behind furniture, for months, running the camera. That is the exact recipe for
 * a swollen lithium pouch cell. Nobody is looking at it. The failure mode is a
 * fire in a house with a family asleep in it. So the capture loop is subordinate
 * to the temperature, not the other way round: above 45 °C the node stops
 * watching the house, because a node that keeps watching is worse than one that
 * stops.
 */
export const THERMAL_THROTTLE_C = 42;
export const THERMAL_SUSPEND_C = 45;
/** Hysteresis floor: once suspended, stay suspended until genuinely cool. */
export const THERMAL_RESUME_C = 41;

export const FPS_NOMINAL = 3;
export const FPS_THROTTLED = 1;

export type ThermalTier = 'nominal' | 'hot' | 'critical' | 'unknown';

export interface ThermalSample {
  /**
   * Battery temperature, or null when the device cannot report it.
   *
   * ★ HONESTY: expo-battery in SDK 57 exposes level, charging state and low-power
   * mode — and NOTHING ELSE. Android's ACTION_BATTERY_CHANGED carries
   * EXTRA_TEMPERATURE but Expo does not surface it, so the real number can only
   * come from the KavachT0 native module. When it is absent this field is null
   * and the policy below degrades to `unknown`. It is never guessed: a fabricated
   * 25 °C on a phone that is actually at 47 °C is the single worst line of code
   * this file could contain.
   */
  celsius: number | null;
  batteryPct: number | null;
  charging: boolean;
  at: number;
}

export interface ThermalDecision {
  tier: ThermalTier;
  /** 0 means do not capture at all. */
  fps: number;
  capture: boolean;
  /** Non-null = raise a maintenance alert and show it on both screens. */
  maintenance: string | null;
}

export function formatCelsius(c: number | null): string {
  return c === null ? 'unreadable' : `${c.toFixed(1)} °C`;
}

export function thermalDecision(
  sample: ThermalSample,
  previous: ThermalTier = 'nominal',
): ThermalDecision {
  const c = sample.celsius;

  if (c === null) {
    return {
      tier: 'unknown',
      fps: FPS_THROTTLED,
      capture: true,
      maintenance:
        'This phone will not report its battery temperature, so the node cannot protect itself from overheating. Capture is held at 1 frame per second. Check the phone by hand every few days — if it is warm to the touch, switch the node off.',
    };
  }

  const stayCritical = previous === 'critical' ? c > THERMAL_RESUME_C : c >= THERMAL_SUSPEND_C;
  if (stayCritical) {
    return {
      tier: 'critical',
      fps: 0,
      capture: false,
      maintenance: `Battery at ${formatCelsius(c)}. Capture is suspended. Unplug the charger and move this phone somewhere with airflow before using it as a node again.`,
    };
  }

  if (c >= THERMAL_THROTTLE_C) {
    return {
      tier: 'hot',
      fps: FPS_THROTTLED,
      capture: true,
      maintenance: `Battery at ${formatCelsius(c)}. Capture reduced to 1 frame per second to let it cool.`,
    };
  }

  return { tier: 'nominal', fps: FPS_NOMINAL, capture: true, maintenance: null };
}

/**
 * Separate from the thermal tier because a flat battery and a hot battery are
 * different problems with different fixes, and merging them produces a message
 * that tells the reader to do the wrong thing.
 */
export function powerAdvisory(sample: ThermalSample): string | null {
  const pct = sample.batteryPct;
  if (pct === null) return null;
  if (!sample.charging && pct <= 15) {
    return `Battery at ${Math.round(pct)}% and not charging. This node will stop watching within the hour.`;
  }
  if (!sample.charging && pct <= 35) {
    return `Battery at ${Math.round(pct)}% and not charging. Plug this phone in.`;
  }
  return null;
}

export function captureIntervalMs(fps: number): number {
  if (fps <= 0) return 0;
  return Math.round(1000 / fps);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 · Placement legality (IT Act s.66E)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ★★★ THE ROOMS A NODE MAY NEVER POINT AT ★★★
 * s.66E of the Information Technology Act, 2000 makes it an offence, punishable
 * with imprisonment, to capture the image of a private area of any person
 * without their consent in circumstances where they had a reasonable expectation
 * of privacy — and it names a changing room, a bathroom and any place where a
 * person undresses. Consent given at setup by the phone's owner does not cover
 * the other people who use that room, so no consent screen can make this lawful.
 *
 * Matching on words is imperfect and it is not meant to be a filter that cannot
 * be defeated — somebody determined can type "living room" and point the phone
 * anywhere. It is meant to stop the ordinary, thoughtless placement, and to put
 * the statute in front of the person at the moment they are deciding. The setup
 * flow says so out loud as well.
 */
const FORBIDDEN_PLACEMENT_TERMS: readonly string[] = [
  'bedroom',
  'bed room',
  'bedrm',
  'sleeping room',
  'bathroom',
  'bath room',
  'washroom',
  'wash room',
  'restroom',
  'rest room',
  'toilet',
  'lavatory',
  'shower',
  'changing room',
  'dressing room',
  'undress',
  // hi / gu — the app ships in three languages (NFR-020), so the guard must too.
  'बेडरूम',
  'शयनकक्ष',
  'सोने का कमरा',
  'बाथरूम',
  'स्नानघर',
  'शौचालय',
  'બેડરૂમ',
  'શયનખંડ',
  'બાથરૂમ',
  'સ્નાનગૃહ',
  'શૌચાલય',
];

export interface PlacementCheck {
  ok: boolean;
  reason: string | null;
}

export function checkPlacement(text: string): PlacementCheck {
  const trimmed = text.trim();
  if (trimmed.length < 4) {
    return {
      ok: false,
      reason: 'Describe where this camera points, e.g. "Hall, facing the main door".',
    };
  }
  const hay = trimmed.toLowerCase().replace(/\s+/g, ' ');
  for (const term of FORBIDDEN_PLACEMENT_TERMS) {
    if (hay.includes(term)) {
      return {
        ok: false,
        reason: `A camera may not be placed in or pointed at a ${term}. Capturing images there is an offence under s.66E of the Information Technology Act, 2000, and nobody in this family can consent on behalf of everyone who uses that room.`,
      };
    }
  }
  return { ok: true, reason: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 · Auto-disable: is anybody home? (P-024)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Presence older than this is not evidence of anything. A phone that last
 * reported four hours ago tells you where somebody WAS, and a node that keeps
 * itself switched off on the strength of a stale fix is a node that is not
 * watching the house it was asked to watch.
 */
export const PRESENCE_FRESH_MS = 10 * 60_000;

/**
 * ★ The installer is standing in the room when they arm the node. Without an
 *   exit delay the auto-disable rule fires instantly and the node can never
 *   start. Two minutes to walk out, during which NOTHING is captured — the delay
 *   protects the installer's own privacy as much as it makes the feature work.
 */
export const ARM_EXIT_DELAY_MS = 120_000;

const HOME_FENCE_LABELS: readonly string[] = ['home', 'house', 'ghar', 'घर', 'ઘર'];

/**
 * The home geofence, or null.
 *
 * ★ Null is a HARD BLOCK upstream, not a warning. Auto-disable-when-somebody-is-
 * home is one of the five obligations of P-024; a node that cannot evaluate it
 * cannot honour it, and an unhonourable obligation must stop the feature rather
 * than be downgraded to a promise.
 */
export function pickHomeFence(fences: readonly Geofence[]): Geofence | null {
  for (const f of fences) {
    if (HOME_FENCE_LABELS.includes(f.label.trim().toLowerCase())) return f;
  }
  for (const f of fences) {
    const label = f.label.trim().toLowerCase();
    if (HOME_FENCE_LABELS.some((h) => label.includes(h))) return f;
  }
  return null;
}

export interface HomeSighting {
  memberId: UUID;
  name: string;
  /** 'room' is an indoor beacon (P-028) — stronger evidence than a GPS pin. */
  via: 'room' | 'location';
  at: number;
}

/**
 * Everybody the app can currently see inside the home fence.
 *
 * A member whose monitoring is paused (P-066) contributes nothing: we have no
 * evidence about them, and treating "no data" as "not home" would be a guess
 * that keeps a camera running. It is the caller's job to surface that gap.
 */
export function membersDetectedHome(
  members: readonly Member[],
  presence: Readonly<Record<UUID, MemberPresence>>,
  home: Geofence | null,
  now: number,
): HomeSighting[] {
  if (home === null) return [];
  const out: HomeSighting[] = [];
  for (const m of members) {
    const p = presence[m.id];
    if (p === undefined || p.monitoringPaused) continue;

    if (p.room !== null && p.lastSeenAt !== null && now - p.lastSeenAt <= PRESENCE_FRESH_MS) {
      out.push({ memberId: m.id, name: m.displayName, via: 'room', at: p.lastSeenAt });
      continue;
    }
    const loc = p.location;
    if (loc !== null && now - loc.at <= PRESENCE_FRESH_MS) {
      const d = haversineM({ lat: loc.lat, lon: loc.lon }, { lat: home.lat, lon: home.lon });
      // The fix's own accuracy counts: a 60 m-accurate fix 160 m from a 150 m
      // fence is not proof of absence, and the privacy-preserving reading of an
      // ambiguous fix is "they might be home".
      if (d - loc.accuracyM <= home.radiusM) {
        out.push({ memberId: m.id, name: m.displayName, via: 'location', at: loc.at });
      }
    }
  }
  return out;
}

/** "Priya is home" / "Priya and Dada are home" / "3 people are home". */
export function describeSightings(sightings: readonly HomeSighting[]): string {
  if (sightings.length === 0) return '';
  if (sightings.length === 1) return `${sightings[0].name} is home`;
  if (sightings.length === 2) return `${sightings[0].name} and ${sightings[1].name} are home`;
  return `${sightings.length} people are home`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 · Retention (P-024 — 7 days, and a hard object cap)
// ═══════════════════════════════════════════════════════════════════════════════

export const SNAPSHOT_RETENTION_DAYS = 7;
export const SNAPSHOT_RETENTION_MS = SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60_000;

/**
 * The cap is a second, independent limit on the same data. Retention protects
 * against time; the cap protects against a bad night — a node that somehow fires
 * every 30 s for six hours would otherwise write 720 sealed frames of somebody's
 * home before the seventh day ever arrives.
 */
export const SNAPSHOT_MAX_OBJECTS = 200;

export const SNAPSHOT_PREFIX = 'snap-';
export const SNAPSHOT_EXT = '.sealed';

/** The capture time lives in the FILENAME so retention never needs to decrypt. */
export function snapshotFileName(capturedAt: number, token: string): string {
  const safe = token.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'x';
  return `${SNAPSHOT_PREFIX}${Math.floor(capturedAt)}-${safe}${SNAPSHOT_EXT}`;
}

export function snapshotCapturedAt(name: string): number | null {
  if (!name.startsWith(SNAPSHOT_PREFIX) || !name.endsWith(SNAPSHOT_EXT)) return null;
  const body = name.slice(SNAPSHOT_PREFIX.length, name.length - SNAPSHOT_EXT.length);
  const at = Number.parseInt(body.split('-')[0] ?? '', 10);
  return Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * Everything that must go: past retention, over the cap, or unparseable.
 *
 * An unparseable name is deleted rather than kept. A file in the snapshot
 * directory whose age cannot be established can never be aged out, and a Class-A
 * object with no expiry is exactly what a 7-day promise is supposed to prevent.
 */
export function snapshotsToDelete(names: readonly string[], now: number): string[] {
  const dated: { name: string; at: number }[] = [];
  const doomed: string[] = [];

  for (const n of names) {
    const at = snapshotCapturedAt(n);
    if (at === null) doomed.push(n);
    else if (now - at >= SNAPSHOT_RETENTION_MS) doomed.push(n);
    else dated.push({ name: n, at });
  }

  if (dated.length > SNAPSHOT_MAX_OBJECTS) {
    dated.sort((a, b) => a.at - b.at);
    for (const d of dated.slice(0, dated.length - SNAPSHOT_MAX_OBJECTS)) doomed.push(d.name);
  }
  return doomed;
}
