import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(repoRoot, "config", "native-tools.json");
const cacheRoot = path.join(repoRoot, "tmp", "native-tools");
const forbiddenOverrides = [
  "FFMPEG_BINARIES_URL",
  "FFMPEG_BINARY_RELEASE",
  "YT_DLP_VERSION",
  "YOUTUBE_DL_HOST"
];

export async function readNativeToolsManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  return manifest;
}

export function targetName(platform, arch) {
  if (platform === "darwin" && (arch === "x64" || arch === "arm64" || arch === "universal")) {
    return "darwin";
  }
  if (platform === "win32" && arch === "x64") return "win32-x64";
  throw new Error(`No native-tool manifest is defined for ${platform}-${arch}.`);
}

export async function prepareNativeTools({
  platform = process.platform,
  arch = process.arch,
  offline = process.env.SOUNDDECK_NATIVE_TOOLS_OFFLINE === "1",
  manifest,
  destinationRoot = cacheRoot,
  fetchImpl = globalThis.fetch
} = {}) {
  rejectUnpinnedOverrides();
  manifest ||= await readNativeToolsManifest();
  validateManifest(manifest);
  const target = targetName(platform, arch);
  const targetDir = path.join(destinationRoot, target);
  await mkdir(targetDir, { recursive: true });

  const prepared = {};
  for (const [name, asset] of Object.entries(manifest.targets[target])) {
    const destination = path.join(targetDir, asset.fileName);
    const existingDigest = await sha256File(destination).catch(() => "");
    if (existingDigest === asset.sha256) {
      await chmod(destination, 0o755);
      prepared[name] = destination;
      continue;
    }
    if (existingDigest && offline) {
      throw new Error(`${name} cache checksum mismatch: expected ${asset.sha256}, got ${existingDigest}.`);
    }
    if (offline) {
      throw new Error(`${name} is missing from the verified native-tool cache (${destination}).`);
    }

    const response = await fetchImpl(asset.url, {
      redirect: "follow",
      headers: { "User-Agent": "sounddeck-studio-build" }
    });
    if (!response.ok) {
      throw new Error(`Failed to download ${asset.url}: HTTP ${response.status} ${response.statusText}`);
    }
    const downloaded = Buffer.from(await response.arrayBuffer());
    assertDigest(`${name} download`, downloaded, asset.downloadSha256);
    const executable = asset.compression === "gzip" ? gunzipSync(downloaded) : downloaded;
    assertDigest(name, executable, asset.sha256);

    const temporary = `${destination}.tmp-${process.pid}`;
    await writeFile(temporary, executable, { mode: 0o755 });
    try {
      await chmod(temporary, 0o755);
      await rm(destination, { force: true });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    prepared[name] = destination;
  }
  return { target, files: prepared };
}

export async function installNativeTools(context, options = {}) {
  const platform = context.electronPlatformName;
  const arch = normalizeArch(context.arch);
  if (platform !== "darwin" && platform !== "win32") return [];

  const prepared = await prepareNativeTools({ platform, arch, ...options });
  const destination = platform === "darwin"
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents",
        "Resources",
        "native-tools"
      )
    : path.join(context.appOutDir, "resources", "native-tools");
  await mkdir(destination, { recursive: true });

  const installed = [];
  for (const source of Object.values(prepared.files)) {
    const output = path.join(destination, path.basename(source));
    await copyFile(source, output);
    await chmod(output, 0o755);
    installed.push(output);
  }
  const manifest = await readNativeToolsManifest();
  await writeFile(path.join(destination, "PROVENANCE.json"), `${JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    target: prepared.target,
    assets: manifest.targets[prepared.target]
  }, null, 2)}\n`);
  return installed;
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !manifest.targets || typeof manifest.targets !== "object") {
    throw new Error("Native-tool manifest must use schemaVersion 1 and define targets.");
  }
  for (const [target, assets] of Object.entries(manifest.targets)) {
    if (!assets || typeof assets !== "object" || !Object.keys(assets).length) {
      throw new Error(`Native-tool target ${target} has no assets.`);
    }
    for (const [name, asset] of Object.entries(assets)) {
      const required = ["version", "url", "compression", "downloadSha256", "sha256", "fileName", "source", "license"];
      for (const field of required) {
        if (!asset[field]) throw new Error(`${target}/${name} is missing ${field}.`);
      }
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\//.test(asset.url)) {
        throw new Error(`${target}/${name} must use an exact GitHub release asset URL.`);
      }
      if (asset.url.includes("/latest/")) throw new Error(`${target}/${name} must not use a mutable latest URL.`);
      if (!asset.url.includes(`/releases/download/${encodeURIComponent(asset.version)}/`)) {
        throw new Error(`${target}/${name} URL must contain its exact version tag.`);
      }
      if (!/^[a-f0-9]{64}$/.test(asset.downloadSha256) || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
        throw new Error(`${target}/${name} must define lowercase SHA-256 values.`);
      }
      if (asset.compression !== "none" && asset.compression !== "gzip") {
        throw new Error(`${target}/${name} uses unsupported compression ${asset.compression}.`);
      }
      if (path.basename(asset.fileName) !== asset.fileName) {
        throw new Error(`${target}/${name} has an unsafe fileName.`);
      }
      if (!asset.source.startsWith("https://") || !asset.license.startsWith("https://")) {
        throw new Error(`${target}/${name} source and license URLs must use HTTPS.`);
      }
    }
  }
}

export async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function verifyNativeToolHashes(directory, assets) {
  for (const [name, asset] of Object.entries(assets)) {
    const filePath = path.join(directory, asset.fileName);
    const digest = await sha256File(filePath);
    if (digest !== asset.sha256) {
      throw new Error(`${name} packaged checksum mismatch: expected ${asset.sha256}, got ${digest}.`);
    }
  }
}

function assertDigest(label, content, expected) {
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== expected) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual}.`);
  }
}

function rejectUnpinnedOverrides() {
  const configured = forbiddenOverrides.filter((name) => process.env[name]);
  if (configured.length) {
    throw new Error(
      `Unpinned native-tool overrides are not supported (${configured.join(", ")}). Update config/native-tools.json with an exact URL and SHA-256 values.`
    );
  }
}

function normalizeArch(arch) {
  if (arch === "x64" || arch === 1) return "x64";
  if (arch === "arm64" || arch === 3) return "arm64";
  if (arch === "universal" || arch === 4) return "universal";
  return String(arch);
}

export async function clearNativeToolsCache(root = cacheRoot) {
  await rm(root, { recursive: true, force: true });
}
