// Pure helpers for media import/storage, extracted from main.cjs so they can
// be unit-tested without Electron.
const path = require("node:path");

function sanitizeName(input) {
  return String(input || "sound")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "sound";
}

function inferMime(ext) {
  const normalized = ext.toLowerCase();
  return {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".webm": "audio/webm"
  }[normalized] || "application/octet-stream";
}

function allowedAudioExtensions() {
  return new Set([".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".webm"]);
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// Guard for renderer-supplied media paths: only paths strictly inside the
// app-managed media directory may be read, deleted, or used as a crop source.
function isInsideMediaRoot(root, candidate) {
  const resolvedRoot = path.resolve(String(root || ""));
  const resolvedCandidate = path.resolve(String(candidate || ""));
  return resolvedCandidate.startsWith(resolvedRoot + path.sep);
}

module.exports = {
  sanitizeName,
  inferMime,
  allowedAudioExtensions,
  isHttpUrl,
  isInsideMediaRoot
};
