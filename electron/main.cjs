const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, globalShortcut, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { createCorsairBridge, isGKeyAccelerator } = require("./corsair.cjs");

const isDev = !app.isPackaged;
if (isDev && process.env.SOUNDDECK_USER_DATA) app.setPath("userData", process.env.SOUNDDECK_USER_DATA);
let mainWindow;
let tray;
let isQuitting = false;
let registered = new Map();
let corsairBindings = new Map();

const corsair = createCorsairBridge({
  onKey: (key) => {
    mainWindow?.webContents.send("corsair-gkey", key);
    const binding = corsairBindings.get(key);
    if (binding) mainWindow?.webContents.send("hotkey-trigger", binding);
  },
  onStateChange: (state) => {
    mainWindow?.webContents.send("corsair-status", state);
  }
});

function appRoot() {
  return path.join(app.getPath("userData"), "library");
}

function libraryFile() {
  return path.join(appRoot(), "library.json");
}

function mediaRoot() {
  return path.join(appRoot(), "media");
}

async function ensureLibrary() {
  await fs.mkdir(mediaRoot(), { recursive: true });
  try {
    await fs.access(libraryFile());
  } catch {
    const now = new Date().toISOString();
    await fs.writeFile(
      libraryFile(),
      JSON.stringify({
        version: 1,
        activeBoardId: "board-default",
        settings: {
          micPassthrough: false,
          soundboardToVirtualMic: false,
          monitorToHeadphones: true,
          monitorMicToHeadphones: false,
          micVolume: 0.85,
          soundboardVolume: 0.9,
          monitorVolume: 0.8,
          monitorDeviceId: "",
          microphoneDeviceId: "",
          stopAllHotkey: "CommandOrControl+Alt+Space"
        },
        boards: [
          {
            id: "board-default",
            name: "Main Board",
            color: "#1db7a6",
            icon: "zap",
            createdAt: now,
            updatedAt: now,
            sounds: []
          }
        ]
      }, null, 2)
    );
  }
}

function sanitizeName(input) {
  return String(input || "sound")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "sound";
}

function inferMime(ext) {
  const normalized = ext.toLowerCase();
  return {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".webm": "audio/webm"
  }[normalized] || "application/octet-stream";
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function canReachUrl(url, timeoutMs = 350) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(
      parsed,
      { method: "HEAD", timeout: timeoutMs },
      (response) => {
        response.resume();
        resolve(true);
      }
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end();
  });
}

async function loadRenderer(window) {
  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  const builtIndex = path.join(__dirname, "../dist/index.html");

  if (isDev) {
    if (await canReachUrl(devUrl)) {
      await window.loadURL(devUrl);
      return;
    }
    if (await fileExists(builtIndex)) {
      await window.loadFile(builtIndex);
      return;
    }
    throw new Error(`Renderer not available. Start Vite with "npm run dev" or build first with "npm run build". Tried ${devUrl} and ${builtIndex}.`);
  }

  await window.loadFile(builtIndex);
}

function trayIconPath() {
  return isDev
    ? path.join(__dirname, "../build/icon.ico")
    : path.join(process.resourcesPath, "icon.ico");
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(trayIconPath());
  tray = new Tray(icon);
  tray.setToolTip("SoundDeck Studio");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Open SoundDeck Studio",
      click: () => showMainWindow()
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("double-click", () => showMainWindow());
}

async function createWindow() {
  await ensureLibrary();
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: "#101114",
    title: "SoundDeck Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev) {
    mainWindow.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (input.key === "F12" || (input.control && input.shift && input.key.toUpperCase() === "I")) {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
      if (input.control && input.key.toUpperCase() === "R") {
        mainWindow.webContents.reload();
        event.preventDefault();
      }
    });
  }

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  await loadRenderer(mainWindow);
}

function registerHotkeys(bindings) {
  for (const accelerator of registered.keys()) {
    globalShortcut.unregister(accelerator);
  }
  registered = new Map();
  corsairBindings = new Map();

  const results = [];
  for (const binding of bindings) {
    if (!binding.accelerator) continue;
    if (isGKeyAccelerator(binding.accelerator)) {
      const key = binding.accelerator.trim().toUpperCase();
      if (corsairBindings.has(key)) {
        results.push({ ...binding, ok: false, reason: "duplicate" });
        continue;
      }
      corsairBindings.set(key, binding);
      const connected = corsair.isConnected();
      results.push({ ...binding, ok: connected, reason: connected ? "" : "icue-not-connected" });
      continue;
    }
    if (registered.has(binding.accelerator)) {
      results.push({ ...binding, ok: false, reason: "duplicate" });
      continue;
    }
    try {
      const ok = globalShortcut.register(binding.accelerator, () => {
        mainWindow?.webContents.send("hotkey-trigger", binding);
      });
      if (ok) registered.set(binding.accelerator, binding);
      results.push({ ...binding, ok, reason: ok ? "" : "system-or-app-conflict" });
    } catch (error) {
      results.push({ ...binding, ok: false, reason: "invalid-accelerator" });
    }
  }
  return results;
}

app.whenReady().then(async () => {
  await createWindow();
  createTray();
  corsair.start();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  corsair.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("library:load", async () => {
  await ensureLibrary();
  return readJson(libraryFile());
});

ipcMain.handle("library:save", async (_event, library) => {
  await ensureLibrary();
  await fs.writeFile(libraryFile(), JSON.stringify(library, null, 2));
  return { ok: true };
});

ipcMain.handle("library:reveal", async () => {
  await ensureLibrary();
  await shell.openPath(appRoot());
  return { ok: true };
});

ipcMain.handle("library:export", async (_event, library) => {
  const target = await dialog.showSaveDialog(mainWindow, {
    title: "Export SoundDeck library backup",
    defaultPath: `sounddeck-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "SoundDeck Backup", extensions: ["json"] }]
  });
  if (target.canceled || !target.filePath) return { ok: false, canceled: true };
  await fs.writeFile(target.filePath, JSON.stringify(library, null, 2));
  return { ok: true, filePath: target.filePath };
});

ipcMain.handle("library:importBackup", async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: "Import SoundDeck library backup",
    properties: ["openFile"],
    filters: [{ name: "SoundDeck Backup", extensions: ["json"] }]
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
  const imported = await readJson(picked.filePaths[0]);
  await fs.writeFile(libraryFile(), JSON.stringify(imported, null, 2));
  return { ok: true, library: imported };
});

ipcMain.handle("media:import", async (_event, filePaths) => {
  await ensureLibrary();
  const allowed = new Set([".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".webm"]);
  const imported = [];
  for (const sourcePath of filePaths) {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) continue;
    const ext = path.extname(sourcePath).toLowerCase();
    if (!allowed.has(ext)) {
      imported.push({ ok: false, sourcePath, reason: "unsupported-format" });
      continue;
    }
    const id = crypto.randomUUID();
    const baseName = sanitizeName(path.basename(sourcePath, ext));
    const storedName = `${id}${ext}`;
    const dest = path.join(mediaRoot(), storedName);
    await fs.copyFile(sourcePath, dest);
    imported.push({
      ok: true,
      id,
      title: baseName,
      sourcePath,
      mediaPath: dest,
      storedName,
      ext,
      mime: inferMime(ext),
      size: stat.size
    });
  }
  return imported;
});

ipcMain.handle("media:delete", async (_event, mediaPath) => {
  const resolved = path.resolve(String(mediaPath || ""));
  const root = path.resolve(mediaRoot());
  if (!resolved.startsWith(root + path.sep)) {
    return { ok: false, reason: "outside-media-root" };
  }
  try {
    await fs.rm(resolved, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
});

ipcMain.handle("media:read", async (_event, mediaPath) => {
  const data = await fs.readFile(mediaPath);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

ipcMain.handle("media:saveRecording", async (_event, payload) => {
  await ensureLibrary();
  const id = crypto.randomUUID();
  const ext = payload.ext || ".webm";
  const title = sanitizeName(payload.title || "Recording");
  const dest = path.join(mediaRoot(), `${id}${ext}`);
  await fs.writeFile(dest, Buffer.from(payload.bytes));
  const stat = await fs.stat(dest);
  return {
    ok: true,
    id,
    title,
    mediaPath: dest,
    storedName: `${id}${ext}`,
    ext,
    mime: inferMime(ext),
    size: stat.size
  };
});

ipcMain.handle("hotkeys:register", async (_event, bindings) => registerHotkeys(bindings));

ipcMain.handle("corsair:status", async () => corsair.getState());

ipcMain.handle("app:openExternal", async (_event, url) => {
  await shell.openExternal(url);
  return { ok: true };
});
