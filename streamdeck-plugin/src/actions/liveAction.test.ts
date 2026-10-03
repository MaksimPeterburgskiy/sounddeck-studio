import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveAction } from "./liveAction";
import { PlaySound } from "./playSound";
import { ToggleSetting } from "./toggleSetting";
import type { Connection } from "../connection";
import type { ActionSettings } from "../settings";

vi.mock("@elgato/streamdeck", () => ({
  default: { logger: { error: vi.fn(), warn: vi.fn() }, ui: { sendToPropertyInspector: vi.fn() } },
  SingletonAction: class {}, action: () => (target: unknown) => target,
}));
afterEach(() => vi.useRealTimers());
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fakeConnection() {
  let listener = () => {};
  const connection = {
    status: "connected", statusLabel: "", snapshot: {
      playback: [] as Array<{ soundId: string; startedAt: number; duration: number; loop: boolean }>,
      settings: { micPassthrough: false }, library: { boards: [] as Array<{ id: string; sounds: Array<{ id: string; title: string; hasImage: boolean }> }> },
    },
    subscribe: (callback: () => void) => { listener = callback; },
    command: vi.fn(async () => ({ ok: true })), peekImage: () => null,
    emit: () => listener(),
  };
  return connection;
}
function fakeKey() {
  return { id: "key", isKey: () => true, setImage: vi.fn(async (_image: string) => {}),
    setTitle: vi.fn(async (_title: string) => {}), setState: vi.fn(async (_state: number) => {}),
    setSettings: vi.fn(async (_settings: ActionSettings) => {}), showAlert: vi.fn() };
}

describe("live actions", () => {
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
    expect(key.setTitle).toHaveBeenCalledTimes(2);
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

  it("persists renamed and moved sound metadata, then resolves a re-import using that fallback", async () => {
    const connection = fakeConnection();
    const action = new PlaySound(connection as unknown as Connection);
    const key = fakeKey();
    connection.snapshot.library.boards = [{ id: "new-board", sounds: [{ id: "original", title: "Airhorn", hasImage: false }] }];
    action.onWillAppear({ action: key, payload: { settings: { soundId: "original", boardId: "old-board", title: "Horn" } } } as never);
    await flush();
    const saved = key.setSettings.mock.lastCall![0];
    expect(saved).toEqual({ soundId: "original", boardId: "new-board", title: "Airhorn" });
    connection.snapshot.library.boards[0].sounds[0].id = "imported";
    connection.emit(); await flush();
    expect(key.setSettings).toHaveBeenLastCalledWith({ ...saved, soundId: "imported" });
    await action.onKeyDown({ action: key, payload: { settings: saved } } as never);
    expect(connection.command).toHaveBeenLastCalledWith("sound.play", { soundId: "imported", boardId: "new-board", title: "Airhorn" });
    action.onWillDisappear({ action: key } as never);
  });
});
