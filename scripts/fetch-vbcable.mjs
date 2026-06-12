// Downloads the official VB-CABLE driver pack into build/vbcable/ so the
// NSIS installer can bundle it. VB-CABLE is donationware by VB-Audio and is
// not redistributed in this repository; it is fetched from vb-audio.com at
// package time. See https://vb-audio.com/Cable/ for licensing.
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VBCABLE_URL = "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = path.join(repoRoot, "build", "vbcable");
const marker = path.join(targetDir, "VBCABLE_Setup_x64.exe");

if (existsSync(marker)) {
  console.log(`VB-CABLE already present at ${targetDir}, skipping download.`);
  process.exit(0);
}

console.log(`Downloading VB-CABLE driver pack from ${VBCABLE_URL} ...`);
const response = await fetch(VBCABLE_URL);
if (!response.ok) {
  console.error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  process.exit(1);
}
const zipBytes = Buffer.from(await response.arrayBuffer());
console.log(`Downloaded ${(zipBytes.length / 1024 / 1024).toFixed(1)} MB.`);

await mkdir(targetDir, { recursive: true });
const zipPath = path.join(targetDir, "vbcable.zip");
await writeFile(zipPath, zipBytes);

execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", "Expand-Archive -Path vbcable.zip -DestinationPath . -Force"],
  { stdio: "inherit", cwd: targetDir }
);
await rm(zipPath);

if (!existsSync(marker)) {
  console.error("Extraction finished but VBCABLE_Setup_x64.exe is missing — archive layout may have changed.");
  process.exit(1);
}
console.log(`VB-CABLE extracted to ${targetDir}.`);
