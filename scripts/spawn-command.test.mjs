import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveSpawnCommand } from "./spawn-command.mjs";

// The mapping itself is trivial; what can actually break is whether the shim we
// synthesise is one Windows will really execute.
test("the resolved Windows pnpm command executes the installed shim", {
  skip: process.platform !== "win32"
}, () => {
  const resolved = resolveSpawnCommand("pnpm", ["--version"]);
  const result = spawnSync(resolved.command, resolved.args, {
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("non-pnpm commands are spawned directly on Windows", () => {
  assert.deepEqual(
    resolveSpawnCommand("node", ["scripts/fetch-native-tools.mjs"], {
      platform: "win32",
      comSpec: "C:\\Windows\\System32\\cmd.exe"
    }),
    { command: "node", args: ["scripts/fetch-native-tools.mjs"] }
  );
});
