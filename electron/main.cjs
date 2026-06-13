const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createCorsairBridge, isGKeyAccelerator } = require("./corsair.cjs");
const { createHotkeyEngine } = require("./hotkeys.cjs");

const isDev = !app.isPackaged;
if (isDev && process.env.SOUNDDECK_USER_DATA) app.setPath("userData", process.env.SOUNDDECK_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
}

let mainWindow;
let tray;
let isQuitting = false;
let corsairBindings = new Map();
let hotkeyCaptureActive = false;

const hotkeyEngine = createHotkeyEngine({
  onTrigger: (binding) => mainWindow?.webContents.send("hotkey-trigger", binding)
});

const corsair = createCorsairBridge({
  onKey: (key) => {
    mainWindow?.webContents.send("corsair-gkey", key);
    // While capturing, the pressed G-key is being recorded as a new bind;
    // firing its existing binding here would play/stop/switch mid-capture.
    if (hotkeyCaptureActive) return;
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

function bundledYtDlpCandidates() {
  const fileName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const packagedCandidates = [
    path.join(process.resourcesPath || "", "app.asar.unpacked", "node_modules", "youtube-dl-exec", "bin", fileName),
    path.join(process.resourcesPath || "", "app", "node_modules", "youtube-dl-exec", "bin", fileName),
    path.join(process.resourcesPath || "", "node_modules", "youtube-dl-exec", "bin", fileName)
  ];
  const devCandidates = [
    path.join(__dirname, "..", "node_modules", "youtube-dl-exec", "bin", fileName)
  ];
  const candidates = app.isPackaged ? [...packagedCandidates, ...devCandidates] : [...devCandidates, ...packagedCandidates];

  try {
    candidates.push(require("youtube-dl-exec").constants.YOUTUBE_DL_PATH);
  } catch {
    // Fallback candidates below cover normal dev and packaged layouts.
  }

  return [...new Set(candidates.filter(Boolean))];
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
          micVirtualVolume: 1,
          micMonitorVolume: 1,
          soundboardVirtualVolume: 1,
          soundboardMonitorVolume: 1,
          monitorDeviceId: "",
          microphoneDeviceId: "",
          stopAllHotkey: "Ctrl+Alt+Space",
          cycleBoardsHotkey: ""
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

function allowedAudioExtensions() {
  return new Set([".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".webm"]);
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

async function importMediaPaths(filePaths) {
  await ensureLibrary();
  const allowed = allowedAudioExtensions();
  const imported = [];
  for (const sourcePath of filePaths) {
    try {
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
    } catch (error) {
      imported.push({ ok: false, sourcePath, reason: error?.message || "failed-to-import" });
    }
  }
  return imported;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function runYtDlp(args, cwd) {
  const bundledCandidates = bundledYtDlpCandidates().map((command) => ({ command, args }));
  const candidates = process.platform === "win32"
    ? [
        ...bundledCandidates,
        { command: "yt-dlp.exe", args },
        { command: "yt-dlp", args },
        { command: "py", args: ["-m", "yt_dlp", ...args] },
        { command: "python", args: ["-m", "yt_dlp", ...args] }
      ]
    : [
        ...bundledCandidates,
        { command: "yt-dlp", args },
        { command: "python3", args: ["-m", "yt_dlp", ...args] },
        { command: "python", args: ["-m", "yt_dlp", ...args] }
      ];

  return new Promise((resolve, reject) => {
    let index = 0;
    const failures = [];

    const tryNext = () => {
      const candidate = candidates[index++];
      if (!candidate) {
        reject(new Error(`yt-dlp could not be started. Reinstall dependencies or make sure yt-dlp is on PATH, then try again. Tried: ${failures.join("; ")}`));
        return;
      }

      let child;
      try {
        child = spawn(candidate.command, candidate.args, {
          cwd,
          windowsHide: true,
          shell: false
        });
      } catch (error) {
        failures.push(`${candidate.command}: ${error?.message || error}`);
        tryNext();
        return;
      }
      let stdout = "";
      let stderr = "";
      let candidateFinished = false;

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        if (candidateFinished) return;
        candidateFinished = true;
        failures.push(`${candidate.command}: ${error.message}`);
        if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) {
          tryNext();
        } else {
          reject(new Error(`${candidate.command} could not be started: ${error.message}`));
        }
      });
      child.on("close", (code) => {
        if (candidateFinished) return;
        candidateFinished = true;
        if (code === 0) resolve({ stdout, stderr });
        else {
          const output = (stderr || stdout).trim();
          const reason = output || `exited with code ${code}`;
          failures.push(`${candidate.command}: ${reason}`);
          if (code === -4058 || /No module named yt_dlp/i.test(output)) tryNext();
          else reject(new Error(`${candidate.command} ${reason}`));
        }
      });
    };

    tryNext();
  });
}

async function listFilesRecursive(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

async function removeTempDir(tempDir) {
  try {
    await fs.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200
    });
  } catch (error) {
    console.warn(`Could not remove temporary download folder ${tempDir}:`, error);
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
  corsairBindings = new Map();

  const results = [];
  const keyboardBindings = [];
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
    keyboardBindings.push(binding);
  }
  results.push(...hotkeyEngine.register(keyboardBindings));
  return results;
}

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function setupAutoUpdates() {
  // Portable builds have no installer to hand updates to; only the NSIS
  // install supports auto-update.
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (error) {
    console.error("electron-updater unavailable:", error);
    return;
  }
  const sendStatus = (status) => mainWindow?.webContents.send("update-status", status);
  autoUpdater.on("error", (error) => console.error("Auto-update error:", error));
  autoUpdater.on("update-available", (info) => sendStatus({ state: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("download-progress", (progress) => sendStatus({ state: "downloading", percent: progress.percent }));
  autoUpdater.on("update-downloaded", (info) => sendStatus({ state: "ready", version: info.version }));
  ipcMain.handle("update:install", () => {
    isQuitting = true;
    // Silent install with auto-relaunch: no installer pages, no "run app?" prompt.
    autoUpdater.quitAndInstall(true, true);
  });
  const check = () => autoUpdater.checkForUpdates().catch((error) => {
    console.error("Auto-update check failed:", error);
  });
  check();
  // Long-running sessions (app lives in the tray) should still pick up new
  // releases without a restart.
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(async () => {
  await createWindow();
  createTray();
  corsair.start();
  setupAutoUpdates();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  hotkeyEngine.stop();
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

ipcMain.handle("board:export", async (_event, board) => {
  const target = await dialog.showSaveDialog(mainWindow, {
    title: `Export board "${board?.name || "board"}"`,
    defaultPath: `${sanitizeName(board?.name)}.sdboard`,
    filters: [{ name: "SoundDeck Board", extensions: ["sdboard"] }]
  });
  if (target.canceled || !target.filePath) return { ok: false, canceled: true };
  // Audio bytes are embedded so the backup stays valid after the originals are deleted.
  const media = {};
  for (const sound of board?.sounds || []) {
    if (!sound.storedName || media[sound.storedName]) continue;
    try {
      media[sound.storedName] = (await fs.readFile(sound.mediaPath)).toString("base64");
    } catch {
      // Missing source audio: keep the slot in the backup, restore will skip it.
    }
  }
  await fs.writeFile(target.filePath, JSON.stringify({ format: "sounddeck-board", version: 1, board, media }));
  return { ok: true, filePath: target.filePath };
});

ipcMain.handle("board:import", async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: "Import a board file",
    properties: ["openFile"],
    filters: [{ name: "SoundDeck Board", extensions: ["sdboard"] }]
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
  let payload;
  try {
    payload = await readJson(picked.filePaths[0]);
  } catch {
    return { ok: false, reason: "unreadable-file" };
  }
  if (payload?.format !== "sounddeck-board" || !payload.board || !Array.isArray(payload.board.sounds)) {
    return { ok: false, reason: "not-a-board-backup" };
  }
  await ensureLibrary();
  // Fresh ids and media files so a restored board never collides with the original.
  const restoredPaths = new Map();
  const sounds = [];
  for (const sound of payload.board.sounds) {
    const data = payload.media?.[sound.storedName];
    if (typeof data !== "string") continue;
    let mediaPath = restoredPaths.get(sound.storedName);
    if (!mediaPath) {
      const ext = path.extname(sound.storedName) || sound.ext || "";
      mediaPath = path.join(mediaRoot(), `${crypto.randomUUID()}${ext}`);
      await fs.writeFile(mediaPath, Buffer.from(data, "base64"));
      restoredPaths.set(sound.storedName, mediaPath);
    }
    sounds.push({ ...sound, id: crypto.randomUUID(), mediaPath, storedName: path.basename(mediaPath) });
  }
  return { ok: true, board: { ...payload.board, sounds } };
});

ipcMain.handle("media:import", async (_event, filePaths) => {
  return importMediaPaths(Array.isArray(filePaths) ? filePaths : []);
});

ipcMain.handle("media:download", async (_event, urls) => {
  await ensureLibrary();
  const requestedUrls = Array.isArray(urls) ? urls.map((url) => String(url).trim()).filter(Boolean) : [];
  const allowed = allowedAudioExtensions();
  const results = [];
  for (const url of requestedUrls) {
    if (!isHttpUrl(url)) {
      results.push({ ok: false, sourceUrl: url, sourcePath: url, reason: "Enter a valid http or https URL." });
      continue;
    }

    let tempDir = "";
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sounddeck-ytdlp-"));
      await runYtDlp([
        "--no-playlist",
        "--format",
        "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
        "--output",
        "%(title).180B.%(ext)s",
        url
      ], tempDir);
      const downloaded = (await listFilesRecursive(tempDir))
        .filter((filePath) => allowed.has(path.extname(filePath).toLowerCase()));
      if (!downloaded.length) {
        results.push({ ok: false, sourceUrl: url, sourcePath: url, reason: "yt-dlp did not produce a supported audio file." });
        continue;
      }
      const imported = await importMediaPaths(downloaded);
      results.push(...imported.map((result) => ({ ...result, sourceUrl: url })));
    } catch (error) {
      results.push({ ok: false, sourceUrl: url, sourcePath: url, reason: error?.message || "Download failed." });
    } finally {
      if (tempDir) await removeTempDir(tempDir);
    }
  }
  return results;
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

ipcMain.handle("hotkeys:capture", (_event, active) => {
  hotkeyCaptureActive = Boolean(active);
  hotkeyEngine.setSuspended(hotkeyCaptureActive);
  return { ok: true };
});

ipcMain.handle("corsair:status", async () => corsair.getState());

ipcMain.handle("app:openExternal", async (_event, url) => {
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("app:getVersion", () => app.getVersion());
