// Generates the NSIS installer artwork (welcome/finish sidebar and header
// strip) procedurally so it always matches the app theme: charcoal deck,
// LED-lime accents, and a soundboard waveform. Writes 24-bit uncompressed
// BMPs, the only format NSIS accepts.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(repoRoot, "build");

// Theme colors (mirrors src/styles.css).
const BG_DEEP = [6, 7, 8];
const BG = [10, 11, 13];
const SURFACE = [18, 20, 25];
const LINE = [38, 43, 52];
const ACCENT = [198, 241, 46];
const TEXT_DIM = [151, 161, 176];

// 5x7 pixel font, just the glyphs the artwork needs.
const FONT = {
  S: ["01110", "10001", "10000", "01110", "00001", "10001", "01110"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"]
};

function makeCanvas(width, height) {
  const pixels = new Uint8Array(width * height * 3);
  return {
    width,
    height,
    pixels,
    set(x, y, [r, g, b]) {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const offset = (y * width + x) * 3;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
    }
  };
}

function fillRect(canvas, x, y, w, h, color) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) canvas.set(x + dx, y + dy, color);
  }
}

function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
}

function verticalGradient(canvas, top, bottom) {
  for (let y = 0; y < canvas.height; y++) {
    const color = mix(top, bottom, y / (canvas.height - 1));
    fillRect(canvas, 0, y, canvas.width, 1, color);
  }
}

function drawText(canvas, text, x, y, scale, color) {
  let cursor = x;
  for (const char of text) {
    const glyph = FONT[char];
    if (!glyph) {
      cursor += 3 * scale; // space
      continue;
    }
    glyph.forEach((row, gy) => {
      [...row].forEach((bit, gx) => {
        if (bit === "1") fillRect(canvas, cursor + gx * scale, y + gy * scale, scale, scale, color);
      });
    });
    cursor += 6 * scale;
  }
  return cursor - scale; // width used
}

function textWidth(text, scale) {
  return text.length * 6 * scale - scale;
}

// Deterministic pseudo-random so the artwork is reproducible.
function makeRng(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function drawWaveform(canvas, centerY, x, width, maxHalf, seed) {
  const rng = makeRng(seed);
  const barWidth = 3;
  const gap = 2;
  for (let bx = x; bx + barWidth <= x + width; bx += barWidth + gap) {
    const t = (bx - x) / width;
    const envelope = 0.35 + 0.65 * Math.sin(Math.PI * t) ** 0.8;
    const half = Math.max(2, Math.round(maxHalf * envelope * (0.3 + 0.7 * rng())));
    const bright = rng() > 0.25;
    const color = bright ? ACCENT : mix(ACCENT, SURFACE, 0.6);
    fillRect(canvas, bx, centerY - half, barWidth, half * 2, color);
  }
}

function writeBmp(filePath, canvas) {
  const { width, height, pixels } = canvas;
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write("BM", 0);
  buf.writeUInt32LE(54 + dataSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28); // 24-bit, BI_RGB
  buf.writeUInt32LE(dataSize, 34);
  buf.writeInt32LE(2835, 38); // 72 DPI
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const rowOffset = 54 + (height - 1 - y) * rowSize; // BMP rows are bottom-up
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      const dst = rowOffset + x * 3;
      buf[dst] = pixels[src + 2]; // BGR order
      buf[dst + 1] = pixels[src + 1];
      buf[dst + 2] = pixels[src];
    }
  }
  writeFileSync(filePath, buf);
  console.log(`Wrote ${filePath} (${width}x${height})`);
}

// Welcome/finish sidebar: 164x314.
{
  const canvas = makeCanvas(164, 314);
  verticalGradient(canvas, SURFACE, BG_DEEP);
  // Lime LED strip along the outer edge.
  fillRect(canvas, 0, 0, 3, canvas.height, ACCENT);
  // Wordmark.
  const title = "SOUNDDECK";
  const subtitle = "STUDIO";
  drawText(canvas, title, Math.round((164 - textWidth(title, 2)) / 2), 38, 2, ACCENT);
  drawText(canvas, subtitle, Math.round((164 - textWidth(subtitle, 2)) / 2), 58, 2, TEXT_DIM);
  fillRect(canvas, 30, 80, 104, 1, LINE);
  // Waveform centerpiece.
  drawWaveform(canvas, 180, 14, 136, 52, 7);
  fillRect(canvas, 14, 180, 136, 1, mix(ACCENT, BG, 0.5));
  writeBmp(path.join(buildDir, "installerSidebar.bmp"), canvas);
}

// Header strip (top-right of the install pages): 150x57.
{
  const canvas = makeCanvas(150, 57);
  verticalGradient(canvas, SURFACE, BG);
  fillRect(canvas, 0, 54, canvas.width, 3, ACCENT);
  drawWaveform(canvas, 26, 10, 130, 17, 21);
  writeBmp(path.join(buildDir, "installerHeader.bmp"), canvas);
}
