import { runStep } from "./spawn-command.mjs";

if (process.platform !== "win32") {
  throw new Error("Windows packaging requires Windows.");
}

const env = {
  ...process.env,
  SOUNDDECK_NATIVE_TOOLS_OFFLINE: "1"
};
for (const tokenName of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_RELEASE_TOKEN", "RELEASE_TOKEN"]) {
  delete env[tokenName];
}

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
  await runStep(command, args, { ...env, ...overrides });
}
