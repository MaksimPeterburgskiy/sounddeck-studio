import { describe, expect, it } from "vitest";
import type { ControlLibrary } from "../../src/lib/controlProtocol";
import { autoSlots, BOARD_SLOT, BoardSlots, slotBoard, type VisibleSlotKey } from "./boardSlots";
import type { ActionSettings } from "./settings";

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
    expect(slots.sound("first", {})?.id).toBe("a1");
    expect(slots.sound("second", {})?.id).toBe("a2");
    expect(slots.sound("last", {})?.id).toBe("a3");
    expect(slots.sound("other", {})?.id).toBe("a1");
    expect(slots.sound("multi", {})).toBeNull();
  });

  it("recomputes after appearance, disappearance and switching auto/fixed without counting hidden pages or folders", () => {
    const slots = setup(key("right", 0, 3));
    slots.appear(key("left", 0, 1));
    expect(slots.sound("right", {})?.id).toBe("a2");
    slots.disappear("left");
    expect(slots.sound("right", {})?.id).toBe("a1");
    slots.appear(key("left", 0, 1));
    slots.settings("left", { slot: 8 });
    expect(slots.page("deck").size).toBe(1);
    expect(slots.sound("right", {})?.id).toBe("a1");
    expect(slots.sound("left", { slot: 8 })?.id).toBe("a8");
    slots.settings("left", { slot: "" });
    expect(slots.sound("right", {})?.id).toBe("a2");
    slots.disappear("left");
    slots.disappear("right");
    slots.appear(key("folder", 0, 1));
    expect(slots.page("deck").size).toBe(1);
    expect(slots.sound("folder", {})?.id).toBe("a1");
    slots.disappear("folder");
    slots.appear(key("page-2", 0, 0));
    expect(slots.sound("page-2", {})?.id).toBe("a1");
  });

  it("resolves pinned versus follow boards and separates empty slots from missing boards", () => {
    const data = library();
    expect(slotBoard(data, {})?.id).toBe("a");
    expect(slotBoard(data, { boardId: "b" })?.id).toBe("b");
    expect(slotBoard(data, { boardId: "deleted" })).toBeUndefined();
    const slots = setup(key("follow"), key("pinned", 0, 1, "deck", { boardId: "b" }));
    slots.move("deck", 1);
    expect(slots.sound("follow", {})?.id).toBe("a3");
    expect(slots.sound("pinned", { boardId: "b" })).toBeNull();
    expect(slots.sound("pinned", { boardId: "deleted" })).toBeUndefined();
    expect(slots.sound("follow", { slot: "100" })).toBeNull();
    expect(slots.sound("follow", { slot: "invalid" })).toBeUndefined();
    slots.updateLibrary(library(8, 3, "b"));
    expect(slots.sound("follow", {})?.id).toBe("b1");
    expect(slots.sound("pinned", { boardId: "b" })?.id).toBe("b2");
  });
});

describe("board slot paging", () => {
  it("keeps offsets per device with different visible key counts, labels pages and does nothing at the ends", () => {
    const slots = setup(key("one"), key("two", 0, 1), key("mini", 0, 0, "mini"));
    expect(slots.page("deck")).toMatchObject({ label: "1 / 4", size: 2, offset: 0, previous: false, next: true });
    slots.move("deck", -1);
    expect(slots.page("deck").label).toBe("1 / 4");
    slots.move("deck", 1);
    expect(slots.page("deck")).toMatchObject({ label: "2 / 4", offset: 2, previous: true, next: true });
    expect(slots.page("mini")).toMatchObject({ label: "1 / 8", offset: 0 });
    expect(slots.sound("one", {})?.id).toBe("a3");
    expect(slots.sound("two", {})?.id).toBe("a4");
    for (let i = 0; i < 5; i++) slots.move("deck", 1);
    expect(slots.page("deck")).toMatchObject({ label: "4 / 4", offset: 6, previous: true, next: false });
    slots.move("deck", -1);
    expect(slots.page("deck").label).toBe("3 / 4");
    expect(slots.page("absent")).toMatchObject({ label: "1 / 1", size: 0, next: false, previous: false });
  });

  it("resets all device pages on active board change and clamps a shrinking board without later restoring the old offset", () => {
    const slots = setup(key("one"), key("two", 0, 1), key("mini", 0, 0, "mini"));
    for (let i = 0; i < 3; i++) { slots.move("deck", 1); slots.move("mini", 1); }
    slots.updateLibrary(library(3));
    expect(slots.page("deck")).toMatchObject({ label: "2 / 2", offset: 2 });
    expect(slots.sound("two", {})).toBeNull();
    expect(slots.page("mini")).toMatchObject({ label: "3 / 3", offset: 2 });
    slots.updateLibrary(library(8));
    expect(slots.page("deck").label).toBe("2 / 4");
    slots.updateLibrary(library(8, 3, "b"));
    expect(slots.page("deck")).toMatchObject({ label: "1 / 2", offset: 0 });
    expect(slots.page("mini")).toMatchObject({ label: "1 / 3", offset: 0 });
    slots.updateLibrary(library(8, 0, "b"));
    expect(slots.page("deck")).toMatchObject({ label: "1 / 1", offset: 0 });
  });

  it("pages pinned auto keys with the longest represented board while fixed keys ignore paging and page counts", () => {
    const slots = setup(key("follow"), key("pin", 0, 1, "deck", { boardId: "b" }),
      key("fixed", 0, 2, "deck", { slot: 1, boardId: "b" }));
    slots.updateLibrary(library(3, 8));
    expect(slots.page("deck").label).toBe("1 / 4");
    slots.move("deck", 1);
    expect(slots.sound("follow", {})?.id).toBe("a3");
    expect(slots.sound("pin", { boardId: "b" })?.id).toBe("b4");
    expect(slots.sound("fixed", { slot: 1, boardId: "b" })?.id).toBe("b1");
    slots.disappear("pin");
    expect(slots.page("deck").label).toBe("2 / 3");
    slots.appear(key("pin", 0, 1, "deck", { boardId: "b", slot: 1 }));
    expect(slots.page("deck").label).toBe("2 / 3");
    slots.updateLibrary(library(3, 8, "b"));
    expect(slots.page("deck").offset).toBe(0);
  });

  it("retains a device page across a complete page/folder transition and recomputes its size", () => {
    const slots = setup(key("old-one"), key("old-two", 0, 1));
    slots.move("deck", 1);
    slots.disappear("old-one"); slots.disappear("old-two");
    expect(slots.page("deck").label).toBe("1 / 1");
    slots.appear(key("new-one"));
    expect(slots.page("deck")).toMatchObject({ label: "2 / 8", size: 1, offset: 1 });
    slots.appear(key("new-two", 0, 1));
    expect(slots.page("deck")).toMatchObject({ label: "2 / 4", size: 2, offset: 2 });
  });
});
