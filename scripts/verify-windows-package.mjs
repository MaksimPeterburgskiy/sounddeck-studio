import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readNativeToolsManifest, sha256File } from "./native-tools.mjs";

const execFileAsync = promisify(execFile);
const appOutDir = process.argv[2] || path.join("release", "win-unpacked");
const toolsDir = path.join(appOutDir, "resources", "native-tools");
const manifest = await readNativeToolsManifest();
const assets = manifest.targets["win32-x64"];
const provenance = JSON.parse(await readFile(path.join(toolsDir, "PROVENANCE.json"), "utf8"));
if (provenance.target !== "win32-x64" || JSON.stringify(provenance.assets) !== JSON.stringify(assets)) {
  throw new Error("Packaged native-tool provenance does not match config/native-tools.json.");
}

for (const [name, asset] of Object.entries(assets)) {
  const filePath = path.join(toolsDir, asset.fileName);
  await access(filePath);
  const digest = await sha256File(filePath);
  if (digest !== asset.sha256) {
    throw new Error(`${name} packaged checksum mismatch: expected ${asset.sha256}, got ${digest}.`);
  }
  const args = name === "ffmpeg" ? ["-version"] : ["--version"];
  await execFileAsync(filePath, args, { timeout: 30_000, windowsHide: true });
}

console.log(`Verified project-managed native tools in ${appOutDir}.`);
