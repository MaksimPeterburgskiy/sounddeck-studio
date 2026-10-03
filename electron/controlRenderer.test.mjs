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
    bridge.cancelPending();
    expect(await volume).toEqual({ ok: false, code: "unavailable" });
    expect(await setting).toEqual({ ok: false, code: "unavailable" });
    bridge.complete(send.mock.calls[0][0].requestId, { ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
  });

  it("correlates concurrent replies and returns the applied values", async () => {
    const send = vi.fn();
    const bridge = createControlRenderer({ send });
    const volume = bridge.dispatch(command);
    const setting = bridge.dispatch({ command: "setting.toggle", args: { key: "micPassthrough" } });
    const [volumeRequest, settingRequest] = send.mock.calls.map(([message]) => message);
    bridge.complete(settingRequest.requestId, { ok: true, data: { key: "micPassthrough", value: true } });
    bridge.complete(volumeRequest.requestId, { ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    expect(await volume).toEqual({ ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    expect(await setting).toEqual({ ok: true, data: { key: "micPassthrough", value: true } });
  });

  it("relays operation cancellation without disturbing concurrent requests", async () => {
    const send = vi.fn();
    const bridge = createControlRenderer({ send });
    const controller = new AbortController();
    const first = bridge.dispatch({ command: "sound.play", args: { soundId: "sound" } }, controller.signal);
    const requestId = send.mock.lastCall[0].requestId;
    const second = bridge.dispatch(command);
    const otherId = send.mock.lastCall[0].requestId;
    controller.abort();
    expect(send).toHaveBeenLastCalledWith({ command: "sound.cancel", requestId });
    bridge.complete(requestId, { ok: false, code: "unavailable" });
    bridge.complete(otherId, { ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    expect(await first).toEqual({ ok: false, code: "unavailable" });
    expect(await second).toEqual({ ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    const sent = send.mock.calls.length;
    expect(await bridge.dispatch(command, controller.signal)).toEqual({ ok: false, code: "unavailable" });
    expect(send).toHaveBeenCalledTimes(sent);
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
