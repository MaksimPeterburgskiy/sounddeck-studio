import { describe, expect, it } from "vitest";
import type { ControlLibrary } from "../../src/lib/controlProtocol";
import { resolveSound, currentSoundBinding } from "./resolveSound";

const sound = (id: string, title: string) => ({ id, title, color: "#1db7a6", hasImage: false });
const library: ControlLibrary = {
  activeBoardId: "a",
  boards: [
    { id: "a", name: "One", color: "#1db7a6", sounds: [sound("one", "Airhorn"), sound("two", "Airhorn")] },
    { id: "b", name: "Two", color: "#1db7a6", sounds: [sound("three", "Airhorn")] }
  ]
};

describe("sound binding resolution", () => {
  it("prioritizes the sound id across all boards over stale fallback metadata", () => {
    expect(resolveSound(library, { soundId: "three", boardId: "a", title: "Airhorn" })?.id).toBe("three");
  });

  it("resolves re-imported sounds by exact board and title, using the first duplicate as the server does", () => {
    expect(resolveSound(library, { soundId: "old-id", boardId: "a", title: "Airhorn" })?.id).toBe("one");
    expect(resolveSound(library, { boardId: "b", title: "Airhorn" })?.id).toBe("three");
  });

  it("matches old full titles to bounded metadata without guessing between truncated collisions", () => {
    const prefix = "H".repeat(256);
    const bounded: ControlLibrary = { activeBoardId: "a", boards: [{ id: "a", name: "One", color: "", sounds: [sound("new-id", prefix)] }] };
    expect(resolveSound(bounded, { soundId: "old-id", boardId: "a", title: prefix + "original" })?.id).toBe("new-id");
    bounded.boards[0].sounds.push(sound("other-id", prefix));
    expect(resolveSound(bounded, { soundId: "old-id", boardId: "a", title: prefix })).toBeUndefined();
    expect(resolveSound(bounded, { soundId: "other-id", boardId: "a", title: prefix })?.id).toBe("other-id");
  });

  it("preserves missing stable bindings in incomplete summaries while keeping summarized IDs usable", () => {
    const partial: ControlLibrary = { ...library, incomplete: true };
    const binding = { soundId: "omitted", boardId: "a", title: "Airhorn" };
    expect(resolveSound(partial, binding)).toBeUndefined();
    expect(currentSoundBinding(partial, binding)).toBe(binding);
    expect(resolveSound(partial, { soundId: "three", boardId: "a", title: "Airhorn" })?.id).toBe("three");
    expect(currentSoundBinding(partial, { soundId: "three", boardId: "a", title: "Old" })).toEqual({ soundId: "three", boardId: "b", title: "Airhorn" });
    // Full snapshots keep the existing reimport fallback behavior.
    expect(resolveSound({ ...partial, incomplete: false }, binding)?.id).toBe("one");
  });

  it("does not guess by title across boards or use case-insensitive matches", () => {
    expect(resolveSound(library, { soundId: "old-id", title: "Airhorn" })).toBeUndefined();
    expect(resolveSound(library, { boardId: "missing", title: "Airhorn" })).toBeUndefined();
    expect(resolveSound(library, { boardId: "a", title: "airhorn" })).toBeUndefined();
    expect(resolveSound(library, {})).toBeUndefined();
  });
});
