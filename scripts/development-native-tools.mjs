import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readNativeToolsManifest, targetName } from "./native-tools.mjs";

const defaultCacheRoot = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "tmp",
  "native-tools"
);

export async function canUseDevelopmentHostTools({
  platform = process.platform,
  arch = process.arch,
  cacheRoot = defaultCacheRoot,
  env = process.env
} = {}) {
  const configuredFfmpeg = await isExecutable(env.SOUNDDECK_FFMPEG_PATH);
  const configuredYtDlp = await isExecutable(env.SOUNDDECK_YT_DLP_PATH);
  const ffmpegAvailable = configuredFfmpeg || await commandOnPath({
    command: platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    platform,
    env
  });
  const ytDlpAvailable = configuredYtDlp || await commandOnPath({
    command: platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
    platform,
    env
  });
  if (!ffmpegAvailable || !ytDlpAvailable) return false;
  if (configuredFfmpeg && configuredYtDlp) return true;

  const manifest = await readNativeToolsManifest();
  const target = targetName(platform, arch);
  for (const asset of Object.values(manifest.targets[target])) {
    if (await exists(path.join(cacheRoot, target, asset.fileName))) return false;
  }
  return true;
}

async function commandOnPath({ command, platform, env }) {
  // process.env is already case-insensitive on Windows, so PATH covers Path.
  const pathValue = env.PATH || "";
  if (!pathValue) return false;
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(delimiter)) {
    const normalized = directory.trim().replace(/^"(.*)"$/, "$1");
    if (normalized && await isExecutable(path.join(normalized, command))) return true;
  }
  return false;
}

async function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    if (!(await stat(filePath)).isFile()) return false;
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
