import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";
import type { ControlCommand, ControlHello } from "../../src/lib/controlProtocol";
import { Connection, type ConnectionOptions } from "./connection";
import { SoundKeyPresses } from "./soundKeyPresses";
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
async function realServer(options: { cooldownMs?: number } = {}, distribution?: ConnectionOptions["distribution"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), ".connection-test-"));
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
  const connection = new Connection("0.1.22", { discover: readDiscovery, retryMinMs: 20, retryMaxMs: 50, distribution });
  resources.push(() => connection.stop());
  return { bridge, connection, readDiscovery, upgrades, command };
}

describe("shared connection", () => {
  it("falls back on a protocol-1 server without press support and probes again after reconnect", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    resources.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const commands = vi.fn((_message: ControlCommand) => {});
    let supportsPress = false;
    server.on("connection", (socket) => socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ControlHello | ControlCommand;
      if (message.type === "hello") {
        socket.send(JSON.stringify({
          type: "welcome", protocol: 1, app: { version: "0.1.22" },
          state: { library: { boards: [], activeBoardId: "" }, activeBoardId: "", playback: [] },
        }));
        return;
      }
      commands(message);
      // PR #116's validator returns unknown-command for sound.press/release.
      const unsupported = !supportsPress && (message.command === "sound.press" || message.command === "sound.release");
      socket.send(JSON.stringify({ type: "result", id: message.id, ok: !unsupported, ...(unsupported ? { code: "unknown-command" } : {}) }));
    }));
    const connection = new Connection("0.1.22", {
      discover: async () => ({ path: "state", state: parseDiscovery({
        enabled: true, protocol: 1, host: "127.0.0.1", port: (server.address() as { port: number }).port,
        token: "token", allowLan: false, appVersion: "0.1.22", appPath: "/Applications/SoundDeck Studio.app",
      }) }),
      retryMinMs: 20, retryMaxMs: 50,
    });
    resources.push(() => connection.stop());
    const keys = new SoundKeyPresses(connection);
    const otherKeys = new SoundKeyPresses(connection);
    const binding = { soundId: "sound-a", boardId: "board-a", title: "Horn" };
    connection.start();
    await waitFor(() => connection.status === "connected");
    expect((await keys.press("a", binding)).ok).toBe(true);
    await keys.release("a");
    expect((await keys.press("b", binding)).ok).toBe(true);
    await keys.release("b");
    expect((await otherKeys.press("c", binding)).ok).toBe(true);
    await otherKeys.release("c");
    expect(commands.mock.calls.map(([message]) => [message.command, message.args])).toEqual([
      ["sound.press", { ...binding, pressId: expect.any(String) }],
      ["sound.play", binding], ["sound.play", binding], ["sound.play", binding],
    ]);
    const session = connection.session;
    supportsPress = true;
    for (const socket of server.clients) socket.terminate();
    await waitFor(() => connection.session !== null && connection.session !== session);
    expect((await keys.press("a", binding)).ok).toBe(true);
    await keys.release("a");
    const press = commands.mock.calls[4][0];
    expect(press.command).toBe("sound.press");
    expect(commands.mock.calls[5][0]).toMatchObject({ command: "sound.release", args: { pressId: (press.args as { pressId: string }).pressId } });
    expect(commands).toHaveBeenCalledTimes(6);
  });

  it.each(["github", "marketplace"] as const)("reports the build distribution %s to the server", async (distribution) => {
    const { bridge, connection } = await realServer({}, distribution);
    connection.start();
    await waitFor(() => connection.status === "connected");
    expect(bridge.getState().clients).toEqual([{ name: "SoundDeck Stream Deck plugin", version: "0.1.22", distribution }]);
  });

  it("releases held keys on socket closure and sends no stale releases after reconnect", async () => {
    const { bridge, connection, command } = await realServer();
    const keys = new SoundKeyPresses(connection);
    connection.start();
    await waitFor(() => connection.status === "connected");
    const session = connection.session;
    await keys.press("a", { soundId: "sound-a" });
    await keys.press("b", { soundId: "sound-a" });
    const ids = command.mock.calls.map(([message]) => (message as unknown as { args: { pressId: string } }).args.pressId);
    expect(ids[0]).not.toBe(ids[1]);
    await bridge.regenerateToken();
    await waitFor(() => connection.session !== null && connection.session !== session);
    expect(command.mock.calls.slice(2).map(([message]) => message)).toEqual(ids.map((pressId) => ({ command: "sound.release", args: { pressId } })));
    await keys.release("a");
    await keys.release("b");
    expect(command).toHaveBeenCalledTimes(4);
    await keys.press("a", { soundId: "sound-a" });
    await keys.release("a");
    expect(command).toHaveBeenCalledTimes(6);
  });

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
    expect(command).toHaveBeenCalledWith({ command: "sound.play", args: { soundId: "sound-a" } }, expect.any(AbortSignal));
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
    const oldSession = connection.session;
    expect(oldSession).not.toBeNull();
    const oldToken = bridge.getState().token;
    await bridge.regenerateToken();
    await waitFor(() => connection.status === "auth-error");
    await waitFor(() => connection.status === "connected");
    expect(bridge.getState().token).not.toBe(oldToken);
    expect(connection.session).not.toBeNull();
    expect(connection.session).not.toBe(oldSession);
    connection.stop();
    expect(connection.session).toBeNull();
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps HTTP upgrade authentication cooldowns classified as auth-error", async () => {
    const { readDiscovery, upgrades } = await realServer({ cooldownMs: 1500 });
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
    // Status is briefly "offline" between attempts, so wait for the classification rather than sampling it.
    await waitFor(() => upgrades.length >= 6 && connection.status === "auth-error");
    wrongToken = false;
    const priorUpgrades = upgrades.length;
    await waitFor(() => upgrades.length > priorUpgrades && connection.status === "auth-error");
    await waitFor(() => connection.status === "connected");
  });

  it("recovers from auth-error when the unchanged listener stops, launching only on throttled presses", async () => {
    const { bridge, readDiscovery, upgrades } = await realServer({ cooldownMs: 1500 });
    const file = await readDiscovery();
    const staleFile = { ...file, state: { ...file.state!, token: "wrong" } };
    const reads = vi.fn(async () => staleFile);
    const launch = vi.fn();
    let now = 0;
    const connection = new Connection("0.1.22", { discover: reads, launch, now: () => now, retryMinMs: 20, retryMaxMs: 40 });
    resources.push(() => connection.stop());
    connection.start();
    await waitFor(() => upgrades.length >= 6 && connection.status === "auth-error");
    connection.handleDisconnectedPress();
    expect(launch).not.toHaveBeenCalled();
    await bridge.stop();
    await waitFor(() => connection.status === "offline");
    expect(connection.statusLabel).toBe("Offline");
    const priorReads = reads.mock.calls.length;
    await waitFor(() => reads.mock.calls.length >= priorReads + 3);
    expect(connection.status).toBe("offline");
    expect(launch).not.toHaveBeenCalled();
    connection.handleDisconnectedPress();
    connection.handleDisconnectedPress();
    now = 29_999;
    connection.handleDisconnectedPress();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(file.state!.appPath);
    now = 30_000;
    connection.handleDisconnectedPress();
    expect(launch).toHaveBeenCalledTimes(2);
    expect((await connection.command("playback.stopAll", {})).ok).toBe(false);
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

  it("classifies missing and disabled installations and rereads using bounded exponential backoff without launching", async () => {
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
    // A disabled installation still needs a protocol update, but cannot launch.
    file = { ...base, state: { ...base.state!, protocol: 2 } };
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.status).toBe("disabled");
    connection.handleDisconnectedPress();
    expect(launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 10_000 + 10_000);
    expect(read).toHaveBeenCalledTimes(8);
    // An enabled installation with nothing listening is exercised below with a real refused port.
  });

  it("launches on a press when stale protocol metadata has no listener, throttles presses, and refreshes after launch", async () => {
    const { bridge, readDiscovery } = await realServer();
    await bridge.stop();
    const file = await readDiscovery();
    await writeFile(path.join(file.path, "external-control.json"), JSON.stringify({ ...file.state!, protocol: 2, appVersion: "0.1.21" }));
    const reads = vi.fn(readDiscovery);
    const launch = vi.fn();
    let now = 0;
    const connection = new Connection("0.1.22", { discover: reads, launch, now: () => now, retryMinMs: 40, retryMaxMs: 80 });
    resources.push(() => connection.stop());
    connection.start();
    await waitFor(() => reads.mock.calls.length >= 2 && connection.status === "offline");
    expect(connection.statusLabel).toBe("Offline");
    expect(launch).not.toHaveBeenCalled();
    await waitFor(() => {
      connection.handleDisconnectedPress();
      return launch.mock.calls.length === 1;
    });
    expect(launch).toHaveBeenCalledWith("/Applications/SoundDeck Studio.app");
    connection.handleDisconnectedPress();
    now = 29_999;
    connection.handleDisconnectedPress();
    expect(launch).toHaveBeenCalledTimes(1);
    expect((await connection.command("playback.stopAll", {})).ok).toBe(false);
    now = 30_000;
    await waitFor(() => {
      connection.handleDisconnectedPress();
      return launch.mock.calls.length === 2;
    });
    // A fresh process rewrites the discovery file with its current protocol.
    const relaunched = createExternalControlBridge({ userData: file.path, appVersion: "0.1.22", appPath: file.state!.appPath });
    resources.push(() => relaunched.stop());
    await relaunched.start();
    await waitFor(() => connection.status === "connected");
    expect((await readDiscovery()).state?.protocol).toBe(1);
    connection.handleDisconnectedPress();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("connects to a compatible listener even when the persisted protocol is stale", async () => {
    const { readDiscovery } = await realServer();
    const launch = vi.fn();
    const connection = new Connection("0.1.22", {
      discover: async () => {
        const file = await readDiscovery();
        return { ...file, state: { ...file.state!, protocol: 2 } };
      },
      launch, retryMinMs: 20, retryMaxMs: 50,
    });
    resources.push(() => connection.stop());
    connection.start();
    await waitFor(() => connection.status === "connected");
    connection.handleDisconnectedPress();
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not launch or loop when a live listener confirms a protocol mismatch", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    resources.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const hello = vi.fn();
    server.on("connection", (socket) => socket.on("message", () => {
      hello();
      socket.send(JSON.stringify({ type: "error", code: "protocol-mismatch", protocol: 2 }));
    }));
    const launch = vi.fn();
    const connection = new Connection("0.1.22", {
      discover: async () => ({ path: "state", state: parseDiscovery({
        enabled: true, protocol: 2, host: "127.0.0.1", port: (server.address() as { port: number }).port,
        token: "token", allowLan: false, appVersion: "0.1.22", appPath: "/Applications/SoundDeck Studio.app",
      }) }),
      launch, retryMinMs: 20, retryMaxMs: 50,
    });
    resources.push(() => connection.stop());
    connection.start();
    await waitFor(() => hello.mock.calls.length >= 2 && connection.status === "protocol-mismatch");
    connection.handleDisconnectedPress();
    connection.handleDisconnectedPress();
    expect(launch).not.toHaveBeenCalled();
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
