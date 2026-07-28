import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifyNativeToolHashes, verifyPackagedProvenance } from "./native-tools.mjs";

const execFileAsync = promisify(execFile);
const argv = process.argv.slice(2);
const positionals = [];
let channel = "latest";
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--channel") {
    channel = argv[index + 1];
    index += 1;
  } else {
    positionals.push(argv[index]);
  }
}
if (!/^[a-z][a-z0-9-]*$/.test(channel || "")) {
  throw new Error("--channel requires a lowercase channel name such as latest or beta.");
}
const updaterFeedName = `${channel}.yml`;
const appOutDir = positionals[0] || path.join("release", "win-unpacked");
const releaseDir = path.dirname(appOutDir);
const toolsDir = path.join(appOutDir, "resources", "native-tools");
const assets = await verifyPackagedProvenance(toolsDir, "win32-x64");

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
  updaterFeedName
]) {
  await access(path.join(releaseDir, fileName));
}
const updaterFeed = await readFile(path.join(releaseDir, updaterFeedName), "utf8");
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
