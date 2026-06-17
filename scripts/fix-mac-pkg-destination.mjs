import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
applyLocalEnv(await readEnvFile(path.join(process.cwd(), ".env.macos.local")));

const pkgPath = process.argv[2] || await findReleasePkg();
const installerIdentity = process.env.MACOS_INSTALLER_IDENTITY ||
  process.env.CSC_INSTALLER_NAME ||
  "Developer ID Installer: Maksim Peterburgskiy (7WX3FK3V9U)";

if (process.platform !== "darwin") {
  throw new Error("macOS PKG destination postprocessing can only run on macOS.");
}

if (!installerIdentity || installerIdentity === "-") {
  throw new Error("A Developer ID Installer identity is required to re-sign the patched package.");
}

const tempRoot = await mkdtemp(path.join(tmpdir(), "sounddeck-pkg-fix-"));
const expandedDir = path.join(tempRoot, "expanded");
const flattenedPath = path.join(tempRoot, "patched.pkg");
const backupPath = path.join(tempRoot, "original.pkg");

try {
  await run("pkgutil", ["--expand-full", pkgPath, expandedDir]);
  const distributionPath = path.join(expandedDir, "Distribution");
  const originalDistribution = await readFile(distributionPath, "utf8");
  const patchedDistribution = forceSingleSystemDestination(originalDistribution);

  if (patchedDistribution !== originalDistribution) {
    await writeFile(distributionPath, patchedDistribution);
  }

  await run("pkgutil", ["--flatten", expandedDir, flattenedPath]);
  await rename(pkgPath, backupPath);

  const signArgs = ["--sign", installerIdentity];
  if (process.env.APPLE_KEYCHAIN) {
    signArgs.push("--keychain", process.env.APPLE_KEYCHAIN);
  }
  signArgs.push(flattenedPath, pkgPath);
  await run("productsign", signArgs);

  await notarizeAndStaple(pkgPath);
  console.log(`Patched ${pkgPath} to install only on the startup volume.`);
} catch (error) {
  if (!existsSync(pkgPath) && existsSync(backupPath)) {
    await rename(backupPath, pkgPath);
  }
  throw error;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function forceSingleSystemDestination(distribution) {
  const withRootVolume = distribution.replace(/<options\b([^>]*)\/>/, (match, attrs) => {
    const cleanedAttrs = attrs.replace(/\srootVolumeOnly="[^"]*"/, "");
    return `<options${cleanedAttrs} rootVolumeOnly="true"/>`;
  });

  if (!withRootVolume.includes('rootVolumeOnly="true"')) {
    throw new Error("Could not patch Distribution options with rootVolumeOnly=true.");
  }

  const withDomains = withRootVolume.replace(
    /<domains\b[^>]*\/>/,
    '<domains enable_localSystem="true"/>'
  );

  if (!withDomains.includes('<domains enable_localSystem="true"/>')) {
    throw new Error("Could not patch Distribution domains to local system only.");
  }

  return withDomains;
}

async function notarizeAndStaple(filePath) {
  const args = ["notarytool", "submit", filePath, "--wait", "--output-format", "json"];

  if (process.env.APPLE_KEYCHAIN_PROFILE && process.env.APPLE_KEYCHAIN) {
    args.push("--keychain", process.env.APPLE_KEYCHAIN, "--keychain-profile", process.env.APPLE_KEYCHAIN_PROFILE);
  } else if (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) {
    args.push(
      "--apple-id", process.env.APPLE_ID,
      "--password", process.env.APPLE_APP_SPECIFIC_PASSWORD,
      "--team-id", process.env.APPLE_TEAM_ID
    );
  } else {
    throw new Error("Missing notarization credentials for patched macOS package.");
  }

  await run("xcrun", args);
  await run("xcrun", ["stapler", "staple", filePath]);
}

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

async function findReleasePkg() {
  const releaseDir = path.join(process.cwd(), "release");
  const packages = (await readdir(releaseDir))
    .filter((entry) => entry.endsWith(".pkg"))
    .map((entry) => path.join(releaseDir, entry));
  if (packages.length !== 1) {
    throw new Error(`Expected exactly one release/*.pkg artifact, found ${packages.length}.`);
  }
  return packages[0];
}

async function readEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const result = {};
  const content = await readFile(filePath, "utf8");
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
