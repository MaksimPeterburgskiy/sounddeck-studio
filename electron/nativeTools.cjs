const path = require("node:path");
const { existsSync } = require("node:fs");

function packagedNativeToolPath({ resourcesPath, platform, arch, tool }) {
  if (!resourcesPath) throw new Error("A packaged native tool requires resourcesPath.");
  if (platform === "darwin") {
    if (tool === "ffmpeg") {
      if (arch !== "x64" && arch !== "arm64") {
        throw new Error(`No packaged ffmpeg is defined for macOS ${arch}.`);
      }
      return path.join(resourcesPath, "native-tools", `ffmpeg-${arch}`);
    }
    if (tool === "yt-dlp") return path.join(resourcesPath, "native-tools", "yt-dlp");
  }
  if (platform === "win32" && arch === "x64") {
    const fileName = tool === "ffmpeg" ? "ffmpeg.exe" : tool === "yt-dlp" ? "yt-dlp.exe" : "";
    if (fileName) return path.join(resourcesPath, "native-tools", fileName);
  }
  throw new Error(`No packaged ${tool} is defined for ${platform}-${arch}.`);
}

function developmentNativeToolCandidates({ repoRoot, platform, arch, tool, env = process.env }) {
  const configured = tool === "ffmpeg" ? env.SOUNDDECK_FFMPEG_PATH : env.SOUNDDECK_YT_DLP_PATH;
  const target = platform === "darwin" ? "darwin" : `${platform}-${arch}`;
  const cacheName = platform === "darwin"
    ? (tool === "ffmpeg" ? `ffmpeg-${arch}` : "yt-dlp")
    : (tool === "ffmpeg" ? "ffmpeg.exe" : "yt-dlp.exe");
  const cached = repoRoot ? path.join(repoRoot, "tmp", "native-tools", target, cacheName) : "";
  return [configured, existsSync(cached) ? cached : ""].filter(Boolean);
}

module.exports = {
  packagedNativeToolPath,
  developmentNativeToolCandidates
};
