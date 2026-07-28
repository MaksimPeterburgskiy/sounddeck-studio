import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareMacReleaseAssets, rewriteFeedZipReferences, sanitizeAssetName } from "./prepare-mac-release-assets.mjs";

const tempDirs = [];

function makeReleaseDir(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sounddeck-mac-assets-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function feedFor(zipName) {
  return [
    "version: 0.1.18-beta.3",
    "files:",
    `  - url: ${zipName}`,
    "    sha512: abc",
    `path: ${zipName}`,
    "releaseDate: '2026-07-26T00:00:00.000Z'",
    ""
  ].join("\n");
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("sanitizeAssetName", () => {
  it("replaces every space with a dot", () => {
    expect(sanitizeAssetName("SoundDeck Studio-0.1.18.pkg")).toBe("SoundDeck.Studio-0.1.18.pkg");
    expect(sanitizeAssetName("already-clean.zip")).toBe("already-clean.zip");
  });
});

describe("rewriteFeedZipReferences", () => {
  it("points url and path entries at the sanitized zip", () => {
    const rewritten = rewriteFeedZipReferences(feedFor("SoundDeck Studio-0.1.18.zip"), "SoundDeck.Studio-0.1.18.zip");
    expect(rewritten).toContain("url: SoundDeck.Studio-0.1.18.zip");
    expect(rewritten).toContain("path: SoundDeck.Studio-0.1.18.zip");
    expect(rewritten).not.toContain("SoundDeck Studio");
  });
});

describe("prepareMacReleaseAssets", () => {
  it.each(["latest", "beta"])("sanitizes names and rewrites the %s feed", (channel) => {
    const releaseDir = makeReleaseDir({
      "SoundDeck Studio-0.1.18.pkg": "pkg",
      "SoundDeck Studio-0.1.18.zip": "zip",
      "SoundDeck Studio-0.1.18.zip.blockmap": "blockmap",
      [`${channel}-mac.yml`]: feedFor("SoundDeck Studio-0.1.18.zip")
    });

    const files = prepareMacReleaseAssets({ releaseDir, channel });

    expect(files.map((file) => path.basename(file)).sort()).toEqual([
      "SoundDeck.Studio-0.1.18.pkg",
      "SoundDeck.Studio-0.1.18.zip",
      "SoundDeck.Studio-0.1.18.zip.blockmap",
      `${channel}-mac.yml`
    ].sort());
    expect(readdirSync(releaseDir).sort()).toEqual(files.map((file) => path.basename(file)).sort());
    const feed = readFileSync(path.join(releaseDir, `${channel}-mac.yml`), "utf8");
    expect(feed).toContain("url: SoundDeck.Studio-0.1.18.zip");
    expect(feed).toContain("path: SoundDeck.Studio-0.1.18.zip");
  });

  it("leaves already-clean names untouched", () => {
    const releaseDir = makeReleaseDir({
      "SoundDeck-0.1.18.pkg": "pkg",
      "SoundDeck-0.1.18.zip": "zip",
      "beta-mac.yml": feedFor("SoundDeck-0.1.18.zip")
    });

    const files = prepareMacReleaseAssets({ releaseDir, channel: "beta" });

    expect(files.map((file) => path.basename(file))).toContain("SoundDeck-0.1.18.pkg");
    expect(readFileSync(path.join(releaseDir, "beta-mac.yml"), "utf8")).toContain("path: SoundDeck-0.1.18.zip");
  });

  it("rejects an unknown channel", () => {
    const releaseDir = makeReleaseDir({});
    expect(() => prepareMacReleaseAssets({ releaseDir, channel: "nightly" })).toThrow(/Unknown channel/);
  });

  it.each([
    ["pkg", { "SoundDeck.zip": "zip", "beta-mac.yml": feedFor("SoundDeck.zip") }, /pkg artifact/],
    ["zip", { "SoundDeck.pkg": "pkg", "beta-mac.yml": feedFor("SoundDeck.zip") }, /zip updater artifact/],
    ["feed", { "SoundDeck.pkg": "pkg", "SoundDeck.zip": "zip" }, /beta-mac\.yml updater feed/]
  ])("fails when the %s is missing", (_missing, files, expected) => {
    const releaseDir = makeReleaseDir(files);
    expect(() => prepareMacReleaseAssets({ releaseDir, channel: "beta" })).toThrow(expected);
  });
});
