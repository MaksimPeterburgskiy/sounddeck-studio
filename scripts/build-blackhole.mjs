import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
applyLocalEnv(readEnvFile(path.join(root, ".env.macos.local")));
const blackholeDir = path.join(root, "build", "blackhole");
const driverDest = path.join(blackholeDir, "BlackHole2ch.driver");
const noticeDest = path.join(blackholeDir, "NOTICE.txt");
const metadataDest = path.join(blackholeDir, "BUILD-METADATA.json");

const repoUrl = process.env.BLACKHOLE_REPO || "https://github.com/ExistentialAudio/BlackHole.git";
const pinnedCommit = process.env.BLACKHOLE_COMMIT || "11efc147fef0ac537be1c24ea7e29e4b2a2d63c7";
const suppliedDriver = process.env.BLACKHOLE_DRIVER_PATH ? path.resolve(process.env.BLACKHOLE_DRIVER_PATH) : "";
const sourcePath = process.env.BLACKHOLE_SOURCE_PATH
  ? path.resolve(process.env.BLACKHOLE_SOURCE_PATH)
  : path.join(root, "tmp", "blackhole-src");
const signingIdentity = process.env.BLACKHOLE_CODESIGN_IDENTITY || process.env.CSC_NAME;

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      maxBuffer: 1024 * 1024 * 20,
      ...options
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result;
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

async function ensureSourceCheckout() {
  if (process.env.BLACKHOLE_SOURCE_PATH) {
    if (!existsSync(path.join(sourcePath, "BlackHole.xcodeproj"))) {
      throw new Error(`BLACKHOLE_SOURCE_PATH does not point at a BlackHole checkout: ${sourcePath}`);
    }
  } else if (!existsSync(path.join(sourcePath, ".git"))) {
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await run("git", ["clone", repoUrl, sourcePath]);
  }

  await run("git", ["fetch", "--tags", "origin", pinnedCommit], { cwd: sourcePath });
  await run("git", ["checkout", "--detach", pinnedCommit], { cwd: sourcePath });
}

async function buildFromSource() {
  await ensureSourceCheckout();
  const buildDir = path.join(sourcePath, "build", "sounddeck-2ch");
  await rm(buildDir, { recursive: true, force: true });
  await run("xcodebuild", [
    "-project", "BlackHole.xcodeproj",
    "-configuration", "Release",
    "-target", "BlackHole",
    `CONFIGURATION_BUILD_DIR=${buildDir}`,
    "PRODUCT_BUNDLE_IDENTIFIER=audio.existential.BlackHole2ch",
    "GCC_PREPROCESSOR_DEFINITIONS=$(inherited) kNumber_Of_Channels=2 kPlugIn_BundleID=\\\"audio.existential.BlackHole2ch\\\" kDriver_Name=\\\"BlackHole\\\"",
    "CODE_SIGNING_ALLOWED=NO"
  ], { cwd: sourcePath });

  const builtDriver = path.join(buildDir, "BlackHole.driver");
  if (!existsSync(builtDriver)) {
    throw new Error(`BlackHole build succeeded but did not produce ${builtDriver}`);
  }
  return builtDriver;
}

async function blackHoleMetadata() {
  if (!existsSync(path.join(sourcePath, ".git"))) return {};
  const actualCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: sourcePath })).stdout.trim();
  const dirtyStatus = (await run("git", ["status", "--short", "--", ".", ":(exclude)build"], { cwd: sourcePath })).stdout.trim();
  const versionPath = path.join(sourcePath, "VERSION");
  const version = existsSync(versionPath) ? (await readFile(versionPath, "utf8")).trim() : "";
  return {
    sourceRepo: repoUrl,
    sourcePath,
    pinnedCommit,
    actualCommit,
    dirtyStatus,
    version
  };
}

await mkdir(blackholeDir, { recursive: true });

let sourceDriver = suppliedDriver;
if (suppliedDriver) {
  if (!existsSync(suppliedDriver)) throw new Error(`BLACKHOLE_DRIVER_PATH does not exist: ${suppliedDriver}`);
} else {
  sourceDriver = await buildFromSource();
}

await rm(driverDest, { recursive: true, force: true });
await cp(sourceDriver, driverDest, { recursive: true, force: true });

if (process.platform === "darwin") {
  if (!signingIdentity) {
    throw new Error("Set BLACKHOLE_CODESIGN_IDENTITY or CSC_NAME before signing the BlackHole driver.");
  }
  await run("codesign", ["--force", "--deep", "--options", "runtime", "--sign", signingIdentity, driverDest]);
}

await writeFile(
  noticeDest,
  [
    "SoundDeck Studio macOS virtual audio driver notice",
    "",
    "This package is configured to bundle BlackHole 2ch for managed virtual microphone routing.",
    "BlackHole is Copyright Existential Audio Inc. and is distributed under GPL-3.0 unless a separate license has been obtained.",
    "Release artifacts that bundle BlackHole must include the corresponding source, notices, and build/install scripts.",
    "",
    `Upstream project: ${repoUrl}`,
    `Pinned source commit: ${pinnedCommit}`
  ].join("\n")
);

await writeFile(
  metadataDest,
  JSON.stringify({
    builtAt: new Date().toISOString(),
    driver: path.relative(root, driverDest),
    sourceDriver,
    signingIdentity,
    ...(await blackHoleMetadata())
  }, null, 2)
);

console.log(`Prepared ${path.relative(root, driverDest)}, ${path.relative(root, noticeDest)}, and ${path.relative(root, metadataDest)}`);

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
