import type { MediaImportResult, OutputTarget, SoundBoard, SoundEffects, SoundLibrary, SoundSlot } from "../types";
import { normalizeSelectableDeviceId } from "./devices";
import { normalizeAccelerator } from "./hotkeys";

const palette = ["#1db7a6", "#ffcf5c", "#ff6b6b", "#8f7cff", "#4ba3ff", "#74d66b", "#ef7bd5", "#f6903d"];
const icons = ["zap", "radio", "music", "mic", "laugh", "siren", "sparkles", "gamepad"];
const defaultSettings: SoundLibrary["settings"] = {
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
  virtualBackend: "windows-vbcable",
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
const defaultEffects: SoundEffects = {
  pitchEnabled: false,
  pitchSemitones: 0,
  eq: {
    enabled: false,
    lowGainDb: 0,
    midGainDb: 0,
    highGainDb: 0
  },
  compressor: {
    enabled: false,
    thresholdDb: -24,
    ratio: 3,
    attackMs: 3,
    releaseMs: 250
  },
  limiter: {
    enabled: false,
    ceilingDb: -1
  },
  reverb: {
    enabled: false,
    mix: 0.18,
    decaySec: 1.4
  }
};

function cloneEffects(effects: SoundEffects): SoundEffects {
  return {
    pitchEnabled: effects.pitchEnabled,
    pitchSemitones: effects.pitchSemitones,
    eq: { ...effects.eq },
    compressor: { ...effects.compressor },
    limiter: { ...effects.limiter },
    reverb: { ...effects.reverb }
  };
}

function numberIn(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function boolOr(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

export function getDefaultSoundEffects(): SoundEffects {
  return cloneEffects(defaultEffects);
}

export function normalizeSoundEffects(value: unknown): SoundEffects {
  const incoming = (value || {}) as Partial<SoundEffects>;
  const eq = (incoming.eq || {}) as Partial<SoundEffects["eq"]>;
  const compressor = (incoming.compressor || {}) as Partial<SoundEffects["compressor"]>;
  const limiter = (incoming.limiter || {}) as Partial<SoundEffects["limiter"]>;
  const reverb = (incoming.reverb || {}) as Partial<SoundEffects["reverb"]>;
  const legacyPitchEnabled = typeof incoming.pitchSemitones === "number" && Number.isFinite(incoming.pitchSemitones) && Math.abs(incoming.pitchSemitones) > 0.001;
  return {
    pitchEnabled: boolOr(incoming.pitchEnabled, legacyPitchEnabled),
    pitchSemitones: numberIn(incoming.pitchSemitones, defaultEffects.pitchSemitones, -24, 24),
    eq: {
      enabled: boolOr(eq.enabled, defaultEffects.eq.enabled),
      lowGainDb: numberIn(eq.lowGainDb, defaultEffects.eq.lowGainDb, -12, 12),
      midGainDb: numberIn(eq.midGainDb, defaultEffects.eq.midGainDb, -12, 12),
      highGainDb: numberIn(eq.highGainDb, defaultEffects.eq.highGainDb, -12, 12)
    },
    compressor: {
      enabled: boolOr(compressor.enabled, defaultEffects.compressor.enabled),
      thresholdDb: numberIn(compressor.thresholdDb, defaultEffects.compressor.thresholdDb, -60, 0),
      ratio: numberIn(compressor.ratio, defaultEffects.compressor.ratio, 1, 20),
      attackMs: numberIn(compressor.attackMs, defaultEffects.compressor.attackMs, 0, 1000),
      releaseMs: numberIn(compressor.releaseMs, defaultEffects.compressor.releaseMs, 10, 1000)
    },
    limiter: {
      enabled: boolOr(limiter.enabled, defaultEffects.limiter.enabled),
      ceilingDb: numberIn(limiter.ceilingDb, defaultEffects.limiter.ceilingDb, -12, 0)
    },
    reverb: {
      enabled: boolOr(reverb.enabled, defaultEffects.reverb.enabled),
      mix: numberIn(reverb.mix, defaultEffects.reverb.mix, 0, 1),
      decaySec: numberIn(reverb.decaySec, defaultEffects.reverb.decaySec, 0.1, 6)
    }
  };
}

export function soundEffectsAreDefault(value: unknown) {
  return JSON.stringify(normalizeSoundEffects(value)) === JSON.stringify(defaultEffects);
}

export function soundEffectsAreActive(value: unknown) {
  const effects = normalizeSoundEffects(value);
  return (
    effects.pitchEnabled ||
    effects.eq.enabled ||
    effects.compressor.enabled ||
    effects.limiter.enabled ||
    effects.reverb.enabled
  );
}

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
    effects: getDefaultSoundEffects(),
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
    soundboardMonitorVolume: volumeOr(currentSettings.soundboardMonitorVolume, defaultSettings.soundboardMonitorVolume),
    echoCancellationEnabled: boolOr(currentSettings.echoCancellationEnabled, defaultSettings.echoCancellationEnabled),
    noiseSuppressionEnabled: boolOr(currentSettings.noiseSuppressionEnabled, defaultSettings.noiseSuppressionEnabled),
    noiseSuppressionAttenuationDb: Math.round(numberIn(currentSettings.noiseSuppressionAttenuationDb, defaultSettings.noiseSuppressionAttenuationDb, 6, 30))
  };
  settings.stopAllHotkey = normalizeAccelerator(settings.stopAllHotkey);
  settings.cycleBoardsHotkey = normalizeAccelerator(settings.cycleBoardsHotkey);
  settings.monitorDeviceId = normalizeSelectableDeviceId(settings.monitorDeviceId);
  settings.virtualOutputDeviceId = normalizeSelectableDeviceId(settings.virtualOutputDeviceId);
  if (!settings.virtualOutputMode) settings.virtualOutputMode = defaultSettings.virtualOutputMode;
  if (!settings.virtualBackend) settings.virtualBackend = defaultSettings.virtualBackend;
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
        volume: sound.volume === 0.9 ? 1 : sound.volume,
        effects: normalizeSoundEffects(sound.effects)
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
