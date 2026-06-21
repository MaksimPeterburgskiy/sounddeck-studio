import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, copyFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { writeMacTrayTemplateFiles } = require("../electron/trayIcon.cjs");
const root = process.cwd();
const sourcePng = path.join(root, "docs", "icon.png");
const buildDir = path.join(root, "build");
const iconsetDir = path.join(buildDir, "icon.iconset");
const iconPng = path.join(buildDir, "icon.png");
const iconIcns = path.join(buildDir, "icon.icns");

await mkdir(buildDir, { recursive: true });
await copyFile(sourcePng, iconPng);
await writeMacTrayTemplateFiles(buildDir);

if (process.platform !== "darwin") {
  console.warn("Skipping icon.icns generation because macOS iconutil is only available on macOS.");
  process.exit(0);
}

await rm(iconsetDir, { recursive: true, force: true });
await mkdir(iconsetDir, { recursive: true });

const sizes = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"]
];

for (const [size, name] of sizes) {
  await execFileAsync("sips", ["-z", String(size), String(size), sourcePng, "--out", path.join(iconsetDir, name)]);
}

await execFileAsync("iconutil", ["-c", "icns", iconsetDir, "-o", iconIcns]);
await rm(iconsetDir, { recursive: true, force: true });
console.log(`Prepared ${path.relative(root, iconIcns)}`);
