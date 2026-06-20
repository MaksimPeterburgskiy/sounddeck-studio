import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import packageJson from "../package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const root = process.cwd();
applyLocalEnv(readEnvFile(path.join(root, ".env.macos.local")));
const driverSource = path.join(root, "build", "blackhole", "BlackHole2ch.driver");
const packageDir = path.join(root, "build", "extra-pkgs");
const packageRoot = path.join(packageDir, "hal-driver-root");
const scriptsDir = path.join(packageDir, "hal-driver-scripts");
const packagePath = path.join(packageDir, "sounddeck-blackhole-hal.pkg");
const installLocation = "/Library/Audio/Plug-Ins/HAL";
const packageIdentifier = "com.sounddeck.studio.blackhole-hal";
const installerIdentity = process.env.MACOS_INSTALLER_IDENTITY || process.env.CSC_INSTALLER_NAME;

if (process.platform !== "darwin") {
  throw new Error("BlackHole HAL component packages can only be built on macOS.");
}

if (!existsSync(driverSource)) {
  throw new Error(`Missing BlackHole driver. Run scripts/build-blackhole.mjs first: ${driverSource}`);
}

if (!installerIdentity || installerIdentity === "-") {
  throw new Error("Set MACOS_INSTALLER_IDENTITY or CSC_INSTALLER_NAME before building the signed HAL package.");
}

await rm(packageDir, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });
await mkdir(scriptsDir, { recursive: true });
await run("ditto", [driverSource, path.join(packageRoot, "BlackHole2ch.driver")]);

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

args.push("--sign", installerIdentity);

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

function readEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const result = {};
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    result[key] = expandHome(unquote(rawValue.trim()));
  }
  return result;
}

function applyLocalEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function expandHome(value) {
  return value.replace("$HOME", homedir()).replace(/^~(?=$|\/)/, homedir());
}
