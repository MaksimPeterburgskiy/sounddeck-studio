export type OutputTarget = "monitor" | "virtual" | "both";
export type RetriggerMode = "restart" | "overlap" | "stop";
export type SoundDeckPlatform = "win32" | "darwin" | "linux" | "unknown";
export type VirtualOutputMode = "managed" | "manual";
export type VirtualBackend = "windows-vbcable" | "macos-bundled-blackhole" | "linux-managed-pactl" | "linux-managed-pipewire" | "manual";

export interface SoundEffects {
  pitchEnabled: boolean;
  pitchSemitones: number;
  eq: {
    enabled: boolean;
    lowGainDb: number;
    midGainDb: number;
    highGainDb: number;
  };
  compressor: {
    enabled: boolean;
    thresholdDb: number;
    ratio: number;
    attackMs: number;
    releaseMs: number;
  };
  limiter: {
    enabled: boolean;
    ceilingDb: number;
  };
  reverb: {
    enabled: boolean;
    mix: number;
    decaySec: number;
  };
}

export interface SoundSlot {
  id: string;
  title: string;
  mediaPath: string;
  storedName: string;
  mime: string;
  ext: string;
  size: number;
  duration?: number;
  trimStartSec?: number;
  trimEndSec?: number;
  playbackRate?: number;
  effects?: SoundEffects;
  color: string;
  icon: string;
  image?: string;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  loop: boolean;
  soloPlay: boolean;
  retriggerMode: RetriggerMode;
  hotkey: string;
  outputTarget: OutputTarget;
  waveform?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface SoundBoard {
  id: string;
  name: string;
  color: string;
  icon: string;
  switchHotkey?: string;
  createdAt: string;
  updatedAt: string;
  sounds: SoundSlot[];
}

export interface AudioSettings {
  micPassthrough: boolean;
  echoCancellationEnabled: boolean;
  noiseSuppressionEnabled: boolean;
  noiseSuppressionAttenuationDb: number;
  soundboardToVirtualMic: boolean;
  monitorToHeadphones: boolean;
  monitorMicToHeadphones: boolean;
  micVirtualVolume: number;
  micMonitorVolume: number;
  soundboardVirtualVolume: number;
  soundboardMonitorVolume: number;
  monitorDeviceId: string;
  virtualOutputDeviceId: string;
  virtualOutputMode: VirtualOutputMode;
  virtualBackend: VirtualBackend;
  microphoneDeviceId: string;
  stopAllHotkey: string;
  cycleBoardsHotkey: string;
}

export interface SoundLibrary {
  version: number;
  activeBoardId: string;
  settings: AudioSettings;
  boards: SoundBoard[];
}

export interface MediaImportResult {
  ok: boolean;
  id?: string;
  title?: string;
  sourcePath: string;
  sourceUrl?: string;
  mediaPath?: string;
  storedName?: string;
  ext?: string;
  mime?: string;
  size?: number;
  reason?: string;
}

export interface MediaCropResult {
  ok: boolean;
  reason?: string;
  mediaPath?: string;
  storedName?: string;
  ext?: string;
  mime?: string;
  size?: number;
}

export interface HotkeyBinding {
  type: "sound" | "stop-all" | "board" | "cycle-board";
  soundId?: string;
  boardId?: string;
  accelerator: string;
}

export interface HotkeyResult extends HotkeyBinding {
  ok: boolean;
  reason: string;
}

export type CorsairState = "unavailable" | "idle" | "connecting" | "connected" | "disconnected";

export interface AppCapabilities {
  platform: SoundDeckPlatform;
  managedVirtualBackend: VirtualBackend;
  managedVirtualMicAvailable: boolean;
  runAtStartupSupported: boolean;
  hotkeys: {
    advancedHookAvailable: boolean;
    globalShortcutFallbackAvailable: boolean;
    lastFailureReason: string;
    permissionHelpUrl?: string;
  };
  updateChecksSupported: boolean;
  corsairAvailable: boolean;
}

export type UpdateChannel = "stable" | "beta";

export interface UpdateChannelState {
  /** Explicit user preference; null means the installed version decides. */
  preference: UpdateChannel | null;
  /** Channel implied by the installed version's semver prerelease tag. */
  installedChannel: UpdateChannel;
}

export type UpdateStatus =
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "error"; message?: string }
  | { state: "downloading"; version?: string; percent?: number }
  | { state: "ready"; version: string };

export interface StartupSettings {
  supported: boolean;
  enabled: boolean;
  hideOnStartup?: boolean;
  wasOpenedAtLogin?: boolean;
  wasOpenedAsHidden?: boolean;
  status?: string;
  reason?: string;
}

declare global {
  interface Window {
    sounddeck: {
      loadLibrary: () => Promise<SoundLibrary>;
      saveLibrary: (library: SoundLibrary) => Promise<{ ok: boolean }>;
      exportBoard: (board: SoundBoard) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>;
      importBoard: () => Promise<{ ok: boolean; canceled?: boolean; reason?: string; board?: SoundBoard }>;
      revealLibrary: () => Promise<{ ok: boolean }>;
      importMedia: (paths: string[]) => Promise<MediaImportResult[]>;
      downloadMedia: (urls: string[]) => Promise<MediaImportResult[]>;
      readMedia: (mediaPath: string) => Promise<ArrayBuffer>;
      getNoiseSuppressionAssets: () => Promise<{ wasm: ArrayBuffer; model: ArrayBuffer }>;
      deleteMedia: (mediaPath: string) => Promise<{ ok: boolean; reason?: string }>;
      cropMedia: (payload: { mediaPath: string; ext: string; startSec: number; endSec: number; rate: number; sampleRate?: number }) => Promise<MediaCropResult>;
      saveRecording: (payload: { title: string; ext: string; bytes: ArrayBuffer }) => Promise<MediaImportResult>;
      registerHotkeys: (bindings: HotkeyBinding[]) => Promise<HotkeyResult[]>;
      setHotkeyCapture: (active: boolean) => Promise<{ ok: boolean }>;
      openExternal: (url: string) => Promise<{ ok: boolean }>;
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<SoundDeckPlatform>;
      getCapabilities: () => Promise<AppCapabilities>;
      getStartupSettings: () => Promise<StartupSettings>;
      setRunAtStartup: (enabled: boolean, options?: { hideOnStartup?: boolean }) => Promise<StartupSettings & { ok: boolean }>;
      getPathForFile: (file: File) => string;
      onHotkeyTrigger: (callback: (binding: HotkeyBinding) => void) => () => void;
      getCorsairStatus: () => Promise<CorsairState>;
      onCorsairStatus: (callback: (state: CorsairState) => void) => () => void;
      onCorsairKey: (callback: (key: string) => void) => () => void;
      checkForUpdates: () => Promise<void>;
      installUpdate: () => Promise<void>;
      getUpdateChannel: () => Promise<UpdateChannelState>;
      setUpdateChannel: (channel: UpdateChannel) => Promise<UpdateChannelState>;
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
    };
  }
}
