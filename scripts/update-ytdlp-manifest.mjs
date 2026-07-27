// Proposes a yt-dlp bump for config/native-tools.json: reads the latest
// upstream release, verifies its SHA2-256SUMS file against the signing key
// pinned in config/yt-dlp-signing-keys.asc, downloads the exact assets the
// manifest packages, confirms their hashes against the signed sums, and
// rewrites the manifest entries. The result still goes through a reviewed
// pull request — this script only prepares it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateManifest } from "./native-tools.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(repoRoot, "config", "native-tools.json");
const signingKeyPath = path.join(repoRoot, "config", "yt-dlp-signing-keys.asc");
const pinnedFingerprint = "AC0CBBE6848D6A873464AF4E57CF65933B5A7581";

// Asset names per manifest target; both use the same release and sums file.
const ytDlpAssets = {
  darwin: "yt-dlp_macos",
  "win32-x64": "yt-dlp.exe"
};

export function parseSha256Sums(sums, assetName) {
  const escaped = assetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sums.match(new RegExp(`^([a-f0-9]{64})\\s+\\*?${escaped}$`, "im"));
  if (!match) throw new Error(`Could not find a SHA-256 entry for ${assetName}.`);
  return match[1].toLowerCase();
}

export function withUpdatedYtDlp(manifest, { version, hashes }) {
  const updated = structuredClone(manifest);
  for (const [target, assetName] of Object.entries(ytDlpAssets)) {
    const entry = updated.targets[target]?.["yt-dlp"];
    if (!entry) throw new Error(`Manifest target ${target} has no yt-dlp entry.`);
    entry.version = version;
    entry.url = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${assetName}`;
    entry.downloadSha256 = hashes[assetName];
    entry.sha256 = hashes[assetName];
    entry.license = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${version}/LICENSE`;
  }
  validateManifest(updated);
  return updated;
}

async function verifySignedSums(version) {
  const sums = await fetchText(assetUrl(version, "SHA2-256SUMS"));
  const signature = await fetchBuffer(assetUrl(version, "SHA2-256SUMS.sig"));
  const gnupgHome = await mkdtemp(path.join(os.tmpdir(), "sounddeck-ytdlp-gpg-"));
  const sumsFile = path.join(gnupgHome, "SHA2-256SUMS");
  const signatureFile = path.join(gnupgHome, "SHA2-256SUMS.sig");
  try {
    await writeFile(sumsFile, sums);
    await writeFile(signatureFile, signature);
    const env = { ...process.env, GNUPGHOME: gnupgHome };
    const imported = await execFileAsync("gpg", ["--batch", "--import", signingKeyPath], { env });
    if (!imported.stderr.includes(pinnedFingerprint.slice(-16))) {
      throw new Error("The pinned yt-dlp signing key does not match the expected fingerprint.");
    }
    // The temporary keyring contains only the pinned key, and VALIDSIG must
    // still name its exact fingerprint.
    const { stdout } = await execFileAsync(
      "gpg",
      ["--batch", "--status-fd", "1", "--verify", signatureFile, sumsFile],
      { env }
    );
    if (!stdout.split("\n").some((line) =>
      line.startsWith("[GNUPG:] VALIDSIG") && line.includes(pinnedFingerprint)
    )) {
      throw new Error(`SHA2-256SUMS for ${version} is not signed by the pinned yt-dlp key.`);
    }
    return sums;
  } finally {
    await rm(gnupgHome, { recursive: true, force: true });
  }
}

function assetUrl(version, assetName) {
  return `https://github.com/yt-dlp/yt-dlp/releases/download/${encodeURIComponent(version)}/${assetName}`;
}

async function fetchText(url) {
  const response = await fetchOk(url);
  return response.text();
}

async function fetchBuffer(url) {
  const response = await fetchOk(url);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchOk(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: requestHeaders(url),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`Request failed ${response.status} ${response.statusText}: ${url}`);
  return response;
}

function requestHeaders(url) {
  const headers = { "User-Agent": "sounddeck-studio-build" };
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    headers.Accept = "application/vnd.github+json";
  }
  return headers;
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);

  // "latest" is only used to discover the version; every downloaded artifact
  // is verified against the signed sums file before the manifest changes.
  const release = JSON.parse(await fetchText("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"));
  const version = release.tag_name;
  if (!version) throw new Error("Could not determine the latest yt-dlp release tag.");

  const current = Object.keys(ytDlpAssets).map((target) => manifest.targets[target]["yt-dlp"].version);
  if (current.every((existing) => existing === version)) {
    console.log(`yt-dlp ${version} is already pinned; nothing to update.`);
    return;
  }

  const sums = await verifySignedSums(version);
  const hashes = {};
  for (const assetName of Object.values(ytDlpAssets)) {
    const expected = parseSha256Sums(sums, assetName);
    const binary = await fetchBuffer(assetUrl(version, assetName));
    const actual = createHash("sha256").update(binary).digest("hex");
    if (actual !== expected) {
      throw new Error(`${assetName} checksum mismatch: signed sums say ${expected}, got ${actual}.`);
    }
    hashes[assetName] = actual;
  }

  const updated = withUpdatedYtDlp(manifest, { version, hashes });
  await writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`Updated config/native-tools.json to yt-dlp ${version}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
