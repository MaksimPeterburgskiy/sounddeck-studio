import { spawn } from "node:child_process";

if (process.platform !== "win32") {
  throw new Error("Windows packaging requires Windows.");
}

const env = {
  ...process.env,
  GITHUB_TOKEN: "",
  GH_TOKEN: "",
  GITHUB_RELEASE_TOKEN: "",
  RELEASE_TOKEN: "",
  SOUNDDECK_NATIVE_TOOLS_OFFLINE: "1"
};

const steps = [
  ["pnpm", ["run", "clean:release"]],
  ["node", ["scripts/fetch-native-tools.mjs", "--platform", "win32", "--arch", "x64"], {
    SOUNDDECK_NATIVE_TOOLS_OFFLINE: ""
  }],
  ["node", ["scripts/fetch-vbcable.mjs"]],
  ["node", ["scripts/make-installer-art.mjs"]],
  ["pnpm", ["run", "build"]],
  ["pnpm", ["exec", "electron-builder", "--win", "--publish", "never"]],
  ["node", ["scripts/verify-windows-package.mjs"]]
];

for (const [command, args, overrides = {}] of steps) {
  await run(command, args, overrides);
}

function run(command, args, overrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...env, ...overrides },
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
