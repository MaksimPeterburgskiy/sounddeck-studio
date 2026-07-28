import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { packagedNativeToolPath, developmentNativeToolCandidates } = require("./nativeTools.cjs");

describe("packaged native tool discovery", () => {
  it("uses only project-managed macOS resources selected for the running architecture", () => {
    expect(packagedNativeToolPath({
      resourcesPath: "/Applications/SoundDeck Studio.app/Contents/Resources",
      platform: "darwin",
      arch: "arm64",
      tool: "ffmpeg"
    })).toBe(path.join(
      "/Applications/SoundDeck Studio.app/Contents/Resources",
      "native-tools",
      "ffmpeg-arm64"
    ));
  });

  it("uses project-managed Windows executables", () => {
    expect(packagedNativeToolPath({
      resourcesPath: "C:\\SoundDeck\\resources",
      platform: "win32",
      arch: "x64",
      tool: "yt-dlp"
    })).toBe(path.join("C:\\SoundDeck\\resources", "native-tools", "yt-dlp.exe"));
  });

  it("returns no packaged candidate for an architecture without a manifest entry", () => {
    expect(packagedNativeToolPath({
      resourcesPath: "/resources",
      platform: "win32",
      arch: "arm64",
      tool: "ffmpeg"
    })).toBe("");
  });
});

describe("development native tool discovery", () => {
  it("allows an explicit developer override without inventing a missing cache path", () => {
    const candidates = developmentNativeToolCandidates({
      repoRoot: "/repo",
      platform: "darwin",
      arch: "x64",
      tool: "ffmpeg",
      env: { SOUNDDECK_FFMPEG_PATH: "/opt/local/bin/ffmpeg" }
    });
    expect(candidates).toEqual(["/opt/local/bin/ffmpeg"]);
  });

  it("uses only disposable signed copies for managed macOS development tools", () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "sounddeck-native-candidates-"));
    const verifiedCache = path.join(repoRoot, "tmp", "native-tools", "darwin", "ffmpeg-x64");
    const signedCopy = path.join(
      repoRoot,
      "tmp",
      "development-native-tools",
      "darwin",
      "ffmpeg-x64"
    );
    try {
      mkdirSync(path.dirname(verifiedCache), { recursive: true });
      mkdirSync(path.dirname(signedCopy), { recursive: true });
      writeFileSync(verifiedCache, "verified but unsigned");
      writeFileSync(signedCopy, "disposable signed copy");
      expect(developmentNativeToolCandidates({
        repoRoot,
        platform: "darwin",
        arch: "x64",
        tool: "ffmpeg",
        env: {}
      })).toEqual([signedCopy]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not invent Windows executable cache paths on unsupported platforms", () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "sounddeck-native-candidates-"));
    const fakeLinuxCache = path.join(repoRoot, "tmp", "native-tools", "linux-x64", "ffmpeg.exe");
    try {
      mkdirSync(path.dirname(fakeLinuxCache), { recursive: true });
      writeFileSync(fakeLinuxCache, "not a Linux executable");
      expect(developmentNativeToolCandidates({
        repoRoot,
        platform: "linux",
        arch: "x64",
        tool: "ffmpeg",
        env: {}
      })).toEqual([]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
