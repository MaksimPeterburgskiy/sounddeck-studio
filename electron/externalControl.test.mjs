import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { Duplex } from "node:stream";
import { mkdtemp, readFile, writeFile, chmod, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import controlModule from "./externalControl.cjs";
import { CONTROL_PROTOCOL_VERSION, CONTROL_DEFAULT_PORT } from "../src/lib/controlProtocol.ts";

const { createExternalControlBridge, launcherPath, PROTOCOL_VERSION, DEFAULT_PORT } = controlModule;
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
  setTimeout() { return this; }
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
const library = {
  activeBoardId: "board-a",
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
  bridge = undefined;
  for (const server of extraServers) await new Promise((resolve) => server.close(resolve));
  extraServers.clear();
  await rm(directory, { recursive: true, force: true });
});

async function create(options = {}, enabled = true) {
  bridge = createExternalControlBridge({ userData: directory, appVersion: "0.1.22", appPath: "/Applications/SoundDeck Studio.app", defaultPort: 0, onCommand, createServer: memoryServer, ...options });
  await bridge.start();
  bridge.updateLibrary(library);
  bridge.updateLiveState({ activeBoardId: "board-a", playback: [] });
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
    for (let attempt = 0; attempt < 4; attempt += 1) expect((await request("/v1/state", { authorize: false })).status).toBe(401);
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
    const connection = await client();
    connection.send(hello({ protocol: 2 }));
    expect(await connection.next()).toMatchObject({ type: "error", code: "protocol-mismatch", protocol: 1 });
    await connection.closed;
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
      expect(onCommand).toHaveBeenLastCalledWith({ command: "sound.play", args: { soundId: expected } });
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
      expect(onCommand).toHaveBeenLastCalledWith(expected);
    }
    expect((await request("/v1/sounds/missing/stop", { method: "POST" })).status).toBe(404);
    expect((await request("/v1/boards/missing/activate", { method: "POST" })).status).toBe(404);
  });

  it("rejects unknown commands, paths, extra fields, wrong types and invalid direction without dispatch", async () => {
    await create();
    const connection = await session();
    for (const [command, args, code] of [
      ["sound.press", { soundId: "sound-new" }, "unknown-command"],
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

  it("pushes library, active board and per-voice playback changes with no duplicate events", async () => {
    const onStateChange = vi.fn();
    await create({ onStateChange });
    const connection = await session();
    const playback = [{ soundId: "sound-new", startedAt: 1700000000000, duration: 1.5, loop: false }, { soundId: "sound-new", startedAt: 1700000000100, duration: 1.5, loop: true }];
    bridge.updateLiveState({ activeBoardId: "board-b", playback });
    expect(await connection.next()).toEqual({ type: "event", event: "board.changed", data: { activeBoardId: "board-b" } });
    expect(await connection.next()).toEqual({ type: "event", event: "playback.changed", data: playback });
    bridge.updateLiveState({ activeBoardId: "board-b", playback });
    bridge.updateLibrary(library);
    connection.send({ type: "command", id: "no-duplicate", command: "library.get", args: {} });
    expect(await connection.next()).toMatchObject({ type: "result", id: "no-duplicate", data: { activeBoardId: "board-b" } });
    bridge.updateLibrary({ ...library, boards: [] });
    expect(await connection.next()).toMatchObject({ event: "library.changed", data: { boards: [] } });
    expect((await request()).body.playback).toEqual(playback);
    connection.ws.close();
    await connection.closed;
    await vi.waitFor(() => expect(onStateChange.mock.lastCall[0].clients).toEqual([]));
  });
});
