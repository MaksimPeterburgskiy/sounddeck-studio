import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudioControlQueue, persistControlLibrary } from "./audioControlQueue";
import { beginAudioConfiguration, trackAudioConfiguration, waitForAudioConfiguration, watchAudioDeviceChanges } from "./controlReadiness";
import { deferred, makeAudioSettings } from "./testing/webAudioFakes";
import type { AudioSettings, SoundLibrary } from "../types";

afterEach(() => vi.useRealTimers());

function setup(initial: Partial<AudioSettings> = {}) {
  let settings = makeAudioSettings(initial);
  const persist = vi.fn(async () => {});
  const waitForConfiguration = vi.fn(async () => {});
  const writeSettings = vi.fn((next: AudioSettings) => { settings = next; });
  const queue = createAudioControlQueue({ getSettings: () => settings, writeSettings, persist, waitForConfiguration });
  return { queue, persist, waitForConfiguration, writeSettings, getSettings: () => settings };
}

describe("external audio mutation FIFO", () => {
  it.each(["pending", "saved", "failed"])("releases a hung save at its deadline without rolling back its unknown outcome (%s)", async (outcome) => {
    const app = setup({ micVirtualVolume: 0.4 });
    const save = deferred<void>();
    app.persist.mockReturnValueOnce(save.promise);
    const cancellation = new AbortController();
    const first = app.queue.enqueue({ command: "volume.set", args: { bus: "micVirtual", value: 0.6 } }, cancellation.signal);
    const later = app.queue.enqueue({ command: "volume.adjust", args: { bus: "micVirtual", delta: 0.2 } });
    await vi.waitFor(() => expect(app.persist).toHaveBeenCalledOnce());
    cancellation.abort("operation-timeout");
    expect(await first).toEqual({ ok: false, code: "unavailable" });
    expect(await later).toEqual({ ok: true, data: { bus: "micVirtual", value: 0.8, muted: false } });
    expect(app.waitForConfiguration).toHaveBeenCalledOnce();
    if (outcome === "saved") save.resolve();
    if (outcome === "failed") save.reject(new Error("disk full"));
    await Promise.resolve();
    expect(app.getSettings().micVirtualVolume).toBe(0.8);
    expect(app.writeSettings).toHaveBeenCalledTimes(2);
  });

  it("acknowledges a saved mutation at its deadline without waiting for hung routing or applying a cancelled queued toggle", async () => {
    const app = setup({ micPassthrough: false });
    const routing = deferred<void>();
    app.waitForConfiguration.mockReturnValueOnce(routing.promise);
    const appliedController = new AbortController();
    const queuedController = new AbortController();
    const applied = app.queue.enqueue({ command: "setting.toggle", args: { key: "micPassthrough" } }, appliedController.signal);
    const queued = app.queue.enqueue({ command: "setting.toggle", args: { key: "micPassthrough" } }, queuedController.signal);
    await vi.waitFor(() => expect(app.waitForConfiguration).toHaveBeenCalledOnce());
    appliedController.abort("operation-timeout");
    queuedController.abort("operation-timeout");
    expect(await applied).toEqual({ ok: true, data: { key: "micPassthrough", value: true } });
    expect(await queued).toEqual({ ok: false, code: "unavailable" });
    expect(app.persist).toHaveBeenCalledOnce();
    expect(app.getSettings().micPassthrough).toBe(true);
    expect(await app.queue.enqueue({ command: "setting.toggle", args: { key: "micPassthrough" } }))
      .toEqual({ ok: true, data: { key: "micPassthrough", value: false } });
    routing.resolve();
    await Promise.resolve();
    expect(app.getSettings().micPassthrough).toBe(false);
  });

  it.each(["settings", "devicechange"])("waits for pending %s routing before acknowledging a saved mutation and advancing the FIFO", async (source) => {
    vi.useFakeTimers();
    let settings = makeAudioSettings({ micPassthrough: false });
    const configuration = { current: null as Promise<void> | null };
    const save = deferred<void>();
    const routing = deferred<void>();
    const persist = vi.fn(async () => {}).mockReturnValueOnce(save.promise);
    const writeSettings = vi.fn((next: AudioSettings) => {
      settings = next;
      trackAudioConfiguration(configuration, Promise.resolve());
    });
    const queue = createAudioControlQueue({
      getSettings: () => settings, writeSettings, persist,
      waitForConfiguration: () => waitForAudioConfiguration(() => configuration.current)
    });
    const completed = vi.fn();
    const first = queue.enqueue({ command: "setting.toggle", args: { key: "micPassthrough" } }).then(completed);
    const later = queue.enqueue({ command: "volume.mute", args: { bus: "micVirtual" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(persist).toHaveBeenCalledOnce();
    const devices = new EventTarget() as MediaDevices;
    const retry = vi.fn(() => routing.promise);
    const cleanup = watchAudioDeviceChanges(devices, configuration, retry);
    let complete: ReturnType<typeof beginAudioConfiguration> | undefined;
    if (source === "devicechange") devices.dispatchEvent(new Event("devicechange"));
    else complete = beginAudioConfiguration(configuration);
    save.resolve();
    await vi.advanceTimersByTimeAsync(599);
    expect(retry).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(writeSettings).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    if (complete) complete(routing.promise);
    else expect(retry).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledOnce();
    routing.resolve();
    await first;
    expect(completed).toHaveBeenCalledExactlyOnceWith({ ok: true, data: { key: "micPassthrough", value: true } });
    expect(await later).toEqual({ ok: true, data: { bus: "micVirtual", value: 1, muted: true } });
    expect(persist).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("holds replies and later mutations until tracked device retries and overlapping configuration settle", async () => {
    const app = setup({ micVirtualVolume: 0.4, micPassthrough: false });
    const refresh = deferred<void>();
    const retry = deferred<void>();
    const configured = deferred<void>();
    const latest = deferred<void>();
    const configuration: { current: Promise<void> | null } = { current: null };
    const retryDevices = vi.fn(() => retry.promise);
    trackAudioConfiguration(configuration, refresh.promise.then(retryDevices));
    // A settings write must retain an already pending device refresh/retry.
    trackAudioConfiguration(configuration, configured.promise);
    app.waitForConfiguration.mockImplementation(() => waitForAudioConfiguration(() => configuration.current));
    const replied = vi.fn();
    const first = app.queue.enqueue({ command: "volume.mute", args: { bus: "micVirtual" } }).then(replied);
    const later = app.queue.enqueue({ command: "setting.toggle", args: { key: "micPassthrough" } });
    try {
      await vi.waitFor(() => expect(app.waitForConfiguration).toHaveBeenCalledOnce());
      configured.resolve();
      refresh.resolve();
      await vi.waitFor(() => expect(retryDevices).toHaveBeenCalledOnce());
      expect(replied).not.toHaveBeenCalled();
      expect(app.writeSettings).toHaveBeenCalledOnce();
      // Another configuration arriving during the wait must also be observed.
      const beforeLatest = configuration.current;
      trackAudioConfiguration(configuration, latest.promise);
      retry.resolve();
      await beforeLatest;
      await Promise.resolve();
      expect(replied).not.toHaveBeenCalled();
      expect(app.writeSettings).toHaveBeenCalledOnce();
      latest.resolve();
      await first;
      expect(replied).toHaveBeenCalledExactlyOnceWith({ ok: true, data: { bus: "micVirtual", value: 0.4, muted: true } });
      expect(await later).toEqual({ ok: true, data: { key: "micPassthrough", value: true } });
      expect(app.writeSettings).toHaveBeenCalledTimes(2);
    } finally {
      refresh.resolve();
      retry.resolve();
      configured.resolve();
      latest.resolve();
      await Promise.all([first, later]);
    }
  });

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

describe("external control library persistence", () => {
  it.each(["saved", "failed"])("leaves a timed-out snapshot eligible for UI persistence even after a late save settles (%s)", async (outcome) => {
    const snapshot: SoundLibrary = { version: 1, activeBoardId: "", boards: [], settings: makeAudioSettings() };
    const savedLibraries = new WeakSet<SoundLibrary>();
    const save = deferred<{ ok: boolean }>();
    const cancellation = new AbortController();
    const saving = persistControlLibrary(snapshot, savedLibraries, () => save.promise, cancellation.signal);
    expect(savedLibraries.has(snapshot)).toBe(true);
    cancellation.abort("operation-timeout");
    await expect(saving).rejects.toThrow("Control operation cancelled");
    expect(savedLibraries.has(snapshot)).toBe(false);
    if (outcome === "saved") save.resolve({ ok: true });
    else save.reject(new Error("disk full"));
    await Promise.resolve();
    expect(savedLibraries.has(snapshot)).toBe(false);
  });

  it.each(["reject", "not-ok"])("leaves an unsaved edit eligible for UI persistence after a same-value command's save fails (%s)", async (failure) => {
    let library: SoundLibrary = { version: 1, activeBoardId: "edited-board", boards: [], settings: makeAudioSettings({ micPassthrough: false }) };
    const savedLibraries = new WeakSet<SoundLibrary>();
    const save = deferred<{ ok: boolean }>();
    const saveLibrary = vi.fn(async (_snapshot: SoundLibrary) => ({ ok: true })).mockReturnValueOnce(save.promise);
    const writeSettings = vi.fn((settings: AudioSettings) => { library = { ...library, settings }; });
    const queue = createAudioControlQueue({
      getSettings: () => library.settings,
      writeSettings,
      persist: () => persistControlLibrary(library, savedLibraries, saveLibrary),
      waitForConfiguration: async () => {}
    });
    const failed = queue.enqueue({ command: "setting.set", args: { key: "micPassthrough", value: false } });
    await vi.waitFor(() => expect(saveLibrary).toHaveBeenCalledOnce());
    const snapshot = library;
    expect(savedLibraries.has(snapshot)).toBe(true);
    if (failure === "reject") save.reject(new Error("disk full"));
    else save.resolve({ ok: false });
    expect(await failed).toEqual({ ok: false, code: "internal-error" });
    expect(writeSettings).toHaveBeenCalledOnce();
    expect(library).toBe(snapshot);
    expect(library.activeBoardId).toBe("edited-board");
    expect(savedLibraries.has(snapshot)).toBe(false);
  });

  it("keeps successfully saved snapshots excluded from UI persistence", async () => {
    const snapshot: SoundLibrary = { version: 1, activeBoardId: "", boards: [], settings: makeAudioSettings() };
    const savedLibraries = new WeakSet<SoundLibrary>();
    await persistControlLibrary(snapshot, savedLibraries, async () => ({ ok: true }));
    expect(savedLibraries.has(snapshot)).toBe(true);
  });
});
