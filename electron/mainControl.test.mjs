import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import controlModule from "./externalControl.cjs";
import ffmpegArgs from "./ffmpegArgs.cjs";
import mediaFiles from "./mediaFiles.cjs";
import processTree from "./processTree.cjs";
import security from "./security.cjs";
import shutdownLifecycle from "./shutdownLifecycle.cjs";
import startupSettings from "./startupSettings.cjs";
import updateChannel from "./updateChannel.cjs";
import updateInstallLifecycle from "./updateInstallLifecycle.cjs";

const mainFile = fileURLToPath(new URL("./main.cjs", import.meta.url));
const require = createRequire(mainFile);
// Reuse Vitest's module instances instead of evaluating a second native CJS
// copy, which gives V8 two incompatible coverage maps for each helper.
const helperModules = {
  "./ffmpegArgs.cjs": ffmpegArgs,
  "./mediaFiles.cjs": mediaFiles,
  "./processTree.cjs": processTree,
  "./security.cjs": security,
  "./shutdownLifecycle.cjs": shutdownLifecycle,
  "./startupSettings.cjs": startupSettings,
  "./updateChannel.cjs": updateChannel,
  "./updateInstallLifecycle.cjs": updateInstallLifecycle
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function boot(storageError) {
  const handlers = new Map();
  let window;
  let onCommand;
  let bridge;
  let startup;
  let finishLoading;
  const files = new Map();
  const fileSystem = {
    readFile: vi.fn(async (file) => {
      if (file.endsWith("app-settings.json")) return "{}";
      if (storageError) throw storageError;
      if (files.has(file)) return files.get(file);
      throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    }),
    mkdir: vi.fn(async () => { if (storageError) throw storageError; }),
    access: vi.fn(async (file) => { if (!files.has(file)) throw storageError || new Error("Not found"); }),
    writeFile: vi.fn(async (file, data) => { files.set(file, data); }),
    chmod: async () => {},
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    unlink: async (file) => { files.delete(file); }
  };
  class Window extends EventEmitter {
    constructor() {
      super();
      window = this;
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => false, send: vi.fn(), setWindowOpenHandler: () => {},
        mainFrame: { url: pathToFileURL(path.resolve(path.dirname(mainFile), "../dist/index.html")).href }
      });
    }
    isDestroyed() { return false; }
    loadFile() {
      this.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      return new Promise((resolve) => { finishLoading = resolve; });
    }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, getPath: () => "/test/userData", getVersion: () => "1",
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: (callback) => { startup = callback(); } })
  });
  const icon = { isEmpty: () => false, resize: () => icon };
  const electron = {
    app, BrowserWindow: Window, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => [] },
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} },
    shell: { openPath: vi.fn(async () => "") },
    nativeImage: { createFromPath: () => icon }
  };
  const overrides = {
    ...helperModules,
    electron, "node:fs/promises": fileSystem,
    "./hotkeys.cjs": { createHotkeyEngine: () => ({ stop: () => {}, setSuspended: vi.fn() }) },
    "./corsair.cjs": { createCorsairBridge: () => ({ start: () => {}, stop: () => {} }) },
    "./externalControl.cjs": { ...controlModule, createExternalControlBridge: (options) => {
      onCommand = options.onCommand;
      bridge = controlModule.createExternalControlBridge({ ...options, fileSystem });
      return bridge;
    } }
  };
  runInNewContext(readFileSync(mainFile, "utf8"), {
    require: (name) => overrides[name] || require(name), __dirname: path.dirname(mainFile),
    process: { platform: "linux", execPath: "/app", argv: [], resourcesPath: "/resources", env: { PORTABLE_EXECUTABLE_DIR: "/app" } },
    URL, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval
  });
  await vi.waitFor(() => expect(finishLoading).toBeTypeOf("function"));
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const token = () => window.webContents.send.mock.calls.findLast(([channel]) => channel === "control-ready-token")?.[1];
  const documentLoaded = () => {
    window.webContents.emit("did-navigate");
    window.webContents.emit("did-finish-load");
  };
  return { window, bridge, onCommand, event, fileSystem, token, documentLoaded,
    invoke: (name, sender = event, ...args) => {
      const arity = { "library:load": 0, "library:save": 1, "control:state": 1, "control:result": 2, "hotkeys:capture": 1 }[name];
      if (arity !== undefined && args.length === arity) args.push(token());
      return handlers.get(name)(sender, ...args);
    },
    ready: () => handlers.get("control:ready")(event, window.webContents.send.mock.calls.findLast(([channel]) => channel === "control-ready-token")?.[1]),
    loaded: async () => {
      if (!token()) documentLoaded();
      finishLoading();
      await startup;
    } };
}

describe("main-process external control lifecycle", () => {
  it("waits for persisted settings before and during background startup", async () => {
    const app = await boot();
    const stored = deferred();
    const readFile = app.fileSystem.readFile.getMockImplementation();
    app.fileSystem.readFile.mockImplementation((file) => file.endsWith("external-control.json") ? stored.promise : readFile(file));
    const received = vi.fn();
    const early = app.invoke("control:getSettings").then(received);
    await vi.waitFor(() => expect(app.fileSystem.readFile).toHaveBeenCalledWith(path.join("/test/userData", "external-control.json"), "utf8"));
    await app.loaded();
    const duringStartup = app.invoke("control:getSettings");
    expect(received).not.toHaveBeenCalled();
    const saved = { enabled: false, port: 43123, allowLan: true, token: "a".repeat(43) };
    stored.resolve(JSON.stringify(saved));
    await early;
    expect(received).toHaveBeenCalledWith(expect.objectContaining(saved));
    expect(await duringStartup).toMatchObject(saved);
    expect(app.fileSystem.readFile.mock.calls.filter(([file]) => file.endsWith("external-control.json"))).toHaveLength(1);
    await app.bridge.stop();
  });

  it("shares first-run library creation with concurrent renderer loads until the write finishes", async () => {
    const app = await boot();
    const written = deferred();
    const writeFile = app.fileSystem.writeFile.getMockImplementation();
    app.fileSystem.writeFile.mockImplementation(async (file, data) => {
      if (file.endsWith("library.json")) {
        await writeFile(file, "{");
        await written.promise;
      }
      await writeFile(file, data);
    });
    await app.loaded();
    await vi.waitFor(() => expect(app.fileSystem.writeFile.mock.calls.some(([file]) => file.endsWith("library.json"))).toBe(true));
    const first = app.invoke("library:load");
    const second = app.invoke("library:load");
    const reveal = app.invoke("library:reveal");
    await Promise.resolve();
    expect(app.fileSystem.access.mock.calls.filter(([file]) => file.endsWith("library.json"))).toHaveLength(1);
    expect(app.fileSystem.readFile.mock.calls.filter(([file]) => file.endsWith("library.json"))).toHaveLength(0);
    written.resolve();
    const libraries = await Promise.all([first, second]);
    await reveal;
    expect(libraries[0]).toMatchObject({ activeBoardId: "board-default", boards: [{ id: "board-default" }] });
    expect(libraries[1]).toEqual(libraries[0]);
    expect(app.fileSystem.writeFile.mock.calls.filter(([file]) => file.endsWith("library.json"))).toHaveLength(1);
    await app.invoke("control:getSettings");
    expect(app.bridge.getSnapshot().activeBoardId).toBe("board-default");
    await app.bridge.stop();
  });

  it("publishes a pending renderer library load after a playback-only update", async () => {
    const app = await boot();
    app.documentLoaded();
    const pendingRead = deferred();
    const readFile = app.fileSystem.readFile.getMockImplementation();
    app.fileSystem.readFile.mockImplementation((file) => file.endsWith("library.json") ? pendingRead.promise : readFile(file));
    const loading = app.invoke("library:load");
    await vi.waitFor(() => expect(app.fileSystem.readFile).toHaveBeenCalledWith(expect.stringContaining("library.json"), "utf8"));
    expect(app.invoke("control:state", app.event, { playback: [] })).toEqual({ ok: true });
    const library = { activeBoardId: "board-a", boards: [{ id: "board-a", name: "Main", sounds: [{ id: "sound-a", title: "Airhorn" }] }] };
    pendingRead.resolve(JSON.stringify(library));
    expect(await loading).toEqual(library);
    expect(app.bridge.getSnapshot()).toMatchObject({ library, activeBoardId: "board-a", playback: [] });
    await app.loaded();
    await app.invoke("control:getSettings");
    await app.bridge.stop();
  });

  it("serializes startup and renderer loads behind coalesced saves without reading a partial write", async () => {
    const app = await boot();
    app.documentLoaded();
    const initial = await app.invoke("library:load");
    const writing = deferred();
    const writeFile = app.fileSystem.writeFile.getMockImplementation();
    app.fileSystem.writeFile.mockImplementation(async (file, data) => {
      if (file.endsWith("library.json")) {
        await writeFile(file, "{");
        await writing.promise;
      }
      await writeFile(file, data);
    });
    const first = app.invoke("library:save", undefined, initial);
    await vi.waitFor(() => expect(app.fileSystem.writeFile).toHaveBeenCalledTimes(2));
    const intermediate = { ...initial, settings: { ...initial.settings, micVirtualVolume: 0.4 } };
    const newBoard = { id: "board-new", name: "New", color: "#123456", sounds: [] };
    const newest = { ...initial, activeBoardId: newBoard.id, boards: [...initial.boards, newBoard], settings: { ...initial.settings, micVirtualVolume: 0.9, micVirtualMuted: true } };
    const pending = app.invoke("library:save", undefined, intermediate);
    const coalesced = app.invoke("library:save", undefined, newest);
    app.fileSystem.readFile.mockClear();
    app.fileSystem.writeFile.mockClear();
    await app.loaded();
    const loaded = vi.fn();
    const reload = app.invoke("library:load").then((library) => { loaded(library); return library; });
    const ready = app.invoke("control:getSettings");
    await vi.waitFor(() => expect(app.fileSystem.readFile).toHaveBeenCalledWith("/test/userData/external-control.json", "utf8"));
    expect(app.fileSystem.readFile.mock.calls.filter(([file]) => file.endsWith("library.json"))).toHaveLength(0);
    expect(loaded).not.toHaveBeenCalled();
    writing.resolve();
    expect(await Promise.all([first, pending, coalesced])).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    await ready;
    expect(await reload).toEqual(newest);
    expect(app.fileSystem.writeFile.mock.calls.filter(([file]) => file.endsWith("library.json"))).toHaveLength(1);
    expect(app.bridge.getSnapshot().volumes.micVirtual).toEqual({ value: 0.9, muted: true });
    expect(app.bridge.getSnapshot()).toMatchObject({ activeBoardId: newBoard.id, library: { activeBoardId: newBoard.id, boards: expect.arrayContaining([newBoard]) } });
    await app.bridge.stop();
  });

  it("allows library initialization to retry after a storage failure", async () => {
    const app = await boot();
    app.documentLoaded();
    app.fileSystem.mkdir.mockRejectedValueOnce(Object.assign(new Error("Storage failure"), { code: "ENOSPC" }));
    await expect(app.invoke("library:load")).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await app.invoke("library:load")).toMatchObject({ activeBoardId: "board-default" });
    await app.loaded();
    await app.invoke("control:getSettings");
    await app.bridge.stop();
  });

  it("requires trusted renderer readiness and clears it on reload, crash and destruction", async () => {
    const app = await boot();
    const command = { command: "board.cycle", args: { direction: 1 } };
    const audioCommand = { command: "volume.mute", args: { bus: "micVirtual" } };
    for (const pending of [command, audioCommand, { command: "setting.toggle", args: { key: "micPassthrough" } }]) {
      expect(app.onCommand(pending)).toEqual({ ok: false, code: "unavailable" });
    }
    expect(() => app.invoke("control:ready", { ...app.event, senderFrame: { url: app.event.senderFrame.url } })).toThrow("Untrusted IPC sender");
    await app.loaded();
    await app.invoke("control:getSettings");
    app.invoke("control:state", undefined, { activeBoardId: "board-a", playback: [] });
    expect(app.onCommand(command).code).toBe("unavailable");
    expect(app.onCommand(audioCommand).code).toBe("unavailable");
    app.ready();
    for (const direction of [1, -1]) {
      const cycle = { command: "board.cycle", args: { direction } };
      expect(app.onCommand(cycle)).toEqual({ ok: true });
      expect(app.window.webContents.send).toHaveBeenLastCalledWith("control-command", cycle);
    }
    app.window.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    app.window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(app.onCommand(command)).toEqual({ ok: true });
    for (const name of ["did-start-navigation", "render-process-gone", "destroyed"]) {
      app.bridge.updateLiveState({ activeBoardId: "board-default", playback: [{ soundId: "sound-a", startedAt: 1, duration: 2, loop: true }] });
      const pending = app.onCommand(audioCommand);
      app.window.webContents.emit(name, { isMainFrame: true, isSameDocument: false });
      expect(await pending).toEqual({ ok: false, code: "unavailable" });
      expect(app.onCommand(command).code).toBe("unavailable");
      expect(app.bridge.getSnapshot()).toMatchObject({ activeBoardId: "board-default", playback: [] });
      expect(app.invoke("control:state", undefined, { activeBoardId: "board-a", playback: [] })).toEqual({ ok: false });
      expect(app.onCommand(audioCommand).code).toBe("unavailable");
      app.window.webContents.emit("did-navigate");
      app.window.webContents.emit("did-finish-load");
      app.ready();
    }
    const pending = app.onCommand(audioCommand);
    app.window.emit("closed");
    expect(await pending).toEqual({ ok: false, code: "unavailable" });
    expect(app.onCommand(command).code).toBe("unavailable");
    await app.bridge.stop();
  });

  it("rejects outgoing document readiness during navigation and after the next document loads", async () => {
    const app = await boot();
    const command = { command: "board.cycle", args: { direction: 1 } };
    expect(app.invoke("control:ready")).toEqual({ ok: false });
    await app.loaded();
    await app.invoke("control:getSettings");
    expect(app.ready()).toEqual({ ok: true });
    const previousToken = app.window.webContents.send.mock.calls.findLast(([channel]) => channel === "control-ready-token")[1];
    const readyFromOutgoingDocument = () => app.invoke("control:ready", app.event, previousToken);
    app.window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(readyFromOutgoingDocument()).toEqual({ ok: false });
    expect(app.onCommand(command).code).toBe("unavailable");
    app.window.webContents.send.mockClear();
    // An outgoing document's late load event must not deliver a new token.
    app.window.webContents.emit("did-finish-load");
    expect(app.window.webContents.send).not.toHaveBeenCalled();
    app.window.webContents.emit("did-navigate");
    expect(readyFromOutgoingDocument()).toEqual({ ok: false });
    app.window.webContents.emit("did-finish-load");
    expect(readyFromOutgoingDocument()).toEqual({ ok: false });
    expect(app.onCommand(command).code).toBe("unavailable");
    expect(app.ready()).toEqual({ ok: true });
    expect(app.onCommand(command)).toEqual({ ok: true });
    await app.bridge.stop();
  });

  it.each(["did-start-navigation", "render-process-gone"])("rejects outgoing state, library saves and capture after %s", async (name) => {
    const app = await boot();
    await app.loaded();
    await app.invoke("control:getSettings");
    app.ready();
    const token = app.token();
    const library = await app.invoke("library:load");
    const playback = [{ soundId: "sound-a", startedAt: 1, duration: 2, loop: true }];
    expect(app.invoke("control:state", app.event, { playback }, token)).toEqual({ ok: true });
    expect(app.invoke("hotkeys:capture", app.event, true, token)).toEqual({ ok: true });
    expect(app.onCommand({ command: "board.cycle", args: {} })).toMatchObject({ code: "busy" });
    app.window.webContents.emit(name, { isMainFrame: true, isSameDocument: false });
    const obsolete = () => {
      expect(app.invoke("control:state", app.event, { playback }, token)).toEqual({ ok: false });
      expect(app.invoke("library:save", app.event, { ...library, activeBoardId: "old" }, token)).toEqual({ ok: false });
      expect(app.invoke("hotkeys:capture", app.event, true, token)).toEqual({ ok: false });
      expect(app.bridge.getSnapshot().playback).toEqual([]);
    };
    obsolete();
    app.documentLoaded();
    app.ready();
    obsolete();
    expect(app.onCommand({ command: "board.cycle", args: {} })).toEqual({ ok: true });
    await app.bridge.stop();
  });

  it("discards a library read that finishes after its source document is replaced", async () => {
    const app = await boot();
    await app.loaded();
    await app.invoke("control:getSettings");
    const original = await app.invoke("library:load");
    const pendingRead = deferred();
    app.fileSystem.readFile.mockReturnValueOnce(pendingRead.promise);
    const outgoingLoad = app.invoke("library:load");
    await vi.waitFor(() => expect(app.fileSystem.readFile.mock.lastCall[0]).toContain("library.json"));
    app.window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    app.documentLoaded();
    const current = { ...original, activeBoardId: "new-board", boards: [{ id: "new-board", name: "New", sounds: [] }] };
    const save = app.invoke("library:save", app.event, current);
    pendingRead.resolve(JSON.stringify(original));
    await outgoingLoad;
    await save;
    expect(app.bridge.getSnapshot().library).toMatchObject({ activeBoardId: "new-board", boards: [{ id: "new-board" }] });
    expect(await app.invoke("library:load")).toEqual(current);
    await app.bridge.stop();
  });

  it("orders accepted disk writes and the replacement document's load across reload", async () => {
    const app = await boot();
    await app.loaded();
    await app.invoke("control:getSettings");
    const original = await app.invoke("library:load");
    const written = deferred();
    const writeFile = app.fileSystem.writeFile.getMockImplementation();
    app.fileSystem.writeFile.mockImplementationOnce(async (file, data) => {
      await written.promise;
      await writeFile(file, data);
    });
    const firstLibrary = { ...original, boards: [{ id: "first", name: "First", sounds: [] }], activeBoardId: "first" };
    const lastLibrary = { ...original, boards: [{ id: "last", name: "Last", sounds: [] }], activeBoardId: "last" };
    const first = app.invoke("library:save", app.event, firstLibrary);
    await vi.waitFor(() => expect(app.fileSystem.writeFile.mock.lastCall[1]).toContain('"first"'));
    const last = app.invoke("library:save", app.event, lastLibrary);
    expect(app.bridge.getSnapshot().activeBoardId).toBe("last");
    app.window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    app.documentLoaded();
    const reloaded = app.invoke("library:load");
    written.resolve();
    await Promise.all([first, last]);
    expect(await reloaded).toEqual(lastLibrary);
    expect(app.bridge.getSnapshot().activeBoardId).toBe("last");
    await app.bridge.stop();
  });

  it("relays disconnect cancellation by request id and removes listeners after completion", async () => {
    const app = await boot();
    await app.loaded();
    await app.invoke("control:getSettings");
    app.ready();
    const firstCancellation = new AbortController();
    const secondCancellation = new AbortController();
    const play = { command: "sound.play", args: { soundId: "sound-a" } };
    const first = app.onCommand(play, firstCancellation.signal);
    const firstId = app.window.webContents.send.mock.lastCall[1].requestId;
    const second = app.onCommand(play, secondCancellation.signal);
    const secondId = app.window.webContents.send.mock.lastCall[1].requestId;
    firstCancellation.abort();
    expect(app.window.webContents.send).toHaveBeenLastCalledWith("control-command", { command: "sound.cancel", requestId: firstId });
    expect(await first).toEqual({ ok: false, code: "unavailable" });
    expect(app.invoke("control:result", app.event, firstId, { ok: true })).toEqual({ ok: false });
    app.invoke("control:result", app.event, secondId, { ok: true });
    expect(await second).toEqual({ ok: true });
    const sent = app.window.webContents.send.mock.calls.length;
    secondCancellation.abort();
    expect(app.window.webContents.send).toHaveBeenCalledTimes(sent);
    expect(await app.onCommand(play, firstCancellation.signal)).toEqual({ ok: false, code: "unavailable" });
    expect(app.window.webContents.send).toHaveBeenCalledTimes(sent);
    await app.bridge.stop();
  });

  it.each([{ ok: true }, { ok: false, code: "unavailable" }, { ok: false, code: "internal-error" }])("waits for the renderer playback result %j", async (result) => {
    const app = await boot();
    await app.loaded();
    await app.invoke("control:getSettings");
    app.ready();
    const command = { command: "sound.play", args: { soundId: "sound-a" } };
    const completed = vi.fn();
    const pending = app.onCommand(command).then(completed);
    const [channel, request] = app.window.webContents.send.mock.lastCall;
    expect(channel).toBe("control-command");
    expect(request).toMatchObject(command);
    expect(request.requestId).toBeTypeOf("string");
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(() => app.invoke("control:result", { ...app.event, senderFrame: { url: app.event.senderFrame.url } }, request.requestId, result)).toThrow("Untrusted IPC sender");
    expect(() => app.invoke("control:result", app.event, request.requestId, { ok: "yes" })).toThrow("Invalid control playback result");
    expect(app.invoke("control:result", app.event, request.requestId, result)).toEqual({ ok: true });
    await pending;
    expect(completed).toHaveBeenCalledExactlyOnceWith(result);
    expect(app.invoke("control:result", app.event, request.requestId, result)).toEqual({ ok: false });
    await app.bridge.stop();
  });

  it.each(["did-start-navigation", "render-process-gone", "destroyed", "closed"])("fails pending playback when the renderer emits %s", async (name) => {
    const app = await boot();
    await app.loaded();
    await app.invoke("control:getSettings");
    app.ready();
    const pending = app.onCommand({ command: "sound.play", args: { soundId: "sound-a" } });
    const requestId = app.window.webContents.send.mock.lastCall[1].requestId;
    const target = name === "closed" ? app.window : app.window.webContents;
    target.emit(name, { isMainFrame: true, isSameDocument: false });
    expect(app.window.webContents.send).toHaveBeenCalledWith("control-command", { command: "sound.cancel", requestId });
    expect(await pending).toEqual({ ok: false, code: "unavailable" });
    if (name !== "closed") expect(app.invoke("control:result", app.event, requestId, { ok: true })).toEqual({ ok: false });
    await app.bridge.stop();
  });

  it("returns trusted renderer acknowledgements through the shared readiness gate", async () => {
    const app = await boot();
    await app.loaded();
    app.ready();
    const setting = app.onCommand({ command: "setting.toggle", args: { key: "micPassthrough" } });
    const settingRequest = app.window.webContents.send.mock.lastCall[1];
    const volume = app.onCommand({ command: "volume.mute", args: { bus: "micVirtual" } });
    const volumeRequest = app.window.webContents.send.mock.lastCall[1];
    const settingResult = { ok: true, data: { key: "micPassthrough", value: true } };
    const volumeResult = { ok: true, data: { bus: "micVirtual", value: 0.6, muted: true } };
    expect(() => app.invoke("control:result", { ...app.event, senderFrame: { url: app.event.senderFrame.url } }, volumeRequest.requestId, volumeResult)).toThrow("Untrusted IPC sender");
    app.invoke("control:result", undefined, volumeRequest.requestId, volumeResult);
    app.invoke("control:result", undefined, settingRequest.requestId, settingResult);
    expect(await volume).toEqual(volumeResult);
    expect(await setting).toEqual(settingResult);
    app.invoke("hotkeys:capture", undefined, true);
    expect(app.onCommand({ command: "volume.mute", args: { bus: "micVirtual" } })).toEqual({ ok: false, code: "busy" });
    expect(app.onCommand({ command: "board.cycle", args: {} })).toEqual({ ok: false, code: "busy" });
    await app.bridge.stop();
  });

  it("cancels pending replies and clears readiness on shutdown", async () => {
    const app = await boot();
    await app.loaded();
    app.ready();
    const command = { command: "setting.toggle", args: { key: "micPassthrough" } };
    const pending = app.onCommand(command);
    app.window.emit("session-end");
    expect(await pending).toEqual({ ok: false, code: "unavailable" });
    expect(app.onCommand(command)).toEqual({ ok: false, code: "unavailable" });
    await app.bridge.stop();
  });

  it.each(["EACCES", "ENOSPC", "EISDIR"])("opens the window despite %s app-data failures and reports a bridge error", async (code) => {
    const app = await boot(Object.assign(new Error("Storage failure"), { code }));
    expect(app.window).toBeDefined();
    await app.loaded();
    await vi.waitFor(() => expect(app.bridge.getState()).toMatchObject({ listening: false, error: { code } }));
    expect((await app.invoke("control:getSettings")).error.code).toBe(code);
    await app.bridge.stop();
  });
});
