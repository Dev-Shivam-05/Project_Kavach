/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Asset generator — app icon, adaptive icon, splash logo, notification icon.
 *
 * ★ WHY THIS EXISTS ★
 * The EAS build failed at :app:processReleaseResources with
 *   "resource drawable/splashscreen_logo not found"
 * because the expo-splash-screen plugin writes
 *   <item name="windowSplashScreenAnimatedIcon">@drawable/splashscreen_logo</item>
 * into styles.xml unconditionally, but generates no drawable when no source image
 * is configured. Every drawable-* directory came out empty and AAPT2 refused to
 * link. Shipping a safety app with no icon is its own defect anyway.
 *
 * ★ WHY HAND-ROLLED PNG ★
 * No sharp, no canvas, no image library — those are heavy native dependencies for
 * four small images, and a build that needs a C++ toolchain to produce an icon is
 * a build that breaks on someone else's machine. Node's zlib is enough: a PNG is
 * IHDR + deflate(filtered scanlines) + IEND, and CRC32 is fifteen lines.
 *
 * The mark is a shield — कवच means "armour" — in the product's danger red on the
 * product's near-black, with a white heartbeat trace across it. It has to read at
 * 48 px in a notification tray, so it is a silhouette and nothing more.
 *
 * Run:  npm run gen:assets
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../assets');
mkdirSync(OUT, { recursive: true });

// ── PNG encoding ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array of w*h*4, straight (non-premultiplied) alpha. */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10,11,12 = deflate / adaptive filtering / no interlace, all zero.

  // One filter byte (0 = None) per scanline. Filtering would shrink these
  // further, but at 1024² the file is already ~30 KB and clarity wins.
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    rgba.copy
      ? rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4)
      : Buffer.from(rgba.subarray(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (1 + w * 4) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── The mark ──────────────────────────────────────────────────────────────────

const RED = [0xe5, 0x32, 0x2e];
const DARK = [0x0b, 0x0f, 0x14];
const WHITE = [0xff, 0xff, 0xff];

/**
 * Shield membership for normalised coords in [-1, 1].
 * Flat-ish shoulders that taper to a point — the classic heater shield, which
 * stays legible when a launcher masks it to a circle.
 */
function shieldHalfWidth(ny) {
  if (ny < -1 || ny > 1) return -1;
  if (ny <= 0.1) {
    // Shoulders: near-full width, corners eased off so a circular mask does not
    // shave a flat edge.
    const t = (ny + 1) / 1.1; // 0 at the very top → 1 at the shoulder line
    return Math.min(1, Math.sqrt(Math.max(0, 1 - Math.pow(1 - t, 2.2) * 0.42)));
  }
  // Body: cosine taper to a point at the bottom.
  return Math.cos(((ny - 0.1) / 0.9) * (Math.PI / 2));
}

/**
 * A heartbeat trace across the shield. Returns the |dy| distance from the trace
 * at a given nx, or Infinity where the trace does not run.
 */
function pulseDistance(nx, ny) {
  if (nx < -0.62 || nx > 0.62) return Infinity;
  let y;
  if (nx < -0.28) y = 0;
  else if (nx < -0.14) y = ((nx + 0.28) / 0.14) * -0.34; // up stroke
  else if (nx < 0.02) y = -0.34 + ((nx + 0.14) / 0.16) * 0.66; // down stroke
  else if (nx < 0.16) y = 0.32 - ((nx - 0.02) / 0.14) * 0.32; // back to baseline
  else y = 0;
  return Math.abs(ny - y);
}

/**
 * @param size    square edge in px
 * @param inset   fraction of the canvas the shield occupies (adaptive icons need
 *                the mark inside the centre 66% safe zone, or launchers crop it)
 * @param bg      [r,g,b] or null for transparent
 * @param fg      shield fill
 * @param pulse   draw the heartbeat trace
 */
function renderIcon({ size, inset, bg, fg, pulse = true, monochrome = false }) {
  const px = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const scale = 1 / (inset * half);
  // Supersample: these are hard-edged shapes and aliasing is very visible at
  // notification size.
  const S = 3;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      let pulseHit = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const nx = (x + (sx + 0.5) / S - half) * scale;
          const ny = (y + (sy + 0.5) / S - half) * scale;
          const hw = shieldHalfWidth(ny);
          if (hw >= 0 && Math.abs(nx) <= hw) {
            hit++;
            if (pulse && pulseDistance(nx, ny) < 0.075) pulseHit++;
          }
        }
      }
      const n = S * S;
      const cov = hit / n;
      const pcov = pulseHit / n;
      const i = (y * size + x) * 4;

      if (monochrome) {
        // Android notification icons are a silhouette: only alpha is read, any
        // colour is replaced by the system. Punch the pulse OUT of the shield so
        // the shape survives that flattening.
        const a = Math.max(0, cov - pcov);
        px[i] = px[i + 1] = px[i + 2] = 0xff;
        px[i + 3] = Math.round(a * 255);
        continue;
      }

      let r, g, b, a;
      if (bg) {
        r = bg[0]; g = bg[1]; b = bg[2]; a = 255;
      } else {
        r = fg[0]; g = fg[1]; b = fg[2]; a = 0;
      }
      if (cov > 0) {
        const over = bg ? cov : 1;
        r = Math.round(r * (1 - over) + fg[0] * over);
        g = Math.round(g * (1 - over) + fg[1] * over);
        b = Math.round(b * (1 - over) + fg[2] * over);
        a = Math.max(a, Math.round(cov * 255));
      }
      if (pcov > 0) {
        r = Math.round(r * (1 - pcov) + WHITE[0] * pcov);
        g = Math.round(g * (1 - pcov) + WHITE[1] * pcov);
        b = Math.round(b * (1 - pcov) + WHITE[2] * pcov);
        a = Math.max(a, Math.round(pcov * 255));
      }
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }
  return encodePng(size, size, px);
}

const targets = [
  // Store/launcher icon: opaque, mark fills most of the tile.
  { file: 'icon.png', opts: { size: 1024, inset: 0.74, bg: DARK, fg: RED } },
  // Adaptive foreground: transparent, mark inside the safe zone so no launcher
  // mask clips it.
  { file: 'adaptive-icon.png', opts: { size: 1024, inset: 0.46, bg: null, fg: RED } },
  // Splash: transparent; expo-splash-screen composites it on backgroundColor.
  { file: 'splash-icon.png', opts: { size: 512, inset: 0.62, bg: null, fg: RED } },
  // Notification: white silhouette, alpha only.
  { file: 'notification-icon.png', opts: { size: 192, inset: 0.72, bg: null, fg: WHITE, monochrome: true } },
  // Favicon for the web target.
  { file: 'favicon.png', opts: { size: 64, inset: 0.8, bg: DARK, fg: RED, pulse: false } },
];

for (const { file, opts } of targets) {
  const png = renderIcon(opts);
  writeFileSync(resolve(OUT, file), png);
  console.log(`  ✔ ${file.padEnd(22)} ${opts.size}×${opts.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log(`\n✔ ${targets.length} assets → ${OUT}`);
