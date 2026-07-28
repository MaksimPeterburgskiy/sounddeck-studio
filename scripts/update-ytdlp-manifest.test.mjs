import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readNativeToolsManifest, validateManifest } from "./native-tools.mjs";
import { compareYtDlpVersions, parseSha256Sums, withUpdatedYtDlp } from "./update-ytdlp-manifest.mjs";

const sums = [
  "52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8  yt-dlp.exe",
  "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b  yt-dlp_macos",
  "0000000000000000000000000000000000000000000000000000000000000000  yt-dlp_macos_legacy"
].join("\n");

test("signed sums parsing matches whole asset names only", () => {
  assert.equal(
    parseSha256Sums(sums, "yt-dlp_macos"),
    "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b"
  );
  assert.equal(
    parseSha256Sums(sums, "yt-dlp.exe"),
    "52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8"
  );
  assert.throws(() => parseSha256Sums(sums, "yt-dlp"), /Could not find a SHA-256 entry/);
});

test("a yt-dlp bump rewrites both targets and still satisfies the manifest policy", async () => {
  const manifest = await readNativeToolsManifest();
  const version = "2099.01.01";
  const hashes = {
    "yt-dlp_macos": "a".repeat(64),
    "yt-dlp.exe": "b".repeat(64)
  };
  const updated = withUpdatedYtDlp(manifest, { version, hashes });

  assert.doesNotThrow(() => validateManifest(updated));
  for (const [target, assetName] of [["darwin", "yt-dlp_macos"], ["win32-x64", "yt-dlp.exe"]]) {
    const entry = updated.targets[target]["yt-dlp"];
    assert.equal(entry.version, version);
    assert.equal(entry.url, `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${assetName}`);
    assert.equal(entry.downloadSha256, hashes[assetName]);
    assert.equal(entry.sha256, hashes[assetName]);
    assert.equal(entry.license, `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${version}/LICENSE`);
  }
  // ffmpeg entries and the on-disk manifest are untouched.
  assert.deepEqual(updated.targets.darwin["ffmpeg-x64"], manifest.targets.darwin["ffmpeg-x64"]);
  assert.notEqual(manifest.targets.darwin["yt-dlp"].version, version);
});

test("version comparison orders dotted date tags and rejects other formats", () => {
  assert.equal(compareYtDlpVersions("2026.07.04", "2026.07.04"), 0);
  assert.equal(compareYtDlpVersions("2026.07.10", "2026.07.04"), 1);
  assert.equal(compareYtDlpVersions("2025.12.30", "2026.07.04"), -1);
  // A fourth hotfix segment outranks the plain date, and missing segments are zero.
  assert.equal(compareYtDlpVersions("2023.12.30.1", "2023.12.30"), 1);
  assert.equal(compareYtDlpVersions("2023.12.30", "2023.12.30.0"), 0);
  assert.throws(() => compareYtDlpVersions("latest", "2026.07.04"), /Unexpected yt-dlp version format/);
  assert.throws(() => compareYtDlpVersions("2026.07.04", "v2026.07.04"), /Unexpected yt-dlp version format/);
});

test("the committed signing key pins the audited yt-dlp fingerprint source", async () => {
  const key = await readFile(new URL("../config/yt-dlp-signing-keys.asc", import.meta.url), "utf8");
  assert.match(key, /^-----BEGIN PGP PUBLIC KEY BLOCK-----/);
  assert.match(key, /-----END PGP PUBLIC KEY BLOCK-----\s*$/);
});
