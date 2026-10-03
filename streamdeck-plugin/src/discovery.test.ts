import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discover, discoveryPaths, discoveryStatus, parseDiscovery, protocolLabel } from "./discovery";

const state = { enabled: true, protocol: 1, host: "127.0.0.1", port: 41730, token: "token", allowLan: false, appVersion: "1.0", appPath: "/Applications/SoundDeck Studio.app" };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("discovery", () => {
  it("checks both Electron application names in native platform paths", () => {
    expect(discoveryPaths({ platform: "darwin", home: "/Users/test", env: {} })).toEqual([
      "/Users/test/Library/Application Support/sounddeck-studio/external-control.json",
      "/Users/test/Library/Application Support/SoundDeck Studio/external-control.json",
    ]);
    expect(discoveryPaths({ platform: "win32", home: "C:\\Users\\test", env: { APPDATA: "C:\\Roaming" } })[1]).toBe("C:\\Roaming\\SoundDeck Studio\\external-control.json");
    expect(discoveryPaths({ platform: "linux", home: "/home/test", env: { XDG_CONFIG_HOME: "/config" } })[0]).toBe("/config/sounddeck-studio/external-control.json");
    expect(discoveryPaths({ platform: "linux", home: "/home/test", env: {} })[0]).toBe("/home/test/.config/sounddeck-studio/external-control.json");
  });

  it("selects the newest file and does not fall back to an old token if it becomes malformed", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), ".discovery-test-"));
    directories.push(home);
    const options = { platform: "linux" as const, home, env: {} };
    expect(await discover(options)).toBeNull();
    const files = discoveryPaths(options);
    await Promise.all(files.map(async (file, index) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ ...state, token: `token-${index}` }));
      await utimes(file, 100 + index, 100 + index);
    }));
    expect((await discover(options))?.state?.token).toBe("token-1");
    await writeFile(files[1], "{broken");
    expect(await discover(options)).toEqual({ path: files[1], state: null });
  });

  it("classifies disabled, missing, malformed, and version-mismatched installations", () => {
    const parsed = parseDiscovery(state)!;
    expect(parsed).toEqual(state);
    expect(parseDiscovery({ ...state, port: -1 })).toBeNull();
    expect(parseDiscovery({ ...state, appPath: "bad\0path" })).toBeNull();
    expect(discoveryStatus(null)).toBe("not-installed");
    expect(discoveryStatus({ path: "state", state: null })).toBe("offline");
    expect(discoveryStatus({ path: "state", state: { ...parsed, enabled: false } })).toBe("disabled");
    expect(discoveryStatus({ path: "state", state: parsed })).toBe("offline");
    expect(discoveryStatus({ path: "state", state: { ...parsed, protocol: 2 } })).toBe("protocol-mismatch");
    expect(protocolLabel(2)).toBe("Update\nplugin");
    expect(protocolLabel(0)).toBe("Update\napp");
  });
});
