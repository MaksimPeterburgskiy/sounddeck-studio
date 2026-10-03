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

async function boot(storageError) {
  const handlers = new Map();
  let window;
  let onCommand;
  let bridge;
  let startup;
  let finishLoading;
  const fileSystem = {
    readFile: async (file) => {
      if (file.endsWith("app-settings.json")) return "{}";
      if (storageError) throw storageError;
      throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    },
    mkdir: async () => { if (storageError) throw storageError; },
    access: async () => { throw storageError || new Error("Not found"); },
    writeFile: async () => {}, chmod: async () => {}, rename: async () => {}, unlink: async () => {}
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
  return { window, bridge, onCommand, event, invoke: (name, sender = event) => handlers.get(name)(sender),
    loaded: async () => { finishLoading(); await startup; } };
}

describe("main-process external control lifecycle", () => {
  it("requires trusted renderer readiness and clears it on reload, crash and destruction", async () => {
    const app = await boot();
    const command = { command: "board.cycle", args: { direction: 1 } };
    expect(app.onCommand(command)).toEqual({ ok: false, code: "unavailable" });
    expect(() => app.invoke("control:ready", { ...app.event, senderFrame: { url: app.event.senderFrame.url } })).toThrow("Untrusted IPC sender");
    await app.loaded();
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
      app.window.webContents.emit(name, { isMainFrame: true, isSameDocument: false });
      expect(app.onCommand(command).code).toBe("unavailable");
      app.invoke("control:ready");
    }
    app.window.emit("closed");
    expect(app.onCommand(command).code).toBe("unavailable");
    await app.bridge.stop();
  });

  it.each(["EACCES", "ENOSPC", "EISDIR"])("opens the window despite %s app-data failures and reports a bridge error", async (code) => {
    const app = await boot(Object.assign(new Error("Storage failure"), { code }));
    expect(app.window).toBeDefined();
    await app.loaded();
    await vi.waitFor(() => expect(app.bridge.getState()).toMatchObject({ listening: false, error: { code } }));
    expect(app.invoke("control:getSettings").error.code).toBe(code);
    await app.bridge.stop();
  });
});
