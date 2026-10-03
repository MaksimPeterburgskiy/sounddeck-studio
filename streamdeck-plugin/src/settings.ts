import type { ControlSettingKey } from "../../src/lib/controlProtocol";

export type ActionSettings = {
  boardId?: string;
  soundId?: string;
  title?: string;
  key?: ControlSettingKey;
};

export const settingLabels: Record<ControlSettingKey, string> = {
  micPassthrough: "Mic passthrough",
  soundboardToVirtualMic: "Sounds to virtual mic",
  noiseSuppressionEnabled: "Noise suppression",
  echoCancellationEnabled: "Echo cancellation",
  monitorToHeadphones: "Monitor to headphones"
};

export function settingKey(value: unknown): ControlSettingKey | undefined {
  return typeof value === "string" && Object.hasOwn(settingLabels, value)
    ? value as ControlSettingKey : undefined;
}
