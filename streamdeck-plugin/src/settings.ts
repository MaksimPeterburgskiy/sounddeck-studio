import type { ControlSettingKey } from "../../src/lib/controlProtocol";

export type ActionSettings = {
  /** Monotonic property inspector snapshot revision; preserved by plugin updates. */
  inspectorRevision?: number;
  boardId?: string;
  soundId?: string;
  title?: string;
  key?: ControlSettingKey;
};

export const settingLabels: Record<ControlSettingKey, string> = {
  micPassthrough: "Mic\npass-thru",
  soundboardToVirtualMic: "Virtual\nmic",
  noiseSuppressionEnabled: "Noise\nfilter",
  echoCancellationEnabled: "Echo\ncancel",
  monitorToHeadphones: "Monitor\nphones"
};

export function settingKey(value: unknown): ControlSettingKey | undefined {
  return typeof value === "string" && Object.hasOwn(settingLabels, value)
    ? value as ControlSettingKey : undefined;
}
