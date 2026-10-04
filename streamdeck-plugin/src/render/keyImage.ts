import { keyIcons } from "./icons";
import { keyTitle } from "./keyTitle";
import type { ControlPlaybackVoice } from "../../../src/lib/controlProtocol";

export interface KeyTitleLayout {
  // Effective SDK title, already formatted; user titles are never word-wrapped.
  title: string;
  showTitle: boolean;
  titleAlignment: "bottom" | "middle" | "top";
  fontSize: number;
}

export interface KeyImageInput {
  title: string;
  titleLayout?: KeyTitleLayout;
  badge?: string;
  color?: string;
  image?: string | null;
  playing?: ControlPlaybackVoice;
  now?: number;
  dimmed?: boolean;
  warning?: boolean;
  active?: boolean;
  glyph?: string;
  icon?: keyof typeof keyIcons;
  iconOn?: boolean;
  playingRing?: boolean;
}

const DEFAULT_COLOR = "#1db7a6";
const BAR_WIDTH = 112;
// Stream Deck draws the title over the bottom of the key (13pt, bottom aligned):
// roughly 30px per line plus an 8px margin on a 144px key. Artwork is centered in
// the space above it so a two-line title never runs into the icon.
const TITLE_LINE = 30;
const TITLE_MARGIN = 8;
const ART_TOP = 20;
const ART_GAP = 6;
const ART_MAX = 64;
const BADGE_ICON_MAX = 44;
const BADGE_FONT = 20;
const BADGE_GAP = 6;
const MAX_CACHE_ENTRIES = 512;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const cache = new Map<string, string>();
let cacheBytes = 0;

function escapeXml(value: string): string {
  // XML 1.0 characters only; imported text can contain lone UTF-16 surrogates
  // that would also make encodeURIComponent throw when encoding the SVG.
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, "\ufffd")
    .replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

function safeColor(value?: string): string {
  return value && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : DEFAULT_COLOR;
}

function safeImage(value?: string | null): string | undefined {
  // Only embedded image data is allowed; never let a key fetch remote or local URLs.
  return value && /^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=\r\n]+$/.test(value) ? value : undefined;
}

/** Approximate bold Arial advance widths, enough to center short badges like "100%" or "Muted". */
function textWidth(text: string, size: number): number {
  return Array.from(text).reduce((total, c) => total + size * (
    /[%MW]/.test(c) ? 0.89 : /[il.,'!:;|]/.test(c) ? 0.28 : /[ftrIj ()-]/.test(c) ? 0.39 : /[A-Z]/.test(c) ? 0.72 : 0.56
  ), 0);
}

function glyphColor(color: string): string {
  const hex = color.slice(1);
  const expanded = hex.length === 3 || hex.length === 4 ? hex.split("").map((c) => c + c).join("") : hex;
  const alpha = expanded.length === 8 ? parseInt(expanded.slice(6), 16) / 255 : 1;
  const background = [17, 24, 27];
  const channels = [0, 2, 4].map((offset, index) =>
    (parseInt(expanded.slice(offset, offset + 2), 16) * alpha + background[index] * (1 - alpha)) / 255);
  const luminance = channels.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return luminance[0] * 0.2126 + luminance[1] * 0.7152 + luminance[2] * 0.0722 > 0.2 ? "#11181b" : "#ffffff";
}

/** Produces a 144px SVG. Titles remain separate so Stream Deck can override them. */
export function keyImage(input: KeyImageInput): string {
  const color = safeColor(input.color);
  const image = safeImage(input.image);
  const glyph = input.warning ? "" : Array.from(input.glyph ?? "").slice(0, 1).join("");
  const generatedTitle = keyTitle(input.title);
  const title = input.titleLayout?.title ?? generatedTitle;
  // The event doesn't identify user overrides versus dynamic titles. Reserve the
  // larger area until the next event, so a generated title change also fits.
  const lineCount = (text: string) => text.trim() ? text.split("\n").length : 0;
  const lines = input.titleLayout?.showTitle === false ? 0 : Math.max(lineCount(title), lineCount(generatedTitle));
  const fontSize = input.titleLayout?.fontSize;
  const lineHeight = Number.isFinite(fontSize) && fontSize! > 0 ? Math.ceil(TITLE_LINE * fontSize! / 13) : TITLE_LINE;
  const titleHeight = Math.min(128, lines * lineHeight);
  const alignment = lines ? input.titleLayout?.titleAlignment ?? "bottom" : "bottom";
  const ring = input.playing || input.playingRing ? "playing" : input.active ? "active" : "idle";
  const now = input.now ?? Date.now();
  const elapsed = input.playing && Number.isFinite(now) ? Math.max(0, now - input.playing.startedAt) : 0;
  const indeterminate = Boolean(input.playing && (input.playing.loop || !Number.isFinite(input.playing.duration) || input.playing.duration <= 0));
  // Quantize to rendered pixels and discrete loop frames, avoiding redundant image updates.
  const progress = input.playing && !indeterminate
    ? Math.round(Math.min(1, elapsed / (input.playing.duration * 1000)) * BAR_WIDTH)
    : 0;
  const loopStep = indeterminate ? Math.floor(elapsed / 125) % 16 : 0;
  const cacheKey = JSON.stringify([color, image, glyph, Boolean(input.playing), progress, indeterminate, loopStep, Boolean(input.dimmed), Boolean(input.warning), Boolean(input.active), input.icon, input.iconOn, input.badge, ring, titleHeight, alignment]);
  const existing = cache.get(cacheKey);
  if (existing) {
    cache.delete(cacheKey);
    cache.set(cacheKey, existing);
    return existing;
  }

  const iconColor = input.iconOn ? DEFAULT_COLOR : "#8fa5a4";
  const titleTop = alignment === "top" ? TITLE_MARGIN
    : alignment === "middle" ? (144 - titleHeight) / 2 : 144 - TITLE_MARGIN - titleHeight;
  let artTop = ART_TOP;
  let artBottom = (lines ? titleTop : 144 - ART_TOP) - ART_GAP;
  // Top titles put artwork below them. Middle titles use the larger free side;
  // if the title fills the key, omit foreground artwork rather than overlap it.
  if (lines && (alignment === "top" || (alignment === "middle"
    && 144 - ART_TOP - titleTop - titleHeight > titleTop - ART_TOP))) {
    artTop = Math.max(ART_TOP, titleTop + titleHeight + ART_GAP);
    artBottom = 144 - ART_TOP - ART_GAP;
  }
  // A status badge (for example a volume level) sits beside the icon, and the pair is centered.
  const size = Math.max(0, Math.min(input.badge ? BADGE_ICON_MAX : ART_MAX, artBottom - artTop));
  const centerY = Math.round((artTop + artBottom) / 2);
  const groupLeft = 72 - (input.badge ? size + BADGE_GAP + textWidth(input.badge, BADGE_FONT) : size) / 2;
  const icon = (name: string, body: string, color: string, attributes: string, centerX = 72) => {
    if (!size) return "";
    const scale = size / 24;
    return `<g data-${name} transform="translate(${Math.round((centerX - 12 * scale) * 10) / 10} ${centerY - 12 * scale}) scale(${scale})" color="${color}" ${attributes}>${body}</g>`;
  };
  const content = input.warning
    ? ""
    : input.icon
      ? icon(`icon="${input.icon}"`, keyIcons[input.icon], iconColor, 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"', input.badge ? groupLeft + size / 2 : 72)
      : image
        ? `<image data-image="custom" href="${escapeXml(image)}" xlink:href="${escapeXml(image)}" x="8" y="8" width="128" height="128" preserveAspectRatio="xMidYMid slice"/><path d="M8 8H136V136H8Z M20 8H124Q136 8 136 20V124Q136 136 124 136H20Q8 136 8 124V20Q8 8 20 8Z" fill="#11181b" fill-rule="evenodd"/>`
        : glyph && size
          // Arial capitals are about 0.72em tall; offset the baseline so the capital is centered.
          ? `<text data-glyph="initial" x="72" y="${Math.round(centerY + size * 0.9 * 0.36)}" text-anchor="middle" fill="${glyphColor(color)}" font-family="Arial, sans-serif" font-size="${Math.round(size * 0.9)}" font-weight="700">${escapeXml(glyph)}</text>`
          : "";
  const badge = input.badge ? `<text data-badge="status" x="${Math.round(groupLeft + size + BADGE_GAP)}" y="${Math.round(centerY + BADGE_FONT * 0.36)}" fill="${input.iconOn ? "#ffffff" : "#8fa5a4"}" font-family="Arial, sans-serif" font-size="${BADGE_FONT}" font-weight="700">${escapeXml(input.badge)}</text>` : "";
  const shadeTop = Math.max(8, titleTop - 12);
  const shade = lines ? `<rect x="8" y="${shadeTop}" width="128" height="${Math.min(136, titleTop + titleHeight) - shadeTop}" rx="12" fill="url(#titleShade)"/>` : "";
  const bar = input.playing
    ? `<rect data-progress-track="top" x="16" y="12" width="${BAR_WIDTH}" height="5" rx="2.5" fill="#071916" fill-opacity="0.85"/>${indeterminate
      ? `<rect x="${16 + Math.round((BAR_WIDTH - 30) * (1 - Math.abs(loopStep / 8 - 1)))}" y="12" width="30" height="5" rx="2.5" fill="#62ffe7" data-progress="indeterminate"/>`
      : `<rect x="16" y="12" width="${progress}" height="5" rx="2.5" fill="#62ffe7" data-progress="determinate" data-progress-pixels="${progress}"/>`}`
    : "";
  const warning = input.warning ? icon('warning="true"', keyIcons.warning, "#ffb020", "") : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144" viewBox="0 0 144 144"><defs><linearGradient id="titleShade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.8"/></linearGradient></defs><rect width="144" height="144" rx="18" fill="#11181b"/><rect data-pad="${input.icon ? "control" : "sound"}" x="8" y="8" width="128" height="128" rx="12" fill="${input.icon ? "#11181b" : color}"/>${content}${badge}${shade}<rect data-ring="${ring}" x="2.5" y="2.5" width="139" height="139" rx="16.5" fill="none" stroke="${ring === "playing" ? "#62ffe7" : ring === "active" ? "#ffffff" : "#283f3e"}" stroke-width="${ring === "playing" ? 4 : ring === "active" ? 3 : 1}"/>${bar}${input.dimmed ? '<rect width="144" height="144" rx="18" fill="#000000" fill-opacity="0.6" data-dimmed="true"/>' : ""}${warning}</svg>`;
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
