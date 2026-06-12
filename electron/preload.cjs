const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("sounddeck", {
  loadLibrary: () => ipcRenderer.invoke("library:load"),
  saveLibrary: (library) => ipcRenderer.invoke("library:save", library),
  exportBoard: (board) => ipcRenderer.invoke("board:export", board),
  importBoard: () => ipcRenderer.invoke("board:import"),
  revealLibrary: () => ipcRenderer.invoke("library:reveal"),
  importMedia: (paths) => ipcRenderer.invoke("media:import", paths),
  readMedia: (mediaPath) => ipcRenderer.invoke("media:read", mediaPath),
  deleteMedia: (mediaPath) => ipcRenderer.invoke("media:delete", mediaPath),
  saveRecording: (payload) => ipcRenderer.invoke("media:saveRecording", payload),
  registerHotkeys: (bindings) => ipcRenderer.invoke("hotkeys:register", bindings),
  setHotkeyCapture: (active) => ipcRenderer.invoke("hotkeys:capture", active),
  openExternal: (url) => ipcRenderer.invoke("app:openExternal", url),
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onHotkeyTrigger: (callback) => {
    const listener = (_event, binding) => callback(binding);
    ipcRenderer.on("hotkey-trigger", listener);
    return () => ipcRenderer.removeListener("hotkey-trigger", listener);
  },
  getCorsairStatus: () => ipcRenderer.invoke("corsair:status"),
  onCorsairStatus: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("corsair-status", listener);
    return () => ipcRenderer.removeListener("corsair-status", listener);
  },
  installUpdate: () => ipcRenderer.invoke("update:install"),
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
