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
    expect(library.settings.stopAllHotkey).toBe("CommandOrControl+Alt+Space");
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
  });

  it("formats metadata for compact cards", () => {
    expect(formatDuration(65.2)).toBe("1:05");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(acceleratorLooksReserved("Alt+F4")).toBe(true);
  });
});
