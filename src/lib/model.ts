import type { MediaImportResult, OutputTarget, SoundBoard, SoundLibrary, SoundSlot } from "../types";

const palette = ["#1db7a6", "#ffcf5c", "#ff6b6b", "#8f7cff", "#4ba3ff", "#74d66b", "#ef7bd5", "#f6903d"];
const icons = ["zap", "radio", "music", "mic", "laugh", "siren", "sparkles", "gamepad"];
const defaultSettings: SoundLibrary["settings"] = {
  micPassthrough: false,
  soundboardToVirtualMic: false,
  monitorToHeadphones: true,
  monitorMicToHeadphones: false,
  micVolume: 1,
  soundboardVolume: 1,
  monitorVolume: 1,
  monitorDeviceId: "",
  microphoneDeviceId: "",
  stopAllHotkey: "CommandOrControl+Alt+Space"
};
const defaultSoundOptions: Pick<SoundSlot, "fadeInMs" | "fadeOutMs" | "loop" | "retriggerMode" | "hotkey" | "outputTarget"> = {
  fadeInMs: 0,
  fadeOutMs: 0,
  loop: false,
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
  return {
    ...library,
    activeBoardId,
    settings: { ...defaultSettings, ...library.settings },
    boards: boards.map((board) => ({
      ...board,
      // volume 0.9 was the old import default; lift it to the new 100% default.
      sounds: board.sounds.map((sound) => ({ ...defaultSoundOptions, ...sound, volume: sound.volume === 0.9 ? 1 : sound.volume }))
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
  const normalized = value.toLowerCase().replace(/\s+/g, "");
  return ["alt+f4", "commandorcontrol+w", "commandorcontrol+q", "commandorcontrol+r", "f5"].includes(normalized);
}
