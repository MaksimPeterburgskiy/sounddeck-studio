// Pure helpers for media import/storage, extracted from main.cjs so they can
// be unit-tested without Electron.
const fs = require("node:fs");
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

// Resolve symlinks so the containment check compares physical paths. The
// target may not exist yet (e.g. a crop destination before it is written), so
// walk up to the nearest existing ancestor and re-attach the missing tail —
// a symlinked parent directory still can't smuggle the path outside the root.
function realPathOrNearestAncestor(target) {
  const resolved = path.resolve(String(target || ""));
  try {
    // The native realpath also canonicalizes on-disk casing, which the JS
    // implementation does not; case-insensitive volumes (default APFS,
    // NTFS) need that for the containment comparison below.
    return fs.realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(realPathOrNearestAncestor(parent), path.basename(resolved));
  }
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

// Where the submitted path's own directory entry lives: symlinks (and
// on-disk casing, on case-insensitive filesystems) are canonicalized in the
// parent directories but not in the final component, because deletes remove
// the entry itself rather than whatever it points at.
function entryLocation(target) {
  const resolved = path.resolve(String(target || ""));
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(realPathOrNearestAncestor(parent), path.basename(resolved));
}

// Guard for renderer-supplied media paths: only paths strictly inside the
// app-managed media directory may be read, deleted, or used as a crop source.
// Containment must hold both for the directory entry itself (an external
// symlink aliasing in-root media stays rejected — deletes operate on the
// submitted path) and after fully resolving symlinks (an in-root symlink
// can't reach outside the root).
function isInsideMediaRoot(root, candidate) {
  const realRoot = realPathOrNearestAncestor(root);
  return (
    isContained(realRoot, entryLocation(candidate)) &&
    isContained(realRoot, realPathOrNearestAncestor(candidate))
  );
}

module.exports = {
  sanitizeName,
  inferMime,
  allowedAudioExtensions,
  isHttpUrl,
  isInsideMediaRoot
};
