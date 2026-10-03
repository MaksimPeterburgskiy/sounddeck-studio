import type { ControlPlaybackVoice } from "../../../src/lib/controlProtocol";

export interface KeyImageInput {
  title: string;
  color?: string;
  image?: string | null;
  playing?: ControlPlaybackVoice;
  now?: number;
  dimmed?: boolean;
  warning?: boolean;
  active?: boolean;
  symbol?: string;
}

const DEFAULT_COLOR = "#1db7a6";
const BAR_WIDTH = 124;
const MAX_CACHE_ENTRIES = 512;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheBytes = 0;

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

function safeColor(value?: string): string {
  return value && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : DEFAULT_COLOR;
}

function safeImage(value?: string | null): string | undefined {
  // Only embedded image data is allowed; never let a key fetch remote or local URLs.
  return value && /^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\r\n]+$/.test(value) ? value : undefined;
}

/** Produces a 144px SVG. Titles remain separate so Stream Deck can override them. */
export function keyImage(input: KeyImageInput): string {
  const color = safeColor(input.color);
  const image = safeImage(input.image);
  const glyph = Array.from(input.symbol ?? (Array.from(input.title)[0] ?? "").toUpperCase()).slice(0, 8).join("");
  const now = input.now ?? Date.now();
  const elapsed = input.playing && Number.isFinite(now) ? Math.max(0, now - input.playing.startedAt) : 0;
  const indeterminate = Boolean(input.playing && (input.playing.loop || !Number.isFinite(input.playing.duration) || input.playing.duration <= 0));
  // Quantize to rendered pixels and discrete loop frames, avoiding redundant image updates.
  const progress = input.playing && !indeterminate
    ? Math.round(Math.min(1, elapsed / (input.playing.duration * 1000)) * BAR_WIDTH)
    : 0;
  const loopStep = indeterminate ? Math.floor(elapsed / 125) % 16 : 0;
  const cacheKey = JSON.stringify([color, image, glyph, Boolean(input.playing), progress, indeterminate, loopStep, Boolean(input.dimmed), Boolean(input.warning), Boolean(input.active)]);
  const existing = cache.get(cacheKey);
  if (existing) {
    cache.delete(cacheKey);
    cache.set(cacheKey, existing);
    return existing;
  }

  const border = input.playing ? "#62ffe7" : input.active ? DEFAULT_COLOR : "#ffffff";
  const borderOpacity = input.playing || input.active ? 1 : 0.15;
  const content = image
    ? `<image href="${escapeXml(image)}" x="4" y="4" width="136" height="136" preserveAspectRatio="xMidYMid slice" clip-path="url(#pad)"/>`
    : `<text x="72" y="77" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="60" font-weight="700">${escapeXml(glyph)}</text>`;
  const bar = input.playing
    ? `<rect x="10" y="128" width="${BAR_WIDTH}" height="6" rx="3" fill="#071916" fill-opacity="0.65"/>${indeterminate
      ? `<rect x="${10 + Math.round((BAR_WIDTH - 30) * (1 - Math.abs(loopStep / 8 - 1)))}" y="128" width="30" height="6" rx="3" fill="#62ffe7" data-progress="indeterminate"/>`
      : `<rect x="10" y="128" width="${progress}" height="6" rx="3" fill="#62ffe7" data-progress="determinate"/>`}`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><defs><clipPath id="pad"><rect x="4" y="4" width="136" height="136" rx="14"/></clipPath></defs><rect width="144" height="144" rx="18" fill="#11181b"/><rect x="4" y="4" width="136" height="136" rx="14" fill="${color}"/>${content}<rect x="4" y="4" width="136" height="136" rx="14" fill="none" stroke="${border}" stroke-opacity="${borderOpacity}" stroke-width="${input.playing || input.active ? 6 : 2}"/>${bar}${input.dimmed ? '<rect width="144" height="144" rx="18" fill="#000000" fill-opacity="0.6" data-dimmed="true"/>' : ""}${input.warning ? '<text x="119" y="29" text-anchor="middle" fill="#ffd06a" font-family="Arial, sans-serif" font-size="25">⚠</text>' : ""}</svg>`;
  const result = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  const bytes = (cacheKey.length + result.length) * 2;
  if (bytes <= MAX_CACHE_BYTES) {
    cache.set(cacheKey, result);
    cacheBytes += bytes;
    while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
      const oldest = cache.entries().next().value!;
      cacheBytes -= (oldest[0].length + oldest[1].length) * 2;
      cache.delete(oldest[0]);
    }
  }
  return result;
}
