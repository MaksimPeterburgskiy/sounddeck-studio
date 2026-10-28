import type { AudioSettings } from "../types";
import type { ControlSettingValue, ControlVolumeResult, RendererControlCommand } from "./controlProtocol";

type WithoutRequestId<Command> = Command extends { requestId: string } ? Omit<Command, "requestId"> : Command;
export type AudioControlCommand = WithoutRequestId<Extract<RendererControlCommand, { command: `setting.${string}` | `volume.${string}` }>>;

export function applyAudioControlCommand(settings: AudioSettings, message: AudioControlCommand): {
  settings: AudioSettings;
  data: ControlSettingValue | ControlVolumeResult;
} {
  if (message.command === "setting.set" || message.command === "setting.toggle") {
    const { key } = message.args;
    const data: ControlSettingValue = message.command === "setting.set" ? message.args : { key: message.args.key, value: !settings[message.args.key] };
    return { settings: { ...settings, [key]: data.value }, data };
  }
  const { bus } = message.args;
  const volumeKey = `${bus}Volume` as const;
  const muteKey = `${bus}Muted` as const;
  const requested = message.command === "volume.set" ? message.args.value
    : message.command === "volume.adjust" ? settings[volumeKey] + message.args.delta : settings[volumeKey];
  const value = message.command === "volume.mute" ? settings[volumeKey]
    : Math.min(1, Math.max(0, Math.round(requested * 10000) / 10000));
  const muted = message.command === "volume.mute" ? (message.args.muted ?? !settings[muteKey]) : false;
  return { settings: { ...settings, [volumeKey]: value, [muteKey]: muted }, data: { bus, value, muted } };
}
