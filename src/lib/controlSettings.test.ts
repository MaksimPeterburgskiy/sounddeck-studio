import { describe, expect, it } from "vitest";
import { applyAudioControlCommand } from "./controlSettings";
import { makeAudioSettings } from "./testing/webAudioFakes";
import type { ControlSettingKey, ControlVolumeBus } from "./controlProtocol";

describe("external audio controls", () => {
  it.each<ControlSettingKey>(["micPassthrough", "soundboardToVirtualMic", "noiseSuppressionEnabled", "echoCancellationEnabled", "monitorToHeadphones"])("sets and toggles %s", (key) => {
    const initial = makeAudioSettings();
    const set = applyAudioControlCommand(initial, { command: "setting.set", args: { key, value: false } });
    const toggled = applyAudioControlCommand(set.settings, { command: "setting.toggle", args: { key } });
    expect(set.data).toEqual({ key, value: false });
    expect(toggled.data).toEqual({ key, value: true });
    expect(toggled.settings).toEqual({ ...initial, [key]: true });
  });

  it.each<ControlVolumeBus>(["micVirtual", "micMonitor", "soundboardVirtual", "soundboardMonitor"])("preserves %s volume across mute and unmutes on volume changes", (bus) => {
    const initial = makeAudioSettings({ [`${bus}Volume`]: 0.4 });
    const muted = applyAudioControlCommand(initial, { command: "volume.mute", args: { bus } });
    expect(muted.data).toEqual({ bus, value: 0.4, muted: true });
    expect(initial[`${bus}Muted`]).toBe(false);
    const explicit = applyAudioControlCommand(muted.settings, { command: "volume.mute", args: { bus, muted: true } });
    expect(explicit.settings).toEqual(muted.settings);
    const restored = applyAudioControlCommand(muted.settings, { command: "volume.mute", args: { bus, muted: false } });
    expect(restored.data).toEqual({ bus, value: 0.4, muted: false });
    const adjusted = applyAudioControlCommand(muted.settings, { command: "volume.adjust", args: { bus, delta: 0.2 } });
    expect(adjusted.settings[`${bus}Volume`]).toBeCloseTo(0.6);
    expect(adjusted.settings[`${bus}Muted`]).toBe(false);
    const set = applyAudioControlCommand(muted.settings, { command: "volume.set", args: { bus, value: 0 } });
    expect(set.data).toEqual({ bus, value: 0, muted: false });
    expect(set.settings).toEqual({ ...initial, [`${bus}Volume`]: 0 });
  });

  it("clamps adjustments and applies consecutive changes to the latest settings", () => {
    let settings = makeAudioSettings({ micVirtualVolume: 0.99, micVirtualMuted: true });
    settings = applyAudioControlCommand(settings, { command: "volume.adjust", args: { bus: "micVirtual", delta: 0.02 } }).settings;
    expect(settings.micVirtualVolume).toBe(1);
    settings = applyAudioControlCommand(settings, { command: "volume.adjust", args: { bus: "micVirtual", delta: -0.2 } }).settings;
    expect(settings.micVirtualVolume).toBe(0.8);
    const result = applyAudioControlCommand(settings, { command: "volume.adjust", args: { bus: "micVirtual", delta: -2 } });
    expect(result.data).toEqual({ bus: "micVirtual", value: 0, muted: false });
  });
});
