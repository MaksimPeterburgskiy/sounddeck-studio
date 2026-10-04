export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_DEFAULT_PORT = 41730;

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
}

export interface ControlCommandArgs {
  "sound.play": { soundId: string; boardId?: string; title?: string };
  "sound.stop": { soundId: string };
  "playback.stopAll": Record<string, never>;
  "board.activate": { boardId: string };
  "board.cycle": { direction?: 1 | -1 };
  "library.get": Record<string, never>;
  "sound.image": { soundId: string };
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
  | { type: "result"; id: string; ok: true; data?: ControlLibrary | { image: string | null } }
  | { type: "result"; id: string; ok: false; code: ControlErrorCode };

export interface ControlEventData {
  "library.changed": ControlLibrary;
  "board.changed": { activeBoardId: string };
  "playback.changed": ControlPlaybackVoice[];
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

export type RendererControlCommand =
  | { command: "sound.cancel"; requestId: string }
  | { command: "sound.play"; requestId: string; args: ControlCommandArgs["sound.play"] }
  | { command: "sound.stop"; args: ControlCommandArgs["sound.stop"] }
  | { command: "board.cycle"; args: ControlCommandArgs["board.cycle"] };
