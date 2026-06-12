export type OutputTarget = "monitor" | "virtual" | "both";
export type RetriggerMode = "restart" | "overlap" | "stop";

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
  color: string;
  icon: string;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  loop: boolean;
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
  createdAt: string;
  updatedAt: string;
  sounds: SoundSlot[];
}

export interface AudioSettings {
  micPassthrough: boolean;
  soundboardToVirtualMic: boolean;
  monitorToHeadphones: boolean;
  monitorMicToHeadphones: boolean;
  micVolume: number;
  soundboardVolume: number;
  monitorVolume: number;
  monitorDeviceId: string;
  virtualMicDeviceId: string;
  microphoneDeviceId: string;
  stopAllHotkey: string;
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
  mediaPath?: string;
  storedName?: string;
  ext?: string;
  mime?: string;
  size?: number;
  reason?: string;
}

export interface HotkeyBinding {
  type: "sound" | "stop-all";
  soundId?: string;
  boardId?: string;
  accelerator: string;
}

export interface HotkeyResult extends HotkeyBinding {
  ok: boolean;
  reason: string;
}

export type CorsairState = "unavailable" | "idle" | "connecting" | "connected" | "disconnected";

declare global {
  interface Window {
    sounddeck: {
      loadLibrary: () => Promise<SoundLibrary>;
      saveLibrary: (library: SoundLibrary) => Promise<{ ok: boolean }>;
      exportLibrary: (library: SoundLibrary) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>;
      importBackup: () => Promise<{ ok: boolean; canceled?: boolean; library?: SoundLibrary }>;
      revealLibrary: () => Promise<{ ok: boolean }>;
      importMedia: (paths: string[]) => Promise<MediaImportResult[]>;
      readMedia: (mediaPath: string) => Promise<ArrayBuffer>;
      saveRecording: (payload: { title: string; ext: string; bytes: ArrayBuffer }) => Promise<MediaImportResult>;
      registerHotkeys: (bindings: HotkeyBinding[]) => Promise<HotkeyResult[]>;
      openExternal: (url: string) => Promise<{ ok: boolean }>;
      getPathForFile: (file: File) => string;
      onHotkeyTrigger: (callback: (binding: HotkeyBinding) => void) => () => void;
      getCorsairStatus: () => Promise<CorsairState>;
      onCorsairStatus: (callback: (state: CorsairState) => void) => () => void;
      onCorsairKey: (callback: (key: string) => void) => () => void;
    };
  }
}
