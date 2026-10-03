import { afterEach, describe, expect, it, vi } from "vitest";
import rendererModule from "./controlRenderer.cjs";

const { createControlRenderer } = rendererModule;
const command = { command: "volume.adjust", args: { bus: "micVirtual", delta: 0.02 } };
afterEach(() => vi.useRealTimers());

describe("renderer control acknowledgements", () => {
  it("cancels in-flight commands and ignores their late replies", async () => {
    const send = vi.fn();
    const bridge = createControlRenderer({ send });
    const volume = bridge.dispatch(command);
    const setting = bridge.dispatch({ command: "setting.toggle", args: { key: "micPassthrough" } });
    const playback = bridge.dispatch({ command: "sound.play", args: { soundId: "sound-a" } });
    const requestIds = send.mock.calls.map(([message]) => message.requestId);
    bridge.receive(send.mock.calls[0][0].requestId);
    bridge.cancelPending();
    expect(send.mock.calls.slice(3).map(([message]) => message)).toEqual(requestIds.map((requestId) => ({ command: "control.cancel", requestId })));
    expect(await volume).toEqual({ ok: false, code: "unavailable" });
    expect(await setting).toEqual({ ok: false, code: "unavailable" });
    expect(await playback).toEqual({ ok: false, code: "unavailable" });
    expect(bridge.complete(send.mock.calls[2][0].requestId, { ok: true })).toBe(false);
    bridge.complete(send.mock.calls[0][0].requestId, { ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
  });

  it("correlates concurrent replies and returns the applied values", async () => {
    const send = vi.fn();
    const bridge = createControlRenderer({ send });
    const volume = bridge.dispatch(command);
    const setting = bridge.dispatch({ command: "setting.toggle", args: { key: "micPassthrough" } });
    const playback = bridge.dispatch({ command: "sound.play", args: { soundId: "sound-a" } });
    const [volumeRequest, settingRequest, playbackRequest] = send.mock.calls.map(([message]) => message);
    bridge.complete(settingRequest.requestId, { ok: true, data: { key: "micPassthrough", value: true } });
    bridge.complete(playbackRequest.requestId, { ok: false, code: "not-found" });
    bridge.complete(volumeRequest.requestId, { ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    expect(await volume).toEqual({ ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    expect(await setting).toEqual({ ok: true, data: { key: "micPassthrough", value: true } });
    expect(await playback).toEqual({ ok: false, code: "not-found" });
  });

  it("times out receipt but keeps accepted commands pending through slow saves and routing", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const bridge = createControlRenderer({ send });
    const completed = vi.fn();
    const playback = bridge.dispatch({ command: "sound.play", args: { soundId: "sound-a" } }).then(completed);
    const setting = bridge.dispatch({ command: "setting.toggle", args: { key: "micPassthrough" } });
    const volumeCompleted = vi.fn();
    const volume = bridge.dispatch(command).then(volumeCompleted);
    expect(bridge.receive(send.mock.calls[0][0].requestId)).toBe(true);
    expect(bridge.receive(send.mock.calls[2][0].requestId)).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await setting).toEqual({ ok: false, code: "unavailable" });
    expect(completed).not.toHaveBeenCalled();
    expect(volumeCompleted).not.toHaveBeenCalled();
    expect(bridge.receive(send.mock.calls[1][0].requestId)).toBe(false);
    expect(bridge.complete(send.mock.calls[2][0].requestId, { ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } })).toBe(true);
    await volume;
    expect(volumeCompleted).toHaveBeenCalledExactlyOnceWith({ ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    expect(bridge.complete(send.mock.calls[0][0].requestId, { ok: true })).toBe(true);
    await playback;
    expect(completed).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });

  it.each(["sound.play", "sound.press"])("relays %s cancellation without disturbing concurrent requests", async (name) => {
    const send = vi.fn();
    const bridge = createControlRenderer({ send });
    const controller = new AbortController();
    const first = bridge.dispatch({ command: name, args: { soundId: "sound", ...(name === "sound.press" && { pressId: "held" }) } }, controller.signal);
    const requestId = send.mock.lastCall[0].requestId;
    const second = bridge.dispatch(command);
    const otherId = send.mock.lastCall[0].requestId;
    bridge.receive(requestId);
    controller.abort();
    expect(send).toHaveBeenLastCalledWith({ command: "control.cancel", requestId });
    expect(bridge.receive(requestId)).toBe(false);
    expect(bridge.complete(requestId, { ok: true })).toBe(false);
    bridge.complete(otherId, { ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    expect(await first).toEqual({ ok: false, code: "unavailable" });
    expect(await second).toEqual({ ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    const sent = send.mock.calls.length;
    expect(await bridge.dispatch(command, controller.signal)).toEqual({ ok: false, code: "unavailable" });
    expect(send).toHaveBeenCalledTimes(sent);
  });

  it("revokes a mutation before receipt synchronously so it cannot be accepted later", async () => {
    const send = vi.fn();
    const bridge = createControlRenderer({ send });
    const controller = new AbortController();
    const operation = bridge.dispatch(command, controller.signal);
    const requestId = send.mock.lastCall[0].requestId;
    controller.abort();
    expect(send).toHaveBeenLastCalledWith({ command: "control.cancel", requestId });
    expect(bridge.receive(requestId)).toBe(false);
    expect(bridge.complete(requestId, { ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } })).toBe(false);
    expect(await operation).toEqual({ ok: false, code: "unavailable" });
  });

  it.each(["sound.play", "sound.press"])("settles revoked %s and teardown even if cancellation delivery fails", async (name) => {
    const send = vi.fn();
    const bridge = createControlRenderer({ send });
    const controller = new AbortController();
    const playback = bridge.dispatch({ command: name, args: { soundId: "sound-a", ...(name === "sound.press" && { pressId: "held" }) } }, controller.signal);
    const mutation = bridge.dispatch(command);
    send.mockImplementation(() => { throw new Error("Renderer gone"); });
    controller.abort();
    bridge.cancelPending();
    expect(await playback).toEqual({ ok: false, code: "unavailable" });
    expect(await mutation).toEqual({ ok: false, code: "unavailable" });
  });

  it("keeps an accepted mutation pending after disconnect until its applied result completes", async () => {
    const send = vi.fn();
    const bridge = createControlRenderer({ send });
    const controller = new AbortController();
    const completed = vi.fn();
    const operation = bridge.dispatch(command, controller.signal).then(completed);
    const requestId = send.mock.lastCall[0].requestId;
    bridge.receive(requestId);
    controller.abort();
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith({ command: "control.cancel", requestId });
    bridge.complete(requestId, { ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    await operation;
    expect(completed).toHaveBeenCalledExactlyOnceWith({ ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
  });

  it("fails if the renderer does not answer or sends an invalid result", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const bridge = createControlRenderer({ send });
    const unanswered = bridge.dispatch(command);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await unanswered).toEqual({ ok: false, code: "unavailable" });
    const invalid = bridge.dispatch(command);
    bridge.complete(send.mock.lastCall[0].requestId, { ok: true, data: { bus: "micVirtual", value: 2, muted: false } });
    expect(await invalid).toEqual({ ok: false, code: "internal-error" });
  });
});
