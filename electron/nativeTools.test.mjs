import { createRequire } from "node:module";
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

  it("fails closed for an architecture without a manifest entry", () => {
    expect(() => packagedNativeToolPath({
      resourcesPath: "/resources",
      platform: "win32",
      arch: "arm64",
      tool: "ffmpeg"
    })).toThrow(/No packaged ffmpeg/);
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
});
