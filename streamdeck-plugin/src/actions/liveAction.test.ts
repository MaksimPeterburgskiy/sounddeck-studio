import { afterEach, describe, expect, it, vi } from "vitest";
import streamDeck from "@elgato/streamdeck";
import { keyImage } from "../render/keyImage";
import { LiveAction } from "./liveAction";
import { PlaySound } from "./playSound";
import { ToggleSetting } from "./toggleSetting";
import type { Connection } from "../connection";
import type { ActionSettings } from "../settings";

vi.mock("@elgato/streamdeck", () => ({
  default: { logger: { error: vi.fn(), warn: vi.fn() }, ui: { sendToPropertyInspector: vi.fn() } },
  SingletonAction: class {}, action: () => (target: unknown) => target,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(streamDeck.ui.sendToPropertyInspector).mockReset();
  streamDeck.ui.action = undefined;
});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fakeConnection() {
  let listener = () => {};
  const connection = {
    session: {}, status: "connected", statusLabel: "", snapshot: {
      playback: [] as Array<{ soundId: string; startedAt: number; duration: number; loop: boolean }>,
      settings: { micPassthrough: false }, library: { boards: [] as Array<{ id: string; name?: string; sounds: Array<{ id: string; title: string; hasImage: boolean }> }> },
    },
    subscribe: (callback: () => void) => { listener = callback; },
    command: vi.fn(async () => ({ ok: true })), peekImage: () => null,
    emit: () => listener(),
  };
  return connection;
}
function fakeKey(settings: ActionSettings = {}) {
  return { id: "key", isKey: () => true, setImage: vi.fn(async (_image: string) => {}),
    setTitle: vi.fn(async (_title: string) => {}), setState: vi.fn(async (_state: number) => {}),
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn(async (next: ActionSettings) => { settings = next; }), showAlert: vi.fn() };
}
function inspectorFixture() {
  const connection = fakeConnection();
  connection.snapshot.library.boards = ["a", "b"].map((id) => ({
    id, name: id, sounds: [{ id: `sound-${id}`, title: `Sound ${id}`, hasImage: false }],
  }));
  const action = new ToggleSetting(connection as unknown as Connection);
  const key = { ...fakeKey(), getSettings: vi.fn(async (): Promise<ActionSettings> => ({ boardId: "a" })) };
  streamDeck.ui.action = key as never;
  return { connection, action, key, send: vi.mocked(streamDeck.ui.sendToPropertyInspector) };
}

describe("live actions", () => {
  it("tracks title layout per visible key and state, including hidden titles and generated-title changes", async () => {
    class TestAction extends LiveAction {
      protected override visual(settings: ActionSettings) {
        return { title: settings.title || "Horn", icon: "cycle-boards" as const, state: settings.key ? 1 as const : 0 as const };
      }
      protected override async press() {}
    }
    const connection = fakeConnection();
    const action = new TestAction(connection as unknown as Connection);
    const first = fakeKey(), second = { ...fakeKey(), id: "second" };
    for (const key of [first, second]) action.onWillAppear({ action: key, payload: { settings: {} } } as never);
    await flush();
    const titleParameters = { showTitle: true, titleAlignment: "bottom" as const, fontSize: 13 };
    const changed = (title: string, parameters = titleParameters, state = 0) => action.onTitleParametersDidChange({
      action: first, payload: { title, titleParameters: parameters, state },
    } as never);
    changed("Custom\nTitle");
    await flush();
    expect(first.setImage).toHaveBeenLastCalledWith(keyImage({ title: "Horn", icon: "cycle-boards", titleLayout: { title: "Custom\nTitle", ...titleParameters } }));
    expect(first.setTitle).toHaveBeenCalledTimes(1);
    expect(second.setImage).toHaveBeenCalledTimes(1);
    const count = first.setImage.mock.calls.length;
    changed("Hidden", { ...titleParameters, showTitle: false }, 1);
    await flush();
    expect(first.setImage).toHaveBeenCalledTimes(count);
    action.onDidReceiveSettings({ action: first, payload: { settings: { key: "micPassthrough" } } } as never);
    await flush();
    expect(first.setImage).toHaveBeenLastCalledWith(keyImage({ title: "", icon: "cycle-boards" }));
    action.onDidReceiveSettings({ action: first, payload: { settings: {} } } as never);
    changed("Horn"); // The SDK also reports plugin-generated titles.
    await flush();
    action.onDidReceiveSettings({ action: first, payload: { settings: { title: "Main Board" } } } as never);
    await flush();
    expect(first.setImage).toHaveBeenLastCalledWith(keyImage({ title: "Main Board", icon: "cycle-boards" }));
    for (const key of [first, second]) action.onWillDisappear({ action: key } as never);
  });

  it("coalesces renders, deduplicates writes, stops animation after playback, and stops writes on disappearance", async () => {
    vi.useFakeTimers();
    const connection = fakeConnection();
    class TestAction extends LiveAction {
      protected override visual(settings: ActionSettings) {
        return { title: settings.title || "Idle", glyph: "A", state: 0 as const, playing: connection.snapshot.playback[0] };
      }
      protected override async press() {}
    }
    const action = new TestAction(connection as unknown as Connection);
    const key = fakeKey();
    let release!: () => void;
    key.setImage.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    action.onWillAppear({ action: key, payload: { settings: {} } } as never);
    await flush();
    for (const title of ["Old", "Latest"]) action.onDidReceiveSettings({ action: key, payload: { settings: { title } } } as never);
    release();
    await flush();
    expect(key.setTitle).toHaveBeenLastCalledWith("Latest");
    expect(key.setImage).toHaveBeenCalledTimes(1);
    expect(key.setState).toHaveBeenCalledTimes(1);
    connection.emit();
    await flush();
    expect(key.setTitle).toHaveBeenCalledTimes(1);
    connection.snapshot.playback = [{ soundId: "s", startedAt: Date.now(), duration: 10, loop: false }];
    connection.emit(); await flush();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    connection.snapshot.playback = [];
    connection.emit(); await flush();
    expect(vi.getTimerCount()).toBe(0);
    const imageCount = key.setImage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(key.setImage).toHaveBeenCalledTimes(imageCount);
    key.setImage.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    connection.snapshot.playback = [{ soundId: "s", startedAt: Date.now(), duration: 10, loop: false }];
    connection.emit(); await flush();
    const titleCount = key.setTitle.mock.calls.length;
    action.onWillDisappear({ action: key } as never);
    release(); await flush();
    expect(key.setTitle).toHaveBeenCalledTimes(titleCount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops stale inspector batches before each remaining message when newer settings or status arrive", async () => {
    const { connection, action, key, send } = inspectorFixture();
    let release!: () => void;
    send.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const appearing = action.onPropertyInspectorDidAppear({ action: key } as never);
    await flush();
    expect(send.mock.calls).toEqual([[{ event: "boards", items: [{ label: "a", value: "a" }, { label: "b", value: "b" }] }]]);
    action.onDidReceiveSettings({ action: key, payload: { settings: { boardId: "b" } } } as never);
    await flush();
    expect(send.mock.calls.at(-2)).toEqual([{ event: "sounds", items: [{ label: "Sound b", value: "sound-b" }] }]);
    const latestCalls = send.mock.calls.length;
    release();
    await appearing;
    expect(send).toHaveBeenCalledTimes(latestCalls);

    // Also supersede a connected batch while its sounds message is pending.
    send.mockClear();
    send.mockImplementationOnce(async () => {}).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    action.onDidReceiveSettings({ action: key, payload: { settings: { boardId: "a" } } } as never);
    await flush();
    connection.status = "offline";
    connection.statusLabel = "Offline";
    connection.emit();
    await flush();
    expect(send.mock.lastCall).toEqual([{ event: "status", label: "Offline" }]);
    const offlineCalls = send.mock.calls.length;
    release();
    await flush();
    expect(send).toHaveBeenCalledTimes(offlineCalls);
    connection.emit();
    await flush();
    expect(send).toHaveBeenCalledTimes(offlineCalls);
  });

  it.each(["appear", "request"])("discards a stale inspector settings read from %s after a settings change", async (event) => {
    const { action, key, send } = inspectorFixture();
    await action.onPropertyInspectorDidAppear({ action: key } as never);
    send.mockClear();
    let release!: (settings: ActionSettings) => void;
    key.getSettings.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const reading = event === "appear"
      ? action.onPropertyInspectorDidAppear({ action: key } as never)
      : action.onSendToPlugin({ action: key, payload: { event: "sounds" } } as never);
    action.onDidReceiveSettings({ action: key, payload: { settings: { boardId: "b" } } } as never);
    await flush();
    expect(send.mock.calls.at(-2)).toEqual([{ event: "sounds", items: [{ label: "Sound b", value: "sound-b" }] }]);
    const latestCalls = send.mock.calls.length;
    release({ boardId: "a" });
    await reading;
    expect(send).toHaveBeenCalledTimes(latestCalls);
  });

  it("discards pending reads and sends when the same inspector key is reopened", async () => {
    const { action, key, send } = inspectorFixture();
    let releaseRead!: (settings: ActionSettings) => void;
    key.getSettings.mockImplementationOnce(() => new Promise((resolve) => { releaseRead = resolve; }));
    const oldRead = action.onPropertyInspectorDidAppear({ action: key } as never);
    streamDeck.ui.action = undefined;
    action.onPropertyInspectorDidDisappear({ action: key } as never);
    streamDeck.ui.action = key as never;
    let releaseSend!: () => void;
    send.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseSend = resolve; }));
    const oldSend = action.onPropertyInspectorDidAppear({ action: key } as never);
    await flush();
    streamDeck.ui.action = undefined;
    action.onPropertyInspectorDidDisappear({ action: key } as never);
    streamDeck.ui.action = key as never;
    key.getSettings.mockResolvedValueOnce({ boardId: "b" });
    await action.onPropertyInspectorDidAppear({ action: key } as never);
    const latestCalls = send.mock.calls.length;
    releaseRead({ boardId: "a" });
    releaseSend();
    await Promise.all([oldRead, oldSend]);
    expect(send).toHaveBeenCalledTimes(latestCalls);
    expect(send.mock.calls.at(-2)).toEqual([{ event: "sounds", items: [{ label: "Sound b", value: "sound-b" }] }]);
  });

  it("recomputes the key status after an awaited image write before sending a title", async () => {
    const connection = fakeConnection();
    const action = new ToggleSetting(connection as unknown as Connection);
    const key = fakeKey();
    let release!: () => void;
    key.setImage.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    action.onWillAppear({ action: key, payload: { settings: {} } } as never);
    await flush();
    connection.status = "offline";
    connection.statusLabel = "Offline";
    connection.emit();
    release();
    await flush();
    expect(key.setTitle.mock.calls).toEqual([["Offline"]]);
    action.onWillDisappear({ action: key } as never);
  });

  it.each([false, true])("sets requested multi-action states independently of existing value %s", async (existing) => {
    const connection = fakeConnection();
    connection.snapshot.settings.micPassthrough = existing;
    const action = new ToggleSetting(connection as unknown as Connection);
    for (const desired of [0, 1]) {
      await action.onKeyDown({ action: fakeKey(), payload: { settings: {}, isInMultiAction: true, userDesiredState: desired } } as never);
      expect(connection.command).toHaveBeenLastCalledWith("setting.set", { key: "micPassthrough", value: desired === 1 });
    }
    await action.onKeyDown({ action: fakeKey(), payload: { settings: {}, isInMultiAction: false, userDesiredState: 1 } } as never);
    expect(connection.command).toHaveBeenLastCalledWith("setting.toggle", { key: "micPassthrough" });
  });

  it("sends key up immediately while its press acknowledgement is pending", async () => {
    const connection = fakeConnection();
    connection.snapshot.library.boards = [{ id: "board", sounds: [{ id: "sound", title: "Horn", hasImage: false }] }];
    const action = new PlaySound(connection as unknown as Connection);
    const key = fakeKey();
    const event = { action: key, payload: { settings: { soundId: "sound" } } };
    let acknowledge!: (result: { ok: boolean }) => void;
    connection.command.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    const down = action.onKeyDown(event as never);
    expect(connection.command).toHaveBeenLastCalledWith("sound.press", { soundId: "sound", pressId: expect.any(String) });
    const pressId = (connection.command.mock.lastCall as unknown as [string, { pressId: string }])[1].pressId;
    await action.onKeyUp(event as never);
    expect(connection.command).toHaveBeenLastCalledWith("sound.release", { pressId });
    acknowledge({ ok: true });
    await down;
  });

  it("persists renamed and moved sound metadata, then resolves a re-import using that fallback", async () => {
    const connection = fakeConnection();
    const action = new PlaySound(connection as unknown as Connection);
    const key = fakeKey({ soundId: "original", boardId: "old-board", title: "Horn" });
    connection.snapshot.library.boards = [{ id: "new-board", sounds: [{ id: "original", title: "Airhorn", hasImage: false }] }];
    action.onWillAppear({ action: key, payload: { settings: { soundId: "original", boardId: "old-board", title: "Horn" } } } as never);
    await flush();
    const saved = key.setSettings.mock.lastCall![0];
    expect(saved).toEqual({ soundId: "original", boardId: "new-board", title: "Airhorn" });
    connection.snapshot.library.boards[0].sounds[0].id = "imported";
    connection.emit(); await flush();
    expect(key.setSettings).toHaveBeenLastCalledWith({ ...saved, soundId: "imported" });
    await action.onKeyDown({ action: key, payload: { settings: saved } } as never);
    expect(connection.command).toHaveBeenLastCalledWith("sound.press", { soundId: "imported", pressId: expect.any(String) });
    const pressId = (connection.command.mock.lastCall as unknown as [string, { pressId: string }])[1].pressId;
    action.onWillDisappear({ action: key } as never);
    await flush();
    expect(connection.command).toHaveBeenLastCalledWith("sound.release", { pressId });
  });

  it("preserves an inspector binding persisted before its echo when syncing library metadata", async () => {
    const connection = fakeConnection();
    const action = new PlaySound(connection as unknown as Connection);
    const original = { soundId: "original", boardId: "board", title: "Horn", inspectorRevision: 1 };
    const selected = { ...original, soundId: "selected", title: "Selected", inspectorRevision: 2 };
    const key = fakeKey(original);
    connection.snapshot.library.boards = [{ id: "board", sounds: [
      { id: "original", title: "Horn", hasImage: false },
      { id: "selected", title: "Selected", hasImage: false },
    ] }];
    action.onWillAppear({ action: key, payload: { settings: original } } as never);
    await flush();

    // The inspector has saved a different binding, but no didReceiveSettings
    // echo has reached the plugin yet.
    key.getSettings.mockResolvedValue(selected);
    connection.snapshot.library.boards[0].sounds[0].title = "Renamed Horn";
    connection.emit();
    await flush();
    expect(key.setSettings).not.toHaveBeenCalled();
    expect(key.setTitle).toHaveBeenLastCalledWith("Selected");

    connection.snapshot.library.boards[0].sounds[1].title = "Renamed Selection";
    connection.emit();
    await flush();
    expect(key.setSettings).toHaveBeenCalledExactlyOnceWith({ ...selected, title: "Renamed Selection" });
    action.onWillDisappear({ action: key } as never);
  });

  it.each(["H".repeat(257), "Horn\nEffect"])("plays and re-imports sounds with titles outside the protocol limits (case %#)", async (title) => {
    const connection = fakeConnection();
    const action = new PlaySound(connection as unknown as Connection);
    const key = fakeKey();
    const settings = { soundId: "original", boardId: "board", title };
    connection.snapshot.library.boards = [{ id: "board", sounds: [{ id: "original", title, hasImage: false }] }];
    await action.onKeyDown({ action: key, payload: { settings } } as never);
    expect(connection.command).toHaveBeenLastCalledWith("sound.press", { soundId: "original", pressId: expect.any(String) });
    connection.snapshot.library.boards[0].sounds[0].id = "imported";
    await action.onKeyDown({ action: key, payload: { settings } } as never);
    expect(connection.command).toHaveBeenLastCalledWith("sound.press", { soundId: "imported", pressId: expect.any(String) });
    expect(key.showAlert).not.toHaveBeenCalled();
  });
});
