import { describe, expect, it } from "vitest";
import path from "node:path";
import mediaFiles from "./mediaFiles.cjs";

const { sanitizeName, inferMime, allowedAudioExtensions, isHttpUrl, isInsideMediaRoot } = mediaFiles;

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
