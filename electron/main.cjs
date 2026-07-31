const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, systemPreferences } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createCorsairBridge, isCorsairSupportedPlatform, isGKeyAccelerator } = require("./corsair.cjs");
const { createHotkeyEngine } = require("./hotkeys.cjs");
const { buildCropArgs } = require("./ffmpegArgs.cjs");
const {
  packagedNativeToolPath,
  developmentNativeToolCandidates
} = require("./nativeTools.cjs");
const { shouldDetachProcessTree, terminateProcessTree } = require("./processTree.cjs");
const { createMacTrayTemplateImage, MAC_TRAY_ICON_FILENAME } = require("./trayIcon.cjs");
const { createShutdownLifecycle, registerWindowShutdown } = require("./shutdownLifecycle.cjs");
const { createUpdateInstallLifecycle } = require("./updateInstallLifecycle.cjs");
const { installedChannel, isStalePayload, normalizeChannelPreference, resolveUpdaterFlags } = require("./updateChannel.cjs");
const { getWindowsStartupState, hasStartupArg, startupLoginItemOptions, STARTUP_ARG, WINDOWS_STARTUP_NAME } = require("./startupSettings.cjs");
const {
  sanitizeName,
  inferMime,
  allowedAudioExtensions,
  safeAudioExtension,
  storedAudioExtension,
  isHttpUrl,
  isInsideMediaRoot
} = require("./mediaFiles.cjs");
const {
  rendererPolicy,
  isTrustedIpcSender,
  installNavigationGuards,
  isAllowedExternalUrl
} = require("./security.cjs");

const isDev = !app.isPackaged;
const builtIndex = path.join(__dirname, "../dist/index.html");
const devServerUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
let trustedRendererPolicy;
if (isDev && process.env.SOUNDDECK_USER_DATA) app.setPath("userData", process.env.SOUNDDECK_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (!hasStartupArg(argv)) {
      showMainWindow();
      return;
    }
    void readStartupPreferences()
      .then((preferences) => {
        if (!preferences.hideOnStartup) showMainWindow();
      })
      .catch(() => undefined);
  });
}

let mainWindow;
let tray;
let isQuitting = false;
let allowWindowCloseForUpdate = false;
let pendingShowMainWindow = false;
let corsairBindings = new Map();
let hotkeyCaptureActive = false;
let updateCheckTimer;
const registerIpcHandler = ipcMain.handle.bind(ipcMain);

const WINDOWS_LEGACY_STARTUP_NAMES = ["com.sounddeck.studio", "sounddeck-studio"];

function sendToMainWindow(channel, payload) {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  const webContents = window.webContents;
  if (!webContents || webContents.isDestroyed()) return;
  webContents.send(channel, payload);
}

function handleTrustedIpc(channel, handler) {
  registerIpcHandler(channel, (event, ...args) => {
    const trustedWebContents = mainWindow?.isDestroyed() ? null : mainWindow?.webContents;
    if (!isTrustedIpcSender(event, trustedWebContents, trustedRendererPolicy)) {
      throw new Error("Untrusted IPC sender");
    }
    return handler(event, ...args);
  });
}

const hotkeyEngine = createHotkeyEngine({
  onTrigger: (binding) => sendToMainWindow("hotkey-trigger", binding)
});

const corsair = createCorsairBridge({
  onKey: (key) => {
    sendToMainWindow("corsair-gkey", key);
    // While capturing, the pressed G-key is being recorded as a new bind;
    // firing its existing binding here would play/stop/switch mid-capture.
    if (hotkeyCaptureActive) return;
    const binding = corsairBindings.get(key);
    if (binding) sendToMainWindow("hotkey-trigger", binding);
  },
  onStateChange: (state) => {
    sendToMainWindow("corsair-status", state);
  }
});

const shutdownLifecycle = createShutdownLifecycle({
  onShutdown: () => {
    isQuitting = true;
    hotkeyCaptureActive = false;
    hotkeyEngine.stop();
    corsair.stop();
    if (updateCheckTimer) {
      clearInterval(updateCheckTimer);
      updateCheckTimer = undefined;
    }
    if (tray) {
      tray.destroy();
      tray = undefined;
    }
  },
  onError: (error) => console.error("Shutdown cleanup failed:", error)
});

const updateInstallLifecycle = createUpdateInstallLifecycle({
  setWindowCloseAllowed: (value) => { allowWindowCloseForUpdate = value; },
  isShuttingDown: () => shutdownLifecycle.isShuttingDown()
});

function appRoot() {
  return path.join(app.getPath("userData"), "library");
}

function libraryFile() {
  return path.join(appRoot(), "library.json");
}

function appSettingsFile() {
  return path.join(appRoot(), "app-settings.json");
}

function mediaRoot() {
  return path.join(appRoot(), "media");
}

function deepFilterResourcePath(fileName) {
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
  return path.join(root, "deepfilter", fileName);
}

function bundledYtDlpCandidates() {
  if (app.isPackaged) {
    return [packagedNativeToolPath({
      resourcesPath: process.resourcesPath,
      platform: process.platform,
      arch: process.arch,
      tool: "yt-dlp"
    })].filter(Boolean);
  }
  return developmentNativeToolCandidates({
    repoRoot: path.join(__dirname, ".."),
    platform: process.platform,
    arch: process.arch,
    tool: "yt-dlp"
  });
}

function ytDlpJsRuntimeArgs() {
  if (!process.versions.electron || !process.execPath) return [];
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  return ["--no-js-runtimes", "--js-runtimes", `node:${process.execPath}`];
}

function ytDlpSpawnEnv() {
  const env = { ...process.env };
  if (ytDlpJsRuntimeArgs().length) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

function bundledFfmpegPath() {
  if (app.isPackaged) {
    return packagedNativeToolPath({
      resourcesPath: process.resourcesPath,
      platform: process.platform,
      arch: process.arch,
      tool: "ffmpeg"
    });
  }
  return developmentNativeToolCandidates({
    repoRoot: path.join(__dirname, ".."),
    platform: process.platform,
    arch: process.arch,
    tool: "ffmpeg"
  })[0] || "ffmpeg";
}

function sounddeckPlatform() {
  if (process.platform === "win32" || process.platform === "darwin" || process.platform === "linux") return process.platform;
  return "unknown";
}

function managedVirtualBackend() {
  if (process.platform === "darwin") return "macos-bundled-blackhole";
  if (process.platform === "linux") return "linux-managed-pactl";
  if (process.platform === "win32") return "windows-vbcable";
  return "manual";
}

function macOSHotkeyPermissionHelpUrl() {
  return "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent";
}

function appCapabilities() {
  const hotkeyStatus = hotkeyEngine.getStatus?.() || {};
  const macAccessibilityTrusted = process.platform === "darwin" && systemPreferences?.isTrustedAccessibilityClient
    ? systemPreferences.isTrustedAccessibilityClient(false)
    : true;
  const lastFailureReason = process.platform === "darwin" && !macAccessibilityTrusted
    ? "macos-input-monitoring-permission"
    : hotkeyStatus.lastFailureReason || "";
  return {
    platform: sounddeckPlatform(),
    managedVirtualBackend: managedVirtualBackend(),
    managedVirtualMicAvailable: process.platform === "win32" || process.platform === "darwin" || process.platform === "linux",
    runAtStartupSupported: startupSettingsSupported(),
    hotkeys: {
      advancedHookAvailable: Boolean(hotkeyStatus.advancedHookAvailable),
      globalShortcutFallbackAvailable: Boolean(hotkeyStatus.globalShortcutFallbackAvailable),
      lastFailureReason,
      ...(process.platform === "darwin" ? { permissionHelpUrl: macOSHotkeyPermissionHelpUrl() } : {})
    },
    updateChecksSupported: app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR,
    corsairAvailable: isCorsairSupportedPlatform()
  };
}

function startupSettingsSupported() {
  if (process.platform === "win32" && process.env.PORTABLE_EXECUTABLE_DIR) return false;
  return process.platform === "darwin" || process.platform === "win32";
}

function startupUnsupportedReason() {
  if (process.platform === "win32" && process.env.PORTABLE_EXECUTABLE_DIR) return "portable-build";
  return "unsupported-platform";
}

function startupLoginItemQueryOptions() {
  if (process.platform !== "win32") return {};
  return {
    path: process.execPath,
    args: [STARTUP_ARG]
  };
}

function clearLegacyWindowsStartupItems() {
  if (process.platform !== "win32") return;
  for (const name of WINDOWS_LEGACY_STARTUP_NAMES) {
    app.setLoginItemSettings({ openAtLogin: false, enabled: false, name });
  }
}

function clearWindowsStartupItems() {
  if (process.platform !== "win32") return;
  app.setLoginItemSettings(startupLoginItemOptions(false));
  app.setLoginItemSettings({ openAtLogin: false, enabled: false, name: WINDOWS_STARTUP_NAME });
  app.setLoginItemSettings({ openAtLogin: false, enabled: false, name: WINDOWS_STARTUP_NAME, path: process.execPath });
  app.setLoginItemSettings({ openAtLogin: false, enabled: false, path: process.execPath });
  clearLegacyWindowsStartupItems();
}

function setWindowsStartupItem(openAtLogin, hideOnStartup = true, approved = openAtLogin) {
  app.setLoginItemSettings({
    ...startupLoginItemOptions(openAtLogin, hideOnStartup),
    enabled: Boolean(approved)
  });
}

function windowsStartupState(settings) {
  return getWindowsStartupState(settings, {
    name: WINDOWS_STARTUP_NAME,
    executablePath: process.execPath
  });
}

let appSettingsWriteQueue = Promise.resolve();

async function readAppSettingsFile() {
  try {
    return JSON.parse(await fs.readFile(appSettingsFile(), "utf8"));
  } catch {
    return {};
  }
}

async function readAppSettings() {
  await appSettingsWriteQueue;
  return readAppSettingsFile();
}

async function updateAppSettings(update) {
  const pendingWrite = appSettingsWriteQueue.then(async () => {
    await fs.mkdir(appRoot(), { recursive: true });
    const current = await readAppSettingsFile();
    await fs.writeFile(appSettingsFile(), JSON.stringify(update(current), null, 2));
  });
  appSettingsWriteQueue = pendingWrite.catch(() => undefined);
  return pendingWrite;
}

async function readStartupPreferences() {
  const settings = await readAppSettings();
  return {
    hideOnStartup: settings?.startup?.hideOnStartup !== false,
    runAtStartup: typeof settings?.startup?.runAtStartup === "boolean" ? settings.startup.runAtStartup : undefined
  };
}

async function writeStartupPreferences(preferences) {
  await updateAppSettings((current) => {
    const startup = { ...(current.startup || {}), ...preferences };
    return { ...current, startup };
  });
}

async function readUpdateChannelPreference() {
  const settings = await readAppSettings();
  return normalizeChannelPreference(settings?.updates?.channel);
}

async function writeUpdateChannelPreference(channel) {
  await updateAppSettings((current) => {
    const updates = { ...(current.updates || {}), channel };
    return { ...current, updates };
  });
}

async function getStartupSettings(argv = process.argv) {
  const preferences = await readStartupPreferences();
  if (!startupSettingsSupported()) {
    return { supported: false, enabled: false, hideOnStartup: preferences.hideOnStartup, reason: startupUnsupportedReason() };
  }
  try {
    const queryOptions = startupLoginItemQueryOptions();
    let settings = app.getLoginItemSettings(queryOptions);
    let windowsState = process.platform === "win32" ? windowsStartupState(settings) : null;
    if (process.platform === "win32" && preferences.runAtStartup !== false && !settings.openAtLogin && windowsState?.approved) {
      app.setLoginItemSettings(startupLoginItemOptions(true, preferences.hideOnStartup));
      clearLegacyWindowsStartupItems();
      settings = app.getLoginItemSettings(queryOptions);
      windowsState = windowsStartupState(settings);
    }
    const isStartupLaunch = hasStartupArg(argv);
    const wasOpenedAtLogin = Boolean(settings.wasOpenedAtLogin || isStartupLaunch);
    const status = process.platform === "win32" ? windowsState?.status : settings.status;
    return {
      supported: true,
      enabled: preferences.runAtStartup === false
        ? false
        : process.platform === "win32" ? Boolean(windowsState?.registered) : Boolean(settings.openAtLogin),
      hideOnStartup: preferences.hideOnStartup,
      wasOpenedAtLogin,
      wasOpenedAsHidden: Boolean(settings.wasOpenedAsHidden || (wasOpenedAtLogin && preferences.hideOnStartup)),
      ...(typeof status === "string" ? { status } : {})
    };
  } catch (error) {
    return { supported: false, enabled: false, hideOnStartup: preferences.hideOnStartup, reason: error?.message || "startup-settings-unavailable" };
  }
}

// Reads the source stream's native sample rate from ffmpeg's banner (printed to stderr).
// decodeAudioData in the renderer resamples to the AudioContext rate, so the renderer's
// buffer rate is unreliable for baking speed; the file's own rate is what ffmpeg decodes at.
function probeAudioSampleRate(ffmpeg, input) {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(ffmpeg, ["-hide_banner", "-i", input], { windowsHide: true });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const match = stderr.match(/(\d{3,6})\s*Hz/);
      resolve(match ? Number(match[1]) : 0);
    });
    shutdownLifecycle.trackChild(child);
  });
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
          echoCancellationEnabled: false,
          noiseSuppressionEnabled: false,
          noiseSuppressionAttenuationDb: 18,
          soundboardToVirtualMic: false,
          monitorToHeadphones: true,
          monitorMicToHeadphones: false,
          micVirtualVolume: 1,
          micMonitorVolume: 1,
          soundboardVirtualVolume: 1,
          soundboardMonitorVolume: 1,
          monitorDeviceId: "",
          virtualOutputDeviceId: "",
          virtualOutputMode: "managed",
          virtualBackend: managedVirtualBackend(),
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

function runYtDlp(args, cwd) {
  const ytDlpArgs = [...ytDlpJsRuntimeArgs(), ...args];
  const bundledCandidates = bundledYtDlpCandidates().map((command) => ({ command, args: ytDlpArgs }));
  const developmentCandidates = process.platform === "win32"
    ? [
        { command: "yt-dlp.exe", args: ytDlpArgs },
        { command: "yt-dlp", args: ytDlpArgs },
        { command: "py", args: ["-m", "yt_dlp", ...ytDlpArgs] },
        { command: "python", args: ["-m", "yt_dlp", ...ytDlpArgs] }
      ]
    : [
        { command: "yt-dlp", args: ytDlpArgs },
        { command: "python3", args: ["-m", "yt_dlp", ...ytDlpArgs] },
        { command: "python", args: ["-m", "yt_dlp", ...ytDlpArgs] }
      ];
  const candidates = app.isPackaged
    ? bundledCandidates
    : [...bundledCandidates, ...developmentCandidates];

  return new Promise((resolve, reject) => {
    let index = 0;
    const failures = [];

    const tryNext = () => {
      if (shutdownLifecycle.isShuttingDown()) {
        reject(new Error("Download cancelled because SoundDeck Studio is shutting down."));
        return;
      }
      const candidate = candidates[index++];
      if (!candidate) {
        const guidance = app.isPackaged
          ? "Reinstall SoundDeck Studio and try again."
          : "Set SOUNDDECK_YT_DLP_PATH or make sure yt-dlp is on PATH, then try again.";
        reject(new Error(`yt-dlp could not be started. ${guidance} Tried: ${failures.join("; ")}`));
        return;
      }

      let child;
      try {
        child = spawn(candidate.command, candidate.args, {
          cwd,
          env: ytDlpSpawnEnv(),
          windowsHide: true,
          shell: false,
          detached: shouldDetachProcessTree()
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
        if (shutdownLifecycle.isShuttingDown()) {
          reject(new Error("Download cancelled because SoundDeck Studio is shutting down."));
          return;
        }
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
        if (shutdownLifecycle.isShuttingDown()) {
          reject(new Error("Download cancelled because SoundDeck Studio is shutting down."));
          return;
        }
        if (code === 0) resolve({ stdout, stderr });
        else {
          const output = (stderr || stdout).trim();
          const reason = output || `exited with code ${code}`;
          failures.push(`${candidate.command}: ${reason}`);
          if (code === -4058 || /No module named yt_dlp|unsupported version of Python/i.test(output)) tryNext();
          else reject(new Error(`${candidate.command} ${reason}`));
        }
      });
      shutdownLifecycle.trackChild(child, { terminate: terminateProcessTree });
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

async function selectRendererTarget() {
  if (isDev) {
    if (await canReachUrl(devServerUrl)) {
      return {
        type: "url",
        value: devServerUrl,
        policy: rendererPolicy({ isPackaged: false, builtIndex, devServerUrl })
      };
    }
    if (await fileExists(builtIndex)) {
      return {
        type: "file",
        value: builtIndex,
        policy: rendererPolicy({ isPackaged: true, builtIndex, devServerUrl })
      };
    }
    throw new Error(`Renderer not available. Start Vite with "pnpm run dev" or build first with "pnpm run build". Tried ${devServerUrl} and ${builtIndex}.`);
  }

  return {
    type: "file",
    value: builtIndex,
    policy: rendererPolicy({ isPackaged: true, builtIndex, devServerUrl })
  };
}

async function loadRenderer(window, target) {
  if (target.type === "url") await window.loadURL(target.value);
  else await window.loadFile(target.value);
}

function trayIconPath() {
  const iconFile = process.platform === "win32" ? "icon.ico" : "icon.png";
  const devPath = process.platform === "win32"
    ? path.join(__dirname, "../build/icon.ico")
    : path.join(__dirname, "../docs/icon.png");
  return isDev ? devPath : path.join(process.resourcesPath, iconFile);
}

function macTrayIconPath() {
  const devPath = path.join(__dirname, "../build", MAC_TRAY_ICON_FILENAME);
  return isDev ? devPath : path.join(process.resourcesPath, MAC_TRAY_ICON_FILENAME);
}

function createMacTrayIcon() {
  const icon = nativeImage.createFromPath(macTrayIconPath());
  if (icon.isEmpty()) return createMacTrayTemplateImage(nativeImage);

  icon.setTemplateImage(true);
  return icon;
}

function createTrayIcon() {
  if (process.platform === "darwin") {
    return createMacTrayIcon();
  }

  const icon = nativeImage.createFromPath(trayIconPath());
  if (icon.isEmpty() || process.platform === "win32") return icon;

  return icon.resize({ width: 24, height: 24, quality: "best" });
}

function showMainWindow() {
  if (shutdownLifecycle.isShuttingDown()) return;
  if (mainWindow?.isDestroyed()) mainWindow = undefined;
  if (!mainWindow) {
    pendingShowMainWindow = true;
    return;
  }
  pendingShowMainWindow = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (shutdownLifecycle.isShuttingDown()) return;
  const icon = createTrayIcon();
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
        shutdownLifecycle.beginShutdown();
        app.quit();
      }
    }
  ]));
  tray.on("double-click", () => showMainWindow());
}

async function createWindow() {
  await ensureLibrary();
  if (shutdownLifecycle.isShuttingDown()) return;
  const rendererTarget = await selectRendererTarget();
  trustedRendererPolicy = rendererTarget.policy;
  Menu.setApplicationMenu(null);
  const startupSettings = await getStartupSettings();
  if (shutdownLifecycle.isShuttingDown()) return;
  const startHidden = Boolean(startupSettings.enabled && startupSettings.wasOpenedAtLogin && startupSettings.hideOnStartup && !pendingShowMainWindow);
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    show: !startHidden,
    backgroundColor: "#101114",
    title: "SoundDeck Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      navigateOnDragDrop: false
    }
  });
  mainWindow = window;
  installNavigationGuards(window.webContents, rendererTarget.policy);

  if (isDev) {
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (input.key === "F12" || (input.control && input.shift && input.key.toUpperCase() === "I")) {
        window.webContents.toggleDevTools();
        event.preventDefault();
      }
      if (input.control && input.key.toUpperCase() === "R") {
        window.webContents.reload();
        event.preventDefault();
      }
    });
  }

  // Electron skips app-level quit events during Windows shutdown and logout.
  // session-end is irreversible, so cleanup here without delaying the OS query.
  registerWindowShutdown(window, shutdownLifecycle);
  window.on("close", (event) => {
    if (isQuitting || allowWindowCloseForUpdate) return;
    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  await loadRenderer(window, rendererTarget);
  if (shutdownLifecycle.isShuttingDown()) return;
  if (pendingShowMainWindow) showMainWindow();
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

// The channel IPC is registered at module scope, not in setupAutoUpdates():
// the renderer queries the channel in its mount effect, which can run before
// createWindow() resolves and setupAutoUpdates() gets called. What a change
// of preference does to the live updater is injected by setupAutoUpdates()
// once one exists; until then persisting the preference is all there is to do.
let onUpdateChannelPreferenceChanged = () => undefined;

async function updateChannelState() {
  return {
    preference: await readUpdateChannelPreference(),
    installedChannel: installedChannel(app.getVersion())
  };
}

handleTrustedIpc("update:getChannel", () => updateChannelState());
handleTrustedIpc("update:setChannel", async (_event, channel) => {
  const preference = normalizeChannelPreference(channel);
  if (!preference) throw new Error("Unknown update channel");
  await writeUpdateChannelPreference(preference);
  onUpdateChannelPreferenceChanged(preference);
  return updateChannelState();
});

function setupAutoUpdates() {
  const registerUnsupportedUpdateHandlers = () => {
    // No auto-updater is available for this build (dev, portable, or missing
    // electron-updater). Keep the IPC handlers registered so the renderer's
    // check-for-updates button stays responsive instead of hanging; quietly
    // report "up-to-date" so the UI doesn't surface an error for something
    // that simply isn't wired up here.
    handleTrustedIpc("update:check", () => {
      sendToMainWindow("update-status", { state: "up-to-date" });
    });
    handleTrustedIpc("update:install", () => undefined);
  };
  // Portable Windows builds have no installer to hand updates to. Installed
  // Windows and signed/notarized macOS packages can use electron-updater.
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) {
    registerUnsupportedUpdateHandlers();
    return;
  }
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (error) {
    console.error("electron-updater unavailable:", error);
    registerUnsupportedUpdateHandlers();
    return;
  }
  const sendStatus = (status) => sendToMainWindow("update-status", status);
  autoUpdater.on("error", (error) => {
    updateInstallLifecycle.resetAfterFailure();
    console.error("Auto-update error:", error);
    sendStatus({ state: "error", message: error?.message || "Update check failed." });
  });
  autoUpdater.on("checking-for-update", () => sendStatus({ state: "checking" }));
  autoUpdater.on("update-available", (info) => sendStatus({ state: "downloading", version: info.version, percent: 0 }));
  autoUpdater.on("update-not-available", () => sendStatus({ state: "up-to-date" }));
  autoUpdater.on("download-progress", (progress) => sendStatus({ state: "downloading", percent: progress.percent }));
  // macOS hands a completed payload to the native Squirrel updater as soon
  // as autoInstallOnAppQuit is set, and a staged Squirrel update installs at
  // quit with no way to cancel — a later channel switch couldn't retract it.
  // So on macOS a payload goes native only on an explicit install; Windows
  // keeps install-on-quit, whose flag is read at quit time and can still be
  // disarmed by a switch.
  const canArmInstallOnQuit = process.platform !== "darwin";
  autoUpdater.autoInstallOnAppQuit = false;
  // In-memory mirror of the persisted preference, so the update-downloaded
  // listener can decide synchronously: macOS's updater consults
  // autoInstallOnAppQuit the moment this listener yields, so the staleness
  // decision and the arming can't sit behind an await.
  let channelPreference = null;
  // Version of the payload currently offered by the ready toast, or null when
  // nothing downloaded is installable (including after a channel switch
  // invalidated it).
  let readyPayloadVersion = null;
  autoUpdater.on("update-downloaded", (info) => {
    // A download begun before a channel switch can finish after it; never
    // offer or arm a payload the current preference wouldn't have chosen.
    if (isStalePayload(channelPreference, info.version, app.getVersion())) {
      readyPayloadVersion = null;
      // The switch-time check couldn't download anything while this download
      // held the updater's single in-flight slot (downloadUpdate() returns
      // the existing promise), and that slot is only released after this
      // event's dispatch settles. Re-check from a fresh task so the new
      // channel's payload actually arrives instead of waiting for the timer.
      setTimeout(() => void check(), 0);
      return;
    }
    // Re-arm install-on-quit where that's revocable (Windows); a channel
    // switch may have disarmed it to keep an old-channel payload from
    // installing at quit.
    if (canArmInstallOnQuit) autoUpdater.autoInstallOnAppQuit = true;
    readyPayloadVersion = info.version;
    sendStatus({ state: "ready", version: info.version });
  });
  handleTrustedIpc("update:install", () => {
    // A channel switch may have invalidated the payload while its ready toast
    // was still on screen; never install what the current channel wouldn't
    // have chosen.
    if (!readyPayloadVersion) return;
    // Silent install with auto-relaunch: no installer pages, no "run app?" prompt.
    updateInstallLifecycle.requestInstall(() => autoUpdater.quitAndInstall(true, true));
  });
  // Every metadata check — manual or automatic — funnels through
  // pendingCheck so a channel switch can wait out an in-flight old-channel
  // check (electron-updater hands concurrent callers the same cached
  // promise) before querying anew.
  let pendingCheck = null;
  const trackCheck = (run) => {
    const tracked = run.catch(() => undefined).finally(() => {
      if (pendingCheck === tracked) pendingCheck = null;
    });
    pendingCheck = tracked;
    return run;
  };
  handleTrustedIpc("update:check", async () => {
    if (shutdownLifecycle.isShuttingDown()) return;
    try {
      const result = await trackCheck(autoUpdater.checkForUpdates());
      await result?.downloadPromise;
    } catch (error) {
      console.error("Manual update check failed:", error);
      throw error;
    }
  });
  const check = () => {
    if (shutdownLifecycle.isShuttingDown()) return Promise.resolve();
    return trackCheck(autoUpdater.checkForUpdates()).catch((error) => {
      console.error("Auto-update check failed:", error);
    });
  };
  const applyChannelFlags = (preference) => {
    const flags = resolveUpdaterFlags(preference, app.getVersion());
    if (!flags) return;
    autoUpdater.channel = flags.channel;
    autoUpdater.allowPrerelease = flags.allowPrerelease;
    autoUpdater.allowDowngrade = flags.allowDowngrade;
  };
  onUpdateChannelPreferenceChanged = (preference) => {
    channelPreference = preference;
    applyChannelFlags(preference);
    // An update downloaded from the old channel may already be registered to
    // install on quit; disarm that so it can't land after the user switched
    // away. The check below downloads from the new channel if there is
    // anything to install, and update-downloaded re-arms install-on-quit.
    autoUpdater.autoInstallOnAppQuit = false;
    // A payload already offered by the ready toast may be one the new channel
    // would never pick; retract it (update:install refuses it from here on,
    // and up-to-date dismisses the toast).
    if (readyPayloadVersion && isStalePayload(preference, readyPayloadVersion, app.getVersion())) {
      readyPayloadVersion = null;
      sendStatus({ state: "up-to-date" });
    }
    // A check already in flight (startup or the four-hour timer) ran with the
    // old channel, and electron-updater would hand a concurrent call that
    // same cached promise. Let it settle first, then query the new channel.
    const settled = pendingCheck || Promise.resolve();
    void settled.then(() => check());
  };
  // The persisted channel preference must be in effect before the first check.
  void readUpdateChannelPreference().then((preference) => {
    channelPreference = preference;
    applyChannelFlags(preference);
    return check();
  });
  // Long-running sessions (app lives in the tray) should still pick up new
  // releases without a restart.
  updateCheckTimer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(async () => {
  await createWindow();
  if (shutdownLifecycle.isShuttingDown() || !mainWindow) return;
  app.on("activate", () => {
    if (shutdownLifecycle.isShuttingDown()) return;
    if (mainWindow) {
      showMainWindow();
      return;
    }
    void createWindow();
  });
  createTray();
  if (shutdownLifecycle.isShuttingDown()) return;
  corsair.start();
  setupAutoUpdates();
});

app.on("before-quit", () => {
  shutdownLifecycle.beginShutdown();
});

app.on("will-quit", () => {
  shutdownLifecycle.beginShutdown();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

handleTrustedIpc("library:load", async () => {
  await ensureLibrary();
  return readJson(libraryFile());
});

handleTrustedIpc("library:save", async (_event, library) => {
  await ensureLibrary();
  await fs.writeFile(libraryFile(), JSON.stringify(library, null, 2));
  return { ok: true };
});

handleTrustedIpc("library:reveal", async () => {
  await ensureLibrary();
  await shell.openPath(appRoot());
  return { ok: true };
});

handleTrustedIpc("board:export", async (_event, board) => {
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

handleTrustedIpc("board:import", async () => {
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
    if (!sound || typeof sound !== "object") continue;
    const data = payload.media?.[sound.storedName];
    if (typeof data !== "string") continue;
    let mediaPath = restoredPaths.get(sound.storedName);
    if (!mediaPath) {
      const ext = storedAudioExtension(sound.storedName, sound.ext);
      if (!ext) continue;
      const storedName = `${crypto.randomUUID()}${ext}`;
      mediaPath = path.join(mediaRoot(), storedName);
      if (!isInsideMediaRoot(mediaRoot(), mediaPath)) continue;
      await fs.writeFile(mediaPath, Buffer.from(data, "base64"), { flag: "wx" });
      restoredPaths.set(sound.storedName, mediaPath);
    }
    sounds.push({ ...sound, id: crypto.randomUUID(), mediaPath, storedName: path.basename(mediaPath) });
  }
  return { ok: true, board: { ...payload.board, sounds } };
});

handleTrustedIpc("media:import", async (_event, filePaths) => {
  return importMediaPaths(Array.isArray(filePaths) ? filePaths : []);
});

handleTrustedIpc("media:download", async (_event, urls) => {
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

handleTrustedIpc("media:delete", async (_event, mediaPath) => {
  const resolved = path.resolve(String(mediaPath || ""));
  if (!isInsideMediaRoot(mediaRoot(), resolved)) {
    return { ok: false, reason: "outside-media-root" };
  }
  try {
    await fs.rm(resolved, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
});

handleTrustedIpc("media:read", async (_event, mediaPath) => {
  const resolved = path.resolve(String(mediaPath || ""));
  if (!isInsideMediaRoot(mediaRoot(), resolved)) {
    throw new Error("outside-media-root");
  }
  const data = await fs.readFile(resolved);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
});

handleTrustedIpc("audio:getNoiseSuppressionAssets", async () => {
  const [wasm, model] = await Promise.all([
    fs.readFile(deepFilterResourcePath("deep_filter_bg.wasm")),
    fs.readFile(deepFilterResourcePath("DeepFilterNet3_onnx.tar.gz"))
  ]);
  return {
    wasm: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    model: model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength)
  };
});

handleTrustedIpc("media:saveRecording", async (_event, payload) => {
  await ensureLibrary();
  const id = crypto.randomUUID();
  const ext = safeAudioExtension(payload?.ext || ".webm");
  if (!ext) return { ok: false, reason: "unsupported-extension" };
  const title = sanitizeName(payload?.title || "Recording");
  const storedName = `${id}${ext}`;
  const dest = path.join(mediaRoot(), storedName);
  if (!isInsideMediaRoot(mediaRoot(), dest)) {
    return { ok: false, reason: "outside-media-root" };
  }
  await fs.writeFile(dest, Buffer.from(payload?.bytes || []), { flag: "wx" });
  const stat = await fs.stat(dest);
  return {
    ok: true,
    id,
    title,
    mediaPath: dest,
    storedName,
    ext,
    mime: inferMime(ext),
    size: stat.size
  };
});

handleTrustedIpc("media:crop", async (_event, payload) => {
  if (shutdownLifecycle.isShuttingDown()) return { ok: false, reason: "app-is-shutting-down" };
  await ensureLibrary();
  if (shutdownLifecycle.isShuttingDown()) return { ok: false, reason: "app-is-shutting-down" };
  const sourcePath = path.resolve(String(payload?.mediaPath || ""));
  if (!isInsideMediaRoot(mediaRoot(), sourcePath)) {
    return { ok: false, reason: "outside-media-root" };
  }
  const ffmpeg = bundledFfmpegPath();
  if (!ffmpeg) {
    return { ok: false, reason: "ffmpeg-unavailable" };
  }
  const ext = (payload?.ext || path.extname(sourcePath) || ".wav").toLowerCase();
  if (!allowedAudioExtensions().has(ext)) {
    return { ok: false, reason: "unsupported-extension" };
  }
  const id = crypto.randomUUID();
  const storedName = `${id}${ext}`;
  const dest = path.join(mediaRoot(), storedName);
  // Defence in depth: the extension is allow-listed above, but make sure the resolved
  // destination still lands inside the media root before ffmpeg writes with -y.
  if (!isInsideMediaRoot(mediaRoot(), dest)) {
    return { ok: false, reason: "outside-media-root" };
  }
  const rate = Number(payload?.rate) || 1;
  // Probe the file's real sample rate; only matters when actually re-timing.
  const sampleRate = Math.abs(rate - 1) > 1e-6
    ? (await probeAudioSampleRate(ffmpeg, sourcePath)) || Number(payload?.sampleRate) || 0
    : 0;
  if (shutdownLifecycle.isShuttingDown()) return { ok: false, reason: "app-is-shutting-down" };
  const args = buildCropArgs({
    input: sourcePath,
    output: dest,
    startSec: Number(payload?.startSec) || 0,
    endSec: Number(payload?.endSec) || 0,
    rate,
    sampleRate
  });

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split("\n").pop() || ""}`));
      });
      shutdownLifecycle.trackChild(child);
    });
    const stat = await fs.stat(dest);
    return {
      ok: true,
      mediaPath: dest,
      storedName,
      ext,
      mime: inferMime(ext),
      size: stat.size
    };
  } catch (error) {
    await fs.rm(dest, { force: true }).catch(() => {});
    return { ok: false, reason: String(error?.message || error) };
  }
});

handleTrustedIpc("hotkeys:register", async (_event, bindings) => registerHotkeys(bindings));

handleTrustedIpc("hotkeys:capture", (_event, active) => {
  hotkeyCaptureActive = Boolean(active);
  hotkeyEngine.setSuspended(hotkeyCaptureActive);
  return { ok: true };
});

handleTrustedIpc("corsair:status", async () => corsair.getState());

handleTrustedIpc("app:openExternal", async (_event, url) => {
  if (!isAllowedExternalUrl(url)) return { ok: false, reason: "unsupported-url" };
  await shell.openExternal(url);
  return { ok: true };
});

handleTrustedIpc("app:getVersion", () => app.getVersion());

handleTrustedIpc("app:getPlatform", () => sounddeckPlatform());

handleTrustedIpc("app:getCapabilities", () => appCapabilities());

handleTrustedIpc("app:getStartupSettings", () => getStartupSettings());

handleTrustedIpc("app:setRunAtStartup", async (_event, enabled, options = {}) => {
  if (!startupSettingsSupported()) return { ok: false, ...(await getStartupSettings()) };
  let rollbackStartupSettings = null;
  try {
    const openAtLogin = Boolean(enabled);
    const currentPreferences = await readStartupPreferences();
    const hideOnStartup = typeof options?.hideOnStartup === "boolean" ? options.hideOnStartup : currentPreferences.hideOnStartup;
    const previousSettings = app.getLoginItemSettings(startupLoginItemQueryOptions());
    if (process.platform === "win32") {
      const previousWindowsState = windowsStartupState(previousSettings);
      rollbackStartupSettings = () => {
        if (previousWindowsState.registered) setWindowsStartupItem(true, currentPreferences.hideOnStartup, previousWindowsState.approved);
        else clearWindowsStartupItems();
      };
    } else {
      rollbackStartupSettings = () => app.setLoginItemSettings(startupLoginItemOptions(Boolean(previousSettings.openAtLogin), currentPreferences.hideOnStartup));
    }
    if (openAtLogin) {
      if (process.platform === "win32") setWindowsStartupItem(true, hideOnStartup);
      else app.setLoginItemSettings(startupLoginItemOptions(true, hideOnStartup));
      clearLegacyWindowsStartupItems();
    } else {
      if (process.platform === "win32") clearWindowsStartupItems();
      else app.setLoginItemSettings(startupLoginItemOptions(false, hideOnStartup));
    }
    await writeStartupPreferences({ hideOnStartup, runAtStartup: openAtLogin });
    return { ok: true, ...(await getStartupSettings()) };
  } catch (error) {
    try {
      rollbackStartupSettings?.();
    } catch {
      // Keep reporting the original failure; the refreshed settings below reflect any rollback failure.
    }
    return { ok: false, ...(await getStartupSettings()), reason: error?.message || "startup-settings-unavailable" };
  }
});
