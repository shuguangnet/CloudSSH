// Generates the PWA PNG icons (terminal prompt on a dark rounded square) into
// frontend/public/icons/. Run with: node scripts/generate-pwa-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const BACKGROUND = [10, 10, 10]; // var(--bg)
const ACCENT = [74, 246, 38]; // var(--accent)
const BORDER = [56, 56, 56];

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const distToSegment = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

/** Renders the icon at `size` with 4x supersampling. Coordinates are 0..1. */
function renderIcon(size) {
  const s = size * 4;
  const pixels = new Float64Array(s * s * 4);
  const radius = 0.22 * s;
  const border = 0.018 * s;
  const lineWidth = 0.075 * s; // prompt stroke thickness
  // Prompt ">": chevron from (0.26,0.32) to (0.47,0.5) to (0.26,0.68)
  const arm1 = [0.26 * s, 0.32 * s, 0.47 * s, 0.5 * s];
  const arm2 = [0.47 * s, 0.5 * s, 0.26 * s, 0.68 * s];
  // Underscore bar
  const bar = { x0: 0.56 * s, x1: 0.76 * s, y0: 0.60 * s, y1: 0.60 * s + lineWidth };
  const half = radius + border; // rounded-rect outer half-extent from edges
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const index = (y * s + x) * 4;
      // rounded-rect coverage with soft edge
      const cx = Math.max(Math.abs(x - s / 2) - (s / 2 - half), 0);
      const cy = Math.max(Math.abs(y - s / 2) - (s / 2 - half), 0);
      const dist = Math.hypot(cx, cy);
      const inside = 1 - Math.min(Math.max(dist - (half - 0.5), 0), 1);
      if (inside <= 0) continue;
      let r = BACKGROUND[0];
      let g = BACKGROUND[1];
      let b = BACKGROUND[2];
      // border ring
      const ringAlpha = 1 - Math.min(Math.max(Math.abs(dist - (radius + border / 2)) - border / 2, 0), 1);
      if (ringAlpha > 0) {
        r = r * (1 - ringAlpha) + BORDER[0] * ringAlpha;
        g = g * (1 - ringAlpha) + BORDER[1] * ringAlpha;
        b = b * (1 - ringAlpha) + BORDER[2] * ringAlpha;
      }
      // accent prompt glyph
      let glyph = 0;
      const d1 = distToSegment(x + 0.5, y + 0.5, ...arm1);
      const d2 = distToSegment(x + 0.5, y + 0.5, ...arm2);
      glyph = Math.max(glyph, 1 - Math.min(Math.max(Math.min(d1, d2) - lineWidth / 2, 0), 1));
      if (x + 0.5 >= bar.x0 && x + 0.5 <= bar.x1 && y + 0.5 >= bar.y0 && y + 0.5 <= bar.y1) glyph = 1;
      if (glyph > 0) {
        r = r * (1 - glyph) + ACCENT[0] * glyph;
        g = g * (1 - glyph) + ACCENT[1] * glyph;
        b = b * (1 - glyph) + ACCENT[2] * glyph;
      }
      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
      pixels[index + 3] = inside * 255;
    }
  }
  // 4x box downsample
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const index = ((y * 4 + dy) * s + x * 4 + dx) * 4;
          const alpha = pixels[index + 3] / 255;
          r += pixels[index] * alpha;
          g += pixels[index + 1] * alpha;
          b += pixels[index + 2] * alpha;
          a += alpha;
        }
      }
      const outIndex = (y * size + x) * 4;
      if (a > 0) {
        out[outIndex] = Math.round(r / a);
        out[outIndex + 1] = Math.round(g / a);
        out[outIndex + 2] = Math.round(b / a);
      }
      out[outIndex + 3] = Math.round((a / 16) * 255);
    }
  }
  return out;
}

const target = resolve('frontend/public/icons');
mkdirSync(target, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(join(target, name), encodePng(size, renderIcon(size)));
  console.log(`wrote ${join('frontend/public/icons', name)} (${size}x${size})`);
}
