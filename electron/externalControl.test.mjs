import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Duplex } from "node:stream";
import { mkdtemp, readFile, writeFile, chmod, stat, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import controlModule from "./externalControl.cjs";
import rendererModule from "./controlRenderer.cjs";
import { createControlCancellation } from "../src/lib/controlCancellation.ts";
import { createAudioControlQueue } from "../src/lib/audioControlQueue.ts";
import { SoundTriggers } from "../src/lib/soundTriggers.ts";
import { deferred, makeSound } from "../src/lib/testing/webAudioFakes.ts";
import { CONTROL_PROTOCOL_VERSION, CONTROL_DEFAULT_PORT } from "../src/lib/controlProtocol.ts";

const { createExternalControlBridge, launcherPath, PROTOCOL_VERSION, DEFAULT_PORT, MAX_IMAGE_DATA_BYTES, HTTP_PRESS_TIMEOUT_MS } = controlModule;
// Use real HTTP/WS parsers over in-memory sockets so the suite also runs in
// sandboxes that disallow loopback listeners.
const listeners = new Map();
let nextPort = 42000;
class MemorySocket extends Duplex {
  remoteAddress = "127.0.0.1";
  _read() {}
  _write(chunk, _encoding, callback) { this.peer.push(Buffer.from(chunk)); callback(); }
  _final(callback) { this.peer.push(null); callback(); }
  _destroy(error, callback) { this.peer?.destroy(); callback(error); }
  setTimeout(ms) { this.timeoutMs = ms; return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
}

function memoryServer(...args) {
  const server = http.createServer(...args);
  let address = null;
  Object.defineProperty(server, "listening", { get: () => address !== null });
  server.address = () => address;
  server.listen = (port, host, callback) => {
    const assignedPort = port || nextPort++;
    queueMicrotask(() => {
      if (listeners.has(assignedPort)) {
        server.emit("error", Object.assign(new Error("Port in use"), { code: "EADDRINUSE" }));
      } else {
        address = { port: assignedPort, address: host, family: "IPv4" };
        listeners.set(assignedPort, server);
        server.emit("listening");
        callback?.();
      }
    });
    return server;
  };
  server.close = (callback) => {
    if (address) listeners.delete(address.port);
    address = null;
    queueMicrotask(() => { server.emit("close"); callback?.(); });
    return server;
  };
  return server;
}

function memoryConnect(options) {
  const socket = new MemorySocket();
  const peer = new MemorySocket();
  socket.peer = peer;
  peer.peer = socket;
  peer.remoteAddress = options.remoteAddress || "127.0.0.1";
  queueMicrotask(() => {
    const server = listeners.get(Number(options.port));
    if (!server) {
      socket.destroy(Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" }));
      return;
    }
    server.emit("connection", peer);
    socket.emit("connect");
  });
  return socket;
}

let directory;
let bridge;
let onCommand;
const sockets = new Set();
const extraServers = new Set();
const icon = "data:image/png;base64,aWNvbg==";
const audioSettings = {
  micPassthrough: false, soundboardToVirtualMic: false, noiseSuppressionEnabled: false,
  echoCancellationEnabled: false, monitorToHeadphones: true,
  micVirtualVolume: 1, micMonitorVolume: 1, soundboardVirtualVolume: 1, soundboardMonitorVolume: 1,
  micVirtualMuted: false, micMonitorMuted: false, soundboardVirtualMuted: false, soundboardMonitorMuted: false
};
const library = {
  activeBoardId: "board-a",
  settings: audioSettings,
  boards: [
    { id: "board-a", name: "Main", color: "#123456", sounds: [{ id: "sound-new", title: "Airhorn", color: "#654321", image: icon, mediaPath: "/private/media.wav" }] },
    { id: "board-b", name: "Other", color: "#abcdef", sounds: [{ id: "sound-other", title: "Airhorn", color: "#000000" }] }
  ]
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "sounddeck-control-"));
  onCommand = vi.fn(() => ({ ok: true }));
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await bridge?.stop();
  vi.useRealTimers();
  bridge = undefined;
  for (const server of extraServers) await new Promise((resolve) => server.close(resolve));
  extraServers.clear();
  await rm(directory, { recursive: true, force: true });
});

async function create(options = {}, enabled = true, populate = true) {
  bridge = createExternalControlBridge({ userData: directory, appVersion: "0.1.22", appPath: "/Applications/SoundDeck Studio.app", defaultPort: 0, onCommand, createServer: memoryServer, ...options });
  await bridge.start();
  if (populate) {
    bridge.updateLibrary(library);
    bridge.updateLiveState({ activeBoardId: "board-a", playback: [] });
  }
  if (enabled) await bridge.setSettings({ enabled: true });
  return bridge.getState();
}

function request(url = "/v1/state", { method = "GET", headers = {}, body, raw, authorize = true, address = "127.0.0.1", chunked = false } = {}) {
  const state = bridge.getState();
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ createConnection: (options) => memoryConnect({ ...options, remoteAddress: address }), hostname: "127.0.0.1", port: state.port, path: url, method,
      headers: { ...(authorize ? { Authorization: `Bearer ${state.token}` } : {}), ...(payload === undefined ? {} : { "Content-Type": "application/json", ...(chunked ? { "Transfer-Encoding": "chunked" } : { "Content-Length": Buffer.byteLength(payload) }) }), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function client(options = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.getState().port}/`, { createConnection: memoryConnect, ...options });
  sockets.add(ws);
  const messages = [];
  const waiting = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (waiting.length) waiting.shift()(message);
    else messages.push(message);
  });
  ws.on("error", () => {});
  const closed = new Promise((resolve) => ws.once("close", resolve));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return {
    ws, closed,
    next: () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No control message received")), 1500);
      waiting.push((message) => { clearTimeout(timer); resolve(message); });
    }),
    send: (message) => ws.send(JSON.stringify(message))
  };
}

function hello(overrides = {}) {
  return { type: "hello", protocol: 1, token: bridge.getState().token, client: { name: "Test client", version: "1.2.3" }, ...overrides };
}

async function session() {
  const connection = await client();
  connection.send(hello());
  expect((await connection.next()).type).toBe("welcome");
  return connection;
}

function upgradeStatus(headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.getState().port}/`, { createConnection: memoryConnect, headers });
    sockets.add(ws);
    ws.on("unexpected-response", (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.on("error", reject);
    ws.on("open", () => { ws.terminate(); reject(new Error("Upgrade unexpectedly accepted")); });
  });
}

describe("external control discovery and listener", () => {
  it("preserves renderer playback received while the startup library load is pending", async () => {
    await create({}, true, false);
    await bridge.stop();
    let finishLoading;
    const startup = bridge.start(() => new Promise((resolve) => { finishLoading = resolve; }));
    await vi.waitFor(() => expect(finishLoading).toBeTypeOf("function"));
    const playback = [{ soundId: "sound-new", startedAt: 123, duration: 10, loop: true }];
    bridge.updateLiveState({ playback });
    finishLoading(library);
    expect(await startup).toMatchObject({ listening: true, error: null });
    expect(bridge.getSnapshot().playback).toEqual(playback);
    expect((await request()).body.playback).toEqual(playback);
    const connection = await client();
    connection.send(hello());
    expect(await connection.next()).toMatchObject({ type: "welcome", state: { playback, activeBoardId: "board-a", library: { boards: [{ id: "board-a" }, { id: "board-b" }] } } });
    connection.send({ type: "command", id: "play", command: "sound.play", args: { soundId: "sound-new" } });
    expect(await connection.next()).toMatchObject({ type: "result", id: "play", ok: true });
  });

  it.each(["library", "live"])("preserves newer %s state when the startup library load finishes", async (kind) => {
    await create({}, true, false);
    await bridge.stop();
    let finish;
    const startup = bridge.start(() => new Promise((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    if (kind === "library") bridge.updateLibrary({ ...library, activeBoardId: "board-b", boards: [library.boards[1]] });
    else bridge.updateLiveState({ activeBoardId: "board-b", playback: [] });
    finish(library);
    await startup;
    expect((await request()).body.activeBoardId).toBe("board-b");
    expect((await request("/v1/library")).body.boards).toHaveLength(kind === "library" ? 1 : 2);
  });

  it("rejects older generations and obsolete documents for library and live state", async () => {
    await create();
    bridge.setDocument("old");
    const oldLibrary = bridge.beginUpdate("old");
    const oldLive = bridge.beginUpdate("old");
    bridge.setDocument("new");
    const earlier = bridge.beginUpdate("new");
    bridge.updateLibrary({ ...library, activeBoardId: "board-b", boards: [library.boards[1]] }, bridge.beginUpdate("new"));
    const playback = [{ soundId: "sound-other", startedAt: 1, duration: 2, loop: false }];
    bridge.updateLiveState({ playback }, bridge.beginUpdate("new"));
    bridge.updateLibrary(library, oldLibrary);
    bridge.updateLiveState({ activeBoardId: "board-a", playback: [] }, oldLive);
    bridge.updateLibrary(library, earlier);
    bridge.updateLiveState({ playback: [] }, earlier);
    expect((await request()).body).toMatchObject({ activeBoardId: "board-b", playback });
    expect((await request("/v1/library")).body.boards.map((board) => board.id)).toEqual(["board-b"]);
  });

  it("accepts pending playback after a newer library update without reverting its active board", async () => {
    await create();
    const pendingLive = bridge.beginUpdate();
    bridge.updateLibrary({ ...library, activeBoardId: "board-b" });
    const playback = [{ soundId: "sound-other", startedAt: 1, duration: 2, loop: false }];
    bridge.updateLiveState({ activeBoardId: "board-a", playback }, pendingLive);
    expect((await request()).body).toMatchObject({ activeBoardId: "board-b", playback });
  });

  it("rejects stale audio snapshots without emitting settings or volume changes", async () => {
    await create();
    const connection = await session();
    bridge.setDocument("old");
    const old = bridge.beginUpdate("old");
    bridge.setDocument("new");
    const earlier = bridge.beginUpdate("new");
    const settings = { ...audioSettings, micPassthrough: true, micVirtualVolume: 0.3, micVirtualMuted: true, soundboardMonitorVolume: 2 };
    expect(bridge.updateLibrary({ ...library, settings }, bridge.beginUpdate("new"))).toBe(true);
    expect(await connection.next()).toMatchObject({ event: "settings.changed", data: { micPassthrough: true } });
    expect(await connection.next()).toMatchObject({ event: "volumes.changed", data: { micVirtual: { value: 0.3, muted: true }, soundboardMonitor: { value: 1 } } });
    expect(bridge.updateLibrary(library, old)).toBe(false);
    expect(bridge.updateLibrary(library, earlier)).toBe(false);
    connection.send({ type: "command", id: "after-stale-audio", command: "library.get", args: {} });
    expect(await connection.next()).toMatchObject({ type: "result", id: "after-stale-audio" });
    expect(bridge.getSnapshot()).toMatchObject({ settings: { micPassthrough: true }, volumes: { micVirtual: { value: 0.3, muted: true } } });
  });

  it("preserves an empty renderer library published before startup initialization finishes", async () => {
    let finish;
    bridge = createExternalControlBridge({ userData: directory, appVersion: "1", appPath: "app", createServer: memoryServer,
      fileSystem: { ...fs, readFile: () => new Promise((resolve) => { finish = resolve; }) } });
    const startup = bridge.start(async () => library);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    bridge.updateLibrary({ boards: [], activeBoardId: "" });
    finish("{}");
    await startup;
    expect(bridge.getSnapshot().library).toEqual({ boards: [], activeBoardId: "" });
  });

  it("ignores a failed obsolete startup read after the renderer supplies a newer library", async () => {
    await create({}, true, false);
    await bridge.stop();
    let fail;
    const startup = bridge.start(() => new Promise((_resolve, reject) => { fail = reject; }));
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    bridge.updateLibrary({ ...library, activeBoardId: "board-b" });
    fail(new Error("Obsolete disk read failed"));
    expect(await startup).toMatchObject({ listening: true, error: null });
    expect((await request()).body.activeBoardId).toBe("board-b");
  });

  it.each(["readFile", "mkdir", "writeFile", "chmod", "rename"])("reports initialization %s failures without rejecting or listening", async (method) => {
    if (method === "chmod" && process.platform === "win32") return;
    const onStateChange = vi.fn();
    const code = method === "readFile" ? "EISDIR" : method === "writeFile" ? "ENOSPC" : "EACCES";
    const fileSystem = { ...fs, [method]: vi.fn(async () => { throw Object.assign(new Error("private path"), { code }); }) };
    bridge = createExternalControlBridge({ userData: directory, appVersion: "1", appPath: "app", fileSystem, onStateChange });
    expect(await bridge.start()).toMatchObject({ listening: false, error: { code } });
    expect(onStateChange.mock.lastCall[0]).toMatchObject({ listening: false, error: { code } });
  });

  it.each(["setSettings", "regenerateToken"])("disables the listener on %s persistence failure and allows retry", async (operation) => {
    let fail = false;
    const fileSystem = { ...fs, rename: async (...args) => {
      if (fail) throw Object.assign(new Error("full disk"), { code: "ENOSPC" });
      return fs.rename(...args);
    } };
    const initial = await create({ fileSystem });
    const connection = await session();
    fail = true;
    expect(await bridge[operation]({ port: initial.port + 1 })).toMatchObject({ listening: false, error: { code: "ENOSPC" }, token: initial.token, port: initial.port });
    await connection.closed;
    fail = false;
    expect(await bridge.setSettings({ enabled: true })).toMatchObject({ listening: true, error: null });
  });

  it("contains corrupt library and invalid live-state initialization failures", async () => {
    await create({}, true, false);
    await bridge.stop();
    const file = path.join(directory, "library.json");
    await writeFile(file, "{corrupt");
    expect(await bridge.start(async () => JSON.parse(await readFile(file, "utf8")))).toMatchObject({ listening: false, error: { code: "initialization-error" } });
    expect(await readFile(file, "utf8")).toBe("{corrupt");
    expect(await bridge.start(async () => ({ ...library, activeBoardId: "invalid board id" }))).toMatchObject({ listening: false, error: { code: "initialization-error" } });
  });

  it("keeps disabled installations offline and persists only discovery settings with user-only permissions", async () => {
    const createServer = vi.fn(http.createServer);
    await create({ createServer, defaultPort: DEFAULT_PORT }, false);
    expect(createServer).not.toHaveBeenCalled();
    const saved = JSON.parse(await readFile(path.join(directory, "external-control.json"), "utf8"));
    expect(saved).toEqual({ enabled: false, protocol: 1, host: "127.0.0.1", port: 41730, token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), allowLan: false, appVersion: "0.1.22", appPath: "/Applications/SoundDeck Studio.app" });
    expect(Buffer.from(saved.token, "base64url")).toHaveLength(32);
    if (process.platform !== "win32") expect((await stat(path.join(directory, "external-control.json"))).mode & 0o777).toBe(0o600);
    expect(PROTOCOL_VERSION).toBe(CONTROL_PROTOCOL_VERSION);
    expect(DEFAULT_PORT).toBe(CONTROL_DEFAULT_PORT);
  });

  it("preserves the token across restarts, refreshes metadata and repairs permissive file modes", async () => {
    const initial = await create({}, false);
    const file = path.join(directory, "external-control.json");
    await chmod(file, 0o644);
    const saved = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...saved, appVersion: "old", host: "attacker.example" }));
    await bridge.stop();
    bridge = createExternalControlBridge({ userData: directory, appVersion: "new", appPath: "new.exe" });
    await bridge.start();
    expect(bridge.getState().token).toBe(initial.token);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ appVersion: "new", host: "127.0.0.1", appPath: "new.exe" });
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("binds loopback, changes host only with LAN opt-in, and releases the port when disabled", async () => {
    const listeners = [];
    await create({ createServer: (...args) => { const listener = memoryServer(...args); listeners.push(listener); return listener; } });
    expect(listeners.at(-1).address().address).toBe("127.0.0.1");
    await bridge.setSettings({ allowLan: true });
    expect(listeners.at(-1).address().address).toBe("0.0.0.0");
    expect(JSON.parse(await readFile(path.join(directory, "external-control.json"), "utf8"))).toMatchObject({ allowLan: true, enabled: true, host: "0.0.0.0" });
    expect((await request("/v1/state", { headers: { Host: "lan.example:1234" } })).status).toBe(200);
    await bridge.setSettings({ enabled: false });
    expect(bridge.getState().listening).toBe(false);
    await expect(request()).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("disconnects sessions when disabled and survives stop during asynchronous startup", async () => {
    await create();
    const connection = await session();
    await bridge.setSettings({ enabled: false });
    await connection.closed;
    expect(bridge.getState()).toMatchObject({ enabled: false, listening: false, clients: [] });
    await bridge.setSettings({ enabled: true });
    await bridge.stop();
    const createServer = vi.fn(memoryServer);
    bridge = createExternalControlBridge({ userData: directory, appVersion: "1", appPath: "app", createServer });
    const starting = bridge.start();
    await bridge.stop();
    await starting;
    expect(createServer).not.toHaveBeenCalled();
    expect(bridge.getState().listening).toBe(false);
  });

  it("rejects invalid settings and reports an occupied port without blocking disable or retry", async () => {
    await create();
    const initialPort = bridge.getState().port;
    for (const patch of [{ port: 0 }, { port: 65536 }, { port: 1.5 }, { enabled: "yes" }, { token: "override" }, { allowLan: 1 }]) {
      expect((await bridge.setSettings(patch)).error.code).toBe("invalid-settings");
      expect(bridge.getState().port).toBe(initialPort);
      expect(bridge.getState().listening).toBe(true);
    }
    const occupied = memoryServer();
    extraServers.add(occupied);
    await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    expect((await bridge.setSettings({ port: occupied.address().port })).error.code).toBe("EADDRINUSE");
    expect(bridge.getState().listening).toBe(false);
    expect((await bridge.setSettings({ enabled: false })).enabled).toBe(false);
    expect((await bridge.setSettings({ enabled: true, port: initialPort })).listening).toBe(true);
  });

  it("returns the packaged macOS bundle or the executable a launcher opens", () => {
    expect(launcherPath("/Applications/SoundDeck Studio.app/Contents/MacOS/SoundDeck Studio", "darwin", true)).toBe("/Applications/SoundDeck Studio.app");
    expect(launcherPath("C:\\Apps\\SoundDeck.exe", "win32", true)).toBe("C:\\Apps\\SoundDeck.exe");
    expect(launcherPath("/dev/Electron.app/Contents/MacOS/Electron", "darwin", false)).toBe("/dev/Electron.app/Contents/MacOS/Electron");
  });
});

describe("external control authentication", () => {
  it.each([
    ["Origin: https://evil.example", 403],
    ["Host: evil.example:41730", 403],
    ["", 404]
  ])("handles a connection reset while rejecting an upgrade with %s", async (header, status) => {
    let rejectedSocket;
    let response;
    await create({ createServer: (...args) => {
      const listener = memoryServer(...args);
      listener.on("connection", (socket) => {
        rejectedSocket = socket;
        socket._write = (chunk, _encoding, callback) => {
          response = chunk.toString();
          callback(Object.assign(new Error("Connection reset"), { code: "ECONNRESET" }));
        };
      });
      return listener;
    } });
    const port = bridge.getState().port;
    const socket = memoryConnect({ port });
    socket.on("error", () => {});
    const closed = new Promise((resolve) => socket.once("close", resolve));
    const host = header.startsWith("Host:") ? header : `Host: 127.0.0.1:${port}`;
    socket.write(`GET ${header ? "/" : "/invalid"} HTTP/1.1\r\n${host}\r\n${header.startsWith("Origin:") ? `${header}\r\n` : ""}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    await closed;
    expect(response).toContain(`HTTP/1.1 ${status}`);
    expect(rejectedSocket.destroyed).toBe(true);
    expect(bridge.getState()).toMatchObject({ listening: true, error: null });
  });

  it("rejects HTTP missing/bad tokens and any Origin, and enforces the exact local Host", async () => {
    await create();
    expect((await request("/v1/state", { authorize: false })).status).toBe(401);
    expect((await request("/v1/state", { headers: { Authorization: "Bearer wrong" } })).body.code).toBe("unauthorized");
    for (const Origin of ["https://evil.example", "null", ""]) expect((await request("/v1/state", { headers: { Origin } })).status).toBe(403);
    for (const Host of ["attacker.example:41730", "127.0.0.1", `127.0.0.1:${bridge.getState().port + 1}`]) expect((await request("/v1/state", { headers: { Host } })).status).toBe(403);
    expect((await request("/v1/state", { headers: { Host: `localhost:${bridge.getState().port}` } })).status).toBe(200);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("rejects browser and DNS-rebinding upgrades, including in LAN mode for Origin", async () => {
    await create();
    expect(await upgradeStatus({ Origin: "https://evil.example" })).toBe(403);
    expect(await upgradeStatus({ Origin: "" })).toBe(403);
    expect(await upgradeStatus({ Host: "evil.example:41730" })).toBe(403);
    await bridge.setSettings({ allowLan: true });
    expect(await upgradeStatus({ Origin: "null" })).toBe(403);
  });

  it.each([undefined, "github", "marketplace"])("accepts optional client distribution %s without changing protocol 1", async (distribution) => {
    await create();
    const connection = await client();
    const metadata = { name: "SoundDeck Stream Deck plugin", version: "0.1.21", ...(distribution ? { distribution } : {}) };
    connection.send(hello({ client: metadata }));
    expect(await connection.next()).toMatchObject({ type: "welcome", protocol: 1 });
    expect(bridge.getState().clients).toEqual([metadata]);
  });

  it.each([null, 1, {}, "", "other"])("rejects invalid client distribution %s", async (distribution) => {
    await create();
    const connection = await client();
    connection.send(hello({ client: { name: "client", version: "1", distribution } }));
    expect(await connection.next()).toMatchObject({ type: "error", code: "invalid-message" });
    await connection.closed;
    expect(bridge.getState().clients).toEqual([]);
  });

  it.each(["wrong", undefined])("rejects a hello with token %s", async (token) => {
    await create();
    const connection = await client();
    connection.send(hello({ token }));
    expect(await connection.next()).toMatchObject({ type: "error", code: "unauthorized", protocol: 1 });
    await connection.closed;
    expect(bridge.getState().clients).toEqual([]);
  });

  it("times out an unauthenticated WebSocket and never registers it", async () => {
    await create({ helloTimeoutMs: 30 });
    const connection = await client();
    expect(await connection.next()).toMatchObject({ code: "unauthorized" });
    await connection.closed;
    expect(bridge.getState().clients).toEqual([]);
  });

  it("throttles repeated auth failures across HTTP and WebSocket, then recovers after cooldown", async () => {
    let time = 1000;
    await create({ now: () => time });
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await request("/v1/state", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    const connection = await client();
    connection.send(hello({ token: "wrong" }));
    expect((await connection.next()).code).toBe("unauthorized");
    await connection.closed;
    expect((await request()).status).toBe(429);
    expect((await request("/v1/state", { headers: { "X-Forwarded-For": "192.168.1.2" } })).status).toBe(429);
    expect((await request("/v1/state", { address: "192.168.1.2" })).status).toBe(200);
    expect(await upgradeStatus({})).toBe(429);
    time += 30001;
    expect((await request()).status).toBe(200);
  });

  it("does not count missing credentials, malformed credential-free hellos or hello timeouts", async () => {
    await create({ helloTimeoutMs: 10 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      for (const Authorization of [undefined, "Bearer ", "Basic wrong"]) {
        expect((await request("/v1/state", { authorize: false, headers: Authorization === undefined ? {} : { Authorization } })).status).toBe(401);
      }
      for (const token of [undefined, ""]) {
        const connection = await client();
        connection.send(hello({ token, extra: true }));
        expect((await connection.next()).code).toBe("invalid-message");
        await connection.closed;
      }
      const timedOut = await client();
      expect((await timedOut.next()).code).toBe("unauthorized");
      await timedOut.closed;
    }
    expect((await request()).status).toBe(200);
    await session();
  });

  it("rotates the token, disconnects authenticated clients, and rejects the previous token", async () => {
    const initial = await create();
    const connection = await session();
    expect(bridge.getState().clients).toEqual([{ name: "Test client", version: "1.2.3" }]);
    const next = await bridge.regenerateToken();
    expect(next.token).not.toBe(initial.token);
    expect(next.clients).toEqual([]);
    await connection.closed;
    expect((await request("/v1/state", { headers: { Authorization: `Bearer ${initial.token}` } })).status).toBe(401);
    expect((await request()).status).toBe(200);
    expect(JSON.parse(await readFile(path.join(directory, "external-control.json"), "utf8")).token).toBe(next.token);
  });
});

describe("external control protocol and dispatch", () => {
  it("reports protocol mismatches with the server version, rejecting noninteger protocols", async () => {
    await create();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const connection = await client();
      connection.send({ type: "hello", protocol: 2, token: "wrong", future: true });
      expect(await connection.next()).toMatchObject({ type: "error", code: "protocol-mismatch", protocol: 1 });
      await connection.closed;
    }
    await session();
    const invalid = await client();
    invalid.send(hello({ protocol: 1.5 }));
    expect((await invalid.next()).code).toBe("invalid-message");
    expect((await request("/v2/state")).body).toMatchObject({ code: "protocol-mismatch", protocol: 1 });
  });

  it("returns a welcome snapshot and cached library/image without exposing paths or credentials", async () => {
    await create();
    const connection = await client();
    connection.send(hello());
    const welcome = await connection.next();
    expect(welcome).toMatchObject({ type: "welcome", protocol: 1, app: { version: "0.1.22" }, state: { activeBoardId: "board-a", playback: [] } });
    connection.send({ type: "command", id: "library", command: "library.get", args: {} });
    const result = await connection.next();
    expect(result).toMatchObject({ type: "result", id: "library", ok: true, data: { boards: [{ id: "board-a", sounds: [{ id: "sound-new", hasImage: true }] }, { id: "board-b" }] } });
    expect(result.data).toEqual((await request("/v1/library")).body);
    for (const forbidden of ["mediaPath", "/private/media.wav", "token", "imageKey", icon]) expect(JSON.stringify(welcome)).not.toContain(forbidden);
    connection.send({ type: "command", id: "image", command: "sound.image", args: { soundId: "sound-new" } });
    expect(await connection.next()).toMatchObject({ id: "image", ok: true, data: { image: icon } });
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("keeps ordinary libraries whole and bounds hostile summaries well below the plugin frame limit", async () => {
    await create();
    const ordinary = Array.from({ length: 5000 }, (_, index) => ({ id: `sound-${index}`, title: `Sound ${index}`, color: "#1db7a6" }));
    bridge.updateLibrary({ boards: [{ id: "board-a", name: "Main", color: "#1db7a6", sounds: ordinary }], activeBoardId: "board-a" });
    expect(bridge.getSnapshot().library.boards[0].sounds).toHaveLength(5000);
    // Escaped control characters take six JSON bytes per code unit.
    const large = "\u0000".repeat(1024);
    const sounds = Array.from({ length: 10000 }, (_, index) => ({ id: `sound-${index}`, title: large, color: large }));
    bridge.updateLibrary({ boards: [{ id: "board-a", name: large, color: large, sounds }], activeBoardId: "board-a" });
    const snapshot = bridge.getSnapshot();
    expect(snapshot.library.boards[0].name.length).toBe(256);
    expect(snapshot.library.boards[0].sounds[0].title.length).toBe(256);
    expect(snapshot.library.boards[0].color.length).toBeLessThanOrEqual(32);
    expect(snapshot.library.boards[0].sounds.length).toBeLessThan(10000);
    expect(Buffer.byteLength(JSON.stringify({ type: "welcome", protocol: 1, app: { version: "0.1.22" }, state: snapshot }))).toBeLessThan(9 * 1024 * 1024);
    bridge.updateLibrary({ boards: [{ id: "b".repeat(129), name: "invalid", sounds: [] },
      { id: "valid", name: "valid", sounds: [{ id: "s".repeat(129), title: "invalid" }] }] });
    expect(bridge.getSnapshot().library.boards).toEqual([{ id: "valid", name: "valid", color: "", sounds: [] }]);
  });

  it("preserves the actual active board when the summary budget omits it", async () => {
    await create();
    const connection = await session();
    const events = [];
    connection.ws.on("message", (data) => events.push(JSON.parse(data.toString())));
    const sounds = Array.from({ length: 10000 }, (_, index) => ({ id: `large-${index}`, title: "\u0000".repeat(256) }));
    bridge.updateLibrary({ ...library, boards: [{ id: "large", name: "Large", sounds }, ...library.boards] });
    const snapshot = bridge.getSnapshot();
    expect(snapshot.library.boards.some((board) => board.id === "board-a")).toBe(false);
    expect(snapshot.activeBoardId).toBe("board-a");
    expect(snapshot.library.activeBoardId).toBe("board-a");
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ event: "library.changed", data: { activeBoardId: "board-a" } });
  });

  it.each(["play", "press"])("marks capped summaries incomplete and avoids %s title fallback for omitted sound IDs", async (action) => {
    await create();
    const filler = Array.from({ length: 10000 }, (_, index) => ({ id: `large-${index}`, title: "\u0000".repeat(256) }));
    bridge.updateLibrary({ ...library, boards: [{ ...library.boards[0], sounds: [library.boards[0].sounds[0], ...filler,
      { id: "omitted", title: "Airhorn" }] }] });
    expect(bridge.getSnapshot().library.incomplete).toBe(true);
    expect((await request("/v1/library")).body.incomplete).toBe(true);
    const calls = onCommand.mock.calls.length;
    expect(await request(`/v1/sounds/omitted/${action}`, { method: "POST", body: { boardId: "board-a", title: "Airhorn" } }))
      .toMatchObject({ status: 404, body: { ok: false, code: "not-found" } });
    const connection = await client();
    connection.send(hello());
    expect((await connection.next()).state.library.incomplete).toBe(true);
    const pressArgs = action === "press" ? { pressId: "held" } : {};
    connection.send({ type: "command", id: "omitted", command: `sound.${action}`,
      args: { soundId: "omitted", boardId: "board-a", title: "Airhorn", ...pressArgs } });
    expect(await connection.next()).toMatchObject({ id: "omitted", ok: false, code: "not-found" });
    expect(onCommand).toHaveBeenCalledTimes(calls);
    expect((await request(`/v1/sounds/sound-new/${action}`, { method: "POST" })).body.ok).toBe(true);
    connection.send({ type: "command", id: "by-id", command: `sound.${action}`,
      args: { soundId: "sound-new", ...pressArgs } });
    expect(await connection.next()).toMatchObject({ id: "by-id", ok: true });
    bridge.updateLibrary(library);
    expect(bridge.getSnapshot().library.incomplete).toBeUndefined();
  });

  it.each(["sound.play", "sound.press"])("resolves %s bounded title fallback after reimport and rejects ambiguous truncated prefixes", async (command) => {
    await create();
    const prefix = "H".repeat(256);
    const board = { ...library.boards[0], name: "N".repeat(16 * 1024 * 1024), sounds: [{ ...library.boards[0].sounds[0], title: prefix + "first" }] };
    bridge.updateLibrary({ ...library, boards: [board] });
    const connection = await client({ maxPayload: 16 * 1024 * 1024 });
    connection.send(hello());
    const welcome = await connection.next();
    expect(welcome.state.library.boards[0].name).toHaveLength(256);
    expect(welcome.state.library.boards[0].sounds[0].title).toBe(prefix);
    const pressArgs = command === "sound.press" ? { pressId: "fallback" } : {};
    connection.send({ type: "command", id: "fallback", command, args: { soundId: "old-id", boardId: board.id, title: prefix, ...pressArgs } });
    expect(await connection.next()).toMatchObject({ id: "fallback", ok: true });
    expect(onCommand).toHaveBeenLastCalledWith({ command, args: { soundId: "sound-new", ...(command === "sound.press" && { pressId: expect.stringMatching(/^external-/) }) } }, expect.any(AbortSignal), expect.any(AbortSignal));
    bridge.updateLibrary({ ...library, boards: [{ ...board, sounds: [...board.sounds, { id: "collision", title: prefix + "second" }] }] });
    expect((await connection.next()).event).toBe("library.changed");
    const calls = onCommand.mock.calls.length;
    connection.send({ type: "command", id: "ambiguous", command, args: { soundId: "old-id", boardId: board.id, title: prefix, ...pressArgs } });
    expect(await connection.next()).toMatchObject({ id: "ambiguous", ok: false, code: "not-found" });
    expect(onCommand).toHaveBeenCalledTimes(calls);
    connection.send({ type: "command", id: "by-id", command, args: { soundId: "collision", ...(command === "sound.press" && { pressId: "by-id" }) } });
    expect(await connection.next()).toMatchObject({ id: "by-id", ok: true });
  });

  it.each([0, 1])("bounds encoded image data without closing the session (bytes above limit: %s)", async (extra) => {
    await create();
    const prefix = "data:image/png;base64,";
    const overhead = Buffer.byteLength(JSON.stringify({ image: prefix }));
    const image = prefix + "A".repeat(MAX_IMAGE_DATA_BYTES - overhead + extra);
    bridge.updateLibrary({ ...library, boards: [{ ...library.boards[0], sounds: [{ ...library.boards[0].sounds[0], image }] }] });
    const connection = await client({ maxPayload: 16 * 1024 * 1024 });
    connection.send(hello());
    expect((await connection.next()).type).toBe("welcome");
    connection.send({ type: "command", id: "image", command: "sound.image", args: { soundId: "sound-new" } });
    const result = await connection.next();
    if (extra) expect(result).toEqual({ type: "result", id: "image", ok: false, code: "payload-too-large" });
    else {
      expect(result.ok).toBe(true);
      expect(result.data.image === image).toBe(true);
    }
    connection.send({ type: "command", id: "play", command: "sound.play", args: { soundId: "sound-new" } });
    expect(await connection.next()).toEqual({ type: "result", id: "play", ok: true });
  });

  it("resolves sound id first, then exact board and title, and reports missing bindings", async () => {
    await create();
    const connection = await session();
    for (const [args, expected] of [
      [{ soundId: "sound-new", boardId: "board-b", title: "Airhorn" }, "sound-new"],
      [{ soundId: "removed-id", boardId: "board-a", title: "Airhorn" }, "sound-new"],
      [{ soundId: "removed-id", boardId: "board-b", title: "Airhorn" }, "sound-other"]
    ]) {
      connection.send({ type: "command", id: "play", command: "sound.play", args });
      expect(await connection.next()).toMatchObject({ id: "play", ok: true });
      expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.play", args: { soundId: expected } }, expect.any(AbortSignal), expect.any(AbortSignal));
    }
    connection.send({ type: "command", id: "missing", command: "sound.play", args: { soundId: "removed-id", boardId: "board-a", title: "airhorn" } });
    expect(await connection.next()).toMatchObject({ id: "missing", ok: false, code: "not-found" });
    expect(onCommand).toHaveBeenCalledTimes(3);
  });

  it("uses the same validated dispatch for HTTP play/stop/stop-all/activate/cycle", async () => {
    await create();
    for (const [url, body, expected] of [
      ["/v1/sounds/old-id/play", { boardId: "board-a", title: "Airhorn" }, { command: "sound.play", args: { soundId: "sound-new" } }],
      ["/v1/sounds/sound-new/stop", {}, { command: "sound.stop", args: { soundId: "sound-new" } }],
      ["/v1/stop-all", {}, { command: "playback.stopAll", args: {} }],
      ["/v1/boards/board-b/activate", {}, { command: "board.activate", args: { boardId: "board-b" } }],
      ["/v1/boards/cycle", { direction: -1 }, { command: "board.cycle", args: { direction: -1 } }],
      ["/v1/boards/cycle", {}, { command: "board.cycle", args: {} }]
    ]) {
      expect(await request(url, { method: "POST", body })).toMatchObject({ status: 200, body: { ok: true } });
      expect(onCommand).toHaveBeenLastCalledWith(expected, expect.any(AbortSignal), expect.any(AbortSignal));
    }
    expect((await request("/v1/sounds/missing/stop", { method: "POST" })).status).toBe(404);
    expect((await request("/v1/boards/missing/activate", { method: "POST" })).status).toBe(404);
  });

  it("scopes press ids to each WebSocket session and releases only the corresponding voice", async () => {
    await create();
    const first = await session();
    const second = await session();
    first.send({ type: "command", id: "press", command: "sound.press", args: { soundId: "removed-id", boardId: "board-a", title: "Airhorn", pressId: "same-key" } });
    expect(await first.next()).toMatchObject({ id: "press", ok: true });
    const firstPress = onCommand.mock.lastCall[0];
    expect(firstPress).toMatchObject({ command: "sound.press", args: { soundId: "sound-new", pressId: expect.stringMatching(/^external-/) } });
    second.send({ type: "command", id: "press", command: "sound.press", args: { soundId: "sound-other", pressId: "same-key" } });
    expect(await second.next()).toMatchObject({ id: "press", ok: true });
    const secondPress = onCommand.mock.lastCall[0];
    expect(secondPress.args.pressId).not.toBe(firstPress.args.pressId);
    first.send({ type: "command", id: "duplicate", command: "sound.press", args: { soundId: "sound-new", pressId: "same-key" } });
    expect(await first.next()).toMatchObject({ id: "duplicate", ok: false, code: "invalid-args" });
    first.send({ type: "command", id: "release", command: "sound.release", args: { pressId: "same-key" } });
    expect(await first.next()).toMatchObject({ id: "release", ok: true });
    expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: firstPress.args.pressId } }, undefined, undefined);
    const calls = onCommand.mock.calls.length;
    first.send({ type: "command", id: "unknown", command: "sound.release", args: { pressId: "same-key" } });
    expect(await first.next()).toMatchObject({ id: "unknown", ok: true });
    expect(onCommand).toHaveBeenCalledTimes(calls);
    second.ws.close();
    await second.closed;
    await vi.waitFor(() => expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: secondPress.args.pressId } }, undefined, undefined));
  });

  it("dispatches release before a pending press acknowledgement and cleans up disconnected clients", async () => {
    await create();
    const connection = await session();
    let acknowledge;
    onCommand.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    connection.send({ type: "command", id: "press", command: "sound.press", args: { soundId: "sound-new", pressId: "pending" } });
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    const internalId = onCommand.mock.calls[0][0].args.pressId;
    connection.send({ type: "command", id: "release", command: "sound.release", args: { pressId: "pending" } });
    expect(await connection.next()).toMatchObject({ id: "release", ok: true });
    expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: internalId } }, undefined, undefined);
    acknowledge({ ok: true });
    expect(await connection.next()).toMatchObject({ id: "press", ok: true });

    onCommand.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    connection.send({ type: "command", id: "disconnect", command: "sound.press", args: { soundId: "sound-new", pressId: "pending" } });
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(3));
    const disconnectedId = onCommand.mock.lastCall[0].args.pressId;
    connection.ws.close();
    await connection.closed;
    await vi.waitFor(() => expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: disconnectedId } }, undefined, undefined));
    acknowledge({ ok: true });
  });

  it("generates HTTP press ids, accepts releases across requests and expires abandoned presses", async () => {
    expect(HTTP_PRESS_TIMEOUT_MS).toBe(5 * 60 * 1000);
    await create({ httpPressTimeoutMs: 100 });
    const pressed = await request("/v1/sounds/old-id/press", { method: "POST", body: { boardId: "board-a", title: "Airhorn" } });
    expect(pressed).toEqual({ status: 200, body: { ok: true, data: { pressId: expect.stringMatching(/^[a-zA-Z0-9_-]+$/) } } });
    const internalId = onCommand.mock.lastCall[0].args.pressId;
    expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.press", args: { soundId: "sound-new", pressId: internalId } }, expect.any(AbortSignal), expect.any(AbortSignal));
    expect(await request(`/v1/presses/${pressed.body.data.pressId}/release`, { method: "POST" })).toEqual({ status: 200, body: { ok: true } });
    expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: internalId } }, undefined, undefined);
    const calls = onCommand.mock.calls.length;
    expect((await request(`/v1/presses/${pressed.body.data.pressId}/release`, { method: "POST" })).body).toEqual({ ok: true });
    expect(onCommand).toHaveBeenCalledTimes(calls);
    await request("/v1/sounds/sound-new/press", { method: "POST" });
    const abandonedId = onCommand.mock.lastCall[0].args.pressId;
    await vi.waitFor(() => expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: abandonedId } }, undefined, undefined));
  });

  it("releases HTTP presses when the response is abandoned before acknowledgement", async () => {
    await create();
    let acknowledge;
    onCommand.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    const state = bridge.getState();
    const req = http.request({ createConnection: memoryConnect, hostname: "127.0.0.1", port: state.port, path: "/v1/sounds/sound-new/press", method: "POST", headers: { Authorization: `Bearer ${state.token}` } });
    req.on("error", () => {});
    req.end();
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    const internalId = onCommand.mock.lastCall[0].args.pressId;
    const signal = onCommand.mock.lastCall[1];
    expect(signal.aborted).toBe(false);
    req.destroy();
    await vi.waitFor(() => expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: internalId } }, undefined, undefined));
    expect(signal.aborted).toBe(true);
    acknowledge({ ok: true });
  });

  it.each([false, true])("releases an acknowledged HTTP press on disconnect only before its response finishes (flushed: %s)", async (flushed) => {
    let response;
    let flushResponse;
    await create({ createServer: (...args) => {
      const server = memoryServer(...args);
      server.on("request", (_req, res) => {
        response = res;
        const socket = res.socket;
        const write = socket._write;
        socket._write = (chunk, encoding, callback) => {
          flushResponse = () => {
            socket._write = write;
            write.call(socket, chunk, encoding, callback);
          };
        };
      });
      return server;
    } });
    const state = bridge.getState();
    const req = http.request({ createConnection: memoryConnect, hostname: "127.0.0.1", port: state.port, path: "/v1/sounds/sound-new/press", method: "POST", headers: { Authorization: `Bearer ${state.token}` } });
    req.on("error", () => {});
    req.end();
    await vi.waitFor(() => expect(flushResponse).toBeTypeOf("function"));
    const internalId = onCommand.mock.lastCall[0].args.pressId;
    const signal = onCommand.mock.lastCall[1];
    expect(response.writableEnded).toBe(true);
    expect(response.writableFinished).toBe(false);
    expect(onCommand).toHaveBeenCalledTimes(1);
    if (flushed) {
      flushResponse();
      await vi.waitFor(() => expect(response.writableFinished).toBe(true));
    }
    req.destroy();
    await vi.waitFor(() => expect(response.destroyed).toBe(true));
    if (flushed) {
      expect(onCommand).toHaveBeenCalledTimes(1);
      expect(signal.aborted).toBe(false);
    } else {
      await vi.waitFor(() => expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: internalId } }, undefined, undefined));
      expect(signal.aborted).toBe(true);
    }
  });

  it("releases all held presses when the API is disabled or its token rotates", async () => {
    await create();
    const connection = await session();
    connection.send({ type: "command", id: "press", command: "sound.press", args: { soundId: "sound-new", pressId: "held" } });
    expect(await connection.next()).toMatchObject({ ok: true });
    await request("/v1/sounds/sound-other/press", { method: "POST" });
    const ids = onCommand.mock.calls.map(([message]) => message.args.pressId);
    await bridge.regenerateToken();
    expect(onCommand.mock.calls.filter(([message]) => message.command === "sound.release").map(([message]) => message.args.pressId).sort()).toEqual([...ids].sort());
    await request("/v1/sounds/sound-new/press", { method: "POST" });
    const disabledId = onCommand.mock.lastCall[0].args.pressId;
    await bridge.setSettings({ enabled: false });
    expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: disabledId } }, undefined, undefined);
    expect(onCommand.mock.calls.filter(([message]) => message.command === "sound.release")).toHaveLength(3);
  });

  it("forgets outgoing document presses and ignores late press failures after the same public id is reused", async () => {
    await create();
    bridge.setDocument("old-document");
    const connection = await session();
    let finish;
    onCommand.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const press = { command: "sound.press", args: { soundId: "sound-new", pressId: "key" } };
    connection.send({ type: "command", id: "old", ...press });
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    const oldId = onCommand.mock.lastCall[0].args.pressId;
    bridge.setDocument("new-document");
    expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: oldId } }, undefined, undefined);
    connection.send({ type: "command", id: "new", ...press });
    expect(await connection.next()).toMatchObject({ id: "new", ok: true });
    const newId = onCommand.mock.lastCall[0].args.pressId;
    expect(newId).not.toBe(oldId);
    finish({ ok: false, code: "unavailable" });
    expect(await connection.next()).toMatchObject({ id: "old", ok: false });
    expect(onCommand).toHaveBeenCalledTimes(3);
    connection.send({ type: "command", id: "up", command: "sound.release", args: { pressId: "key" } });
    expect(await connection.next()).toMatchObject({ id: "up", ok: true });
    expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: newId } }, undefined, undefined);
  });

  it.each(["sound.stop", "playback.stopAll"])("%s clears only the matching press ownership before later presses arrive", async (command) => {
    await create();
    const connection = await session();
    for (const [id, soundId] of [["a", "sound-new"], ["b", "sound-other"]]) {
      connection.send({ type: "command", id, command: "sound.press", args: { soundId, pressId: id } });
      expect(await connection.next()).toMatchObject({ ok: true });
    }
    const [a, b] = onCommand.mock.calls.map(([message]) => message.args.pressId);
    connection.send({ type: "command", id: "stop", command, args: command === "sound.stop" ? { soundId: "sound-new" } : {} });
    expect(await connection.next()).toMatchObject({ id: "stop", ok: true });
    const releases = onCommand.mock.calls.filter(([message]) => message.command === "sound.release").map(([message]) => message.args.pressId);
    expect(releases).toEqual(command === "sound.stop" ? [a] : [a, b]);
    connection.send({ type: "command", id: "later", command: "sound.press", args: { soundId: "sound-new", pressId: "a" } });
    expect(await connection.next()).toMatchObject({ id: "later", ok: true });
    const laterId = onCommand.mock.lastCall[0].args.pressId;
    expect(laterId).not.toBe(a);
    connection.send({ type: "command", id: "up", command: "sound.release", args: { pressId: "a" } });
    expect(await connection.next()).toMatchObject({ id: "up", ok: true });
    expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: laterId } }, undefined, undefined);
  });

  it.each(["play", "press"])("waits for %s results and reports unavailable routes over HTTP and WebSocket", async (operation) => {
    await create();
    const connection = await session();
    let finishPlayback;
    const playback = new Promise((resolve) => { finishPlayback = resolve; });
    onCommand.mockReturnValue(playback);
    const received = vi.fn();
    const httpResult = request(`/v1/sounds/sound-new/${operation}`, { method: "POST" }).then(received);
    connection.send({ type: "command", id: "route", command: `sound.${operation}`, args: { soundId: "sound-new", ...(operation === "press" && { pressId: "held" }) } });
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    expect(received).not.toHaveBeenCalled();
    finishPlayback({ ok: false, code: "unavailable" });
    await httpResult;
    expect(received).toHaveBeenCalledExactlyOnceWith({ status: 503, body: { ok: false, code: "unavailable" } });
    expect(await connection.next()).toEqual({ type: "result", id: "route", ok: false, code: "unavailable" });
  });

  it("shares WebSocket pending capacity across presses, plays and mutations without counting started holds", async () => {
    await create();
    const connection = await session();
    const completions = [];
    onCommand.mockImplementation(({ command }) => command === "sound.release"
      ? { ok: true }
      : new Promise((resolve) => { completions.push(resolve); }));
    const send = (id, command) => connection.send({ type: "command", id, command,
      args: command === "setting.toggle" ? { key: "micPassthrough" }
        : { soundId: "sound-new", ...(command === "sound.press" && { pressId: id }) } });
    try {
      for (let index = 0; index < 32; index += 1) {
        send(`pending-${index}`, index === 31 ? "setting.toggle" : index % 2 ? "sound.press" : "sound.play");
      }
      await vi.waitFor(() => expect(completions).toHaveLength(32));
      for (const command of ["sound.press", "sound.play", "setting.toggle"]) {
        send(`overflow-${command.replace(".", "-")}`, command);
        expect(await connection.next()).toMatchObject({ ok: false, code: "busy" });
      }
      expect(completions).toHaveLength(32);
      completions[1]({ ok: true });
      expect(await connection.next()).toMatchObject({ id: "pending-1", ok: true });
      send("replacement-press", "sound.press");
      await vi.waitFor(() => expect(completions).toHaveLength(33));
      completions[32]({ ok: true });
      expect(await connection.next()).toMatchObject({ id: "replacement-press", ok: true });
      send("replacement-play", "sound.play");
      await vi.waitFor(() => expect(completions).toHaveLength(34));
      expect(onCommand.mock.calls.some(([message]) => message.command === "sound.release")).toBe(false);
      completions[33]({ ok: true });
      expect(await connection.next()).toMatchObject({ id: "replacement-play", ok: true });
      connection.send({ type: "command", id: "release", command: "sound.release", args: { pressId: "pending-1" } });
      expect(await connection.next()).toMatchObject({ id: "release", ok: true });
      expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.release", args: { pressId: expect.stringMatching(/^external-/) } }, undefined, undefined);
    } finally {
      for (const complete of completions) complete({ ok: true });
    }
  });

  it("counts HTTP presses as pending commands and frees capacity after acknowledgement while held", async () => {
    await create();
    const completions = [];
    onCommand.mockImplementation(({ command }) => command === "sound.release"
      ? { ok: true }
      : new Promise((resolve) => { completions.push(resolve); }));
    const press = () => request("/v1/sounds/sound-new/press", { method: "POST" });
    const pending = Array.from({ length: 32 }, press);
    try {
      await vi.waitFor(() => expect(completions).toHaveLength(32));
      expect(await press()).toEqual({ status: 503, body: { ok: false, code: "busy" } });
      expect(await request("/v1/sounds/sound-new/play", { method: "POST" })).toEqual({ status: 503, body: { ok: false, code: "busy" } });
      completions[0]({ ok: true });
      expect(await pending[0]).toEqual({ status: 200, body: { ok: true, data: { pressId: expect.any(String) } } });
      const replacement = press();
      pending.push(replacement);
      await vi.waitFor(() => expect(completions).toHaveLength(33));
      expect(onCommand.mock.calls.some(([message]) => message.command === "sound.release")).toBe(false);
      completions[32]({ ok: true });
      expect((await replacement).status).toBe(200);
    } finally {
      for (const complete of completions) complete({ ok: true });
      await Promise.all(pending);
    }
  });

  it.each([
    ["sound.play", { soundId: "sound-new" }],
    ["setting.set", { key: "micPassthrough", value: true }],
    ["setting.toggle", { key: "micPassthrough" }],
    ["volume.set", { bus: "micVirtual", value: 0.5 }],
    ["volume.adjust", { bus: "micVirtual", delta: 0.1 }],
    ["volume.mute", { bus: "micVirtual" }]
  ])("bounds pending %s commands per WebSocket session and restores capacity after failure", async (command, args) => {
    await create();
    const connection = await session();
    const other = await session();
    const completions = [];
    onCommand.mockImplementation(() => new Promise((resolve) => { completions.push(resolve); }));
    const play = (client, id) => client.send({ type: "command", id, command, args });
    try {
      for (let index = 0; index < 32; index += 1) play(connection, `pending-${index}`);
      await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(32));
      for (const id of ["overflow-1", "overflow-2"]) {
        play(connection, id);
        expect(await connection.next()).toEqual({ type: "result", id, ok: false, code: "busy" });
      }
      expect(onCommand).toHaveBeenCalledTimes(32);
      expect(connection.ws.readyState).toBe(WebSocket.OPEN);
      play(other, "independent");
      await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(33));
      completions[32]({ ok: true });
      expect(await other.next()).toMatchObject({ id: "independent", ok: true });
      completions[0]({ ok: false, code: "unavailable" });
      expect(await connection.next()).toMatchObject({ id: "pending-0", ok: false, code: "unavailable" });
      play(connection, "replacement");
      await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(34));
      completions[33]({ ok: true });
      expect(await connection.next()).toMatchObject({ id: "replacement", ok: true });
    } finally {
      for (const complete of completions) complete({ ok: true });
    }
  });

  it.each([
    ["/v1/sounds/sound-new/play", {}],
    ["/v1/settings/micPassthrough", { value: true }],
    ["/v1/settings/micPassthrough", { toggle: true }],
    ["/v1/volumes/micVirtual", { value: 0.5 }],
    ["/v1/volumes/micVirtual", { delta: 0.1 }],
    ["/v1/volumes/micVirtual", { toggleMute: true }]
  ])("bounds HTTP %s commands per address across connections and restores capacity after dispatch errors (%j)", async (url, body) => {
    await create();
    const completions = [];
    onCommand.mockImplementation(() => new Promise((resolve, reject) => { completions.push({ resolve, reject }); }));
    const play = (address) => request(url, { method: "POST", body, address });
    const pending = Array.from({ length: 32 }, () => play());
    try {
      await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(32));
      for (let index = 0; index < 2; index += 1) {
        expect(await play()).toEqual({ status: 503, body: { ok: false, code: "busy" } });
      }
      expect(onCommand).toHaveBeenCalledTimes(32);
      expect((await request()).status).toBe(200);
      expect((await request("/v1/library")).status).toBe(200);
      const independent = play("127.0.0.2");
      pending.push(independent);
      await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(33));
      completions[32].resolve({ ok: true });
      expect(await independent).toEqual({ status: 200, body: { ok: true } });
      completions[0].reject(new Error("Playback failed"));
      expect(await pending[0]).toEqual({ status: 500, body: { ok: false, code: "internal-error" } });
      const replacement = play();
      pending.push(replacement);
      await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(34));
      completions[33].resolve({ ok: true });
      expect(await replacement).toEqual({ status: 200, body: { ok: true } });
    } finally {
      for (const complete of completions) complete.resolve({ ok: true });
      await Promise.all(pending);
    }
  });

  it("counts streaming HTTP bodies toward the address limit and releases aborted bodies", async () => {
    let listener;
    await create({ createServer: (...args) => { listener = memoryServer(...args); return listener; } });
    const incoming = [];
    listener.on("request", (req) => { incoming.push(req); });
    const state = bridge.getState();
    const streaming = Array.from({ length: 32 }, () => {
      const req = http.request({ createConnection: memoryConnect, hostname: "127.0.0.1", port: state.port,
        method: "POST", path: "/v1/sounds/sound-new/play", headers: { Authorization: `Bearer ${state.token}`, "Transfer-Encoding": "chunked" } });
      req.on("error", () => {});
      req.write("{");
      return req;
    });
    try {
      await vi.waitFor(() => expect(incoming).toHaveLength(32));
      expect(onCommand).not.toHaveBeenCalled();
      expect(await request("/v1/sounds/sound-new/play", { method: "POST" })).toEqual({ status: 503, body: { ok: false, code: "busy" } });
      const aborted = new Promise((resolve) => incoming[0].once("aborted", resolve));
      streaming[0].destroy();
      await aborted;
      expect(await request("/v1/sounds/sound-new/play", { method: "POST" })).toEqual({ status: 200, body: { ok: true } });
      expect(onCommand).toHaveBeenCalledOnce();
    } finally {
      for (const req of streaming) req.destroy();
    }
  });

  it.each([
    ["/v1/sounds/sound-new/play", {}],
    ["/v1/sounds/sound-new/press", {}],
    ["/v1/settings/micPassthrough", { toggle: true }],
    ["/v1/volumes/micVirtual", { delta: -0.1 }]
  ])("keeps fully received HTTP %s alive during dispatch and does not cancel a completed response", async (url, body) => {
    let listener;
    await create({ createServer: (...args) => { listener = memoryServer(...args); return listener; } });
    let socket;
    listener.once("request", (req) => { socket = req.socket; });
    let complete;
    onCommand.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const response = request(url, { method: "POST", body });
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    const signal = onCommand.mock.lastCall[1];
    expect(socket.timeoutMs).toBe(0);
    expect(signal.aborted).toBe(false);
    complete({ ok: true });
    expect(await response).toEqual({ status: 200, body: url.endsWith("/press") ? { ok: true, data: { pressId: expect.any(String) } } : { ok: true } });
    onCommand.mockImplementation(() => ({ ok: true }));
    socket.destroy();
    expect(signal.aborted).toBe(false);
  });

  it("cancels only the disconnected HTTP command and keeps another pending request alive", async () => {
    await create();
    const completions = [];
    onCommand.mockImplementation((_command, signal) => new Promise((resolve) => {
      completions.push(resolve);
      signal.addEventListener("abort", () => resolve({ ok: false, code: "unavailable" }), { once: true });
    }));
    const state = bridge.getState();
    const disconnected = http.request({ createConnection: memoryConnect, hostname: "127.0.0.1", port: state.port,
      method: "POST", path: "/v1/sounds/sound-new/play", headers: { Authorization: `Bearer ${state.token}` } });
    disconnected.on("error", () => {});
    disconnected.end();
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledOnce());
    const other = request("/v1/sounds/sound-new/play", { method: "POST" });
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    disconnected.destroy();
    await vi.waitFor(() => expect(onCommand.mock.calls[0][1].aborted).toBe(true));
    expect(onCommand.mock.calls[1][1].aborted).toBe(false);
    completions[1]({ ok: true });
    expect((await other).body).toEqual({ ok: true });
  });

  it.each([
    ...["disconnect", "token", "disable", "port", "LAN", "stop"].map((reason) => ["HTTP", reason]),
    ...["disconnect", "token", "disable", "port", "LAN", "stop", "invalid-message", "backpressure", "socket-error"].map((reason) => ["WebSocket", reason])
  ])("cancels queued %s mutations on %s while applied mutations finish", async (transport, reason) => {
    let settings = { ...audioSettings };
    let finishSave;
    const saving = new Promise((resolve) => { finishSave = resolve; });
    const persisted = [];
    const requests = new Map();
    const completed = [];
    const queue = createAudioControlQueue({
      getSettings: () => settings,
      writeSettings: (next) => { settings = next; },
      persist: async () => {
        persisted.push(settings.micVirtualVolume);
        if (persisted.length === 1) await saving;
      },
      waitForConfiguration: async () => {}
    });
    const renderer = rendererModule.createControlRenderer({ send: (message) => {
      if (message.command === "control.cancel") {
        requests.get(message.requestId)?.abort();
        return;
      }
      const cancellation = new AbortController();
      requests.set(message.requestId, cancellation);
      renderer.receive(message.requestId);
      void queue.enqueue(message, cancellation.signal).then((result) => {
        requests.delete(message.requestId);
        completed.push(result);
        renderer.complete(message.requestId, result);
      });
    } });
    onCommand.mockImplementation((command, signal) => renderer.dispatch(command, signal));
    let serverSocket;
    await create({ createWebSocketServer: (options) => {
      const server = new WebSocketServer(options);
      server.on("connection", (ws) => { serverSocket = ws; });
      return server;
    } });
    const disconnected = [];
    let connection;
    const submit = async (value) => {
      if (transport === "WebSocket") {
        connection ??= await session();
        connection.send({ type: "command", id: `volume-${value * 10}`, command: "volume.set", args: { bus: "micVirtual", value } });
      } else {
        const state = bridge.getState();
        const req = http.request({ createConnection: memoryConnect, hostname: "127.0.0.1", port: state.port,
          method: "POST", path: "/v1/volumes/micVirtual", headers: { Authorization: `Bearer ${state.token}` } });
        req.on("error", () => {});
        req.end(JSON.stringify({ value }));
        disconnected.push(req);
      }
    };
    await submit(0.6);
    await vi.waitFor(() => expect(persisted).toEqual([0.6]));
    await submit(0.9);
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    let other;
    if (reason === "disconnect") {
      other = request("/v1/volumes/micVirtual", { method: "POST", body: { delta: 0.2 } });
      await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(3));
      if (connection) connection.ws.terminate();
      for (const req of disconnected) req.destroy();
    } else if (reason === "token") await bridge.regenerateToken();
    else if (reason === "disable") await bridge.setSettings({ enabled: false });
    else if (reason === "port") await bridge.setSettings({ port: bridge.getState().port + 1 });
    else if (reason === "LAN") await bridge.setSettings({ allowLan: true });
    else if (reason === "stop") await bridge.stop();
    else if (reason === "invalid-message") serverSocket.emit("message", Buffer.from("{"), false);
    else if (reason === "backpressure") {
      Object.defineProperty(serverSocket, "bufferedAmount", { configurable: true, value: 8 * 1024 * 1024 + 1 });
      bridge.updateLiveState({ activeBoardId: "board-b", playback: [] });
    } else serverSocket.emit("error", new Error("Socket failed"));
    if (reason !== "disconnect") {
      expect(onCommand.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
      expect([...requests.values()].every((cancellation) => cancellation.signal.aborted)).toBe(true);
    }
    await vi.waitFor(() => expect(onCommand.mock.calls.slice(0, 2).every(([, signal]) => signal.aborted)).toBe(true));
    expect(settings.micVirtualVolume).toBe(0.6);
    finishSave();
    const expected = [
      { ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } },
      { ok: false, code: "unavailable" }
    ];
    if (other) {
      expect(await other).toEqual({ status: 200, body: { ok: true, data: { bus: "micVirtual", value: 0.8, muted: false } } });
      expect(persisted).toEqual([0.6, 0.8]);
      expected.push({ ok: true, data: { bus: "micVirtual", value: 0.8, muted: false } });
    } else {
      await vi.waitFor(() => expect(completed).toHaveLength(2));
      expect(persisted).toEqual([0.6]);
      expect(settings.micVirtualVolume).toBe(0.6);
    }
    expect(completed).toEqual(expected);
    expect(requests.size).toBe(0);
  });

  it.each(["WebSocket", "HTTP"].flatMap((transport) => ["save", "routing"].map((hung) => [transport, hung])))
  ("releases accepted mutations hung on %s/%s at the deadline after disconnect through preload", async (transport, hung) => {
    let settings = { ...audioSettings };
    const persist = vi.fn(async () => {});
    const routing = vi.fn(async () => {});
    (hung === "save" ? persist : routing).mockImplementationOnce(() => new Promise(() => {}));
    const queue = createAudioControlQueue({
      getSettings: () => settings, writeSettings: (next) => { settings = next; },
      persist, waitForConfiguration: routing
    });
    const requests = new Map();
    const completed = vi.fn();
    const cancellations = [];
    const ipcRenderer = Object.assign(new EventEmitter(), { invoke: vi.fn(async (channel, requestId, result) => {
      if (channel === "control:received") return { ok: renderer.receive(requestId) };
      if (channel === "control:result") {
        completed(result);
        return { ok: renderer.complete(requestId, result) };
      }
    }) });
    let sounddeck;
    runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
      require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, api) => { sounddeck = api; } } })
    });
    ipcRenderer.emit("control-ready-token", {}, "document");
    sounddeck.onControlCommand((message) => {
      if (message.command === "control.cancel") {
        cancellations.push(message);
        requests.get(message.requestId)?.abort(message.reason);
        return;
      }
      const cancellation = createControlCancellation();
      requests.set(message.requestId, cancellation);
      return queue.enqueue(message, cancellation.signal, cancellation.deadlineSignal)
        .finally(() => requests.delete(message.requestId));
    });
    const renderer = rendererModule.createControlRenderer({ send: (message) => ipcRenderer.emit("control-command", {}, message) });
    onCommand.mockImplementation((command, signal, deadlineSignal) => renderer.dispatch(command, signal, deadlineSignal));
    await create();
    const connection = transport === "WebSocket" ? await session() : null;
    vi.useFakeTimers();
    let disconnected;
    if (connection) connection.send({ type: "command", id: "hung", command: "volume.set", args: { bus: "micVirtual", value: 0.6 } });
    else {
      disconnected = http.request({ createConnection: memoryConnect, hostname: "127.0.0.1", port: bridge.getState().port,
        method: "POST", path: "/v1/volumes/micVirtual", headers: { Authorization: `Bearer ${bridge.getState().token}` } });
      disconnected.on("error", () => {});
      disconnected.end(JSON.stringify({ value: 0.6 }));
    }
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    if (hung === "routing") await vi.waitFor(() => expect(routing).toHaveBeenCalledOnce());
    const original = [...requests.values()][0];
    connection?.ws.terminate();
    disconnected?.destroy();
    await vi.waitFor(() => expect(original.signal.aborted).toBe(true));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(completed).not.toHaveBeenCalled();
    expect(settings.micVirtualVolume).toBe(0.6);
    const later = request("/v1/volumes/micVirtual", { method: "POST", body: { delta: 0.2 } });
    void later.catch(() => {}); // Teardown can close this request if a regression assertion fails.
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(10_000);
    // The original disconnect reason stays immutable; the separate deadline
    // still reaches the original preload callback and unblocks the global FIFO.
    expect(original.signal.reason).not.toBe("operation-timeout");
    expect(original.deadlineSignal.reason).toBe("operation-timeout");
    expect(cancellations.map(({ reason }) => reason)).toEqual([undefined, "operation-timeout"]);
    expect(completed.mock.calls[0][0]).toEqual(hung === "save"
      ? { ok: false, code: "unavailable" }
      : { ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    vi.useRealTimers();
    expect(await later).toEqual({ status: 200, body: { ok: true, data: { bus: "micVirtual", value: 0.8, muted: false } } });
    expect(requests.size).toBe(0);
    expect(completed).toHaveBeenCalledTimes(2);
    expect(onCommand.mock.calls[1][2].aborted).toBe(false);
  });

  it.each(["WebSocket", "HTTP"].flatMap((transport) => ["play", "tap press", "hold press"].flatMap((operation) =>
    ["routing", "decode"].map((hung) => [transport, operation, hung]))))
  ("releases %s %s hung on %s after disconnect through preload at its independent deadline", async (transport, operation, hung) => {
    const sound = makeSound({ id: "sound-new", triggerMode: operation === "hold press" ? "hold" : "tap", retriggerMode: "overlap" });
    const stalled = deferred();
    let configuration = hung === "routing" ? stalled.promise : null;
    const audio = {
      play: vi.fn(async (_sound, signal) => signal.aborted ? false : "later-voice"),
      stop: vi.fn(), stopAll: vi.fn(), stopVoice: vi.fn(), isPlaying: () => false
    };
    if (hung === "decode") audio.play.mockImplementationOnce(async (_sound, signal) => {
      await stalled.promise;
      return signal.aborted ? false : "late-voice";
    });
    const getConfiguration = vi.fn(() => configuration);
    const triggers = new SoundTriggers(() => audio, getConfiguration);
    const requests = new Map();
    const cancellations = [];
    const completed = vi.fn();
    const ipcRenderer = Object.assign(new EventEmitter(), { invoke: vi.fn(async (channel, requestId, result) => {
      if (channel === "control:received") return { ok: renderer.receive(requestId) };
      if (channel === "control:result") {
        completed(result);
        return { ok: renderer.complete(requestId, result) };
      }
    }) });
    let sounddeck;
    runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
      require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, api) => { sounddeck = api; } } })
    });
    ipcRenderer.emit("control-ready-token", {}, "document");
    sounddeck.onControlCommand((message) => {
      if (message.command === "control.cancel") {
        cancellations.push(message);
        requests.get(message.requestId)?.abort(message.reason);
        return;
      }
      if (message.command === "sound.release") { triggers.release(message.args.pressId); return; }
      const cancellation = createControlCancellation();
      requests.set(message.requestId, cancellation);
      return triggers.trigger(sound, message.command === "sound.press" ? message.args.pressId : undefined,
        true, cancellation.signal, cancellation.deadlineSignal)
        .then((started) => ({ ok: !cancellation.signal.aborted && started !== false,
          ...(cancellation.signal.aborted || started === false ? { code: "unavailable" } : {}) }),
        () => ({ ok: false, code: "unavailable" }))
        .finally(() => requests.delete(message.requestId));
    });
    const renderer = rendererModule.createControlRenderer({ send: (message) => ipcRenderer.emit("control-command", {}, message) });
    onCommand.mockImplementation((command, signal, deadlineSignal) => {
      if (command.command === "sound.release") { ipcRenderer.emit("control-command", {}, command); return { ok: true }; }
      return renderer.dispatch(command, signal, deadlineSignal);
    });
    await create();
    const connection = transport === "WebSocket" ? await session() : null;
    const command = operation === "play" ? "sound.play" : "sound.press";
    vi.useFakeTimers();
    let disconnected;
    if (connection) connection.send({ type: "command", id: "hung", command,
      args: { soundId: sound.id, ...(command === "sound.press" && { pressId: "held" }) } });
    else {
      disconnected = http.request({ createConnection: memoryConnect, hostname: "127.0.0.1", port: bridge.getState().port,
        method: "POST", path: `/v1/sounds/${sound.id}/${command.split(".")[1]}`,
        headers: { Authorization: `Bearer ${bridge.getState().token}` } });
      disconnected.on("error", () => {});
      disconnected.end();
    }
    await vi.waitFor(() => expect(hung === "routing" ? getConfiguration : audio.play).toHaveBeenCalledOnce());
    const original = [...requests.values()][0];
    connection?.ws.terminate();
    disconnected?.destroy();
    await vi.waitFor(() => expect(original.signal.aborted).toBe(true));
    if (hung === "decode") expect(audio.play.mock.calls[0][1].aborted).toBe(true);
    configuration = null;
    const later = request(`/v1/sounds/${sound.id}/play`, { method: "POST" });
    void later.catch(() => {});
    await vi.waitFor(() => expect(onCommand.mock.calls.filter(([message]) => message.command !== "sound.release")).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(original.signal.reason).not.toBe("operation-timeout");
    expect(original.deadlineSignal.reason).toBe("operation-timeout");
    expect(cancellations.map(({ reason }) => reason)).toEqual([undefined, "operation-timeout"]);
    expect(completed.mock.calls[0][0]).toEqual({ ok: false, code: "unavailable" });
    vi.useRealTimers();
    expect(await later).toEqual({ status: 200, body: { ok: true } });
    expect(requests.size).toBe(0);
    expect(completed).toHaveBeenCalledTimes(2);
    stalled.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(audio.play).toHaveBeenCalledTimes(hung === "decode" ? 2 : 1);
    expect(audio.stopVoice).not.toHaveBeenCalled();
    expect(onCommand.mock.calls.filter(([message]) => message.command === "sound.release")).toHaveLength(command === "sound.press" ? 1 : 0);
  });

  it.each([["WebSocket", "play"], ["HTTP", "play"], ["WebSocket", "press"], ["HTTP", "press"]])("requests cancellation at the operation deadline and waits for acknowledgement over %s for %s", async (transport, operation) => {
    await create();
    const connection = transport === "WebSocket" ? await session() : null;
    const send = vi.fn();
    const renderer = rendererModule.createControlRenderer({ send });
    onCommand.mockImplementation((command, signal, deadlineSignal) => command.command === "sound.release" ? { ok: true } : renderer.dispatch(command, signal, deadlineSignal));
    const completed = vi.fn();
    vi.useFakeTimers();
    let response;
    if (connection) {
      connection.send({ type: "command", id: "slow", command: `sound.${operation}`, args: { soundId: "sound-new", ...(operation === "press" && { pressId: "held" }) } });
    } else {
      response = request(`/v1/sounds/sound-new/${operation}`, { method: "POST" }).then(completed);
    }
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledOnce());
    const requestId = send.mock.calls[0][0].requestId;
    renderer.receive(requestId);
    if (connection) response = new Promise((resolve) => connection.ws.once("message", (data) => resolve(JSON.parse(data.toString())))).then(completed);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(onCommand.mock.calls[0][1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCommand.mock.calls[0][1].reason).toBe("operation-timeout");
    expect(send).toHaveBeenLastCalledWith({ command: "control.cancel", requestId, reason: "operation-timeout" });
    expect(completed).not.toHaveBeenCalled();
    renderer.complete(requestId, { ok: false, code: "unavailable" });
    vi.useRealTimers();
    await response;
    expect(completed).toHaveBeenCalledExactlyOnceWith(connection
      ? { type: "result", id: "slow", ok: false, code: "unavailable" }
      : { status: 503, body: { ok: false, code: "unavailable" } });
    if (operation === "press") {
      expect(onCommand).toHaveBeenCalledTimes(2);
      expect(onCommand.mock.calls[1]).toEqual([{ command: "sound.release", args: { pressId: send.mock.calls[0][0].args.pressId } }, undefined, undefined]);
    }
    onCommand.mockResolvedValue({ ok: true });
    if (connection) {
      expect(await connection.next()).toMatchObject({ id: "slow", ok: false });
      connection.send({ type: "command", id: "retry", command: `sound.${operation}`, args: { soundId: "sound-new", ...(operation === "press" && { pressId: "held" }) } });
      expect(await connection.next()).toMatchObject({ id: "retry", ok: true });
    } else expect((await request(`/v1/sounds/sound-new/${operation}`, { method: "POST" })).body.ok).toBe(true);
  });

  it("cancels pending WebSocket commands when their client disconnects", async () => {
    await create();
    const connection = await session();
    onCommand.mockImplementation((_command, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ ok: false, code: "unavailable" }), { once: true });
    }));
    connection.send({ type: "command", id: "pending", command: "sound.play", args: { soundId: "sound-new" } });
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledOnce());
    connection.ws.terminate();
    await vi.waitFor(() => expect(onCommand.mock.lastCall[1].aborted).toBe(true));
  });

  it.each(["token", "disable", "port", "LAN", "stop", "invalid-message", "backpressure", "socket-error"])("releases acknowledged session holds synchronously on %s revocation", async (reason) => {
    let serverSocket;
    await create({ createWebSocketServer: (options) => {
      const server = new WebSocketServer(options);
      server.on("connection", (ws) => { serverSocket = ws; });
      return server;
    } });
    const connection = await session();
    connection.send({ type: "command", id: "press", command: "sound.press", args: { soundId: "sound-new", pressId: "held" } });
    expect(await connection.next()).toMatchObject({ id: "press", ok: true });
    const pressId = onCommand.mock.calls[0][0].args.pressId;
    const closed = vi.fn();
    serverSocket.on("close", closed);
    const assertReleased = () => {
      expect(onCommand.mock.calls.filter(([message]) => message.command === "sound.release").map(([message]) => message.args.pressId)).toEqual([pressId]);
      expect(closed).not.toHaveBeenCalled();
    };
    const method = ["token", "invalid-message"].includes(reason) ? "close" : "terminate";
    const original = serverSocket[method].bind(serverSocket);
    const closing = vi.spyOn(serverSocket, method).mockImplementation((...args) => {
      assertReleased();
      return original(...args);
    });
    if (reason === "token") await bridge.regenerateToken();
    else if (reason === "disable") await bridge.setSettings({ enabled: false });
    else if (reason === "port") await bridge.setSettings({ port: bridge.getState().port + 1 });
    else if (reason === "LAN") await bridge.setSettings({ allowLan: true });
    else if (reason === "stop") await bridge.stop();
    else if (reason === "invalid-message") serverSocket.emit("message", Buffer.from("{"), false);
    else if (reason === "backpressure") {
      Object.defineProperty(serverSocket, "bufferedAmount", { configurable: true, value: 8 * 1024 * 1024 + 1 });
      bridge.updateLiveState({ activeBoardId: "board-b", playback: [] });
    } else {
      serverSocket.emit("error", new Error("Socket failed"));
      assertReleased();
    }
    if (reason !== "socket-error") expect(closing).toHaveBeenCalled();
    expect(onCommand.mock.calls.filter(([message]) => message.command === "sound.release")).toHaveLength(1);
    closing.mockRestore();
    serverSocket.terminate();
  });

  it.each(["token", "disable", "port", "LAN", "stop", "invalid-message", "backpressure", "socket-error"].flatMap((reason) => [
    [reason, "sound.play", { soundId: "sound-new" }],
    [reason, "sound.press", { soundId: "sound-new" }],
    [reason, "setting.toggle", { key: "micPassthrough" }],
    [reason, "volume.adjust", { bus: "micVirtual", delta: 0.2 }]
  ]))("aborts every pending session command synchronously on %s revocation (%s)", async (reason, command, args) => {
    let serverSocket;
    await create({ createWebSocketServer: (options) => {
      const server = new WebSocketServer(options);
      server.on("connection", (ws) => { serverSocket = ws; });
      return server;
    } });
    const connection = await session();
    const completions = [];
    const played = vi.fn();
    onCommand.mockImplementation(async (message, signal) => {
      if (message.command === "sound.release") return { ok: true };
      await new Promise((resolve) => completions.push(resolve));
      if (signal.aborted) return { ok: false, code: "unavailable" };
      played();
      return { ok: true };
    });
    for (const id of ["first", "second"]) connection.send({ type: "command", id, command, args: { ...args, ...(command === "sound.press" && { pressId: id }) } });
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    const closed = vi.fn();
    serverSocket.on("close", closed);
    const signals = onCommand.mock.calls.map((call) => call[1]);
    const assertRevoked = () => {
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(closed).not.toHaveBeenCalled();
      if (command === "sound.press") {
        const pressIds = onCommand.mock.calls.slice(0, 2).map(([message]) => message.args.pressId);
        const released = onCommand.mock.calls.filter(([message]) => message.command === "sound.release").map(([message]) => message.args.pressId);
        expect(released.sort()).toEqual(pressIds.sort());
      }
    };
    const method = ["token", "invalid-message"].includes(reason) ? "close" : "terminate";
    const original = serverSocket[method].bind(serverSocket);
    const closing = vi.spyOn(serverSocket, method).mockImplementation((...args) => {
      assertRevoked();
      return original(...args);
    });
    if (reason === "token") await bridge.regenerateToken();
    else if (reason === "disable") await bridge.setSettings({ enabled: false });
    else if (reason === "port") await bridge.setSettings({ port: bridge.getState().port + 1 });
    else if (reason === "LAN") await bridge.setSettings({ allowLan: true });
    else if (reason === "stop") await bridge.stop();
    else if (reason === "invalid-message") serverSocket.emit("message", Buffer.from("{"), false);
    else if (reason === "backpressure") {
      Object.defineProperty(serverSocket, "bufferedAmount", { configurable: true, value: 8 * 1024 * 1024 + 1 });
      bridge.updateLiveState({ activeBoardId: "board-b", playback: [] });
    } else {
      serverSocket.emit("error", new Error("Socket failed"));
      assertRevoked();
    }
    if (reason !== "socket-error") expect(closing).toHaveBeenCalled();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    completions.forEach((complete) => complete());
    await Promise.resolve();
    await Promise.resolve();
    expect(played).not.toHaveBeenCalled();
    closing.mockRestore();
    serverSocket.terminate();
  });

  it.each(["token", "disable", "port", "LAN", "stop"].flatMap((reason) => [
    [reason, "/v1/sounds/sound-new/play", {}],
    [reason, "/v1/sounds/sound-new/press", {}],
    [reason, "/v1/settings/micPassthrough", { toggle: true }],
    [reason, "/v1/volumes/micVirtual", { delta: 0.2 }]
  ]))("aborts dispatched HTTP commands at %s revocation before response closure (%s)", async (reason, url, body) => {
    let listener;
    await create({ createServer: (...args) => { listener = memoryServer(...args); return listener; } });
    let response;
    listener.once("request", (_req, res) => { response = res; });
    let finish;
    onCommand.mockImplementation(async (message, signal) => {
      if (message.command === "sound.release") {
        expect(closed).not.toHaveBeenCalled();
        return { ok: true };
      }
      await new Promise((resolve) => { finish = resolve; });
      return signal.aborted ? { ok: false, code: "unavailable" } : { ok: true };
    });
    const pending = request(url, { method: "POST", body }).catch(() => null);
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledOnce());
    const signal = onCommand.mock.lastCall[1];
    const closed = vi.fn();
    response.once("close", closed);
    const abort = vi.fn(() => expect(closed).not.toHaveBeenCalled());
    signal.addEventListener("abort", abort);
    if (reason === "token") await bridge.regenerateToken();
    else if (reason === "disable") await bridge.setSettings({ enabled: false });
    else if (reason === "port") await bridge.setSettings({ port: bridge.getState().port + 1 });
    else if (reason === "LAN") await bridge.setSettings({ allowLan: true });
    else await bridge.stop();
    expect(signal.aborted).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    if (url.endsWith("/press")) {
      expect(onCommand.mock.calls.filter(([message]) => message.command === "sound.release")).toHaveLength(1);
    }
    finish();
    const result = await pending;
    if (reason === "token") expect(result).toEqual({ status: 503, body: { ok: false, code: "unavailable" } });
  });

  it("dispatches every setting and bus over WebSocket and returns renderer values", async () => {
    await create();
    const connection = await session();
    for (const key of ["micPassthrough", "soundboardToVirtualMic", "noiseSuppressionEnabled", "echoCancellationEnabled", "monitorToHeadphones"]) {
      for (const [command, args] of [["setting.set", { key, value: false }], ["setting.toggle", { key }]]) {
        const data = { key, value: command === "setting.toggle" };
        onCommand.mockReturnValueOnce({ ok: true, data });
        connection.send({ type: "command", id: "setting", command, args });
        expect(await connection.next()).toEqual({ type: "result", id: "setting", ok: true, data });
        expect(onCommand).toHaveBeenLastCalledWith({ command, args }, expect.any(AbortSignal), expect.any(AbortSignal));
      }
    }
    for (const bus of ["micVirtual", "micMonitor", "soundboardVirtual", "soundboardMonitor"]) {
      for (const [command, args] of [
        ["volume.set", { bus, value: 0 }], ["volume.set", { bus, value: 1 }],
        ["volume.adjust", { bus, delta: -2 }], ["volume.adjust", { bus, delta: 2 }],
        ["volume.mute", { bus, muted: false }], ["volume.mute", { bus, muted: true }], ["volume.mute", { bus }]
      ]) {
        const data = { bus, value: 0.5, muted: command === "volume.mute" };
        onCommand.mockReturnValueOnce({ ok: true, data });
        connection.send({ type: "command", id: "volume", command, args });
        expect(await connection.next()).toEqual({ type: "result", id: "volume", ok: true, data });
        expect(onCommand).toHaveBeenLastCalledWith({ command, args }, expect.any(AbortSignal), expect.any(AbortSignal));
      }
    }
  });

  it("maps exclusive HTTP setting and volume bodies to the same commands and results", async () => {
    await create();
    for (const [url, body, expected, data] of [
      ["/v1/settings/micPassthrough", { value: false }, { command: "setting.set", args: { key: "micPassthrough", value: false } }, { key: "micPassthrough", value: false }],
      ["/v1/settings/monitorToHeadphones", { toggle: true }, { command: "setting.toggle", args: { key: "monitorToHeadphones" } }, { key: "monitorToHeadphones", value: false }],
      ["/v1/volumes/micVirtual", { value: 0.4 }, { command: "volume.set", args: { bus: "micVirtual", value: 0.4 } }, { bus: "micVirtual", value: 0.4, muted: false }],
      ["/v1/volumes/micMonitor", { delta: -0.1 }, { command: "volume.adjust", args: { bus: "micMonitor", delta: -0.1 } }, { bus: "micMonitor", value: 0.9, muted: false }],
      ["/v1/volumes/soundboardVirtual", { muted: false }, { command: "volume.mute", args: { bus: "soundboardVirtual", muted: false } }, { bus: "soundboardVirtual", value: 1, muted: false }],
      ["/v1/volumes/soundboardMonitor", { toggleMute: true }, { command: "volume.mute", args: { bus: "soundboardMonitor" } }, { bus: "soundboardMonitor", value: 1, muted: true }]
    ]) {
      onCommand.mockReturnValueOnce({ ok: true, data });
      expect(await request(url, { method: "POST", body })).toEqual({ status: 200, body: { ok: true, data } });
      expect(onCommand).toHaveBeenLastCalledWith(expected, expect.any(AbortSignal), expect.any(AbortSignal));
    }
    onCommand.mockReturnValueOnce({ ok: false, code: "unavailable" });
    expect(await request("/v1/settings/micPassthrough", { method: "POST", body: { toggle: true } })).toEqual({ status: 503, body: { ok: false, code: "unavailable" } });
  });

  it("rejects unsupported audio keys, buses, extra arguments and invalid values without dispatch", async () => {
    await create();
    const connection = await session();
    for (const [command, args] of [
      ["setting.set", { key: "monitorMicToHeadphones", value: true }],
      ["setting.set", { key: "micPassthrough" }],
      ["setting.set", { key: "micPassthrough", value: 1 }],
      ["setting.toggle", { key: "micPassthrough", value: true }],
      ["setting.toggle", { key: ["micPassthrough"] }],
      ["volume.set", { bus: "micVirtual", value: -0.01 }],
      ["volume.set", { bus: "micVirtual", value: 1.01 }],
      ["volume.set", { bus: "micVirtual", value: "0.5" }],
      ["volume.adjust", { bus: "micVirtual", delta: Infinity }],
      ["volume.adjust", { bus: "micVirtual" }],
      ["volume.adjust", { bus: "micVirtual", delta: 0.1, value: 0.5 }],
      ["volume.mute", { bus: "micVolume", muted: true }],
      ["volume.mute", { bus: "micVirtual", muted: null }],
      ["volume.mute", { bus: "micVirtual", toggleMute: true }]
    ]) {
      connection.send({ type: "command", id: "invalid-audio", command, args });
      expect(await connection.next()).toMatchObject({ id: "invalid-audio", ok: false, code: "invalid-args" });
    }
    for (const [url, bodies] of [
      ["/v1/settings/micPassthrough", [{}, [], { value: true, toggle: true }, { toggle: false }, { toggle: 1 }, { value: null }, { value: true, key: "monitorToHeadphones" }]],
      ["/v1/volumes/micVirtual", [{}, { value: 0.5, delta: 0.1 }, { value: 0.5, muted: true }, { muted: true, toggleMute: true }, { toggleMute: false }, { delta: "0.1" }, { muted: null }, { value: 1.01 }, { delta: null }, { bus: "micMonitor", muted: true }]],
      ["/v1/settings/unknown", [{ toggle: true }]],
      ["/v1/volumes/unknown", [{ muted: true }]]
    ]) {
      for (const body of bodies) expect((await request(url, { method: "POST", body })).status).toBe(400);
    }
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("includes audio values in both snapshots and emits changes once from cached library updates", async () => {
    await create();
    const connection = await client();
    connection.send(hello());
    const initial = (await connection.next()).state;
    expect(initial.settings).toEqual({ micPassthrough: false, soundboardToVirtualMic: false, noiseSuppressionEnabled: false, echoCancellationEnabled: false, monitorToHeadphones: true });
    expect(initial.volumes).toEqual({ micVirtual: { value: 1, muted: false }, micMonitor: { value: 1, muted: false }, soundboardVirtual: { value: 1, muted: false }, soundboardMonitor: { value: 1, muted: false } });
    expect((await request()).body).toEqual(initial);
    const changed = { ...library, settings: { ...audioSettings, micPassthrough: true, micVirtualVolume: 0.3, micVirtualMuted: true } };
    bridge.updateLibrary(changed);
    expect(await connection.next()).toEqual({ type: "event", event: "settings.changed", data: { ...initial.settings, micPassthrough: true } });
    expect(await connection.next()).toEqual({ type: "event", event: "volumes.changed", data: { ...initial.volumes, micVirtual: { value: 0.3, muted: true } } });
    bridge.updateLibrary(changed);
    bridge.updateLiveState({ activeBoardId: "board-a", playback: [] });
    connection.send({ type: "command", id: "audio-no-duplicate", command: "library.get", args: {} });
    expect(await connection.next()).toMatchObject({ type: "result", id: "audio-no-duplicate" });
    expect((await request()).body).toMatchObject({ settings: { micPassthrough: true }, volumes: { micVirtual: { value: 0.3, muted: true } } });
    const unmuted = { ...changed, settings: { ...changed.settings, micVirtualMuted: false } };
    bridge.updateLibrary(unmuted);
    expect(await connection.next()).toEqual({ type: "event", event: "volumes.changed", data: { ...initial.volumes, micVirtual: { value: 0.3, muted: false } } });
    bridge.updateLibrary({ ...unmuted, settings: { ...unmuted.settings, noiseSuppressionEnabled: true } });
    expect(await connection.next()).toEqual({ type: "event", event: "settings.changed", data: { ...initial.settings, micPassthrough: true, noiseSuppressionEnabled: true } });
    bridge.updateLibrary({ ...library, settings: undefined });
    expect(await connection.next()).toEqual({ type: "event", event: "settings.changed", data: initial.settings });
    expect(await connection.next()).toEqual({ type: "event", event: "volumes.changed", data: initial.volumes });
  });

  it("rejects unknown commands, paths, extra fields, wrong types and invalid direction without dispatch", async () => {
    await create();
    const connection = await session();
    for (const [command, args, code] of [
      ["sound.unknown", { soundId: "sound-new" }, "unknown-command"],
      ["sound.press", { soundId: "sound-new" }, "invalid-args"],
      ["sound.press", { soundId: "sound-new", pressId: "../key" }, "invalid-args"],
      ["sound.press", { soundId: "sound-new", pressId: "a".repeat(129) }, "invalid-args"],
      ["sound.press", { soundId: "sound-new", pressId: "key", extra: true }, "invalid-args"],
      ["sound.release", { pressId: "" }, "invalid-args"],
      ["sound.release", { pressId: "key", soundId: "sound-new" }, "invalid-args"],
      ["sound.play", { soundId: "../media.wav" }, "invalid-args"],
      ["sound.play", { soundId: "sound-new", path: "/tmp/file" }, "invalid-args"],
      ["sound.play", { soundId: "sound-new", title: {} }, "invalid-args"],
      ["sound.stop", { soundId: ["sound-new"] }, "invalid-args"],
      ["board.activate", {}, "invalid-args"],
      ["board.cycle", { direction: 0 }, "invalid-args"],
      ["library.get", { file: "library.json" }, "invalid-args"],
      ["playback.stopAll", null, "invalid-args"]
    ]) {
      connection.send({ type: "command", id: "invalid", command, args });
      expect(await connection.next()).toMatchObject({ id: "invalid", ok: false, code });
    }
    for (const options of [{ body: { direction: "-1" } }, { raw: "{" }, { body: [] }, { body: { direction: 1, path: "/tmp/x" } }]) {
      expect((await request("/v1/boards/cycle", { method: "POST", ...options })).status).toBe(400);
    }
    expect((await request("/v1/sounds/sound-new/press", { method: "POST", body: { pressId: "client-generated" } })).status).toBe(400);
    expect((await request("/v1/presses/bad%2Fid/release", { method: "POST" })).status).toBe(400);
    expect((await request("/v1/presses/key/release", { method: "POST", body: { extra: true } })).status).toBe(400);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("rejects malformed envelopes, binary messages and oversized payloads", async () => {
    await create();
    for (const message of ["{", JSON.stringify({ type: "hello", protocol: 1, token: bridge.getState().token, client: { name: "client", version: "1", extra: true } }), Buffer.from("binary")]) {
      const connection = await client();
      connection.ws.send(message);
      expect((await connection.next()).code).toBe("invalid-message");
      await connection.closed;
    }
    const authenticated = await session();
    authenticated.send({ type: "command", id: "valid", command: "library.get", args: {}, extra: true });
    expect((await authenticated.next()).code).toBe("invalid-message");
    const oversized = await session();
    oversized.ws.send("x".repeat(65537));
    expect(await oversized.closed).toBe(1009);
    expect((await request("/v1/stop-all", { method: "POST", raw: "x".repeat(65537) })).status).toBe(413);
    expect((await request("/v1/stop-all", { method: "POST", raw: "x".repeat(65537), chunked: true })).status).toBe(413);
    expect((await request("/v1/state", { raw: "x".repeat(65537) })).status).toBe(413);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("rechecks the token after receiving a body that was started before token rotation", async () => {
    let listener;
    await create({ createServer: (...args) => { listener = memoryServer(...args); return listener; } });
    const original = bridge.getState();
    const received = new Promise((resolve) => listener.once("request", resolve));
    let req;
    const response = new Promise((resolve, reject) => {
      req = http.request({ createConnection: memoryConnect, hostname: "127.0.0.1", port: original.port, path: "/v1/stop-all", method: "POST", headers: { Authorization: `Bearer ${original.token}`, "Content-Length": 2 } }, (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.flushHeaders();
    });
    await received;
    await bridge.regenerateToken();
    req.end("{}");
    expect(await response).toBe(401);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("returns dispatch failures without leaking exceptions or dropping the session", async () => {
    await create();
    const connection = await session();
    onCommand.mockReturnValueOnce({ ok: false, code: "busy" });
    connection.send({ type: "command", id: "capture", command: "sound.play", args: { soundId: "sound-new" } });
    expect(await connection.next()).toMatchObject({ id: "capture", ok: false, code: "busy" });
    onCommand.mockImplementationOnce(() => { throw new Error("private file path"); });
    expect(await request("/v1/stop-all", { method: "POST" })).toEqual({ status: 500, body: { ok: false, code: "internal-error" } });
    connection.send({ type: "command", id: "recovered", command: "playback.stopAll", args: {} });
    expect(await connection.next()).toMatchObject({ id: "recovered", ok: true });
  });

  it("publishes cleared playback to existing clients, HTTP state and new sessions", async () => {
    await create();
    bridge.updateLiveState({ activeBoardId: "board-b", playback: [{ soundId: "sound-new", startedAt: 1, duration: 2, loop: true }] });
    const connection = await session();
    bridge.updateLiveState({ activeBoardId: bridge.getSnapshot().activeBoardId, playback: [] });
    expect(await connection.next()).toEqual({ type: "event", event: "playback.changed", data: [] });
    expect((await request()).body).toMatchObject({ activeBoardId: "board-b", playback: [] });
    const newcomer = await client();
    newcomer.send(hello());
    expect(await newcomer.next()).toMatchObject({ type: "welcome", state: { activeBoardId: "board-b", playback: [] } });
  });

  it("pushes library, active board and per-voice playback changes with no duplicate events", async () => {
    const onStateChange = vi.fn();
    await create({ onStateChange });
    const connection = await session();
    const playback = [{ soundId: "sound-new", startedAt: 1700000000000, duration: 1.5, loop: false }, { soundId: "sound-new", startedAt: 1700000000100, duration: 1.5, loop: true }];
    bridge.updateLiveState({ activeBoardId: "board-b", playback });
    expect(await connection.next()).toEqual({ type: "event", event: "board.changed", data: { activeBoardId: "board-b" } });
    expect(await connection.next()).toEqual({ type: "event", event: "playback.changed", data: playback });
    bridge.updateLiveState({ activeBoardId: "board-b", playback });
    bridge.updateLibrary({ ...library, activeBoardId: "board-b" });
    connection.send({ type: "command", id: "no-duplicate", command: "library.get", args: {} });
    expect(await connection.next()).toMatchObject({ type: "result", id: "no-duplicate", data: { activeBoardId: "board-b" } });
    bridge.updateLibrary({ ...library, boards: [] });
    expect(await connection.next()).toMatchObject({ event: "library.changed", data: { boards: [] } });
    expect((await request()).body.playback).toEqual(playback);
    connection.ws.close();
    await connection.closed;
    await vi.waitFor(() => expect(onStateChange.mock.lastCall[0].clients).toEqual([]));
  });

  it.each(["add", "delete"])("publishes consistent library, board and audio state when boards %s", async (change) => {
    const snapshots = [];
    await create({ createWebSocketServer: (options) => {
      const server = new WebSocketServer(options);
      server.on("connection", (ws) => {
        const send = ws.send.bind(ws);
        vi.spyOn(ws, "send").mockImplementation((message) => {
          if (JSON.parse(message).type === "event") snapshots.push(bridge.getSnapshot());
          send(message);
        });
      });
      return server;
    } });
    const connection = await session();
    const newBoard = { id: "board-c", name: "New", color: "#112233", sounds: [] };
    const updated = change === "add"
      ? { ...library, activeBoardId: "board-c", boards: [...library.boards, newBoard] }
      : { ...library, activeBoardId: "board-b", boards: [library.boards[1]] };
    updated.settings = { ...audioSettings, micPassthrough: true, micVirtualVolume: 0.4, micVirtualMuted: true };
    bridge.updateLibrary(updated);
    const libraryEvent = await connection.next();
    expect(libraryEvent).toMatchObject({ event: "library.changed", data: { activeBoardId: updated.activeBoardId } });
    expect(libraryEvent.data.boards.map((board) => board.id)).toEqual(updated.boards.map((board) => board.id));
    expect(await connection.next()).toEqual({ type: "event", event: "board.changed", data: { activeBoardId: updated.activeBoardId } });
    expect(await connection.next()).toEqual({ type: "event", event: "settings.changed", data: { ...snapshots[0].settings, micPassthrough: true } });
    expect(await connection.next()).toEqual({ type: "event", event: "volumes.changed", data: snapshots[0].volumes });
    expect(snapshots).toHaveLength(4);
    for (const snapshot of snapshots) {
      expect(snapshot.activeBoardId).toBe(updated.activeBoardId);
      expect(snapshot.library).toEqual(libraryEvent.data);
      expect(snapshot.settings.micPassthrough).toBe(true);
      expect(snapshot.volumes.micVirtual).toEqual({ value: 0.4, muted: true });
    }
    bridge.updateLiveState({ playback: [] });
    bridge.updateLibrary(updated);
    connection.send({ type: "command", id: "consistent", command: "library.get", args: {} });
    expect(await connection.next()).toEqual({ type: "result", id: "consistent", ok: true, data: libraryEvent.data });
    expect((await request()).body).toEqual(snapshots[0]);
    const newcomer = await client();
    newcomer.send(hello());
    expect(await newcomer.next()).toMatchObject({ type: "welcome", state: snapshots[0] });
  });
});
