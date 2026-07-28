// Downloads a reviewed VB-CABLE release into a fresh staging directory,
// verifies its pinned hashes and Authenticode identity, and only then exposes
// it to electron-builder. No cached or pre-existing payload is trusted.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, prepareVbCable } from "./vbcable-provenance.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repoRoot, "build", "vbcable-provenance.json");
const targetDir = path.join(repoRoot, "build", "vbcable");
const manifest = await loadManifest(manifestPath);

console.log(`Fetching reviewed ${manifest.package} (${manifest.driverVersion}) from ${manifest.url}`);
const result = await prepareVbCable({
  manifest,
  targetDir,
  stageParent: path.join(repoRoot, "build")
});
console.log(`VB-CABLE archive verified: ${result.archiveSha256}`);
console.log(`Verified VB-CABLE payload prepared at ${result.targetDir}`);
