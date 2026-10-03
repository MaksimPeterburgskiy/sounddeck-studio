import type { ControlSettingKey, ControlVolumeBus } from "../../src/lib/controlProtocol";

export type ActionSettings = {
  /** Monotonic property inspector snapshot revision; preserved by plugin updates. */
  inspectorRevision?: number;
  boardId?: string;
  soundId?: string;
  title?: string;
  /** Empty/omitted means auto; fixed slots are one-based. */
  slot?: string | number;
  key?: ControlSettingKey;
  bus?: ControlVolumeBus;
  mode?: "up" | "down";
  step?: number;
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
