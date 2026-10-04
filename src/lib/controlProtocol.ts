export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_DEFAULT_PORT = 41730;

export type ControlSettingKey = "micPassthrough" | "soundboardToVirtualMic" | "noiseSuppressionEnabled" | "echoCancellationEnabled" | "monitorToHeadphones";
export type ControlVolumeBus = "micVirtual" | "micMonitor" | "soundboardVirtual" | "soundboardMonitor";
export type ControlToggleSettings = Record<ControlSettingKey, boolean>;
export type ControlVolumes = Record<ControlVolumeBus, { value: number; muted: boolean }>;
export interface ControlSettingResult { key: ControlSettingKey; value: boolean }
export interface ControlVolumeResult { bus: ControlVolumeBus; value: number; muted: boolean }

export interface ControlPlaybackVoice {
  soundId: string;
  startedAt: number;
  duration: number;
  loop: boolean;
}

export interface ControlLiveState {
  activeBoardId: string;
  playback: ControlPlaybackVoice[];
}

export type ControlPlaybackResult = { ok: true } | { ok: false; code: "unavailable" | "not-found" | "internal-error" };

export interface ControlLibrary {
  activeBoardId: string;
  boards: Array<{
    id: string;
    name: string;
    color: string;
    sounds: Array<{ id: string; title: string; color: string; hasImage: boolean }>;
  }>;
}

export interface ControlSnapshot extends ControlLiveState {
  library: ControlLibrary;
  settings: ControlToggleSettings;
  volumes: ControlVolumes;
}

export interface ControlCommandArgs {
  "sound.play": { soundId: string; boardId?: string; title?: string };
  "sound.stop": { soundId: string };
  "playback.stopAll": Record<string, never>;
  "board.activate": { boardId: string };
  "board.cycle": { direction?: 1 | -1 };
  "library.get": Record<string, never>;
  "sound.image": { soundId: string };
  "setting.set": { key: ControlSettingKey; value: boolean };
  "setting.toggle": { key: ControlSettingKey };
  "volume.set": { bus: ControlVolumeBus; value: number };
  "volume.adjust": { bus: ControlVolumeBus; delta: number };
  "volume.mute": { bus: ControlVolumeBus; muted?: boolean };
}

export type ControlCommandName = keyof ControlCommandArgs;
export type ControlCommand = {
  [Name in ControlCommandName]: { type: "command"; id: string; command: Name; args: ControlCommandArgs[Name] }
}[ControlCommandName];

export interface ControlClient {
  name: string;
  version: string;
}

export interface ControlHello {
  type: "hello";
  protocol: number;
  token: string;
  client: ControlClient;
}

export type ControlErrorCode = "unauthorized" | "forbidden" | "disabled" | "protocol-mismatch" | "invalid-message" | "invalid-args" | "unknown-command" | "not-found" | "rate-limited" | "payload-too-large" | "busy" | "unavailable" | "internal-error";
export type ControlResult =
  | { type: "result"; id: string; ok: true; data?: ControlLibrary | { image: string | null } | ControlSettingResult | ControlVolumeResult }
  | { type: "result"; id: string; ok: false; code: ControlErrorCode };

export type RendererControlResult =
  | ControlPlaybackResult
  | { ok: true; data: ControlSettingResult | ControlVolumeResult }
  | { ok: false; code: ControlErrorCode };

export interface ControlEventData {
  "library.changed": ControlLibrary;
  "board.changed": { activeBoardId: string };
  "playback.changed": ControlPlaybackVoice[];
  "settings.changed": ControlToggleSettings;
  "volumes.changed": ControlVolumes;
}

export type ControlEventName = keyof ControlEventData;
export type ControlClientMessage = ControlHello | ControlCommand;

export type ControlEvent = {
  [Name in keyof ControlEventData]: { type: "event"; event: Name; data: ControlEventData[Name] }
}[keyof ControlEventData];

export type ControlServerMessage = ControlResult | ControlEvent
  | { type: "welcome"; protocol: number; app: { version: string }; state: ControlSnapshot }
  | { type: "error"; code: ControlErrorCode; message: string; protocol: number };

export interface ControlSettings {
  enabled: boolean;
  port: number;
  token: string;
  allowLan: boolean;
}

export interface ControlDiscovery extends ControlSettings {
  protocol: number;
  host: "127.0.0.1" | "0.0.0.0";
  appVersion: string;
  appPath: string;
}

export type ControlSettingsPatch = Partial<Pick<ControlSettings, "enabled" | "port" | "allowLan">>;

export interface ControlStatus extends ControlSettings {
  listening: boolean;
  clients: ControlClient[];
  error: { code: string; message: string } | null;
}

type RendererMutationCommandName = "sound.play" | "setting.set" | "setting.toggle" | "volume.set" | "volume.adjust" | "volume.mute";
export type RendererControlCommand =
  | { command: "control.cancel"; requestId: string; reason?: "operation-timeout" }
  | {
    [Name in RendererMutationCommandName]: { command: Name; requestId: string; args: ControlCommandArgs[Name] }
  }[RendererMutationCommandName]
  | { command: "sound.stop"; args: ControlCommandArgs["sound.stop"] }
  | { command: "board.cycle"; args: ControlCommandArgs["board.cycle"] };
