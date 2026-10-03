import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import controlModule from "./externalControl.cjs";

const mainFile = fileURLToPath(new URL("./main.cjs", import.meta.url));
const require = createRequire(mainFile);

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
    loadFile() { return new Promise((resolve) => { finishLoading = resolve; }); }
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
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} },
    nativeImage: { createFromPath: () => icon }
  };
  const overrides = {
    electron, "node:fs/promises": fileSystem,
    "./hotkeys.cjs": { createHotkeyEngine: () => ({}) },
    "./corsair.cjs": { createCorsairBridge: () => ({ start: () => {} }) },
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
  return { window, bridge, onCommand, event, fileSystem, invoke: (name, sender = event, ...args) => handlers.get(name)(sender, ...args),
    loaded: async () => { finishLoading(); await startup; } };
}

describe("main-process external control lifecycle", () => {
  it("waits for persisted settings before and during background startup", async () => {
    const app = await boot();
    const stored = deferred();
    const readFile = app.fileSystem.readFile.getMockImplementation();
    app.fileSystem.readFile.mockImplementation((file) => file.endsWith("external-control.json") ? stored.promise : readFile(file));
    const received = vi.fn();
    const early = app.invoke("control:getSettings").then(received);
    await vi.waitFor(() => expect(app.fileSystem.readFile).toHaveBeenCalledWith("/test/userData/external-control.json", "utf8"));
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
    await Promise.resolve();
    expect(app.fileSystem.access.mock.calls.filter(([file]) => file.endsWith("library.json"))).toHaveLength(1);
    expect(app.fileSystem.readFile.mock.calls.filter(([file]) => file.endsWith("library.json"))).toHaveLength(0);
    written.resolve();
    const libraries = await Promise.all([first, second]);
    expect(libraries[0]).toMatchObject({ activeBoardId: "board-default", boards: [{ id: "board-default" }] });
    expect(libraries[1]).toEqual(libraries[0]);
    expect(app.fileSystem.writeFile.mock.calls.filter(([file]) => file.endsWith("library.json"))).toHaveLength(1);
    await app.invoke("control:getSettings");
    expect(app.bridge.getSnapshot().activeBoardId).toBe("board-default");
    await app.bridge.stop();
  });

  it("allows library initialization to retry after a storage failure", async () => {
    const app = await boot();
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
    expect(app.onCommand(command)).toEqual({ ok: false, code: "unavailable" });
    expect(() => app.invoke("control:ready", { ...app.event, senderFrame: { url: app.event.senderFrame.url } })).toThrow("Untrusted IPC sender");
    await app.loaded();
    await app.invoke("control:getSettings");
    expect(app.onCommand(command).code).toBe("unavailable");
    app.invoke("control:ready");
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
      const updateLiveState = vi.spyOn(app.bridge, "updateLiveState");
      app.window.webContents.emit(name, { isMainFrame: true, isSameDocument: false });
      expect(app.onCommand(command).code).toBe("unavailable");
      expect(updateLiveState).toHaveBeenLastCalledWith({ activeBoardId: "board-default", playback: [] });
      expect(app.bridge.getSnapshot()).toMatchObject({ activeBoardId: "board-default", playback: [] });
      updateLiveState.mockRestore();
      app.invoke("control:ready");
    }
    app.window.emit("closed");
    expect(app.onCommand(command).code).toBe("unavailable");
    await app.bridge.stop();
  });

  it.each([{ ok: true }, { ok: false, code: "unavailable" }, { ok: false, code: "internal-error" }])("waits for the renderer playback result %j", async (result) => {
    const app = await boot();
    await app.loaded();
    await app.invoke("control:getSettings");
    app.invoke("control:ready");
    const command = { command: "sound.play", args: { soundId: "sound-a" } };
    const completed = vi.fn();
    const pending = app.onCommand(command).then(completed);
    const [channel, request] = app.window.webContents.send.mock.lastCall;
    expect(channel).toBe("control-command");
    expect(request).toMatchObject(command);
    expect(request.requestId).toBeTypeOf("string");
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(() => app.invoke("control:playbackResult", { ...app.event, senderFrame: { url: app.event.senderFrame.url } }, request.requestId, result)).toThrow("Untrusted IPC sender");
    expect(() => app.invoke("control:playbackResult", app.event, request.requestId, { ok: "yes" })).toThrow("Invalid control playback result");
    expect(app.invoke("control:playbackResult", app.event, request.requestId, result)).toEqual({ ok: true });
    await pending;
    expect(completed).toHaveBeenCalledExactlyOnceWith(result);
    expect(app.invoke("control:playbackResult", app.event, request.requestId, result)).toEqual({ ok: false });
    await app.bridge.stop();
  });

  it.each(["did-start-navigation", "render-process-gone", "destroyed", "closed"])("fails pending playback when the renderer emits %s", async (name) => {
    const app = await boot();
    await app.loaded();
    await app.invoke("control:getSettings");
    app.invoke("control:ready");
    const pending = app.onCommand({ command: "sound.play", args: { soundId: "sound-a" } });
    const requestId = app.window.webContents.send.mock.lastCall[1].requestId;
    const target = name === "closed" ? app.window : app.window.webContents;
    target.emit(name, { isMainFrame: true, isSameDocument: false });
    expect(await pending).toEqual({ ok: false, code: "unavailable" });
    if (name !== "closed") expect(app.invoke("control:playbackResult", app.event, requestId, { ok: true })).toEqual({ ok: false });
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
