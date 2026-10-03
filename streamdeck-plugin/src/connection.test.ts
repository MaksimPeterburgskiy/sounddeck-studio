import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { Connection } from "./connection";
import { parseDiscovery, type DiscoveryFile } from "./discovery";

const { createExternalControlBridge } = createRequire(import.meta.url)("../../electron/externalControl.cjs");
const library = {
  boards: [{ id: "board-a", name: "Main", color: "#1db7a6", sounds: [{ id: "sound-a", title: "Horn", color: "#123456", image: "data:image/png;base64,aWNvbg==" }] }],
  settings: { micPassthrough: false, monitorToHeadphones: true },
};
const resources: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});
async function waitFor(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3000, interval: 10 });
}
async function realServer(options: { cooldownMs?: number } = {}) {
  const directory = await mkdtemp(path.join(process.cwd(), ".connection-test-"));
  resources.push(() => rm(directory, { recursive: true, force: true }));
  const upgrades: http.IncomingHttpHeaders[] = [];
  const command = vi.fn(() => ({ ok: true }));
  const bridge = createExternalControlBridge({
    userData: directory, appVersion: "0.1.22", appPath: "/Applications/SoundDeck Studio.app", defaultPort: 0,
    onCommand: command, ...options,
    createServer: (...args: Parameters<typeof http.createServer>) => {
      const server = http.createServer(...args);
      server.on("upgrade", (request) => upgrades.push(request.headers));
      return server;
    },
  });
  resources.push(() => bridge.stop());
  await bridge.start();
  bridge.updateLibrary(library);
  bridge.updateLiveState({ activeBoardId: "board-a", playback: [] });
  await bridge.setSettings({ enabled: true });
  const readDiscovery = async (): Promise<DiscoveryFile> => ({ path: directory, state: parseDiscovery(JSON.parse(await readFile(path.join(directory, "external-control.json"), "utf8"))) });
  const connection = new Connection("0.1.22", { discover: readDiscovery, retryMinMs: 20, retryMaxMs: 50 });
  resources.push(() => connection.stop());
  return { bridge, connection, readDiscovery, upgrades, command };
}

describe("shared connection", () => {
  it("authenticates with the real ephemeral server without Origin, models all events, and invalidates image cache", async () => {
    const { bridge, connection, upgrades, command } = await realServer();
    const changed = vi.fn();
    const unsubscribe = connection.subscribe(changed);
    connection.start();
    await waitFor(() => connection.status === "connected");
    expect(upgrades).toHaveLength(1);
    expect(Object.hasOwn(upgrades[0], "origin")).toBe(false);
    expect(upgrades[0].host).toBe(`127.0.0.1:${bridge.getState().port}`);
    expect(bridge.getState().clients).toEqual([{ name: "SoundDeck Stream Deck plugin", version: "0.1.22" }]);
    expect(connection.snapshot?.library.boards[0].name).toBe("Main");
    const first = connection.getImage("sound-a");
    expect(connection.getImage("sound-a")).toBe(first);
    expect(await first).toBe(library.boards[0].sounds[0].image);
    expect(connection.peekImage("sound-a")).toBe(library.boards[0].sounds[0].image);
    bridge.updateLibrary({ ...library, settings: { micPassthrough: true, monitorToHeadphones: false, micVirtualVolume: 0.4, micVirtualMuted: true }, boards: [{ ...library.boards[0], sounds: [{ ...library.boards[0].sounds[0], image: "data:image/png;base64,bmV3" }] }] });
    bridge.updateLiveState({ activeBoardId: "board-b", playback: [{ soundId: "sound-a", startedAt: 1000, duration: 2, loop: false }] });
    await waitFor(() => connection.snapshot?.settings.micPassthrough === true && connection.snapshot?.playback.length === 1);
    expect(connection.snapshot?.volumes.micVirtual).toEqual({ value: 0.4, muted: true });
    expect(connection.snapshot?.library.activeBoardId).toBe("board-b");
    expect(connection.peekImage("sound-a")).toBeUndefined();
    expect(await connection.getImage("sound-a")).toBe("data:image/png;base64,bmV3");
    expect((await connection.command("sound.play", { soundId: "sound-a" })).ok).toBe(true);
    expect(command).toHaveBeenCalledWith({ command: "sound.play", args: { soundId: "sound-a" } });
    expect(changed).toHaveBeenCalled();
    unsubscribe();
  });

  it("shows auth-error for a wrong token, rereads discovery, and reconnects after token regeneration", async () => {
    const { bridge, readDiscovery } = await realServer();
    let wrongToken = true;
    const reads = vi.fn(async () => {
      const file = await readDiscovery();
      return { ...file, state: { ...file.state!, token: wrongToken ? "wrong" : file.state!.token } };
    });
    const connection = new Connection("0.1.22", { discover: reads, retryMinMs: 40, retryMaxMs: 80 });
    resources.push(() => connection.stop());
    connection.start();
    await waitFor(() => connection.status === "auth-error");
    expect(connection.statusLabel).toBe("Re-pair");
    wrongToken = false;
    await waitFor(() => connection.status === "connected");
    const oldToken = bridge.getState().token;
    await bridge.regenerateToken();
    await waitFor(() => connection.status === "auth-error");
    await waitFor(() => connection.status === "connected");
    expect(bridge.getState().token).not.toBe(oldToken);
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps HTTP upgrade authentication cooldowns classified as auth-error", async () => {
    const { readDiscovery, upgrades } = await realServer({ cooldownMs: 700 });
    let wrongToken = true;
    const connection = new Connection("0.1.22", {
      discover: async () => {
        const file = await readDiscovery();
        return { ...file, state: { ...file.state!, token: wrongToken ? "wrong" : file.state!.token } };
      },
      retryMinMs: 20, retryMaxMs: 40,
    });
    resources.push(() => connection.stop());
    connection.start();
    await waitFor(() => upgrades.length >= 6);
    expect(connection.status).toBe("auth-error");
    wrongToken = false;
    const priorUpgrades = upgrades.length;
    await waitFor(() => upgrades.length > priorUpgrades);
    expect(connection.status).toBe("auth-error");
    await waitFor(() => connection.status === "connected");
  });

  it("does not resurrect a connection when discovery completes after stop", async () => {
    let complete!: (value: DiscoveryFile | null) => void;
    const read = vi.fn(() => new Promise<DiscoveryFile | null>((resolve) => { complete = resolve; }));
    const connection = new Connection("1", { discover: read });
    connection.start();
    connection.stop();
    complete({ path: "state", state: parseDiscovery({ enabled: true, protocol: 2, host: "127.0.0.1", port: 41730, token: "token", allowLan: false, appVersion: "1", appPath: "app" }) });
    await Promise.resolve();
    expect(connection.status).toBe("not-installed");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("classifies installation states, rereads using bounded exponential backoff, and launches only offline", async () => {
    vi.useFakeTimers();
    const base = { path: "state", state: parseDiscovery({ enabled: false, protocol: 1, host: "127.0.0.1", port: 41730, token: "token", allowLan: false, appVersion: "1", appPath: "app" })! };
    let file: DiscoveryFile | null = null;
    const read = vi.fn(async () => file);
    const launch = vi.fn();
    const connection = new Connection("1", { discover: read, launch });
    resources.push(() => connection.stop());
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.status).toBe("not-installed");
    connection.handleDisconnectedPress();
    file = base;
    await vi.advanceTimersByTimeAsync(500);
    expect(connection.status).toBe("disabled");
    connection.handleDisconnectedPress();
    file = { ...base, state: { ...base.state!, enabled: true, protocol: 2 } };
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.status).toBe("protocol-mismatch");
    expect(connection.statusLabel).toBe("Update plugin");
    connection.handleDisconnectedPress();
    expect(launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 10_000 + 10_000);
    expect(read).toHaveBeenCalledTimes(8);
    // An enabled installation with nothing listening is exercised below with a real refused port.
  });

  it("drops offline presses, throttles launch, then reconnects when the real app listener starts again", async () => {
    const launch = vi.fn();
    const stateFile = await realServer();
    stateFile.connection.stop();
    const offlineConnection = new Connection("0.1.22", { discover: stateFile.readDiscovery, launch, retryMinMs: 20, retryMaxMs: 50 });
    resources.push(() => offlineConnection.stop());
    await stateFile.bridge.stop(); // Discovery still records enabled=true, as on normal app exit.
    offlineConnection.start();
    await waitFor(() => offlineConnection.status === "offline");
    offlineConnection.handleDisconnectedPress();
    offlineConnection.handleDisconnectedPress();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith("/Applications/SoundDeck Studio.app");
    expect((await offlineConnection.command("playback.stopAll", {})).ok).toBe(false);
    await stateFile.bridge.start();
    await waitFor(() => offlineConnection.status === "connected");
    offlineConnection.handleDisconnectedPress();
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
