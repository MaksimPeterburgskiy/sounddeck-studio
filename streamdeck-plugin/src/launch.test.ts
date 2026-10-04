import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { parseDiscovery } from "./discovery";
import { launchApp, LaunchThrottle } from "./launch";

describe("offline launch", () => {
  it("passes an argument array without a shell for macOS and executable launches", () => {
    const child = { once: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child);
    launchApp("/Applications/SoundDeck Studio.app", "darwin", spawn as never);
    expect(spawn).toHaveBeenLastCalledWith("/usr/bin/open", ["-g", "-a", "/Applications/SoundDeck Studio.app", "--args", "--sounddeck-external-launch"], { detached: true, stdio: "ignore" });
    launchApp("C:\\Program Files\\SoundDeck Studio.exe", "win32", spawn as never);
    expect(spawn).toHaveBeenLastCalledWith("C:\\Program Files\\SoundDeck Studio.exe", ["--sounddeck-external-launch"], { detached: true, stdio: "ignore" });
    expect(child.once).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.unref).toHaveBeenCalledTimes(2);
  });

  it("rejects relative paths, wrong extensions, control characters and unsupported platforms", () => {
    const spawn = vi.fn();
    for (const [file, platform] of [["calc", "win32"], ["C:\\Apps\\app.cmd", "win32"], ["\\app.exe", "win32"],
      ["Apps/SoundDeck.app", "darwin"], ["/usr/bin/open", "darwin"], ["/tmp/app.app\0", "darwin"], ["/tmp/app", "linux"]]) {
      expect(() => launchApp(file, platform as NodeJS.Platform, spawn as never)).toThrow("Invalid SoundDeck launcher path");
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("discovers and launches the portable executable after Electron's extracted executable is removed", async () => {
    const { launcherPath, createExternalControlBridge } = createRequire(import.meta.url)("../../electron/externalControl.cjs");
    const directory = await mkdtemp(path.join(os.tmpdir(), "portable-launch-"));
    const extracted = path.join(directory, "extracted.exe");
    const portable = "C:\\Users\\test\\Downloads\\SoundDeck Studio.exe";
    const bridge = createExternalControlBridge({ userData: directory, appVersion: "1", appPath: launcherPath(extracted, "win32", true, { PORTABLE_EXECUTABLE_FILE: portable }) });
    try {
      await writeFile(extracted, "temporary Electron executable");
      await bridge.start();
      await bridge.stop();
      await rm(extracted);
      const discovery = parseDiscovery(JSON.parse(await readFile(path.join(directory, "external-control.json"), "utf8")))!;
      expect(discovery.appPath).toBe(portable);
      const child = { once: vi.fn(), unref: vi.fn() };
      const spawn = vi.fn(() => child);
      launchApp(discovery.appPath, "win32", spawn as never);
      expect(spawn).toHaveBeenCalledWith(portable, ["--sounddeck-external-launch"], { detached: true, stdio: "ignore" });
      for (const invalid of ["relative.exe", "C:\\Apps\\app.cmd", "\\app.exe", "C:\\Apps\\bad\0.exe"]) {
        expect(launcherPath(extracted, "win32", true, { PORTABLE_EXECUTABLE_FILE: invalid })).toBe(extracted);
      }
    } finally {
      await bridge.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("throttles all presses for 30 seconds, including failed launch attempts", () => {
    let now = 0;
    const launch = vi.fn(() => { throw new Error("missing app"); });
    const throttle = new LaunchThrottle(launch, () => now);
    expect(throttle.attempt("app")).toBe(true);
    now = 29_999;
    expect(throttle.attempt("app")).toBe(false);
    now = 30_000;
    expect(throttle.attempt("new app")).toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
