import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function resolvePackageRoot(packageName) {
  try {
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    try {
      let current = dirname(require.resolve(packageName));

      while (current && current !== repoRoot) {
        if (existsSync(join(current, "package.json"))) return current;

        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch {
      return null;
    }

    return null;
  }
}

function collectNativeFiles(root) {
  if (!root || !existsSync(root)) return [];

  const files = [];
  const stack = [root];

  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;

    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);

        if (entry.isDirectory()) {
          stack.push(path);
          continue;
        }

        if (entry.isFile() && (path.endsWith(".dylib") || path.endsWith(".node"))) {
          files.push(path);
        }
      }
    } catch (error) {
      console.warn(`> warning: could not read ${current}: ${error.message}`);
    }
  }

  return files.sort();
}

function collectDarwinPrebuildRoots(packageRoot) {
  const prebuildsRoot = packageRoot ? join(packageRoot, "prebuilds") : null;
  if (!prebuildsRoot || !existsSync(prebuildsRoot)) return [];

  try {
    return readdirSync(prebuildsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("darwin-"))
      .map((entry) => join(prebuildsRoot, entry.name))
      .sort();
  } catch (error) {
    console.warn(`> warning: could not read ${prebuildsRoot}: ${error.message}`);
    return [];
  }
}

function runCodesign(args) {
  console.log(`> codesign ${args.join(" ")}`);
  const result = spawnSync("codesign", args, {
    cwd: repoRoot,
    stdio: "inherit"
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.platform !== "darwin") {
  console.log("> macOS dev dependency codesign skipped on this platform");
  process.exit(0);
}

const cueSdkRoot = resolvePackageRoot("cue-sdk");
const cueSdkSignRoots = cueSdkRoot
  ? [
      join(cueSdkRoot, "iCUESDK", "mac"),
      join(cueSdkRoot, "build", "Release"),
      ...collectDarwinPrebuildRoots(cueSdkRoot)
    ]
  : [];
const cueSdkFiles = [...new Set(cueSdkSignRoots.flatMap(collectNativeFiles))];

for (const file of cueSdkFiles) {
  runCodesign(["--force", "--sign", "-", file]);
}

const uiohookRoot = resolvePackageRoot("uiohook-napi");
const uiohookSignRoots = collectDarwinPrebuildRoots(uiohookRoot);
const uiohookFiles = [...new Set(uiohookSignRoots.flatMap(collectNativeFiles))];

for (const file of uiohookFiles) {
  runCodesign(["--force", "--sign", "-", file]);
}

const extraDevBinaries = [
  join(repoRoot, "tmp", "native-tools", "darwin", "ffmpeg-x64"),
  join(repoRoot, "tmp", "native-tools", "darwin", "ffmpeg-arm64"),
  join(repoRoot, "tmp", "native-tools", "darwin", "yt-dlp")
].filter(existsSync);

for (const file of extraDevBinaries) {
  runCodesign(["--force", "--sign", "-", file]);
}

const electronRoot = resolvePackageRoot("electron");
const electronApp = electronRoot ? join(electronRoot, "dist", "Electron.app") : null;

if (electronApp && existsSync(electronApp)) {
  runCodesign(["--force", "--deep", "--sign", "-", electronApp]);
}

if (!cueSdkFiles.length && !uiohookFiles.length && !extraDevBinaries.length && (!electronApp || !existsSync(electronApp))) {
  console.log("> no macOS dev dependencies found to codesign");
}
