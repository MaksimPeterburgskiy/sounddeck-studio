import { execFile } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import packageJson from "../package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const root = process.cwd();
const driverSource = path.join(root, "build", "blackhole", "BlackHole2ch.driver");
const packageDir = path.join(root, "build", "extra-pkgs");
const packageRoot = path.join(packageDir, "hal-driver-root");
const scriptsDir = path.join(packageDir, "hal-driver-scripts");
const packagePath = path.join(packageDir, "sounddeck-blackhole-hal.pkg");
const installLocation = "/Library/Audio/Plug-Ins/HAL";
const packageIdentifier = "com.sounddeck.studio.blackhole-hal";
const installerIdentity = process.env.MACOS_INSTALLER_IDENTITY ||
  process.env.CSC_INSTALLER_NAME ||
  "Developer ID Installer: Maksim Peterburgskiy (7WX3FK3V9U)";

if (process.platform !== "darwin") {
  throw new Error("BlackHole HAL component packages can only be built on macOS.");
}

if (!existsSync(driverSource)) {
  throw new Error(`Missing BlackHole driver. Run scripts/build-blackhole.mjs first: ${driverSource}`);
}

await rm(packageDir, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });
await mkdir(scriptsDir, { recursive: true });
await cp(driverSource, path.join(packageRoot, "BlackHole2ch.driver"), { recursive: true, force: true });

await writeFile(
  path.join(scriptsDir, "postinstall"),
  [
    "#!/bin/sh",
    "set -u",
    "",
    "# The driver is installed by this component payload. Restart Core Audio so",
    "# the newly installed HAL plugin is discovered without requiring a reboot.",
    "killall coreaudiod >/dev/null 2>&1 || true",
    "exit 0",
    ""
  ].join("\n"),
  { mode: 0o755 }
);

const args = [
  "--root", packageRoot,
  "--identifier", packageIdentifier,
  "--version", packageJson.version,
  "--install-location", installLocation,
  "--ownership", "recommended",
  "--scripts", scriptsDir
];

if (installerIdentity && installerIdentity !== "-") {
  args.push("--sign", installerIdentity);
}

args.push(packagePath);
await run("pkgbuild", args);

console.log(`Prepared ${path.relative(root, packagePath)} for ${installLocation}`);

async function run(command, args) {
  try {
    const result = await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 20 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}
