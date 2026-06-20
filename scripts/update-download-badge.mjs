import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const repo = process.env.GITHUB_REPOSITORY || "MaksimPeterburgskiy/sounddeck-studio";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const outFile = process.argv[2] || path.join("docs", "downloads-badge.json");

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "sounddeck-studio-download-badge",
  "X-GitHub-Api-Version": "2022-11-28",
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });

if (!response.ok) {
  throw new Error(`GitHub latest release request failed: ${response.status} ${response.statusText}`);
}

const release = await response.json();
const appAssets = (release.assets ?? []).filter((asset) => isAppDownload(asset.name));
const totalDownloads = appAssets.reduce((sum, asset) => sum + (asset.download_count ?? 0), 0);

const badge = {
  schemaVersion: 1,
  label: "latest downloads",
  message: formatBadgeNumber(totalDownloads),
  color: "1db7a6",
};

await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(badge, null, 2)}\n`);

console.log(`Counted ${totalDownloads} downloads across ${appAssets.length} installer assets on ${release.tag_name}.`);

function isAppDownload(name) {
  if (typeof name !== "string") return false;

  const isWindowsInstaller = name.startsWith("SoundDeck-Studio") && name.endsWith(".exe");
  const isMacInstaller = ["SoundDeck Studio", "SoundDeck.Studio", "SoundDeck-Studio"].some((prefix) => name.startsWith(prefix)) && name.endsWith(".pkg");

  return isWindowsInstaller || isMacInstaller;
}

function formatBadgeNumber(value) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}
