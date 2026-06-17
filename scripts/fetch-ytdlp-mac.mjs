import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const outDir = path.join(repoRoot, "build", "yt-dlp");
const outFile = path.join(outDir, "yt-dlp_macos");
const versionFile = path.join(outDir, "VERSION");
const assetName = "yt-dlp_macos";
const releaseApi = process.env.YT_DLP_VERSION
  ? `https://api.github.com/repos/yt-dlp/yt-dlp/releases/tags/${encodeURIComponent(process.env.YT_DLP_VERSION)}`
  : "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";

const release = await fetchJson(releaseApi);
const version = release.tag_name;
const asset = findAsset(release, assetName);
const sumsAsset = findAsset(release, "SHA2-256SUMS");

await fs.mkdir(outDir, { recursive: true });

if (await isCurrent(version)) {
  console.log(`yt-dlp macOS standalone ${version} already present at ${outFile}.`);
  process.exit(0);
}

console.log(`Downloading yt-dlp macOS standalone ${version}...`);
const [binary, sums] = await Promise.all([
  fetchBuffer(asset.browser_download_url),
  fetchText(sumsAsset.browser_download_url)
]);
const expectedSha256 = parseSha256(sums, assetName);
const actualSha256 = crypto.createHash("sha256").update(binary).digest("hex");

if (actualSha256 !== expectedSha256) {
  throw new Error(`yt-dlp checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
}

const tmpFile = `${outFile}.tmp`;
await fs.writeFile(tmpFile, binary, { mode: 0o755 });
await fs.chmod(tmpFile, 0o755);
await fs.rename(tmpFile, outFile);
await fs.writeFile(versionFile, `${version}\n`);
console.log(`Prepared ${outFile} (${actualSha256}).`);

async function isCurrent(version) {
  try {
    const [existingVersion] = await Promise.all([
      fs.readFile(versionFile, "utf8"),
      fs.access(outFile)
    ]);
    return existingVersion.trim() === version;
  } catch {
    return false;
  }
}

function findAsset(release, name) {
  const asset = release.assets?.find((item) => item.name === name);
  if (!asset?.browser_download_url) {
    throw new Error(`Could not find ${name} in yt-dlp release ${release.tag_name || "(unknown)"}.`);
  }
  return asset;
}

function parseSha256(sums, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sums.match(new RegExp(`^([a-f0-9]{64})\\s+\\*?${escaped}$`, "im"));
  if (!match) throw new Error(`Could not find SHA-256 entry for ${name}.`);
  return match[1].toLowerCase();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

async function fetchText(url) {
  const response = await fetch(url, { headers: requestHeaders() });
  if (!response.ok) throw new Error(`Request failed ${response.status} ${response.statusText}: ${url}`);
  return response.text();
}

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: requestHeaders() });
  if (!response.ok) throw new Error(`Request failed ${response.status} ${response.statusText}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function requestHeaders() {
  const headers = {
    "User-Agent": "sounddeck-studio-build",
    "Accept": "application/vnd.github+json"
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}
