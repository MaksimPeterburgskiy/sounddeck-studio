import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const code = readFileSync(new URL("../com.sounddeck.studio.sdPlugin/ui/inspector.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function inspector(initial: Record<string, string | number>, page = "play-sound") {
  const html = readFileSync(new URL(`../com.sounddeck.studio.sdPlugin/ui/${page}.html`, import.meta.url), "utf8");
  expect(html).not.toMatch(/\b(?:setting|label-setting)=/);
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => {
    const handlers = new Map<string, () => void>();
    let value = "";
    return [id, { get value() { return value; }, set value(next: string) { value = next; handlers.get("valuechange")?.(); },
      textContent: "", addEventListener: (name: string, handler: () => void) => handlers.set(name, handler) }];
  }));
  let message!: (event: unknown) => void;
  let settings!: (event: unknown) => void;
  const client = {
    getConnectionInfo: async () => ({ actionInfo: { payload: { settings: initial } } }),
    sendToPropertyInspector: { subscribe: (callback: typeof message) => { message = callback; } },
    didReceiveSettings: { subscribe: (callback: typeof settings) => { settings = callback; } },
    setSettings: vi.fn(async (_value: unknown) => {}), send: vi.fn(),
  };
  runInNewContext(code, { SDPIComponents: { streamDeckClient: client }, document: { getElementById: (id: string) => elements[id] } });
  return { elements, client, message: (payload: unknown) => message({ payload }), receive: (value: unknown) => settings({ payload: { settings: value } }) };
}
describe("play sound inspector", () => {
  it.each([{}, { boardId: "a", soundId: "old", title: "Old" }])("keeps a board change and sound selection atomic, including on reopen: %j", async (initial) => {
    const ui = inspector(initial); await flush();
    ui.elements.board.value = "b";
    ui.message({ event: "sounds", items: [{ value: "new", label: "Airhorn" }] });
    ui.elements.sound.value = "new";
    ui.receive(initial); // a delayed echo cannot replace the queued local binding
    await flush();
    expect(JSON.parse(JSON.stringify(ui.client.setSettings.mock.calls))).toEqual([
      [{ boardId: "b", soundId: "", title: "", inspectorRevision: 1 }],
      [{ boardId: "b", soundId: "new", title: "Airhorn", inspectorRevision: 2 }],
    ]);
    const reopened = inspector(ui.client.setSettings.mock.lastCall![0] as Record<string, string | number>); await flush();
    expect(reopened.elements.board.value).toBe("b");
    expect(reopened.elements.sound.value).toBe("new");
    expect(reopened.client.setSettings).not.toHaveBeenCalled();
  });
  it("ignores stale echoes after both sends settle and after the latest echo", async () => {
    const initial = { boardId: "a", soundId: "old", title: "Old", inspectorRevision: 5 };
    const ui = inspector(initial); await flush();
    ui.elements.board.value = "b";
    ui.message({ event: "sounds", items: [{ value: "new", label: "Airhorn" }, { value: "next", label: "Next" }] });
    ui.elements.sound.value = "new";
    await flush(); // setSettings resolves on send, before any didReceiveSettings echo
    const first = ui.client.setSettings.mock.calls[0][0];
    const latest = ui.client.setSettings.mock.calls[1][0];
    ui.receive(first);
    ui.receive(initial);
    expect(ui.elements.board.value).toBe("b");
    expect(ui.elements.sound.value).toBe("new");
    ui.receive(latest);
    ui.receive(first); // even an out-of-order echo after acknowledgement stays stale
    expect(ui.elements.sound.value).toBe("new");
    ui.elements.sound.value = "next";
    await flush();
    expect(ui.client.setSettings).toHaveBeenLastCalledWith({
      boardId: "b", soundId: "next", title: "Next", inspectorRevision: 8,
    });
  });
  it("accepts matching and newer revisions without saving again", async () => {
    const ui = inspector({ boardId: "a", inspectorRevision: 3 }); await flush();
    ui.elements.board.value = "b";
    await flush();
    const saved = ui.client.setSettings.mock.lastCall![0] as Record<string, string | number>;
    ui.receive({ ...saved, soundId: "synced", title: "Synced" });
    expect(ui.elements.sound.value).toBe("synced");
    ui.receive({ boardId: "c", soundId: "external", title: "External", inspectorRevision: 9 });
    expect(ui.elements.board.value).toBe("c");
    expect(ui.elements.sound.value).toBe("external");
    ui.receive(saved);
    expect(ui.elements.board.value).toBe("c");
    expect(ui.client.setSettings).toHaveBeenCalledTimes(1);
    ui.elements.board.value = "d";
    await flush();
    expect(ui.client.setSettings).toHaveBeenLastCalledWith({
      boardId: "d", soundId: "", title: "", inspectorRevision: 10,
    });
  });
  it("keeps protection on save failure and lets the next edit retry", async () => {
    const ui = inspector({ boardId: "a" }); await flush();
    ui.client.setSettings.mockRejectedValueOnce(new Error("Disconnected"));
    ui.elements.board.value = "b";
    await flush();
    ui.receive({ boardId: "a" });
    expect(ui.elements.board.value).toBe("b");
    expect(ui.elements.status.textContent).toBe("Could not save. Please retry.");
    ui.elements.board.value = "c";
    await flush();
    expect(ui.client.setSettings).toHaveBeenLastCalledWith({
      boardId: "c", soundId: "", title: "", inspectorRevision: 2,
    });
  });
});

describe("board slot inspector", () => {
  it.each(["board", "slot"])("preserves both selections through stale echoes when %s changes first", async (firstControl) => {
    const initial = { boardId: "a", slot: 1, inspectorRevision: 5 };
    const ui = inspector(initial, "board-slot"); await flush();
    expect(ui.elements.board.value).toBe("a");
    expect(ui.elements.slot.value).toBe("1");
    expect(ui.client.setSettings).not.toHaveBeenCalled();
    for (const id of firstControl === "board" ? ["board", "slot"] : ["slot", "board"]) {
      ui.elements[id].value = id === "board" ? "b" : "2";
    }
    await flush(); // both sends settle before Stream Deck echoes either snapshot
    const first = ui.client.setSettings.mock.calls[0][0];
    const latest = ui.client.setSettings.mock.calls[1][0];
    expect(latest).toEqual({ boardId: "b", slot: "2", inspectorRevision: 7 });
    ui.receive(first);
    ui.receive(initial);
    expect(ui.elements.board.value).toBe("b");
    expect(ui.elements.slot.value).toBe("2");
    ui.elements.board.value = "c";
    await flush();
    expect(ui.client.setSettings).toHaveBeenLastCalledWith({ boardId: "c", slot: "2", inspectorRevision: 8 });
    ui.receive(ui.client.setSettings.mock.lastCall![0]);
    ui.receive(latest); // older snapshots stay stale after the latest acknowledgement
    expect(ui.elements.board.value).toBe("c");
    expect(ui.elements.slot.value).toBe("2");
    ui.elements.slot.value = "3";
    await flush();
    expect(ui.client.setSettings).toHaveBeenLastCalledWith({ boardId: "c", slot: "3", inspectorRevision: 9 });
    expect(ui.client.setSettings).toHaveBeenCalledTimes(4);
    const reopened = inspector(ui.client.setSettings.mock.lastCall![0] as Record<string, string | number>, "board-slot"); await flush();
    expect(reopened.elements.board.value).toBe("c");
    expect(reopened.elements.slot.value).toBe("3");
    expect(reopened.client.setSettings).not.toHaveBeenCalled();
  });
  it.each([{}, { slot: 1 }, { slot: "1" }])("initializes auto and fixed slots without saving: %j", async (initial) => {
    const ui = inspector(initial, "board-slot"); await flush();
    expect(ui.elements.board.value).toBe("");
    expect(ui.elements.slot.value).toBe(initial.slot === undefined ? "" : "1");
    ui.elements.slot.value = ui.elements.slot.value;
    await flush();
    expect(ui.client.setSettings).not.toHaveBeenCalled();
    ui.elements.slot.value = "2";
    ui.elements.slot.value = "";
    await flush();
    expect(ui.client.setSettings.mock.calls).toEqual([
      [{ slot: "2", inspectorRevision: 1 }], [{ slot: "", inspectorRevision: 2 }],
    ]);
  });
});

describe("single-picker inspectors", () => {
  it.each([
    { page: "switch-board", id: "board", field: "boardId", initial: "a", first: "b", latest: "c", next: "d" },
    { page: "toggle-setting", id: "key", field: "key", initial: "micPassthrough", first: "noiseSuppressionEnabled", latest: "echoCancellationEnabled", next: "monitorToHeadphones" },
  ])("ignores delayed settings echoes in $page", async ({ page, id, field, initial, first, latest, next }) => {
    const ui = inspector({ [field]: initial }, page); await flush();
    expect(ui.client.setSettings).not.toHaveBeenCalled();
    ui.elements[id].value = first;
    ui.elements[id].value = latest;
    await flush();
    expect(ui.client.setSettings.mock.calls).toEqual([
      [{ [field]: first, inspectorRevision: 1 }], [{ [field]: latest, inspectorRevision: 2 }],
    ]);
    ui.receive(ui.client.setSettings.mock.calls[0][0]);
    expect(ui.elements[id].value).toBe(latest);
    ui.receive(ui.client.setSettings.mock.calls[1][0]);
    ui.receive({ [field]: initial });
    expect(ui.elements[id].value).toBe(latest);
    ui.elements[id].value = next;
    await flush();
    expect(ui.client.setSettings).toHaveBeenLastCalledWith({ [field]: next, inspectorRevision: 3 });
  });
  it("shows the toggle default without saving it on initialization", async () => {
    const ui = inspector({}, "toggle-setting"); await flush();
    expect(ui.elements.key.value).toBe("micPassthrough");
    expect(ui.client.setSettings).not.toHaveBeenCalled();
  });
});

describe("volume inspectors", () => {
  it.each(["volume", "volume-dial", "volume-mute"])("protects bus changes against stale echoes in %s", async (page) => {
    const ui = inspector({ bus: "micVirtual", inspectorRevision: 4, title: "Custom" }, page); await flush();
    expect(ui.client.setSettings).not.toHaveBeenCalled();
    ui.elements.bus.value = "micMonitor";
    ui.elements.bus.value = "soundboardMonitor";
    await flush();
    expect(ui.client.setSettings.mock.calls).toEqual([
      [{ bus: "micMonitor", inspectorRevision: 5, title: "Custom" }],
      [{ bus: "soundboardMonitor", inspectorRevision: 6, title: "Custom" }],
    ]);
    const latest = ui.client.setSettings.mock.calls[1][0];
    ui.receive(latest);
    ui.receive(ui.client.setSettings.mock.calls[0][0]);
    expect(ui.elements.bus.value).toBe("soundboardMonitor");
  });

  it.each([{ page: "volume", step: "5" }, { page: "volume-dial", step: "2" }])("shows defaults and saves numeric steps atomically in $page", async ({ page, step }) => {
    const ui = inspector({}, page); await flush();
    expect(ui.elements.bus.value).toBe("micVirtual");
    expect(ui.elements.step.value).toBe(step);
    if (ui.elements.mode) expect(ui.elements.mode.value).toBe("up");
    expect(ui.client.setSettings).not.toHaveBeenCalled();
    ui.elements.bus.value = "micMonitor";
    ui.elements.step.value = "7";
    if (ui.elements.mode) ui.elements.mode.value = "down";
    await flush();
    const latest = ui.client.setSettings.mock.lastCall![0];
    ui.receive(latest);
    ui.receive({});
    expect(ui.elements.bus.value).toBe("micMonitor");
    expect(ui.elements.step.value).toBe("7");
    if (ui.elements.mode) expect(ui.elements.mode.value).toBe("down");
    expect(latest).toEqual({ bus: "micMonitor", step: 7, ...(ui.elements.mode && { mode: "down" }), inspectorRevision: ui.elements.mode ? 3 : 2 });
  });
});
