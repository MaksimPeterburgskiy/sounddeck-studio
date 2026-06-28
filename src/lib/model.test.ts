import { describe, expect, it } from "vitest";
import { acceleratorLooksReserved, formatBytes, formatDuration, normalizeLibrary, normalizeSoundEffects, soundEffectsAreDefault, soundFromImport } from "./model";
import type { SoundLibrary } from "../types";

describe("model helpers", () => {
  it("normalizes missing settings and keeps a valid active board", () => {
    const library = normalizeLibrary({
      version: 1,
      activeBoardId: "missing",
      settings: {} as SoundLibrary["settings"],
      boards: [{ id: "a", name: "A", color: "#fff", icon: "zap", createdAt: "", updatedAt: "", sounds: [] }]
    });

    expect(library.activeBoardId).toBe("a");
    expect(library.settings.stopAllHotkey).toBe("Ctrl+Alt+Space");
    expect(library.settings.cycleBoardsHotkey).toBe("");
    expect(library.settings.micVirtualVolume).toBe(1);
    expect(library.settings.micMonitorVolume).toBe(1);
    expect(library.settings.soundboardVirtualVolume).toBe(1);
    expect(library.settings.soundboardMonitorVolume).toBe(1);
    expect(library.settings.virtualOutputDeviceId).toBe("");
    expect(library.settings.virtualOutputMode).toBe("managed");
    expect(library.settings.virtualBackend).toBe("windows-vbcable");
  });

  it("uses 100% defaults instead of migrating legacy shared volume settings", () => {
    const library = normalizeLibrary({
      version: 1,
      activeBoardId: "a",
      settings: {
        micVolume: 0.6,
        soundboardVolume: 0.7,
        monitorVolume: 0.5
      } as unknown as SoundLibrary["settings"],
      boards: [{ id: "a", name: "A", color: "#fff", icon: "zap", createdAt: "", updatedAt: "", sounds: [] }]
    });

    expect(library.settings.micVirtualVolume).toBe(1);
    expect(library.settings.micMonitorVolume).toBe(1);
    expect(library.settings.soundboardVirtualVolume).toBe(1);
    expect(library.settings.soundboardMonitorVolume).toBe(1);
  });

  it("normalizes browser audio role aliases back to system default", () => {
    const library = normalizeLibrary({
      version: 1,
      activeBoardId: "a",
      settings: {
        microphoneDeviceId: "default",
        monitorDeviceId: "communications",
        virtualOutputDeviceId: "default"
      } as SoundLibrary["settings"],
      boards: [{ id: "a", name: "A", color: "#fff", icon: "zap", createdAt: "", updatedAt: "", sounds: [] }]
    });

    expect(library.settings.microphoneDeviceId).toBe("");
    expect(library.settings.monitorDeviceId).toBe("");
    expect(library.settings.virtualOutputDeviceId).toBe("");
  });

  it("migrates legacy Electron accelerators to canonical tokens", () => {
    const library = normalizeLibrary({
      version: 1,
      activeBoardId: "a",
      settings: { stopAllHotkey: "CommandOrControl+Alt+Space" } as SoundLibrary["settings"],
      boards: [{
        id: "a", name: "A", color: "#fff", icon: "zap", createdAt: "", updatedAt: "", switchHotkey: "CommandOrControl+num1",
        sounds: [{
          id: "s", title: "S", mediaPath: "", storedName: "", mime: "", ext: "", size: 0, color: "#fff", icon: "zap",
          volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false, soloPlay: true, retriggerMode: "restart",
          hotkey: "Shift+numadd", outputTarget: "both", createdAt: "", updatedAt: ""
        }]
      }]
    });

    expect(library.settings.stopAllHotkey).toBe("Ctrl+Alt+Space");
    expect(library.boards[0].switchHotkey).toBe("Ctrl+Num1");
    expect(library.boards[0].sounds[0].hotkey).toBe("Shift+NumAdd");
  });

  it("creates a sound from a successful media import", () => {
    const sound = soundFromImport({
      ok: true,
      id: "sound-1",
      title: "Airhorn",
      sourcePath: "C:/tmp/airhorn.mp3",
      mediaPath: "C:/app/media/sound-1.mp3",
      storedName: "sound-1.mp3",
      ext: ".mp3",
      mime: "audio/mpeg",
      size: 1234
    }, 0, "both");

    expect(sound?.title).toBe("Airhorn");
    expect(sound?.outputTarget).toBe("both");
    expect(sound?.retriggerMode).toBe("restart");
    expect(sound?.soloPlay).toBe(true);
    expect(soundEffectsAreDefault(sound?.effects)).toBe(true);
  });

  it("normalizes sound effect defaults and clamps invalid values", () => {
    const effects = normalizeSoundEffects({
      pitchSemitones: 99,
      eq: { enabled: true, lowGainDb: -99, midGainDb: 4, highGainDb: 99 },
      compressor: { enabled: true, thresholdDb: -99, ratio: 99, attackMs: -1, releaseMs: 99999 },
      limiter: { enabled: true, ceilingDb: 10 },
      reverb: { enabled: true, mix: 2, decaySec: 99 }
    });

    expect(effects.pitchEnabled).toBe(true);
    expect(effects.pitchSemitones).toBe(24);
    expect(effects.eq.lowGainDb).toBe(-12);
    expect(effects.eq.midGainDb).toBe(4);
    expect(effects.eq.highGainDb).toBe(12);
    expect(effects.compressor.thresholdDb).toBe(-60);
    expect(effects.compressor.ratio).toBe(20);
    expect(effects.compressor.attackMs).toBe(0);
    expect(effects.compressor.releaseMs).toBe(3000);
    expect(effects.limiter.ceilingDb).toBe(0);
    expect(effects.reverb.mix).toBe(1);
    expect(effects.reverb.decaySec).toBe(6);
  });

  it("keeps explicit pitch disabled while preserving the semitone value", () => {
    const effects = normalizeSoundEffects({ pitchEnabled: false, pitchSemitones: 7 });

    expect(effects.pitchEnabled).toBe(false);
    expect(effects.pitchSemitones).toBe(7);
  });

  it("adds default effects to legacy sounds during library normalization", () => {
    const library = normalizeLibrary({
      version: 1,
      activeBoardId: "a",
      settings: {} as SoundLibrary["settings"],
      boards: [{
        id: "a", name: "A", color: "#fff", icon: "zap", createdAt: "", updatedAt: "",
        sounds: [{
          id: "s", title: "S", mediaPath: "", storedName: "", mime: "", ext: "", size: 0, color: "#fff", icon: "zap",
          volume: 1, fadeInMs: 0, fadeOutMs: 0, loop: false, soloPlay: true, retriggerMode: "restart",
          hotkey: "", outputTarget: "both", createdAt: "", updatedAt: ""
        }]
      }]
    });

    expect(soundEffectsAreDefault(library.boards[0].sounds[0].effects)).toBe(true);
  });

  it("formats metadata for compact cards", () => {
    expect(formatDuration(65.2)).toBe("1:05");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(acceleratorLooksReserved("Alt+F4")).toBe(true);
  });
});
