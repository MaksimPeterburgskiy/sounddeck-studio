import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlLibrary } from "../../src/lib/controlProtocol";
import { autoSlots, BOARD_SLOT, BoardSlots, slotBoard, type VisibleSlotKey } from "./boardSlots";
import type { ActionSettings } from "./settings";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const settle = () => vi.advanceTimersByTime(100);

function library(a = 8, b = 3, activeBoardId = "a"): ControlLibrary {
  return { activeBoardId, boards: [["a", a], ["b", b]].map(([id, length]) => ({
    id: String(id), name: String(id), color: "#1db7a6", sounds: Array.from({ length: Number(length) }, (_, index) => ({
      id: `${id}${index + 1}`, title: `Sound ${index + 1}`, color: "#1db7a6", hasImage: false,
    })),
  })) };
}
function key(id: string, row = 0, column = 0, deviceId = "deck", settings: ActionSettings = {}): VisibleSlotKey {
  return { id, deviceId, manifestId: BOARD_SLOT, coordinates: { row, column }, settings };
}
function setup(...keys: VisibleSlotKey[]) {
  const slots = new BoardSlots();
  slots.updateLibrary(library());
  for (const item of keys) slots.appear(item);
  settle();
  return slots;
}

describe("board slot mapping", () => {
  it("orders auto keys by row then column, excluding controls, fixed keys and coordinate-less multi-actions", () => {
    const keys = [key("last", 1, 0), key("second", 0, 4), key("first", 0, 1),
      key("fixed", 0, 0, "deck", { slot: "2" }), { ...key("stop"), manifestId: "com.sounddeck.studio.stop-all" },
      { ...key("next"), manifestId: "com.sounddeck.studio.page-next" },
      { ...key("multi"), coordinates: undefined }, key("other", 0, 0, "mini")];
    expect(autoSlots(keys, "deck").map((item) => item.id)).toEqual(["first", "second", "last"]);
    const slots = setup(...keys);
    expect(slots.page("deck").size).toBe(3);
    expect(slots.sound("first")?.id).toBe("a1");
    expect(slots.sound("second")?.id).toBe("a2");
    expect(slots.sound("last")?.id).toBe("a3");
    expect(slots.sound("other")?.id).toBe("a1");
    expect(slots.sound("multi")).toBeNull();
  });

  it("recomputes after appearance, disappearance and switching auto/fixed without counting hidden pages or folders", () => {
    const slots = setup(key("right", 0, 3));
    slots.appear(key("left", 0, 1));
    expect(slots.sound("right")?.id).toBe("a2");
    slots.disappear("left");
    expect(slots.sound("right")?.id).toBe("a1");
    slots.appear(key("left", 0, 1));
    slots.settings("left", { slot: 8 });
    expect(slots.page("deck").size).toBe(1);
    expect(slots.sound("right")?.id).toBe("a1");
    expect(slots.sound("left")?.id).toBe("a8");
    slots.settings("left", { slot: "" });
    expect(slots.sound("right")?.id).toBe("a2");
    slots.disappear("left");
    slots.disappear("right");
    slots.appear(key("folder", 0, 1));
    expect(slots.page("deck").size).toBe(1);
    expect(slots.sound("folder")?.id).toBe("a1");
    slots.disappear("folder");
    slots.appear(key("page-2", 0, 0));
    expect(slots.sound("page-2")?.id).toBe("a1");
  });

  it("resolves pinned versus follow boards and separates empty slots from missing boards", () => {
    const data = library();
    expect(slotBoard(data, {})?.id).toBe("a");
    expect(slotBoard(data, { boardId: "b" })?.id).toBe("b");
    expect(slotBoard(data, { boardId: "deleted" })).toBeUndefined();
    const slots = setup(key("follow"), key("pinned", 0, 1, "deck", { boardId: "b" }));
    slots.move("deck", 1);
    expect(slots.sound("follow")?.id).toBe("a2");
    expect(slots.sound("pinned")?.id).toBe("b2");
    slots.settings("pinned", { boardId: "deleted" });
    expect(slots.sound("pinned")).toBeUndefined();
    slots.settings("pinned", { boardId: "b" });
    slots.settings("follow", { slot: "100" });
    expect(slots.sound("follow")).toBeNull();
    slots.settings("follow", { slot: "invalid" });
    expect(slots.sound("follow")).toBeUndefined();
    slots.settings("follow", {});
    settle();
    slots.updateLibrary(library(8, 3, "b"));
    expect(slots.sound("follow")?.id).toBe("b1");
    expect(slots.sound("pinned")?.id).toBe("b1");
  });
});

describe("board slot paging", () => {
  it("reaches every sound of a pinned eight-sound board alongside one follow key", () => {
    const slots = setup(key("follow"), key("pin", 0, 1, "deck", { boardId: "b" }));
    slots.updateLibrary(library(3, 8));
    expect(slots.page("deck")).toMatchObject({ count: 8, size: 2 });
    const pinned: string[] = [];
    const follow: Array<string | undefined> = [];
    for (let page = 0; page < 8; page++) {
      pinned.push(slots.sound("pin")!.id);
      follow.push(slots.sound("follow")?.id);
      slots.move("deck", 1);
    }
    expect(pinned).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"]);
    expect(follow).toEqual(["a1", "a2", "a3", undefined, undefined, undefined, undefined, undefined]);
    expect(slots.page("deck")).toMatchObject({ label: "8 / 8", next: false });
    slots.move("deck", -1);
    expect(slots.sound("pin")?.id).toBe("b7");
  });

  it("uses each interleaved group's key count and positions, including pins to the active board", () => {
    const ids = ["follow-one", "follow-two", "pin-b", "pin-a-one", "pin-a-two", "pin-a-three"];
    const slots = setup(key(ids[4], 1, 0, "deck", { boardId: "a" }), key(ids[1], 0, 4),
      key(ids[3], 0, 3, "deck", { boardId: "a" }), key(ids[0], 0, 1),
      key(ids[2], 0, 2, "deck", { boardId: "b" }), key(ids[5], 1, 2, "deck", { boardId: "a" }),
      key("mini", 0, 0, "mini", { boardId: "b" }));
    slots.updateLibrary(library(7, 8));
    expect(ids.map((id) => slots.sound(id)?.id)).toEqual(["a1", "a2", "b1", "a1", "a2", "a3"]);
    expect(slots.page("deck")).toMatchObject({ count: 8, size: 6 });
    slots.move("deck", 1);
    expect(ids.map((id) => slots.sound(id)?.id)).toEqual(["a3", "a4", "b2", "a4", "a5", "a6"]);
    expect(slots.page("mini")).toMatchObject({ index: 0, count: 8 });
    expect(slots.sound("mini")?.id).toBe("b1");
    slots.move("deck", -1);
    const seen = [[], [], []] as string[][];
    for (let page = 0; page < 8; page++) {
      for (const [group, keys] of [[ids[0], ids[1]], [ids[2]], ids.slice(3)].entries()) {
        for (const id of keys) {
          const sound = slots.sound(id);
          if (sound) seen[group].push(sound.id);
        }
      }
      slots.move("deck", 1);
    }
    expect(seen).toEqual([
      ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
      ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"],
      ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
    ]);
  });

  it("clamps to the remaining groups after a pinned board shrinks or disappears", () => {
    const slots = setup(key("follow"), key("pin", 0, 1, "deck", { boardId: "b" }));
    slots.updateLibrary(library(3, 8));
    for (let page = 0; page < 7; page++) slots.move("deck", 1);
    slots.updateLibrary(library(3, 2));
    expect(slots.page("deck")).toMatchObject({ label: "3 / 3", index: 2 });
    expect(slots.sound("follow")?.id).toBe("a3");
    expect(slots.sound("pin")).toBeNull();
    slots.updateLibrary(library(3, 8));
    expect(slots.page("deck")).toMatchObject({ label: "3 / 8", index: 2 });
    expect(slots.sound("pin")?.id).toBe("b3");
    slots.move("deck", 1);
    const data = library(3, 8);
    data.boards = data.boards.filter((board) => board.id !== "b");
    slots.updateLibrary(data);
    expect(slots.page("deck").label).toBe("3 / 3");
    expect(slots.sound("pin")).toBeUndefined();
  });

  it("keeps offsets per device with different visible key counts, labels pages and does nothing at the ends", () => {
    const slots = setup(key("one"), key("two", 0, 1), key("mini", 0, 0, "mini"));
    expect(slots.page("deck")).toMatchObject({ label: "1 / 4", size: 2, index: 0, previous: false, next: true });
    slots.move("deck", -1);
    expect(slots.page("deck").label).toBe("1 / 4");
    slots.move("deck", 1);
    expect(slots.page("deck")).toMatchObject({ label: "2 / 4", index: 1, previous: true, next: true });
    expect(slots.page("mini")).toMatchObject({ label: "1 / 8", index: 0 });
    expect(slots.sound("one")?.id).toBe("a3");
    expect(slots.sound("two")?.id).toBe("a4");
    for (let i = 0; i < 5; i++) slots.move("deck", 1);
    expect(slots.page("deck")).toMatchObject({ label: "4 / 4", index: 3, previous: true, next: false });
    slots.move("deck", -1);
    expect(slots.page("deck").label).toBe("3 / 4");
    expect(slots.page("absent")).toMatchObject({ label: "1 / 1", size: 0, next: false, previous: false });
  });

  it("resets all device pages on active board change and clamps a shrinking board without later restoring the old offset", () => {
    const slots = setup(key("one"), key("two", 0, 1), key("mini", 0, 0, "mini"));
    for (let i = 0; i < 3; i++) { slots.move("deck", 1); slots.move("mini", 1); }
    slots.updateLibrary(library(3));
    expect(slots.page("deck")).toMatchObject({ label: "2 / 2", index: 1 });
    expect(slots.sound("two")).toBeNull();
    expect(slots.page("mini")).toMatchObject({ label: "3 / 3", index: 2 });
    slots.updateLibrary(library(8));
    expect(slots.page("deck").label).toBe("2 / 4");
    slots.updateLibrary(library(8, 3, "b"));
    expect(slots.page("deck")).toMatchObject({ label: "1 / 2", index: 0 });
    expect(slots.page("mini")).toMatchObject({ label: "1 / 3", index: 0 });
    slots.updateLibrary(library(8, 0, "b"));
    expect(slots.page("deck")).toMatchObject({ label: "1 / 1", index: 0 });
  });

  it("pages each represented group while fixed keys ignore paging and page counts", () => {
    const slots = setup(key("follow"), key("pin", 0, 1, "deck", { boardId: "b" }),
      key("fixed", 0, 2, "deck", { slot: 1, boardId: "b" }));
    slots.updateLibrary(library(3, 8));
    expect(slots.page("deck").label).toBe("1 / 8");
    slots.move("deck", 1);
    expect(slots.sound("follow")?.id).toBe("a2");
    expect(slots.sound("pin")?.id).toBe("b2");
    expect(slots.sound("fixed")?.id).toBe("b1");
    slots.disappear("pin");
    expect(slots.page("deck").label).toBe("2 / 3");
    slots.appear(key("pin", 0, 1, "deck", { boardId: "b", slot: 1 }));
    expect(slots.page("deck").label).toBe("2 / 3");
    slots.updateLibrary(library(3, 8, "b"));
    expect(slots.page("deck").index).toBe(0);
  });

  it("retains a device page across a complete page/folder transition and recomputes its size", () => {
    const slots = setup(key("old-one"), key("old-two", 0, 1));
    slots.move("deck", 1);
    slots.disappear("old-one"); slots.disappear("old-two");
    expect(slots.page("deck").label).toBe("1 / 1");
    settle();
    slots.updateLibrary(library());
    slots.appear(key("new-one"));
    expect(slots.page("deck")).toMatchObject({ label: "2 / 8", size: 1, index: 1 });
    expect(slots.sound("new-one")?.id).toBe("a2");
    slots.appear(key("new-two", 0, 1));
    expect(slots.page("deck")).toMatchObject({ label: "2 / 4", size: 2, index: 1 });
    expect(slots.sound("new-one")?.id).toBe("a3");
    expect(slots.sound("new-two")?.id).toBe("a4");
  });

  it("persists clamps when changing a pinned board to follow, without restoring the old page on expansion", () => {
    const slots = setup(key("follow"), key("pin", 0, 1, "deck", { boardId: "b" }));
    slots.updateLibrary(library(3, 8));
    for (let i = 0; i < 3; i++) slots.move("deck", 1);
    expect(slots.page("deck").label).toBe("4 / 8");
    slots.settings("pin", {});
    expect(slots.page("deck").label).toBe("2 / 2");
    settle();
    slots.settings("pin", { boardId: "b" });
    expect(slots.page("deck").label).toBe("2 / 8");
    expect(slots.sound("follow")?.id).toBe("a2");
    expect(slots.sound("pin")?.id).toBe("b2");
  });

  it("persists clamps after the visible auto slot count grows and settles", () => {
    const slots = setup(key("one"));
    for (let i = 0; i < 7; i++) slots.move("deck", 1);
    slots.appear(key("two", 0, 1));
    expect(slots.page("deck").label).toBe("4 / 4");
    settle();
    slots.disappear("two");
    settle();
    expect(slots.page("deck").label).toBe("4 / 8");
  });

  it("preserves hidden device pages through library updates while clamping a visible device", () => {
    const slots = setup(key("one"), key("two", 0, 1), key("mini", 0, 0, "mini"));
    slots.move("deck", 1);
    slots.move("mini", 1);
    slots.disappear("one");
    slots.disappear("two");
    slots.appear(key("fixed", 0, 0, "deck", { slot: 1 }));
    settle();
    slots.updateLibrary(library(1));
    expect(slots.page("mini").label).toBe("1 / 1");
    slots.updateLibrary(library());
    slots.appear(key("one"));
    slots.appear(key("two", 0, 1));
    settle();
    expect(slots.page("deck").label).toBe("2 / 4");
    expect(slots.page("mini").label).toBe("1 / 8");
  });

  it("preserves a mixed layout's page through library updates while its keys are hidden", () => {
    const slots = setup(key("follow"), key("pin", 0, 1, "deck", { boardId: "b" }));
    slots.updateLibrary(library(3, 8));
    for (let page = 0; page < 6; page++) slots.move("deck", 1);
    slots.disappear("follow");
    slots.disappear("pin");
    slots.appear(key("fixed", 0, 0, "deck", { slot: 1 }));
    settle();
    slots.updateLibrary(library(1, 1));
    slots.updateLibrary(library(3, 8));
    slots.appear(key("follow"));
    slots.appear(key("pin", 0, 1, "deck", { boardId: "b" }));
    settle();
    expect(slots.page("deck").label).toBe("7 / 8");
    expect(slots.sound("pin")?.id).toBe("b7");
    expect(slots.sound("follow")).toBeNull();
    expect(slots.sound("fixed")?.id).toBe("a1");
  });

  it("retains a page when a library update arrives during a partial page/folder transition", () => {
    const slots = setup(key("follow"), key("pin", 0, 1, "deck", { boardId: "b" }));
    slots.updateLibrary(library(3, 8));
    for (let i = 0; i < 3; i++) slots.move("deck", 1);
    slots.disappear("follow");
    slots.disappear("pin");
    slots.updateLibrary(library(3, 8));
    slots.appear(key("follow"));
    expect(slots.page("deck").label).toBe("3 / 3");
    slots.updateLibrary(library(3, 8));
    vi.advanceTimersByTime(50);
    slots.appear(key("pin", 0, 1, "deck", { boardId: "b" }));
    vi.advanceTimersByTime(50);
    expect(slots.page("deck").label).toBe("4 / 8");
    settle();
    expect(slots.page("deck").label).toBe("4 / 8");
    expect(slots.sound("pin")?.id).toBe("b4");
    expect(slots.sound("follow")).toBeNull();
  });
});
