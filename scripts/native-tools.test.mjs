import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { canUseDevelopmentHostTools } from "./development-native-tools.mjs";
import {
  hasNativeToolsManifestTarget,
  prepareNativeTools,
  readNativeToolsManifest,
  targetName,
  validateManifest,
  verifyNativeToolHashes
} from "./native-tools.mjs";
import { parseFetchNativeToolsOptions } from "./fetch-native-tools-options.mjs";

const execFileAsync = promisify(execFile);

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

test("the fetch CLI honors offline mode from the environment", () => {
  assert.deepEqual(
    parseFetchNativeToolsOptions(["--platform", "win32", "--arch", "x64"], {
      platform: "darwin",
      arch: "arm64",
      env: { SOUNDDECK_NATIVE_TOOLS_OFFLINE: "1" }
    }),
    {
      platform: "win32",
      arch: "x64",
      offline: true
    }
  );
});

test("the fetch CLI recognizes the development host-tool fallback", () => {
  assert.deepEqual(
    parseFetchNativeToolsOptions(["--allow-host-tools"], {
      platform: "win32",
      arch: "x64",
      env: {}
    }),
    {
      platform: "win32",
      arch: "x64",
      allowHostTools: true
    }
  );
});

test("native-tool manifest target support is explicit", () => {
  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["darwin", "universal"],
    ["win32", "x64"]
  ]) {
    assert.equal(hasNativeToolsManifestTarget(platform, arch), true);
  }
  for (const [platform, arch] of [["linux", "x64"], ["win32", "arm64"]]) {
    assert.equal(hasNativeToolsManifestTarget(platform, arch), false);
  }
  assert.throws(() => targetName("linux", "x64"), /No native-tool manifest is defined/);
});

test("the fetch CLI skips development targets without a native-tool manifest", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    fileURLToPath(new URL("./fetch-native-tools.mjs", import.meta.url)),
    "--platform",
    "linux",
    "--arch",
    "x64"
  ]);
  assert.match(stdout, /No project-managed native tools for linux-x64/);
  assert.equal(stderr, "");
});

test("development host-tool fallback accepts explicit executable overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-host-"));
  const ffmpeg = path.join(root, process.platform === "win32" ? "custom-ffmpeg.exe" : "custom-ffmpeg");
  const ytDlp = path.join(root, process.platform === "win32" ? "custom-yt-dlp.exe" : "custom-yt-dlp");
  try {
    await writeFile(ffmpeg, "ffmpeg", { mode: 0o755 });
    await writeFile(ytDlp, "yt-dlp", { mode: 0o755 });
    assert.equal(await canUseDevelopmentHostTools({
      platform: process.platform,
      env: {
        SOUNDDECK_FFMPEG_PATH: ffmpeg,
        SOUNDDECK_YT_DLP_PATH: ytDlp
      }
    }), true);
    assert.equal(await canUseDevelopmentHostTools({
      platform: process.platform,
      env: { SOUNDDECK_FFMPEG_PATH: ffmpeg }
    }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development host-tool fallback accepts an empty cache plus tools on PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-path-"));
  const ffmpegName = "ffmpeg.exe";
  const ytDlpName = "yt-dlp.exe";
  try {
    await writeFile(path.join(root, ffmpegName), "ffmpeg", { mode: 0o755 });
    await writeFile(path.join(root, ytDlpName), "yt-dlp", { mode: 0o755 });
    assert.equal(await canUseDevelopmentHostTools({
      platform: "win32",
      arch: "x64",
      cacheRoot: path.join(root, "empty-cache"),
      env: { PATH: root }
    }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development host-tool fallback validates an existing managed cache first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-cache-check-"));
  const pathRoot = path.join(root, "path");
  const cacheRoot = path.join(root, "cache");
  const ffmpegName = "ffmpeg.exe";
  const ytDlpName = "yt-dlp.exe";
  const target = "win32-x64";
  const cachedName = "ffmpeg.exe";
  try {
    await mkdir(pathRoot, { recursive: true });
    await mkdir(path.join(cacheRoot, target), { recursive: true });
    await writeFile(path.join(pathRoot, ffmpegName), "ffmpeg", { mode: 0o755 });
    await writeFile(path.join(pathRoot, ytDlpName), "yt-dlp", { mode: 0o755 });
    await writeFile(path.join(cacheRoot, target, cachedName), "unverified cache");
    assert.equal(await canUseDevelopmentHostTools({
      platform: "win32",
      arch: "x64",
      cacheRoot,
      env: { PATH: pathRoot }
    }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the development prefetch skips verified host overrides while offline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-cli-host-"));
  const ffmpeg = path.join(root, "ffmpeg.exe");
  const ytDlp = path.join(root, "yt-dlp.exe");
  try {
    await writeFile(ffmpeg, "ffmpeg", { mode: 0o755 });
    await writeFile(ytDlp, "yt-dlp", { mode: 0o755 });
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("./fetch-native-tools.mjs", import.meta.url)),
      "--allow-host-tools",
      "--platform",
      "win32",
      "--arch",
      "x64"
    ], {
      env: {
        ...process.env,
        SOUNDDECK_FFMPEG_PATH: ffmpeg,
        SOUNDDECK_YT_DLP_PATH: ytDlp,
        SOUNDDECK_NATIVE_TOOLS_OFFLINE: "1"
      }
    });
    assert.match(stdout, /already available; skipping managed downloads/);
    assert.equal(stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment-only CLI offline mode fails without network access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-test-"));
  let attempts = 0;
  try {
    const options = parseFetchNativeToolsOptions([], {
      platform: "win32",
      arch: "x64",
      env: { SOUNDDECK_NATIVE_TOOLS_OFFLINE: "1" }
    });
    await assert.rejects(
      prepareNativeTools({
        ...options,
        destinationRoot: root,
        manifest: fixtureManifest({
          compression: "none",
          downloadSha256: "0".repeat(64),
          sha256: "0".repeat(64)
        }),
        fetchImpl: async () => {
          attempts += 1;
          return response(Buffer.from("network must not be used"));
        }
      }),
      /missing from the verified native-tool cache/
    );
    assert.equal(attempts, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
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

test("transient native-tool download failures are retried with a timeout signal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-test-"));
  const content = Buffer.from("expected executable");
  const manifest = fixtureManifest({
    compression: "none",
    downloadSha256: sha256(content),
    sha256: sha256(content)
  });
  let attempts = 0;
  try {
    const result = await prepareNativeTools({
      platform: "win32",
      arch: "x64",
      destinationRoot: root,
      manifest,
      downloadRetryDelayMs: 0,
      fetchImpl: async (_url, options) => {
        attempts += 1;
        assert.ok(options.signal instanceof AbortSignal);
        if (attempts === 1) throw new Error("temporary CDN failure");
        return response(content);
      }
    });
    assert.equal(attempts, 2);
    assert.deepEqual(await readFile(result.files.tool), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transient response-body failures are retried", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-test-"));
  const content = Buffer.from("expected executable");
  const manifest = fixtureManifest({
    compression: "none",
    downloadSha256: sha256(content),
    sha256: sha256(content)
  });
  let attempts = 0;
  try {
    const result = await prepareNativeTools({
      platform: "win32",
      arch: "x64",
      destinationRoot: root,
      manifest,
      downloadRetryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          return response(content, {
            arrayBuffer: async () => {
              throw new TypeError("response body connection reset");
            }
          });
        }
        return response(content);
      }
    });
    assert.equal(attempts, 2);
    assert.deepEqual(await readFile(result.files.tool), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-retryable native-tool responses fail immediately", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-test-"));
  let attempts = 0;
  let bodyReads = 0;
  try {
    await assert.rejects(
      prepareNativeTools({
        platform: "win32",
        arch: "x64",
        destinationRoot: root,
        manifest: fixtureManifest({
          compression: "none",
          downloadSha256: "0".repeat(64),
          sha256: "0".repeat(64)
        }),
        downloadRetryDelayMs: 0,
        fetchImpl: async () => {
          attempts += 1;
          return {
            ok: false,
            status: 404,
            statusText: "Not Found",
            async arrayBuffer() {
              bodyReads += 1;
              return Buffer.alloc(0);
            }
          };
        }
      }),
      /HTTP 404 Not Found/
    );
    assert.equal(attempts, 1);
    assert.equal(bodyReads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("timed-out native-tool downloads stop after the configured attempts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sounddeck-native-test-"));
  let attempts = 0;
  try {
    await assert.rejects(
      prepareNativeTools({
        platform: "win32",
        arch: "x64",
        destinationRoot: root,
        manifest: fixtureManifest({
          compression: "none",
          downloadSha256: "0".repeat(64),
          sha256: "0".repeat(64)
        }),
        downloadAttempts: 2,
        downloadTimeoutMs: 10,
        downloadRetryDelayMs: 0,
        fetchImpl: async (_url, { signal }) => {
          attempts += 1;
          return response(Buffer.alloc(0), {
            arrayBuffer: () => new Promise((_resolve, reject) => {
              const keepAlive = setTimeout(
                () => reject(new Error("abort signal did not fire")),
                1_000
              );
              signal.addEventListener("abort", () => {
                clearTimeout(keepAlive);
                reject(signal.reason);
              }, { once: true });
            })
          });
        }
      }),
      { name: "TimeoutError" }
    );
    assert.equal(attempts, 2);
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

function response(content, overrides = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async arrayBuffer() {
      return content;
    },
    ...overrides
  };
}
