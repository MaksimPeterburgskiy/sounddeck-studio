import { spawn } from "node:child_process";

export function resolveSpawnCommand(command, args, {
  platform = process.platform,
  comSpec = process.env.ComSpec
} = {}) {
  if (platform === "win32" && command === "pnpm") {
    return {
      command: comSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", ...args]
    };
  }
  return { command, args };
}

// Runs one packaging step, inheriting stdio so build output streams through.
export function runStep(command, args, env) {
  return new Promise((resolve, reject) => {
    const resolved = resolveSpawnCommand(command, args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
      windowsHide: true
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
