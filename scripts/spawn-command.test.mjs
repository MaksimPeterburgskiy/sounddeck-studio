import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveSpawnCommand } from "./spawn-command.mjs";

test("Windows pnpm commands use the CMD shim", () => {
  assert.deepEqual(
    resolveSpawnCommand("pnpm", ["run", "build"], {
      platform: "win32",
      comSpec: "C:\\Windows\\System32\\cmd.exe"
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", "run", "build"]
    }
  );
});

test("native executables are spawned directly", () => {
  assert.deepEqual(
    resolveSpawnCommand("node", ["scripts/fetch-native-tools.mjs"], {
      platform: "win32",
      comSpec: "C:\\Windows\\System32\\cmd.exe"
    }),
    {
      command: "node",
      args: ["scripts/fetch-native-tools.mjs"]
    }
  );
});

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
