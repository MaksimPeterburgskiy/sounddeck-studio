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
