import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function resolvePackageRoot(packageName) {
  try {
    return dirname(require.resolve(`${packageName}/package.json`));
  } catch {
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

    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stats = statSync(path);

      if (stats.isDirectory()) {
        stack.push(path);
        continue;
      }

      if (stats.isFile() && (path.endsWith(".dylib") || path.endsWith(".node"))) {
        files.push(path);
      }
    }
  }

  return files.sort();
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
      join(cueSdkRoot, "prebuilds", "darwin-x64_arm64")
    ]
  : [];
const cueSdkFiles = [...new Set(cueSdkSignRoots.flatMap(collectNativeFiles))];

for (const file of cueSdkFiles) {
  runCodesign(["--force", "--sign", "-", file]);
}

const electronRoot = resolvePackageRoot("electron");
const electronApp = electronRoot ? join(electronRoot, "dist", "Electron.app") : null;

if (electronApp && existsSync(electronApp)) {
  runCodesign(["--force", "--deep", "--sign", "-", electronApp]);
}

if (!cueSdkFiles.length && !electronApp) {
  console.log("> no macOS dev dependencies found to codesign");
}
