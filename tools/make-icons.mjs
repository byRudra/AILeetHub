/**
 * Renders icons/icon{16,48,128}.png.
 *
 * The extension has no build step and no image dependencies, so the icons are
 * drawn here with plain arithmetic and encoded as PNG by hand. Run with:
 *   node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUPERSAMPLE = 4; // Rendered large, then box-filtered down for smooth edges.

const GRADIENT_FROM = [124, 108, 255]; // --accent
const GRADIENT_TO = [33, 200, 164]; // --easy

/* ------------------------------------------------------------------- shapes */

function roundedRectCoverage(x, y, size, radius) {
  const inset = size * 0.02;
  const min = inset;
  const max = size - inset;
  if (x < min || y < min || x > max || y > max) return 0;

  // Only the corners need a distance test; the rest is inside by definition.
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  return Math.hypot(x - cx, y - cy) <= radius ? 1 : 0;
}

/** Three ascending bars: the "progress" mark. */
function barsCoverage(x, y, size) {
  const bars = [
    { left: 0.24, top: 0.56 },
    { left: 0.43, top: 0.40 },
    { left: 0.62, top: 0.26 },
  ];
  const width = 0.14;
  const bottom = 0.76;

  for (const bar of bars) {
    const x0 = bar.left * size;
    const x1 = (bar.left + width) * size;
    const y0 = bar.top * size;
    const y1 = bottom * size;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return 1;
  }
  return 0;
}

function renderPixel(x, y, size) {
  const outside = roundedRectCoverage(x, y, size, size * 0.22);
  if (!outside) return [0, 0, 0, 0];

  // Diagonal gradient.
  const t = Math.min(1, Math.max(0, (x / size) * 0.5 + (y / size) * 0.5));
  const base = GRADIENT_FROM.map((from, i) => Math.round(from + (GRADIENT_TO[i] - from) * t));

  if (barsCoverage(x, y, size)) return [255, 255, 255, 255];
  return [...base, 255];
}

function renderIcon(size) {
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const [pr, pg, pb, pa] = renderPixel(
            (x * SUPERSAMPLE + sx + 0.5) / SUPERSAMPLE,
            (y * SUPERSAMPLE + sy + 0.5) / SUPERSAMPLE,
            size,
          );
          const alpha = pa / 255;
          r += pr * alpha;
          g += pg * alpha;
          b += pb * alpha;
          a += pa;
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const coverage = a / samples / 255;
      const offset = (y * size + x) * 4;
      // Un-premultiply so edge pixels keep their colour instead of darkening.
      out[offset] = coverage ? Math.round(r / samples / coverage) : 0;
      out[offset + 1] = coverage ? Math.round(g / samples / coverage) : 0;
      out[offset + 2] = coverage ? Math.round(b / samples / coverage) : 0;
      out[offset + 3] = Math.round(a / samples);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- PNG codec */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10-12: compression, filter, interlace — all zero.

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------- main */

mkdirSync(join(ROOT, 'icons'), { recursive: true });
for (const size of [16, 48, 128]) {
  const file = join(ROOT, 'icons', `icon${size}.png`);
  writeFileSync(file, encodePng(renderIcon(size), size));
  console.log(`wrote icons/icon${size}.png`);
}
