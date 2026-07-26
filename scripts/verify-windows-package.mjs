import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readNativeToolsManifest, verifyNativeToolHashes } from "./native-tools.mjs";

const execFileAsync = promisify(execFile);
const appOutDir = process.argv[2] || path.join("release", "win-unpacked");
const releaseDir = path.dirname(appOutDir);
const toolsDir = path.join(appOutDir, "resources", "native-tools");
const manifest = await readNativeToolsManifest();
const assets = manifest.targets["win32-x64"];
const provenance = JSON.parse(await readFile(path.join(toolsDir, "PROVENANCE.json"), "utf8"));
if (provenance.target !== "win32-x64" || JSON.stringify(provenance.assets) !== JSON.stringify(assets)) {
  throw new Error("Packaged native-tool provenance does not match config/native-tools.json.");
}

await verifyNativeToolHashes(toolsDir, assets);
for (const [name, asset] of Object.entries(assets)) {
  const filePath = path.join(toolsDir, asset.fileName);
  await access(filePath);
  const args = name === "ffmpeg" ? ["-version"] : ["--version"];
  await execFileAsync(filePath, args, { timeout: 30_000, windowsHide: true });
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const installerName = `SoundDeck-Studio-Setup-${packageJson.version}.exe`;
const portableName = `SoundDeck-Studio-${packageJson.version}.exe`;
for (const fileName of [
  installerName,
  `${installerName}.blockmap`,
  portableName,
  "latest.yml"
]) {
  await access(path.join(releaseDir, fileName));
}
const updaterFeed = await readFile(path.join(releaseDir, "latest.yml"), "utf8");
if (
  !updaterFeed.includes(`url: ${installerName}`) ||
  !updaterFeed.includes(`path: ${installerName}`)
) {
  throw new Error(`Windows updater metadata must reference ${installerName}.`);
}
const unsafeArtifact = (await readdir(releaseDir)).find(
  (fileName) => /\.exe(?:\.blockmap)?$/.test(fileName) && fileName.includes(" ")
);
if (unsafeArtifact) {
  throw new Error(`Windows artifact contains spaces: ${unsafeArtifact}`);
}

console.log(`Verified project-managed native tools in ${appOutDir}.`);
console.log(`Verified Windows release artifacts in ${releaseDir}.`);
