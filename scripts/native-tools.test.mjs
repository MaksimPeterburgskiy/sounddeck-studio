import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  prepareNativeTools,
  readNativeToolsManifest,
  validateManifest,
  verifyNativeToolHashes
} from "./native-tools.mjs";

test("the committed manifest uses immutable URLs and valid SHA-256 values", async () => {
  const manifest = await readNativeToolsManifest();
  assert.doesNotThrow(() => validateManifest(manifest));
});

test("legacy URL and version overrides fail closed", async () => {
  const previous = process.env.YT_DLP_VERSION;
  process.env.YT_DLP_VERSION = "latest";
  try {
    await assert.rejects(
      prepareNativeTools({
        platform: "win32",
        arch: "x64",
        manifest: fixtureManifest({
          compression: "none",
          downloadSha256: "0".repeat(64),
          sha256: "0".repeat(64)
        })
      }),
      /Unpinned native-tool overrides are not supported/
    );
  } finally {
    if (previous === undefined) delete process.env.YT_DLP_VERSION;
    else process.env.YT_DLP_VERSION = previous;
  }
});

test("a bad download digest fails closed without populating the cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-test-"));
  try {
    const content = Buffer.from("expected executable");
    const compressed = gzipSync(content);
    const manifest = fixtureManifest({
      compression: "gzip",
      downloadSha256: sha256(compressed),
      sha256: sha256(content)
    });
    const result = prepareNativeTools({
      platform: "win32",
      arch: "x64",
      destinationRoot: root,
      manifest,
      fetchImpl: async () => response(Buffer.from("tampered download"))
    });
    await assert.rejects(result, /download checksum mismatch/);
    await assert.rejects(readFile(path.join(root, "win32-x64", "tool.exe")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline mode re-verifies and rejects a poisoned cache entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-test-"));
  try {
    const content = Buffer.from("expected executable");
    const manifest = fixtureManifest({
      compression: "none",
      downloadSha256: sha256(content),
      sha256: sha256(content)
    });
    const cacheFile = path.join(root, "win32-x64", "tool.exe");
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, "poisoned");
    await assert.rejects(
      prepareNativeTools({
        platform: "win32",
        arch: "x64",
        destinationRoot: root,
        manifest,
        offline: true
      }),
      /cache checksum mismatch/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("online mode replaces a poisoned cache only after verifying the new asset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-test-"));
  try {
    const content = Buffer.from("expected executable");
    const manifest = fixtureManifest({
      compression: "none",
      downloadSha256: sha256(content),
      sha256: sha256(content)
    });
    const cacheFile = path.join(root, "win32-x64", "tool.exe");
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, "poisoned");
    const result = await prepareNativeTools({
      platform: "win32",
      arch: "x64",
      destinationRoot: root,
      manifest,
      fetchImpl: async () => response(content)
    });
    assert.deepEqual(await readFile(result.files.tool), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a verified cached executable is accepted without network access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-test-"));
  try {
    const content = Buffer.from("expected executable");
    const manifest = fixtureManifest({
      compression: "none",
      downloadSha256: sha256(content),
      sha256: sha256(content)
    });
    const first = await prepareNativeTools({
      platform: "win32",
      arch: "x64",
      destinationRoot: root,
      manifest,
      fetchImpl: async () => response(content)
    });
    const second = await prepareNativeTools({
      platform: "win32",
      arch: "x64",
      destinationRoot: root,
      manifest,
      offline: true,
      fetchImpl: async () => {
        throw new Error("network must not be used");
      }
    });
    assert.equal(second.files.tool, first.files.tool);
    assert.deepEqual(await readFile(second.files.tool), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("final package verification hashes every native executable and rejects replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-test-"));
  const contents = {
    "ffmpeg-x64": Buffer.from("x64 ffmpeg"),
    "ffmpeg-arm64": Buffer.from("arm64 ffmpeg"),
    "yt-dlp": Buffer.from("universal yt-dlp")
  };
  const assets = Object.fromEntries(
    Object.entries(contents).map(([name, content]) => [
      name,
      { fileName: name, sha256: sha256(content) }
    ])
  );
  try {
    await Promise.all(
      Object.entries(contents).map(([name, content]) => writeFile(path.join(root, name), content))
    );
    await assert.doesNotReject(verifyNativeToolHashes(root, assets));

    await writeFile(path.join(root, "yt-dlp"), "replacement");
    await assert.rejects(
      verifyNativeToolHashes(root, assets),
      /yt-dlp packaged checksum mismatch/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fixtureManifest(asset) {
  return {
    schemaVersion: 1,
    targets: {
      "win32-x64": {
        tool: {
          version: "v1.0.0",
          url: "https://github.com/example/tools/releases/download/v1.0.0/tool.exe",
          fileName: "tool.exe",
          source: "https://github.com/example/tools",
          license: "https://github.com/example/tools/blob/v1.0.0/LICENSE",
          ...asset
        }
      }
    }
  };
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function response(content) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async arrayBuffer() {
      return content;
    }
  };
}
