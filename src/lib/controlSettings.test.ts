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
    expect(adjusted.settings[`${bus}Volume`]).toBe(0.6);
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

  it("rounds set and adjusted volumes to four decimals", () => {
    const initial = makeAudioSettings({ micVirtualVolume: 0.95 });
    const adjusted = applyAudioControlCommand(initial, { command: "volume.adjust", args: { bus: "micVirtual", delta: -0.05 } });
    expect(adjusted.data).toEqual({ bus: "micVirtual", value: 0.9, muted: false });
    const set = applyAudioControlCommand(initial, { command: "volume.set", args: { bus: "micVirtual", value: 0.123456 } });
    expect(set.data).toEqual({ bus: "micVirtual", value: 0.1235, muted: false });
    const fractional = applyAudioControlCommand(initial, { command: "volume.adjust", args: { bus: "micVirtual", delta: -0.123456 } });
    expect(fractional.data).toEqual({ bus: "micVirtual", value: 0.8265, muted: false });
  });

  it("reaches exactly zero after twenty decrements of 0.05 from one", () => {
    let settings = makeAudioSettings({ micVirtualVolume: 1 });
    for (let press = 0; press < 20; press++) {
      settings = applyAudioControlCommand(settings, { command: "volume.adjust", args: { bus: "micVirtual", delta: -0.05 } }).settings;
    }
    expect(settings.micVirtualVolume).toBe(0);
  });
});
