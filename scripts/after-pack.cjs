const { createHash } = require("node:crypto");
const { createReadStream, createWriteStream, existsSync } = require("node:fs");
const { chmod, copyFile, mkdir, unlink } = require("node:fs/promises");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { createGunzip } = require("node:zlib");

const ffmpegPackage = require("ffmpeg-static/package.json");
const ffmpegPackageConfig = ffmpegPackage["ffmpeg-static"] || {};
const ffmpegReleaseEnvVar = ffmpegPackageConfig["binary-release-tag-env-var"] || "FFMPEG_BINARY_RELEASE";
const ffmpegBaseUrlEnvVar = ffmpegPackageConfig["binaries-url-env-var"] || "FFMPEG_BINARIES_URL";
const ffmpegRelease = process.env[ffmpegReleaseEnvVar] || ffmpegPackageConfig["binary-release-tag"] || "b6.1.1";
const ffmpegBaseUrl = process.env[ffmpegBaseUrlEnvVar] || ffmpegPackageConfig["binaries-url"] || "https://github.com/eugeneware/ffmpeg-static/releases/download";

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const arch = normalizeArch(context.arch);
  if (arch !== "x64" && arch !== "arm64") return;

  const productFilename = context.packager.appInfo.productFilename;
  const ffmpegPath = path.join(
    context.appOutDir,
    `${productFilename}.app`,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "ffmpeg-static",
    "ffmpeg"
  );

  if (!existsSync(ffmpegPath)) return;

  const cachedBinary = path.join(
    process.cwd(),
    "tmp",
    "ffmpeg-static",
    ffmpegCacheKey(),
    `ffmpeg-darwin-${arch}`
  );
  await ensureFfmpegBinary(arch, cachedBinary);
  await copyFile(cachedBinary, ffmpegPath);
  await chmod(ffmpegPath, 0o755);
  console.log(`Replaced packaged ffmpeg-static binary with darwin-${arch}`);
};

function normalizeArch(arch) {
  if (arch === "x64" || arch === 1) return "x64";
  if (arch === "arm64" || arch === 3) return "arm64";
  if (arch === "universal" || arch === 4) return "universal";
  return String(arch);
}

function ffmpegCacheKey() {
  const release = String(ffmpegRelease).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "release";
  const hash = createHash("sha256").update(`${ffmpegBaseUrl}\0${ffmpegRelease}`).digest("hex").slice(0, 12);
  return `${release}-${hash}`;
}

async function ensureFfmpegBinary(arch, destination) {
  if (existsSync(destination)) return;

  await mkdir(path.dirname(destination), { recursive: true });
  const tempGzip = path.join(os.tmpdir(), `sounddeck-ffmpeg-darwin-${arch}-${Date.now()}.gz`);
  const url = `${ffmpegBaseUrl}/${ffmpegRelease}/ffmpeg-darwin-${arch}.gz`;

  try {
    await download(url, tempGzip);
    await pipeline(
      createReadStream(tempGzip),
      createGunzip(),
      createWriteStream(destination)
    );
    await chmod(destination, 0o755);
  } finally {
    await unlink(tempGzip).catch(() => {});
  }
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }
      pipeline(response, createWriteStream(destination)).then(resolve, reject);
    });
    request.on("error", reject);
  });
}
