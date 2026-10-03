import type { AudioSettings } from "../types";
import type { ControlSettingResult, ControlVolumeResult, RendererControlCommand } from "./controlProtocol";

type WithoutRequestId<Command> = Command extends { requestId: string } ? Omit<Command, "requestId"> : Command;
export type AudioControlCommand = WithoutRequestId<Extract<RendererControlCommand, { command: `setting.${string}` | `volume.${string}` }>>;

export function applyAudioControlCommand(settings: AudioSettings, message: AudioControlCommand): {
  settings: AudioSettings;
  data: ControlSettingResult | ControlVolumeResult;
} {
  if (message.command === "setting.set" || message.command === "setting.toggle") {
    const { key } = message.args;
    const value = message.command === "setting.set" ? message.args.value : !settings[key];
    return { settings: { ...settings, [key]: value }, data: { key, value } };
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
