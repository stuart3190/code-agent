// Generates the Thrallo desktop icon assets without image libraries: procedural RGBA →
// hand-built PNG, plus ICO and ICNS containers that embed the PNGs (supported by Windows
// Vista+ and macOS 10.7+ respectively). Outputs are committed under desktop/assets so the
// bootstrap stays reproducible without running this script.
//
//   node desktop/generate-assets.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
mkdirSync(OUT, { recursive: true });

function renderIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const s = (v) => Math.round((v / 128) * size);
  const bg = [11, 13, 18];
  const top = [59, 130, 246];
  const bottom = [139, 92, 246];
  const radius = s(22);
  const inRect = (x, y, x0, y0, x1, y1) => x >= s(x0) && x < s(x1) && y >= s(y0) && y < s(y1);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const cx = x < radius ? radius - x : x >= size - radius ? x - (size - radius - 1) : 0;
      const cy = y < radius ? radius - y : y >= size - radius ? y - (size - radius - 1) : 0;
      const outside = cx * cx + cy * cy > radius * radius;
      const glyph = inRect(x, y, 20, 26, 108, 44) || inRect(x, y, 55, 26, 73, 102) || inRect(x, y, 40, 92, 88, 102);
      if (outside) {
        px.set([0, 0, 0, 0], i);
      } else if (glyph) {
        const t = (y - s(26)) / (s(102) - s(26));
        px.set([
          Math.round(top[0] + (bottom[0] - top[0]) * t),
          Math.round(top[1] + (bottom[1] - top[1]) * t),
          Math.round(top[2] + (bottom[2] - top[2]) * t),
          255,
        ], i);
      } else {
        px.set([bg[0], bg[1], bg[2], 255], i);
      }
    }
  }
  return px;
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}
function encodePng(px, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ICO with PNG-compressed entries (one per size).
function encodeIco(pngsBySize) {
  const entries = Object.entries(pngsBySize).map(([size, png]) => ({ size: Number(size), png }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    dir[at] = entry.size >= 256 ? 0 : entry.size;
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size;
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(entry.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((entry) => entry.png)]);
}

// ICNS with PNG payloads: ic07 = 128px, ic08 = 256px, ic09 = 512px.
function encodeIcns(pngsByType) {
  const blocks = Object.entries(pngsByType).map(([type, png]) => {
    const block = Buffer.alloc(8 + png.length);
    block.write(type, 0, "ascii");
    block.writeUInt32BE(8 + png.length, 4);
    png.copy(block, 8);
    return block;
  });
  const total = 8 + blocks.reduce((sum, block) => sum + block.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...blocks]);
}

const png128 = encodePng(renderIcon(128), 128);
const png256 = encodePng(renderIcon(256), 256);
const png512 = encodePng(renderIcon(512), 512);
const png32 = encodePng(renderIcon(32), 32);

writeFileSync(path.join(OUT, "thrallo-128.png"), png128);
writeFileSync(path.join(OUT, "thrallo-256.png"), png256);
writeFileSync(path.join(OUT, "thrallo-512.png"), png512);
writeFileSync(path.join(OUT, "thrallo.ico"), encodeIco({ 32: png32, 128: png128, 256: png256 }));
writeFileSync(path.join(OUT, "thrallo.icns"), encodeIcns({ ic07: png128, ic08: png256, ic09: png512 }));
console.log("assets written to", OUT);
