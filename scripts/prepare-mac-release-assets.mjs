// Prepares the macOS artifacts in release/ for `gh release upload`: verifies the
// pkg, updater zip, and channel feed exist, renames spaces out of asset names
// (GitHub mangles them otherwise), rewrites the feed's url/path fields to the
// sanitized zip name, and prints the final upload list to stdout (one path per
// line; diagnostics go to stderr so callers can pipe the list straight into gh).
import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CHANNELS = ["latest", "beta"];

export function sanitizeAssetName(name) {
  return name.replaceAll(" ", ".");
}

export function rewriteFeedZipReferences(feed, zipName) {
  return feed
    .replace(/url: .+\.zip/g, `url: ${zipName}`)
    .replace(/path: .+\.zip/g, `path: ${zipName}`);
}

export function prepareMacReleaseAssets({ releaseDir, channel, log = () => undefined }) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`Unknown channel "${channel}"; expected one of: ${CHANNELS.join(", ")}.`);
  }
  const feedName = `${channel}-mac.yml`;
  const entries = readdirSync(releaseDir);
  const artifacts = entries.filter((name) => /\.(pkg|zip|zip\.blockmap)$/.test(name));

  if (!artifacts.some((name) => name.endsWith(".pkg"))) {
    throw new Error(`No macOS pkg artifact found in ${releaseDir}.`);
  }
  if (!artifacts.some((name) => name.endsWith(".zip"))) {
    throw new Error(`No macOS zip updater artifact found in ${releaseDir}.`);
  }
  if (!entries.includes(feedName)) {
    throw new Error(`No ${feedName} updater feed found in ${releaseDir}.`);
  }

  const uploads = artifacts.map((name) => {
    const sanitized = sanitizeAssetName(name);
    if (sanitized !== name) {
      renameSync(path.join(releaseDir, name), path.join(releaseDir, sanitized));
      log(`Renamed ${name} -> ${sanitized}`);
    }
    return sanitized;
  });

  const zipName = uploads.find((name) => name.endsWith(".zip"));
  const feedPath = path.join(releaseDir, feedName);
  writeFileSync(feedPath, rewriteFeedZipReferences(readFileSync(feedPath, "utf8"), zipName));
  log(`Rewrote ${feedName} zip references to ${zipName}`);

  return [...uploads, feedName].map((name) => path.join(releaseDir, name));
}

function main() {
  const args = process.argv.slice(2);
  const channelIndex = args.indexOf("--channel");
  const channel = channelIndex === -1 ? null : args[channelIndex + 1];
  if (!channel) {
    console.error("Usage: node scripts/prepare-mac-release-assets.mjs --channel <latest|beta>");
    process.exit(1);
  }
  const files = prepareMacReleaseAssets({
    releaseDir: path.join(process.cwd(), "release"),
    channel,
    log: (message) => console.error(message)
  });
  for (const file of files) console.log(file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
