import { describe, expect, it } from "vitest";
import type { ControlLibrary } from "../../src/lib/controlProtocol";
import { resolveSound } from "./resolveSound";

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

  it("does not guess by title across boards or use case-insensitive matches", () => {
    expect(resolveSound(library, { soundId: "old-id", title: "Airhorn" })).toBeUndefined();
    expect(resolveSound(library, { boardId: "missing", title: "Airhorn" })).toBeUndefined();
    expect(resolveSound(library, { boardId: "a", title: "airhorn" })).toBeUndefined();
    expect(resolveSound(library, {})).toBeUndefined();
  });
});
