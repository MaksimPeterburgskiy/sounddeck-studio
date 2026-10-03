import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { SoundTriggers } from "../src/lib/soundTriggers.ts";
import { deferred, makeSound } from "../src/lib/testing/webAudioFakes.ts";

function preload() {
  let sounddeck;
  const ipcRenderer = Object.assign(new EventEmitter(), { invoke: vi.fn(async () => ({ ok: true })) });
  runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, api) => { sounddeck = api; } } })
  });
  return { ipcRenderer, sounddeck };
}

describe("preload control readiness", () => {
  it("waits for the loaded document's token and retains it for late readiness calls", async () => {
    const outgoing = preload();
    const pending = outgoing.sounddeck.controlReady();
    await Promise.resolve();
    expect(outgoing.ipcRenderer.invoke).not.toHaveBeenCalled();
    outgoing.ipcRenderer.emit("control-ready-token", {}, "old-document");
    await pending;
    expect(outgoing.ipcRenderer.invoke).toHaveBeenLastCalledWith("control:ready", "old-document");
    const current = preload();
    current.ipcRenderer.emit("control-ready-token", {}, "new-document");
    await current.sounddeck.controlReady();
    expect(current.ipcRenderer.invoke).toHaveBeenLastCalledWith("control:ready", "new-document");
    await outgoing.sounddeck.controlReady();
    expect(outgoing.ipcRenderer.invoke).toHaveBeenLastCalledWith("control:ready", "old-document");
  });

  it("tags all cache updates and playback results with their source document", async () => {
    const document = preload();
    const library = { boards: [] };
    const state = { playback: [] };
    const pending = [document.sounddeck.loadLibrary(), document.sounddeck.saveLibrary(library), document.sounddeck.pushControlState(state)];
    expect(document.ipcRenderer.invoke).not.toHaveBeenCalled();
    document.ipcRenderer.emit("control-ready-token", {}, "source-document");
    await Promise.all(pending);
    document.sounddeck.onControlCommand(async () => ({ ok: true }));
    document.ipcRenderer.emit("control-command", {}, { command: "sound.play", args: { soundId: "sound" }, requestId: "request" });
    await vi.waitFor(() => expect(document.ipcRenderer.invoke).toHaveBeenCalledWith("control:result", "request", { ok: true }, "source-document"));
    expect(document.ipcRenderer.invoke.mock.calls).toEqual([
      ["library:load", "source-document"], ["library:save", library, "source-document"],
      ["control:state", state, "source-document"], ["control:received", "request", "source-document"], ["control:result", "request", { ok: true }, "source-document"]
    ]);
  });
  it("forwards cancellation ids without completing the original operation", async () => {
    const document = preload();
    document.ipcRenderer.emit("control-ready-token", {}, "source-document");
    let finish;
    const callback = vi.fn((command) => command.command === "control.cancel" ? undefined : new Promise((resolve) => { finish = resolve; }));
    const unsubscribe = document.sounddeck.onControlCommand(callback);
    document.ipcRenderer.emit("control-command", {}, { command: "sound.play", args: { soundId: "sound" }, requestId: "request" });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    // React may replace its subscription while the original operation is pending.
    unsubscribe();
    document.sounddeck.onControlCommand(callback);
    document.ipcRenderer.invoke.mockClear();
    document.ipcRenderer.emit("control-command", {}, { command: "control.cancel", requestId: "request" });
    expect(callback).toHaveBeenLastCalledWith({ command: "control.cancel", requestId: "request" });
    expect(document.ipcRenderer.invoke).not.toHaveBeenCalled();
    finish({ ok: false, code: "unavailable" });
    await vi.waitFor(() => expect(document.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith("control:result", "request", { ok: false, code: "unavailable" }, "source-document"));
  });

});

describe("preload control acknowledgements", () => {
  it.each(["sound", "all"])("%s stop cancels playback awaiting receipt while preserving later requests", async (stop) => {
    const { ipcRenderer, sounddeck } = preload();
    ipcRenderer.emit("control-ready-token", {}, "current-document");
    const sounds = [makeSound({ id: "a", triggerMode: "hold", loop: true }), makeSound({ id: "b", triggerMode: "hold", loop: true })];
    const audio = {
      play: vi.fn(async (_sound) => `voice-${audio.play.mock.calls.length}`),
      stop: vi.fn(), stopAll: vi.fn(), stopVoice: vi.fn(), isPlaying: () => false
    };
    const triggers = new SoundTriggers(() => audio, () => null);
    const callback = vi.fn(async ({ command, args }) => {
      if (command === "sound.play" || command === "sound.press") {
        await triggers.trigger(sounds.find((sound) => sound.id === args.soundId), command === "sound.press" ? args.pressId : undefined, true);
      }
      return { ok: true };
    });
    sounddeck.onControlCommand(callback);
    const receive = ipcRenderer.listeners("control-command")[0];
    const press = (soundId, requestId) => ({ command: "sound.press", args: { soundId, pressId: requestId }, requestId });
    await receive({}, press("a", "active-a"));
    await receive({}, press("b", "active-b"));
    const receipt = deferred();
    ipcRenderer.invoke.mockImplementationOnce(() => receipt.promise);
    const pendingHold = receive({}, press("a", "pending-a"));
    const pendingPlay = receive({}, { command: "sound.play", args: { soundId: "a" }, requestId: "pending-play" });
    const pendingOther = receive({}, press("b", "pending-b"));
    const setting = receive({}, { command: "setting.toggle", args: { key: "micPassthrough" }, requestId: "setting" });
    await vi.waitFor(() => expect(ipcRenderer.invoke).toHaveBeenCalledWith("control:received", "pending-a", "current-document"));

    sounddeck.cancelPendingControlPlayback(stop === "sound" ? "a" : undefined);
    if (stop === "sound") triggers.stop("a");
    else triggers.stopAll();
    const later = receive({}, press("a", "later"));
    receipt.resolve({ ok: true });
    await Promise.all([pendingHold, pendingPlay, pendingOther, setting, later]);

    expect(audio.play.mock.calls.map(([sound]) => sound.id)).toEqual(stop === "sound" ? ["a", "b", "b", "a"] : ["a", "b", "a"]);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("control:result", "pending-a", { ok: false, code: "unavailable" }, "current-document");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("control:result", "pending-play", { ok: false, code: "unavailable" }, "current-document");
    expect(callback).toHaveBeenCalledWith({ command: "setting.toggle", args: { key: "micPassthrough" }, requestId: "setting" });
    triggers.release("later");
    expect(audio.stopVoice).toHaveBeenLastCalledWith("a", stop === "sound" ? "voice-4" : "voice-3");
  });

  it("cancels only requests preceding an API sound stop while its callback awaits earlier receipts", async () => {
    const { ipcRenderer, sounddeck } = preload();
    ipcRenderer.emit("control-ready-token", {}, "current-document");
    const sound = makeSound({ triggerMode: "hold", loop: true });
    const audio = { play: vi.fn(async () => "voice"), stop: vi.fn(), stopAll: vi.fn(), stopVoice: vi.fn(), isPlaying: () => false };
    const triggers = new SoundTriggers(() => audio, () => null);
    sounddeck.onControlCommand(async ({ command, args }) => {
      if (command === "sound.press") await triggers.trigger(sound, args.pressId, true);
      else if (command === "sound.stop") triggers.stop(args.soundId);
      return { ok: true };
    });
    const receipt = deferred();
    ipcRenderer.invoke.mockImplementationOnce(() => receipt.promise);
    const receive = ipcRenderer.listeners("control-command")[0];
    const earlier = receive({}, { command: "sound.press", args: { soundId: sound.id, pressId: "earlier" }, requestId: "earlier" });
    const stopped = receive({}, { command: "sound.stop", args: { soundId: sound.id } });
    const later = receive({}, { command: "sound.press", args: { soundId: sound.id, pressId: "later" }, requestId: "later" });
    receipt.resolve({ ok: true });
    await Promise.all([earlier, stopped, later]);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.stop).toHaveBeenCalledExactlyOnceWith(sound.id);
    expect(audio.stop.mock.invocationCallOrder[0]).toBeLessThan(audio.play.mock.invocationCallOrder[0]);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("control:result", "earlier", { ok: false, code: "unavailable" }, "current-document");
    triggers.release("later");
    expect(audio.stopVoice).toHaveBeenCalledExactlyOnceWith(sound.id, "voice");
  });

  it("does not apply a command whose receipt was rejected after timeout or reset", async () => {
    const { ipcRenderer, sounddeck } = preload();
    ipcRenderer.emit("control-ready-token", {}, "current-document");
    ipcRenderer.invoke.mockResolvedValueOnce({ ok: false });
    const callback = vi.fn();
    sounddeck.onControlCommand(callback);
    await ipcRenderer.listeners("control-command")[0]({}, { command: "setting.toggle", args: { key: "micPassthrough" }, requestId: "expired" });
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith("control:received", "expired", "current-document");
    expect(callback).not.toHaveBeenCalled();
  });

  it("cancels a mutation while its receipt is pending before invoking the renderer", async () => {
    const { ipcRenderer, sounddeck } = preload();
    ipcRenderer.emit("control-ready-token", {}, "current-document");
    let accept;
    ipcRenderer.invoke.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    const callback = vi.fn();
    sounddeck.onControlCommand(callback);
    ipcRenderer.emit("control-command", {}, { command: "setting.toggle", args: { key: "micPassthrough" }, requestId: "pending" });
    await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
    ipcRenderer.emit("control-command", {}, { command: "control.cancel", requestId: "pending" });
    accept({ ok: true });
    await vi.waitFor(() => expect(ipcRenderer.invoke).toHaveBeenCalledWith("control:result", "pending", { ok: false, code: "unavailable" }, "current-document"));
    expect(callback).not.toHaveBeenCalled();
  });

  it("starts callbacks in arrival order without waiting for their operations to finish", async () => {
    const { ipcRenderer, sounddeck } = preload();
    ipcRenderer.emit("control-ready-token", {}, "current-document");
    let accept;
    ipcRenderer.invoke.mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    let finish;
    const callback = vi.fn((command) => command.requestId === "first" ? new Promise((resolve) => { finish = resolve; }) : { ok: true });
    sounddeck.onControlCommand(callback);
    ipcRenderer.emit("control-command", {}, { command: "sound.play", args: { soundId: "first" }, requestId: "first" });
    ipcRenderer.emit("control-command", {}, { command: "sound.play", args: { soundId: "second" }, requestId: "second" });
    await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
    expect(callback).not.toHaveBeenCalled();
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    accept({ ok: true });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    expect(callback.mock.calls.map(([command]) => command.requestId)).toEqual(["first", "second"]);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("control:result", "second", { ok: true }, "current-document");
    finish({ ok: true });
    await vi.waitFor(() => expect(ipcRenderer.invoke).toHaveBeenCalledWith("control:result", "first", { ok: true }, "current-document"));
  });

  it.each([
    [{ command: "sound.play", args: { soundId: "sound-a" } }, { ok: true }],
    [{ command: "setting.toggle", args: { key: "micPassthrough" } }, { ok: true, data: { key: "micPassthrough", value: true } }],
    [{ command: "volume.mute", args: { bus: "micVirtual" } }, { ok: true, data: { bus: "micVirtual", value: 0.6, muted: true } }]
  ])("acknowledges %j only after its renderer operation completes", async (command, result) => {
    const { ipcRenderer, sounddeck } = preload();
    ipcRenderer.emit("control-ready-token", {}, "current-document");
    await sounddeck.controlReady();
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith("control:ready", "current-document");
    ipcRenderer.invoke.mockClear();
    let finish;
    const callback = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const unsubscribe = sounddeck.onControlCommand(callback);
    ipcRenderer.emit("control-command", {}, { ...command, requestId: "request-a" });
    expect(callback).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith({ ...command, requestId: "request-a" }));
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith("control:received", "request-a", "current-document");
    ipcRenderer.invoke.mockClear();
    finish(result);
    await vi.waitFor(() => expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith("control:result", "request-a", result, "current-document"));
    unsubscribe();
    expect(ipcRenderer.listenerCount("control-command")).toBe(0);
  });
});
