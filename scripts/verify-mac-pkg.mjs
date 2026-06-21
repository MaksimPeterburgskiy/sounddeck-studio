import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pkgPath = process.argv[2];

if (!pkgPath) {
  throw new Error("Usage: node scripts/verify-mac-pkg.mjs <path-to-pkg>");
}

const tempRoot = await mkdtemp(path.join(tmpdir(), "sounddeck-pkg-"));
const tempDir = path.join(tempRoot, "expanded");
try {
  await run("pkgutil", ["--expand-full", pkgPath, tempDir]);
  const distribution = await readFile(path.join(tempDir, "Distribution"), "utf8");
  assertIncludes(distribution, 'rootVolumeOnly="true"', "PKG must hide destination selection and install only on the startup volume.");
  assertNotIncludes(distribution, "enable_anywhere", "PKG must not offer arbitrary install volumes.");
  assertNotIncludes(distribution, "enable_currentUserHome", "PKG must not offer per-user home installs.");
  assertIncludes(distribution, 'enable_localSystem="true"', "PKG must allow the local system install domain.");
  assertIncludes(distribution, 'com.sounddeck.studio.blackhole-hal', "PKG must include the HAL driver component.");

  const appPackageInfo = await readFile(path.join(tempDir, "com.sounddeck.studio.pkg", "PackageInfo"), "utf8");
  assertIncludes(appPackageInfo, 'install-location="/Applications"', "App component must install into /Applications.");
  assertIncludes(appPackageInfo, "<relocate/>", "App component must suppress PackageKit bundle relocation.");
  assertNotIncludes(appPackageInfo, "<scripts>", "App component must not depend on installer scripts.");
  assertNotIncludes(appPackageInfo, "BundlePostInstallScriptPath", "App component must not depend on postinstall copy scripts.");
  await verifyAppPayload(path.join(tempDir, "com.sounddeck.studio.pkg", "Payload", "SoundDeck Studio.app"));

  const halPackageInfo = await readPackageInfoByIdentifier(tempDir, "com.sounddeck.studio.blackhole-hal");
  assertIncludes(halPackageInfo, 'install-location="/Library/Audio/Plug-Ins/HAL"', "HAL component must install directly into the system HAL plugin folder.");
  assertIncludes(halPackageInfo, "BlackHole2ch.driver", "HAL component must contain BlackHole2ch.driver.");

  console.log(`Verified macOS installer payload layout: ${pkgPath}`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
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

async function verifyAppPayload(appPath) {
  await assertSymlink(
    path.join(appPath, "Contents/Frameworks/Electron Framework.framework/Electron Framework"),
    "Electron Framework.framework/Electron Framework must remain a symlink."
  );
  await assertSymlink(
    path.join(appPath, "Contents/Frameworks/Electron Framework.framework/Resources"),
    "Electron Framework.framework/Resources must remain a symlink."
  );
  await assertSymlink(
    path.join(appPath, "Contents/Frameworks/Electron Framework.framework/Versions/Current"),
    "Electron Framework.framework/Versions/Current must remain a symlink."
  );
  await assertFile(
    path.join(appPath, "Contents/Resources/trayTemplate.png"),
    "App payload must include the 1x macOS tray template icon."
  );
  await assertFile(
    path.join(appPath, "Contents/Resources/trayTemplate@2x.png"),
    "App payload must include the 2x macOS tray template icon."
  );
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  await run("spctl", ["--assess", "--verbose", "--type", "execute", appPath]);
}

async function assertSymlink(filePath, message) {
  try {
    const stats = await lstat(filePath);
    if (!stats.isSymbolicLink()) {
      throw new Error(`${message} Found ${filePath} as a real filesystem entry.`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${message} File or directory does not exist at ${filePath}`);
    }
    throw error;
  }
}

async function assertFile(filePath, message) {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile()) {
      throw new Error(`${message} Found ${filePath} but it is not a file.`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${message} File does not exist at ${filePath}`);
    }
    throw error;
  }
}

function assertIncludes(content, expected, message) {
  if (!content.includes(expected)) {
    throw new Error(`${message} Missing: ${expected}`);
  }
}

function assertNotIncludes(content, forbidden, message) {
  if (content.includes(forbidden)) {
    throw new Error(`${message} Found: ${forbidden}`);
  }
}

async function readPackageInfoByIdentifier(expandedPkgDir, identifier) {
  const entries = await readdir(expandedPkgDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".pkg")) continue;
    const packageInfoPath = path.join(expandedPkgDir, entry.name, "PackageInfo");
    const packageInfo = await readFile(packageInfoPath, "utf8");
    if (packageInfo.includes(`identifier="${identifier}"`)) return packageInfo;
  }
  throw new Error(`Could not find component package with identifier ${identifier}`);
}
