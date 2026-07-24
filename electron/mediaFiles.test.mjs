import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mediaFiles from "./mediaFiles.cjs";

const {
  sanitizeName,
  inferMime,
  allowedAudioExtensions,
  safeAudioExtension,
  storedAudioExtension,
  isHttpUrl,
  isInsideMediaRoot
} = mediaFiles;

describe("sanitizeName", () => {
  it("strips filesystem-reserved and control characters", () => {
    expect(sanitizeName('air<horn>:"/\\|?*')).toBe("airhorn");
    // Control characters (including tabs) are stripped before whitespace collapsing.
    expect(sanitizeName("tab\there\x00end")).toBe("tabhereend");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeName("  My   Cool\n Sound  ")).toBe("My Cool Sound");
  });

  it("caps the length at 80 characters", () => {
    expect(sanitizeName("x".repeat(200))).toHaveLength(80);
  });

  it("falls back to 'sound' for empty or fully-stripped input", () => {
    expect(sanitizeName("")).toBe("sound");
    expect(sanitizeName(null)).toBe("sound");
    expect(sanitizeName('<>:"/\\|?*')).toBe("sound");
    expect(sanitizeName("   ")).toBe("sound");
  });
});

describe("inferMime and allowedAudioExtensions", () => {
  it("maps every allowed extension to an audio mime type", () => {
    for (const ext of allowedAudioExtensions()) {
      expect(inferMime(ext)).toMatch(/^audio\//);
    }
  });

  it("is case-insensitive and falls back for unknown extensions", () => {
    expect(inferMime(".MP3")).toBe("audio/mpeg");
    expect(inferMime(".xyz")).toBe("application/octet-stream");
  });

  it("does not allow non-audio extensions", () => {
    expect(allowedAudioExtensions().has(".txt")).toBe(false);
    expect(allowedAudioExtensions().has(".exe")).toBe(false);
  });
});

describe("safe audio extensions", () => {
  it("normalizes allowlisted extension values", () => {
    for (const extension of allowedAudioExtensions()) {
      expect(safeAudioExtension(extension.toUpperCase())).toBe(extension);
    }
    expect(safeAudioExtension(" .webm ")).toBe(".webm");
  });

  it("rejects unsupported, separator-bearing, and traversal values", () => {
    expect(safeAudioExtension(".txt")).toBe("");
    expect(safeAudioExtension("../library.json")).toBe("");
    expect(safeAudioExtension(".webm/../../library.json")).toBe("");
    expect(safeAudioExtension(".webm\\..\\..\\library.json")).toBe("");
    expect(safeAudioExtension("webm")).toBe("");
    expect(safeAudioExtension(".mp3\u0000.exe")).toBe("");
    expect(safeAudioExtension(null)).toBe("");
    expect(safeAudioExtension({})).toBe("");
  });

  it("uses a safe stored-name extension or an allowlisted fallback", () => {
    expect(storedAudioExtension("sound.MP3", ".wav")).toBe(".mp3");
    expect(storedAudioExtension("sound", ".WEBM")).toBe(".webm");
  });

  it("rejects path-like stored names and unsafe fallbacks", () => {
    expect(storedAudioExtension("../../sound.mp3", ".wav")).toBe("");
    expect(storedAudioExtension("..\\..\\sound.mp3", ".wav")).toBe("");
    expect(storedAudioExtension("sound", "../../library.json")).toBe("");
    expect(storedAudioExtension("", ".mp3")).toBe("");
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https URLs only", () => {
    expect(isHttpUrl("https://example.com/a.mp3")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("example.com")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

describe("isInsideMediaRoot", () => {
  const root = path.resolve("/app/library/media");

  it("accepts files directly inside and nested under the root", () => {
    expect(isInsideMediaRoot(root, path.join(root, "sound.mp3"))).toBe(true);
    expect(isInsideMediaRoot(root, path.join(root, "nested", "sound.mp3"))).toBe(true);
  });

  it("rejects traversal out of the root", () => {
    expect(isInsideMediaRoot(root, path.join(root, "..", "library.json"))).toBe(false);
    expect(isInsideMediaRoot(root, path.join(root, "nested", "..", "..", "library.json"))).toBe(false);
  });

  it("rejects sibling directories sharing the root as a name prefix", () => {
    expect(isInsideMediaRoot(root, `${root}-evil${path.sep}sound.mp3`)).toBe(false);
  });

  it("rejects the root itself and empty input", () => {
    expect(isInsideMediaRoot(root, root)).toBe(false);
    expect(isInsideMediaRoot(root, "")).toBe(false);
  });
});

describe("isInsideMediaRoot with symlinks on a real filesystem", () => {
  let sandbox;
  let mediaDir;
  let outsideDir;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sounddeck-media-test-"));
    mediaDir = path.join(sandbox, "media");
    outsideDir = path.join(sandbox, "outside");
    fs.mkdirSync(mediaDir);
    fs.mkdirSync(outsideDir);
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("accepts a real file inside the root", () => {
    const file = path.join(mediaDir, "sound.mp3");
    fs.writeFileSync(file, "data");
    expect(isInsideMediaRoot(mediaDir, file)).toBe(true);
  });

  it("accepts a not-yet-existing destination inside the root", () => {
    expect(isInsideMediaRoot(mediaDir, path.join(mediaDir, "future-crop.wav"))).toBe(true);
  });

  it("rejects a symlink inside the root that points to a file outside", () => {
    const secret = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(secret, "secret");
    const link = path.join(mediaDir, "innocent.mp3");
    fs.symlinkSync(secret, link);
    expect(isInsideMediaRoot(mediaDir, link)).toBe(false);
  });

  it("rejects a path under a symlinked directory that escapes the root", () => {
    const linkDir = path.join(mediaDir, "sub");
    fs.symlinkSync(outsideDir, linkDir, "dir");
    expect(isInsideMediaRoot(mediaDir, path.join(linkDir, "sound.mp3"))).toBe(false);
  });

  it("rejects an external symlink that points at a file inside the root", () => {
    const target = path.join(mediaDir, "real.mp3");
    fs.writeFileSync(target, "data");
    const externalLink = path.join(outsideDir, "alias.mp3");
    fs.symlinkSync(target, externalLink);
    expect(isInsideMediaRoot(mediaDir, externalLink)).toBe(false);
  });

  it("accepts a symlink that stays inside the root", () => {
    const target = path.join(mediaDir, "real.mp3");
    fs.writeFileSync(target, "data");
    const link = path.join(mediaDir, "alias.mp3");
    fs.symlinkSync(target, link);
    expect(isInsideMediaRoot(mediaDir, link)).toBe(true);
  });

  // NTFS and default APFS lookups are case-insensitive, so paths supplied
  // with different casing must still match. Skips itself on case-sensitive
  // volumes, where such paths genuinely name different files.
  it("accepts paths differing only by casing on case-insensitive filesystems", () => {
    const file = path.join(mediaDir, "sound.mp3");
    fs.writeFileSync(file, "data");
    const upperMedia = path.join(sandbox, "MEDIA");
    if (!fs.existsSync(upperMedia)) return;
    expect(isInsideMediaRoot(upperMedia, file)).toBe(true);
    expect(isInsideMediaRoot(mediaDir, path.join(upperMedia, "sound.mp3"))).toBe(true);
  });
});
