const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Each preload belongs to one document. Retain its token so late readiness,
// state updates or command results from an outgoing document cannot own the next one.
const controlReadyToken = new Promise((resolve) => {
  ipcRenderer.once("control-ready-token", (_event, token) => resolve(token));
});

// Pending callbacks survive renderer subscription changes within this document.
const controlCommandRequests = new Map();
let controlCommandStarts = Promise.resolve();

function cancelControlRequest(requestId, request, reason) {
  if (!request || request.cancelled) return;
  request.cancelled = true;
  if (request.started) {
    try { void Promise.resolve(request.callback({ command: "control.cancel", requestId, ...(reason === "operation-timeout" ? { reason } : {}) })).catch(() => {}); } catch {}
  }
}

function cancelPendingControlPlayback(soundId) {
  // Started playback is owned by SoundTriggers; include requests still waiting
  // for receipt without running renderer callbacks before the stop snapshot.
  const earlier = [...controlCommandRequests].filter(([, request]) =>
    !request.started &&
    (request.command.command === "sound.play" || request.command.command === "sound.press") &&
    (soundId === undefined || request.command.args.soundId === soundId));
  for (const [requestId, request] of earlier) cancelControlRequest(requestId, request);
}

contextBridge.exposeInMainWorld("sounddeck", {
  loadLibrary: () => controlReadyToken.then((token) => ipcRenderer.invoke("library:load", token)),
  saveLibrary: (library) => controlReadyToken.then((token) => ipcRenderer.invoke("library:save", library, token)),
  exportBoard: (board) => ipcRenderer.invoke("board:export", board),
  importBoard: () => ipcRenderer.invoke("board:import"),
  revealLibrary: () => ipcRenderer.invoke("library:reveal"),
  importMedia: (paths) => ipcRenderer.invoke("media:import", paths),
  downloadMedia: (urls) => ipcRenderer.invoke("media:download", urls),
  readMedia: (mediaPath) => ipcRenderer.invoke("media:read", mediaPath),
  getNoiseSuppressionAssets: () => ipcRenderer.invoke("audio:getNoiseSuppressionAssets"),
  deleteMedia: (mediaPath) => ipcRenderer.invoke("media:delete", mediaPath),
  cropMedia: (payload) => ipcRenderer.invoke("media:crop", payload),
  saveRecording: (payload) => ipcRenderer.invoke("media:saveRecording", payload),
  registerHotkeys: (bindings) => ipcRenderer.invoke("hotkeys:register", bindings),
  setHotkeyCapture: (active) => controlReadyToken.then((token) => ipcRenderer.invoke("hotkeys:capture", active, token)),
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  getPlatform: () => ipcRenderer.invoke("app:getPlatform"),
  getPlatformSync: () => (["win32", "darwin", "linux"].includes(process.platform) ? process.platform : "unknown"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggleMaximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  getWindowState: () => ipcRenderer.invoke("window:getState"),
  onWindowState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("window-state", listener);
    return () => ipcRenderer.removeListener("window-state", listener);
  },
  getCapabilities: () => ipcRenderer.invoke("app:getCapabilities"),
  getStartupSettings: () => ipcRenderer.invoke("app:getStartupSettings"),
  setRunAtStartup: (enabled, options) => ipcRenderer.invoke("app:setRunAtStartup", enabled, options),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onHotkeyTrigger: (callback) => {
    const listener = (_event, binding) => callback(binding);
    ipcRenderer.on("hotkey-trigger", listener);
    return () => ipcRenderer.removeListener("hotkey-trigger", listener);
  },
  onHotkeyRelease: (callback) => {
    const listener = (_event, binding) => callback(binding);
    ipcRenderer.on("hotkey-release", listener);
    return () => ipcRenderer.removeListener("hotkey-release", listener);
  },
  getControlSettings: () => ipcRenderer.invoke("control:getSettings"),
  setControlSettings: (patch) => ipcRenderer.invoke("control:setSettings", patch),
  regenerateControlToken: () => ipcRenderer.invoke("control:regenerateToken"),
  pushControlState: (state) => controlReadyToken.then((token) => ipcRenderer.invoke("control:state", state, token)),

  controlReady: () => controlReadyToken.then((token) => ipcRenderer.invoke("control:ready", token)),
  cancelPendingControlPlayback: cancelPendingControlPlayback,
  onControlStatus: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("control-status", listener);
    return () => ipcRenderer.removeListener("control-status", listener);
  },
  onControlCommand: (callback) => {
    const listener = (_event, { requestId, ...command }) => {
      if (command.command === "control.cancel") {
        cancelControlRequest(requestId, controlCommandRequests.get(requestId), command.reason);
        return Promise.resolve();
      }
      // Apply the stop boundary at arrival, before later requests register while
      // its ordered renderer callback waits for earlier acceptance replies.
      if (command.command === "sound.stop") cancelPendingControlPlayback(command.args.soundId);
      // Register before receipt can yield, so cancellation cannot get lost
      // while main's acceptance reply is still in flight.
      const request = { cancelled: false, started: false, callback, command };
      if (requestId) controlCommandRequests.set(requestId, request);
      const start = controlCommandStarts.then(async () => {
        const token = await controlReadyToken;
        try {
          if (requestId) {
            const receipt = await ipcRenderer.invoke("control:received", requestId, token);
            if (!receipt.ok) return { skipped: true };
          }
          if (request.cancelled) return { token, result: { ok: false, code: "unavailable" } };
          request.started = true;
          // Return the operation promise inside an object: only callback
          // invocation is ordered, while completion may await saves or audio.
          return { token, result: callback({ ...command, requestId }) };
        } catch {
          return { token, result: { ok: false, code: "internal-error" } };
        }
      });
      controlCommandStarts = start.then(() => undefined, () => undefined);
      return start.then(async ({ skipped, token, result }) => {
        if (skipped) return;
        try { result = await result; } catch { result = { ok: false, code: "internal-error" }; }
        if (requestId) await ipcRenderer.invoke("control:result", requestId, result, token).catch(() => {});
      }).finally(() => {
        if (requestId) controlCommandRequests.delete(requestId);
      });
    };
    ipcRenderer.on("control-command", listener);
    return () => ipcRenderer.removeListener("control-command", listener);
  },
  getCorsairStatus: () => ipcRenderer.invoke("corsair:status"),
  onCorsairStatus: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("corsair-status", listener);
    return () => ipcRenderer.removeListener("corsair-status", listener);
  },
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  getUpdateChannel: () => ipcRenderer.invoke("update:getChannel"),
  setUpdateChannel: (channel) => ipcRenderer.invoke("update:setChannel", channel),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("update-status", listener);
    return () => ipcRenderer.removeListener("update-status", listener);
  },
  onCorsairKey: (callback) => {
    const listener = (_event, key) => callback(key);
    ipcRenderer.on("corsair-gkey", listener);
    return () => ipcRenderer.removeListener("corsair-gkey", listener);
  }
});
