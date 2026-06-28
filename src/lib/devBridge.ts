import type { HotkeyBinding, MediaImportResult, SoundLibrary } from "../types";

const storageKey = "sounddeck-dev-library";

export function installDevBridge() {
  if (window.sounddeck) return;

  window.sounddeck = {
    async loadLibrary() {
      const stored = localStorage.getItem(storageKey);
      if (stored) return JSON.parse(stored) as SoundLibrary;
      const createdAt = new Date().toISOString();
      return {
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
          virtualOutputDeviceId: "",
          virtualOutputMode: "managed",
          virtualBackend: "windows-vbcable",
          microphoneDeviceId: "",
          stopAllHotkey: "Ctrl+Alt+Space",
          cycleBoardsHotkey: ""
        },
        boards: [{ id: "board-default", name: "Main Board", color: "#1db7a6", icon: "zap", createdAt, updatedAt: createdAt, sounds: [] }]
      };
    },
    async saveLibrary(library: SoundLibrary) {
      localStorage.setItem(storageKey, JSON.stringify(library));
      return { ok: true };
    },
    async exportBoard() {
      return { ok: false, canceled: true };
    },
    async importBoard() {
      return { ok: false, canceled: true };
    },
    async revealLibrary() {
      return { ok: true };
    },
    async importMedia(paths: string[]) {
      return paths.map((sourcePath): MediaImportResult => ({ ok: false, sourcePath, reason: "Run in Electron to import media" }));
    },
    async downloadMedia(urls: string[]) {
      return urls.map((url): MediaImportResult => ({ ok: false, sourcePath: url, sourceUrl: url, reason: "Run in Electron to download URL audio" }));
    },
    async readMedia() {
      throw new Error("Run in Electron to read app-managed media");
    },
    async deleteMedia() {
      return { ok: true };
    },
    async cropMedia() {
      return { ok: false, reason: "Run in Electron to cut clips" };
    },
    async saveRecording() {
      return { ok: false, sourcePath: "", reason: "Run in Electron to save recordings" };
    },
    async registerHotkeys(bindings: HotkeyBinding[]) {
      return bindings.map((binding) => ({ ...binding, ok: true, reason: "" }));
    },
    async setHotkeyCapture() {
      return { ok: true };
    },
    async openExternal(url: string) {
      window.open(url, "_blank", "noopener,noreferrer");
      return { ok: true };
    },
    async getVersion() {
      return "dev";
    },
    async getPlatform() {
      return "unknown";
    },
    async getCapabilities() {
      return {
        platform: "unknown",
        managedVirtualBackend: "manual",
        managedVirtualMicAvailable: false,
        hotkeys: {
          advancedHookAvailable: false,
          globalShortcutFallbackAvailable: false,
          lastFailureReason: ""
        },
        updateChecksSupported: false,
        runAtStartupSupported: false,
        corsairAvailable: false
      };
    },
    async getStartupSettings() {
      return { supported: false, enabled: false, hideOnStartup: false, reason: "Run in Electron to manage startup settings" };
    },
    async setRunAtStartup() {
      return { ok: false, supported: false, enabled: false, hideOnStartup: false, reason: "Run in Electron to manage startup settings" };
    },
    getPathForFile(file: File) {
      return file.name;
    },
    onHotkeyTrigger() {
      return () => undefined;
    },
    async getCorsairStatus() {
      return "unavailable";
    },
    onCorsairStatus() {
      return () => undefined;
    },
    onCorsairKey() {
      return () => undefined;
    },
    async checkForUpdates() {
      // No updater in browser preview; let the renderer's timeout settle the status.
    },
    async installUpdate() {
      // No updater outside Electron.
    },
    onUpdateStatus() {
      return () => undefined;
    }
  };
}
