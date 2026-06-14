import type { MediaImportResult, OutputTarget, SoundBoard, SoundLibrary, SoundSlot } from "../types";
import { normalizeSelectableDeviceId } from "./devices";
import { normalizeAccelerator } from "./hotkeys";

const palette = ["#1db7a6", "#ffcf5c", "#ff6b6b", "#8f7cff", "#4ba3ff", "#74d66b", "#ef7bd5", "#f6903d"];
const icons = ["zap", "radio", "music", "mic", "laugh", "siren", "sparkles", "gamepad"];
const defaultSettings: SoundLibrary["settings"] = {
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
};
const defaultSoundOptions: Pick<SoundSlot, "fadeInMs" | "fadeOutMs" | "loop" | "soloPlay" | "retriggerMode" | "hotkey" | "outputTarget"> = {
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: false,
  soloPlay: true,
  retriggerMode: "restart",
  hotkey: "",
  outputTarget: "both"
};

export function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function now() {
  return new Date().toISOString();
}

export function makeBoard(index: number): SoundBoard {
  const timestamp = now();
  return {
    id: makeId("board"),
    name: `Board ${index}`,
    color: palette[index % palette.length],
    icon: icons[index % icons.length],
    switchHotkey: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    sounds: []
  };
}

export function soundFromImport(result: MediaImportResult, index: number, outputTarget: OutputTarget): SoundSlot | null {
  if (!result.ok || !result.id || !result.mediaPath || !result.storedName || !result.mime || !result.ext || !result.size) return null;
  const timestamp = now();
  return {
    id: result.id,
    title: result.title || "Untitled sound",
    mediaPath: result.mediaPath,
    storedName: result.storedName,
    mime: result.mime,
    ext: result.ext,
    size: result.size,
    color: palette[index % palette.length],
    icon: icons[index % icons.length],
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    loop: false,
    soloPlay: true,
    retriggerMode: "restart",
    hotkey: "",
    outputTarget,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function normalizeLibrary(library: SoundLibrary): SoundLibrary {
  const boards = library.boards?.length ? library.boards : [makeBoard(1)];
  const activeBoardId = boards.some((board) => board.id === library.activeBoardId) ? library.activeBoardId : boards[0].id;
  type LegacySettings = Partial<SoundLibrary["settings"]> & { micVolume?: number; soundboardVolume?: number; monitorVolume?: number };
  const incomingSettings = (library.settings || {}) as LegacySettings;
  const currentSettings = { ...incomingSettings };
  delete currentSettings.micVolume;
  delete currentSettings.soundboardVolume;
  delete currentSettings.monitorVolume;
  const volumeOr = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const settings = {
    ...defaultSettings,
    ...currentSettings,
    micVirtualVolume: volumeOr(currentSettings.micVirtualVolume, defaultSettings.micVirtualVolume),
    micMonitorVolume: volumeOr(currentSettings.micMonitorVolume, defaultSettings.micMonitorVolume),
    soundboardVirtualVolume: volumeOr(currentSettings.soundboardVirtualVolume, defaultSettings.soundboardVirtualVolume),
    soundboardMonitorVolume: volumeOr(currentSettings.soundboardMonitorVolume, defaultSettings.soundboardMonitorVolume)
  };
  settings.stopAllHotkey = normalizeAccelerator(settings.stopAllHotkey);
  settings.cycleBoardsHotkey = normalizeAccelerator(settings.cycleBoardsHotkey);
  settings.monitorDeviceId = normalizeSelectableDeviceId(settings.monitorDeviceId);
  settings.microphoneDeviceId = normalizeSelectableDeviceId(settings.microphoneDeviceId);
  return {
    ...library,
    activeBoardId,
    settings,
    boards: boards.map((board) => ({
      ...board,
      switchHotkey: normalizeAccelerator(board.switchHotkey ?? ""),
      // volume 0.9 was the old import default; lift it to the new 100% default.
      sounds: board.sounds.map((sound) => ({
        ...defaultSoundOptions,
        ...sound,
        hotkey: normalizeAccelerator(sound.hotkey || ""),
        volume: sound.volume === 0.9 ? 1 : sound.volume
      }))
    }))
  };
}

export function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function acceleratorLooksReserved(value: string) {
  const normalized = normalizeAccelerator(value).toLowerCase();
  return ["alt+f4", "ctrl+w", "ctrl+q", "ctrl+r", "f5"].includes(normalized);
}
