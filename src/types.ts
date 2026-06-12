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
  soundboardToVirtualMic: boolean;
  monitorToHeadphones: boolean;
  monitorMicToHeadphones: boolean;
  micVolume: number;
  soundboardVolume: number;
  monitorVolume: number;
  monitorDeviceId: string;
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
  type: "sound" | "stop-all" | "board";
  soundId?: string;
  boardId?: string;
  accelerator: string;
}

export interface HotkeyResult extends HotkeyBinding {
  ok: boolean;
  reason: string;
}

export type CorsairState = "unavailable" | "idle" | "connecting" | "connected" | "disconnected";

export type UpdateStatus =
  | { state: "downloading"; version?: string; percent?: number }
  | { state: "ready"; version: string };

declare global {
  interface Window {
    sounddeck: {
      loadLibrary: () => Promise<SoundLibrary>;
      saveLibrary: (library: SoundLibrary) => Promise<{ ok: boolean }>;
      exportBoard: (board: SoundBoard) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string }>;
      importBoard: () => Promise<{ ok: boolean; canceled?: boolean; reason?: string; board?: SoundBoard }>;
      revealLibrary: () => Promise<{ ok: boolean }>;
      importMedia: (paths: string[]) => Promise<MediaImportResult[]>;
      readMedia: (mediaPath: string) => Promise<ArrayBuffer>;
      deleteMedia: (mediaPath: string) => Promise<{ ok: boolean; reason?: string }>;
      saveRecording: (payload: { title: string; ext: string; bytes: ArrayBuffer }) => Promise<MediaImportResult>;
      registerHotkeys: (bindings: HotkeyBinding[]) => Promise<HotkeyResult[]>;
      openExternal: (url: string) => Promise<{ ok: boolean }>;
      getVersion: () => Promise<string>;
      getPathForFile: (file: File) => string;
      onHotkeyTrigger: (callback: (binding: HotkeyBinding) => void) => () => void;
      getCorsairStatus: () => Promise<CorsairState>;
      onCorsairStatus: (callback: (state: CorsairState) => void) => () => void;
      onCorsairKey: (callback: (key: string) => void) => () => void;
      installUpdate: () => Promise<void>;
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
    };
  }
}
