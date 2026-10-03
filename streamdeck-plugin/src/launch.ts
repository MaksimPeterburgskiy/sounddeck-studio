import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import path from "node:path";

export const EXTERNAL_LAUNCH_ARGUMENT = "--sounddeck-external-launch";
type Spawn = (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, "once" | "unref">;

export function launchApp(appPath: string, platform: NodeJS.Platform = process.platform, spawnProcess: Spawn = spawn, onError: (error: Error) => void = () => {}): void {
  if (/[\x00-\x1f\x7f]/.test(appPath)
    || (platform === "darwin" ? !path.posix.isAbsolute(appPath) || !/\.app$/i.test(appPath)
      : platform === "win32" ? !path.win32.isAbsolute(appPath) || !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(appPath) || !/\.exe$/i.test(appPath) : true)) {
    throw new Error("Invalid SoundDeck launcher path");
  }
  const child = platform === "darwin"
    ? spawnProcess("/usr/bin/open", ["-g", "-a", appPath, "--args", EXTERNAL_LAUNCH_ARGUMENT], { detached: true, stdio: "ignore" })
    : spawnProcess(appPath, [EXTERNAL_LAUNCH_ARGUMENT], { detached: true, stdio: "ignore" });
  // Launch is best effort. A missing/moved executable must not crash the plugin.
  child.once("error", onError);
  child.unref();
}

export class LaunchThrottle {
  private lastLaunch = -Infinity;
  constructor(private readonly launch: (appPath: string) => void = launchApp, private readonly now: () => number = Date.now) {}
  attempt(appPath: string): boolean {
    if (this.now() - this.lastLaunch < 30_000) return false;
    this.lastLaunch = this.now();
    try { this.launch(appPath); } catch { /* Keep the same throttle for launch failures. */ }
    return true;
  }
}
