import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const unsigned = args.has("--unsigned");

if (process.platform !== "darwin") {
  throw new Error([
    "macOS packaging requires macOS because it uses Xcode, codesign, productbuild,",
    "pkgbuild, iconutil, stapler, and notarization."
  ].join(" "));
}

const defaults = {
  APPLE_TEAM_ID: "7WX3FK3V9U",
  CSC_NAME: "Maksim Peterburgskiy (7WX3FK3V9U)",
  BLACKHOLE_CODESIGN_IDENTITY: "Developer ID Application: Maksim Peterburgskiy (7WX3FK3V9U)",
  BLACKHOLE_REPO: "https://github.com/ExistentialAudio/BlackHole.git",
  BLACKHOLE_COMMIT: "11efc147fef0ac537be1c24ea7e29e4b2a2d63c7"
};

const localEnv = readEnvFile(path.join(process.cwd(), ".env.macos.local"));
const merged = {
  ...defaults,
  ...localEnv,
  ...presentEnv(process.env)
};

if (merged.APPLE_KEYCHAIN) merged.APPLE_KEYCHAIN = expandHome(merged.APPLE_KEYCHAIN);

const notarizationEnv = selectNotarizationEnv(merged, unsigned);
const env = {
  ...process.env,
  ...merged,
  ...notarizationEnv,
  BLACKHOLE_CODESIGN_IDENTITY: unsigned ? "-" : merged.BLACKHOLE_CODESIGN_IDENTITY,
  CSC_NAME: unsigned ? "" : merged.CSC_NAME
};

const electronBuilderArgs = unsigned
  ? ["exec", "electron-builder", "--mac", "dir", "--publish", "never", "-c.mac.identity=null", "-c.mac.notarize=false"]
  : ["exec", "electron-builder", "--mac", "--publish", "never"];

const steps = [
  ["pnpm", ["run", "clean:release"]],
  ["node", ["scripts/prepare-mac-assets.mjs"]],
  ["node", ["scripts/fetch-ytdlp-mac.mjs"]],
  ["node", ["scripts/build-blackhole.mjs"]],
  ...(unsigned ? [] : [["node", ["scripts/build-mac-hal-driver-pkg.mjs"]]]),
  ["pnpm", ["run", "build"]],
  ["pnpm", electronBuilderArgs],
  ...(unsigned ? [] : [["node", ["scripts/fix-mac-pkg-destination.mjs"]]])
];

if (unsigned) {
  console.log("Building unsigned macOS smoke artifact; app signing and notarization are disabled.");
} else if (notarizationEnv.APPLE_ID) {
  console.log("Using Apple ID app-specific password notarization credentials.");
} else {
  console.log(`Using keychain notarization profile "${notarizationEnv.APPLE_KEYCHAIN_PROFILE}".`);
}

for (const [command, stepArgs] of steps) {
  await run(command, stepArgs);
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

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function expandHome(value) {
  return value.replace("$HOME", os.homedir()).replace(/^~(?=$|\/)/, os.homedir());
}

function presentEnv(source) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== ""));
}

function selectNotarizationEnv(values, skip) {
  if (skip) return {};
  if (values.APPLE_ID && values.APPLE_APP_SPECIFIC_PASSWORD && values.APPLE_TEAM_ID) {
    return {
      APPLE_ID: values.APPLE_ID,
      APPLE_APP_SPECIFIC_PASSWORD: values.APPLE_APP_SPECIFIC_PASSWORD,
      APPLE_TEAM_ID: values.APPLE_TEAM_ID
    };
  }
  if (values.APPLE_KEYCHAIN_PROFILE && values.APPLE_KEYCHAIN) {
    return {
      APPLE_KEYCHAIN_PROFILE: values.APPLE_KEYCHAIN_PROFILE,
      APPLE_KEYCHAIN: values.APPLE_KEYCHAIN
    };
  }
  throw new Error([
    "Missing macOS notarization credentials.",
    "Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID,",
    "or set APPLE_KEYCHAIN_PROFILE and APPLE_KEYCHAIN in .env.macos.local."
  ].join(" "));
}

function run(command, stepArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, stepArgs, {
      cwd: process.cwd(),
      env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${stepArgs.join(" ")} exited with code ${code}`));
    });
  });
}
