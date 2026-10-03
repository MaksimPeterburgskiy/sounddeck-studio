import { describe, expect, it, vi } from "vitest";
import { createAudioControlQueue } from "./audioControlQueue";
import { deferred, makeAudioSettings } from "./testing/webAudioFakes";
import type { AudioSettings } from "../types";

function setup(initial: Partial<AudioSettings> = {}) {
  let settings = makeAudioSettings(initial);
  const persist = vi.fn(async () => {});
  const waitForConfiguration = vi.fn(async () => {});
  const writeSettings = vi.fn((next: AudioSettings) => { settings = next; });
  const queue = createAudioControlQueue({ getSettings: () => settings, writeSettings, persist, waitForConfiguration });
  return { queue, persist, waitForConfiguration, writeSettings, getSettings: () => settings };
}

describe("external audio mutation FIFO", () => {
  it("applies one mutation at a time and waits for both persistence and mute configuration before replying", async () => {
    const app = setup({ micVirtualVolume: 0.4 });
    const save = deferred<void>();
    const configuration = deferred<void>();
    app.persist.mockReturnValueOnce(save.promise);
    app.waitForConfiguration.mockReturnValueOnce(configuration.promise);
    const replied = vi.fn();
    const muted = app.queue.enqueue({ command: "volume.mute", args: { bus: "micVirtual" } }).then(replied);
    const later = app.queue.enqueue({ command: "volume.adjust", args: { bus: "micVirtual", delta: 0.2 } });
    await vi.waitFor(() => expect(app.persist).toHaveBeenCalledOnce());
    expect(app.getSettings().micVirtualMuted).toBe(true);
    expect(app.writeSettings).toHaveBeenCalledOnce();
    expect(app.waitForConfiguration).not.toHaveBeenCalled();
    save.resolve();
    await vi.waitFor(() => expect(app.waitForConfiguration).toHaveBeenCalledOnce());
    expect(replied).not.toHaveBeenCalled();
    expect(app.writeSettings).toHaveBeenCalledOnce();
    configuration.resolve();
    await muted;
    expect(replied).toHaveBeenCalledExactlyOnceWith({ ok: true, data: { bus: "micVirtual", value: 0.4, muted: true } });
    expect(await later).toEqual({ ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
  });

  it("reports a persisted mutation as applied when audio configuration rejects and continues the FIFO", async () => {
    const app = setup({ micVirtualVolume: 0.4, micVirtualMuted: true });
    const configuration = deferred<void>();
    app.waitForConfiguration.mockReturnValueOnce(configuration.promise);
    const replied = vi.fn();
    const applied = app.queue.enqueue({ command: "volume.set", args: { bus: "micVirtual", value: 0.6 } }).then(replied);
    const later = app.queue.enqueue({ command: "volume.mute", args: { bus: "micVirtual" } });
    await vi.waitFor(() => expect(app.waitForConfiguration).toHaveBeenCalledOnce());
    expect(app.persist).toHaveBeenCalledOnce();
    expect(app.writeSettings).toHaveBeenCalledOnce();
    expect(replied).not.toHaveBeenCalled();
    expect(app.getSettings().micVirtualVolume).toBe(0.6);
    expect(app.getSettings().micVirtualMuted).toBe(false);

    configuration.reject(new Error("audio device unavailable"));
    await applied;
    expect(replied).toHaveBeenCalledExactlyOnceWith({ ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    expect(await later).toEqual({ ok: true, data: { bus: "micVirtual", value: 0.6, muted: true } });
    expect(app.persist).toHaveBeenCalledTimes(2);
    expect(app.waitForConfiguration).toHaveBeenCalledTimes(2);
    expect(app.writeSettings.mock.calls.map(([settings]) => ({ value: settings.micVirtualVolume, muted: settings.micVirtualMuted })))
      .toEqual([{ value: 0.6, muted: false }, { value: 0.6, muted: true }]);
    expect(app.getSettings().micVirtualVolume).toBe(0.6);
    expect(app.getSettings().micVirtualMuted).toBe(true);
  });

  it("skips a disconnected client's queued mutation without blocking later clients", async () => {
    const app = setup({ micVirtualVolume: 0.4, micPassthrough: false });
    const save = deferred<void>();
    app.persist.mockReturnValueOnce(save.promise);
    const first = app.queue.enqueue({ command: "volume.mute", args: { bus: "micVirtual", muted: true } });
    const cancellation = new AbortController();
    const cancelled = app.queue.enqueue({ command: "volume.adjust", args: { bus: "micVirtual", delta: 0.2 } }, cancellation.signal);
    const later = app.queue.enqueue({ command: "setting.toggle", args: { key: "micPassthrough" } });
    await vi.waitFor(() => expect(app.persist).toHaveBeenCalledOnce());
    cancellation.abort();
    save.resolve();
    expect(await first).toEqual({ ok: true, data: { bus: "micVirtual", value: 0.4, muted: true } });
    expect(await cancelled).toEqual({ ok: false, code: "unavailable" });
    expect(await later).toEqual({ ok: true, data: { key: "micPassthrough", value: true } });
    expect(app.persist).toHaveBeenCalledTimes(2);
    expect(app.writeSettings).toHaveBeenCalledTimes(2);
    expect(app.getSettings().micVirtualVolume).toBe(0.4);
    expect(app.getSettings().micVirtualMuted).toBe(true);
  });

  it("rejects an already cancelled mutation before reading or writing settings", async () => {
    const app = setup();
    const cancellation = new AbortController();
    cancellation.abort();
    expect(await app.queue.enqueue({ command: "setting.toggle", args: { key: "micPassthrough" } }, cancellation.signal)).toEqual({ ok: false, code: "unavailable" });
    expect(app.writeSettings).not.toHaveBeenCalled();
    expect(app.persist).not.toHaveBeenCalled();
    expect(app.waitForConfiguration).not.toHaveBeenCalled();
  });

  it("finishes an applied mutation's save and configuration after its client disconnects", async () => {
    const app = setup({ micVirtualVolume: 0.4 });
    const save = deferred<void>();
    const configuration = deferred<void>();
    app.persist.mockReturnValueOnce(save.promise);
    app.waitForConfiguration.mockReturnValueOnce(configuration.promise);
    const cancellation = new AbortController();
    const replied = vi.fn();
    const applied = app.queue.enqueue({ command: "volume.adjust", args: { bus: "micVirtual", delta: 0.2 } }, cancellation.signal).then(replied);
    await vi.waitFor(() => expect(app.persist).toHaveBeenCalledOnce());
    cancellation.abort();
    expect(app.getSettings().micVirtualVolume).toBe(0.6);
    save.resolve();
    await vi.waitFor(() => expect(app.waitForConfiguration).toHaveBeenCalledOnce());
    expect(replied).not.toHaveBeenCalled();
    configuration.resolve();
    await applied;
    expect(replied).toHaveBeenCalledExactlyOnceWith({ ok: true, data: { bus: "micVirtual", value: 0.6, muted: false } });
    expect(app.writeSettings).toHaveBeenCalledOnce();
  });

  it("rolls back an applied mutation's failed save after its client disconnects", async () => {
    const app = setup({ micVirtualVolume: 0.4, micVirtualMuted: true });
    const save = deferred<void>();
    app.persist.mockReturnValueOnce(save.promise);
    const cancellation = new AbortController();
    const applied = app.queue.enqueue({ command: "volume.set", args: { bus: "micVirtual", value: 0.6 } }, cancellation.signal);
    await vi.waitFor(() => expect(app.persist).toHaveBeenCalledOnce());
    cancellation.abort();
    save.reject(new Error("disk full"));
    expect(await applied).toEqual({ ok: false, code: "internal-error" });
    expect(app.getSettings().micVirtualVolume).toBe(0.4);
    expect(app.getSettings().micVirtualMuted).toBe(true);
    expect(app.waitForConfiguration).toHaveBeenCalledOnce();
  });

  it("restores a failed toggle before applying a queued same-value write", async () => {
    const app = setup({ micPassthrough: false });
    const save = deferred<void>();
    const rollbackConfiguration = deferred<void>();
    app.persist.mockReturnValueOnce(save.promise);
    app.waitForConfiguration.mockReturnValueOnce(rollbackConfiguration.promise);
    const failed = app.queue.enqueue({ command: "setting.toggle", args: { key: "micPassthrough" } });
    const later = app.queue.enqueue({ command: "setting.set", args: { key: "micPassthrough", value: true } });
    await vi.waitFor(() => expect(app.persist).toHaveBeenCalledOnce());
    save.reject(new Error("disk full"));
    await vi.waitFor(() => expect(app.waitForConfiguration).toHaveBeenCalledOnce());
    expect(app.getSettings().micPassthrough).toBe(false);
    expect(app.persist).toHaveBeenCalledOnce();
    rollbackConfiguration.resolve();
    expect(await failed).toEqual({ ok: false, code: "internal-error" });
    expect(await later).toEqual({ ok: true, data: { key: "micPassthrough", value: true } });
    expect(app.writeSettings.mock.calls.map(([settings]) => settings.micPassthrough)).toEqual([true, false, true]);
  });

  it("preserves a later same-value UI write while restoring other failed fields", async () => {
    const app = setup({ micVirtualVolume: 0.4, micVirtualMuted: true });
    const save = deferred<void>();
    app.persist.mockReturnValueOnce(save.promise);
    const failed = app.queue.enqueue({ command: "volume.set", args: { bus: "micVirtual", value: 0.6 } });
    await vi.waitFor(() => expect(app.persist).toHaveBeenCalledOnce());
    app.queue.recordWrites(["micVirtualVolume", "monitorDeviceId"]);
    app.writeSettings({ ...app.getSettings(), micVirtualVolume: 0.6, monitorDeviceId: "new-headphones" });
    save.reject(new Error("disk full"));
    expect(await failed).toEqual({ ok: false, code: "internal-error" });
    expect(app.getSettings()).toEqual(makeAudioSettings({ micVirtualVolume: 0.6, micVirtualMuted: true, monitorDeviceId: "new-headphones" }));
  });
});
