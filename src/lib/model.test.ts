import { describe, expect, it } from "vitest";
import { acceleratorLooksReserved, formatBytes, formatDuration, normalizeLibrary, soundFromImport } from "./model";
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
  });

  it("formats metadata for compact cards", () => {
    expect(formatDuration(65.2)).toBe("1:05");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(acceleratorLooksReserved("Alt+F4")).toBe(true);
  });
});
