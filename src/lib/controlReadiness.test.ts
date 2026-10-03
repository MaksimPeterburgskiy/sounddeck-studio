import { afterEach, describe, expect, it, vi } from "vitest";
import { beginAudioConfiguration, trackAudioConfiguration, waitForAudioConfiguration, watchAudioDeviceChanges } from "./controlReadiness";
import { deferred } from "./testing/webAudioFakes";

describe("external control audio readiness", () => {
  afterEach(() => vi.useRealTimers());

  it("marks settings pending before configuration starts and waits for its outcome", async () => {
    const configuration = { current: Promise.resolve() };
    const complete = beginAudioConfiguration(configuration);
    const ready = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration.current).then(ready);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    const work = deferred<void>();
    complete(work.promise);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    work.resolve();
    await pending;
    expect(ready).toHaveBeenCalledOnce();
  });

  it.each([false, true])("blocks from devicechange through repeated debounce and retry (retry fails: %s)", async (fails) => {
    vi.useFakeTimers();
    const devices = new EventTarget() as MediaDevices;
    const configuration = { current: Promise.resolve() };
    const work = deferred<void>();
    const retry = vi.fn(() => work.promise);
    const cleanup = watchAudioDeviceChanges(devices, configuration, retry);
    devices.dispatchEvent(new Event("devicechange"));
    const ready = vi.fn();
    const failed = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration.current).then(ready, failed);
    await vi.advanceTimersByTimeAsync(599);
    expect(retry).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    devices.dispatchEvent(new Event("devicechange"));
    await vi.advanceTimersByTimeAsync(599);
    expect(retry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(retry).toHaveBeenCalledOnce();
    expect(ready).not.toHaveBeenCalled();
    if (fails) work.reject(new Error("Routing failed"));
    else work.resolve();
    await pending;
    expect(ready).toHaveBeenCalledTimes(fails ? 0 : 1);
    expect(failed).toHaveBeenCalledTimes(fails ? 1 : 0);
    cleanup();
  });

  it("tracks a new device debounce while an older retry is in flight", async () => {
    vi.useFakeTimers();
    const devices = new EventTarget() as MediaDevices;
    const configuration = { current: Promise.resolve() };
    const first = deferred<void>();
    const second = deferred<void>();
    const retry = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const cleanup = watchAudioDeviceChanges(devices, configuration, retry);
    devices.dispatchEvent(new Event("devicechange"));
    await vi.advanceTimersByTimeAsync(600);
    devices.dispatchEvent(new Event("devicechange"));
    const ready = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration.current).then(ready);
    first.resolve();
    await vi.advanceTimersByTimeAsync(600);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(ready).not.toHaveBeenCalled();
    second.resolve();
    await pending;
    expect(ready).toHaveBeenCalledOnce();
    cleanup();
  });

  it("releases a cancelled debounce and removes its listener without releasing older routing", async () => {
    vi.useFakeTimers();
    const devices = new EventTarget() as MediaDevices;
    const work = deferred<void>();
    const configuration = { current: work.promise };
    const retry = vi.fn();
    const cleanup = watchAudioDeviceChanges(devices, configuration, retry);
    devices.dispatchEvent(new Event("devicechange"));
    const ready = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration.current).then(ready);
    cleanup();
    devices.dispatchEvent(new Event("devicechange"));
    await vi.advanceTimersByTimeAsync(600);
    expect(retry).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    work.resolve();
    await pending;
    expect(ready).toHaveBeenCalledOnce();
  });

  it("retains pending routing when overlapping settings or device retries finish first", async () => {
    const configuration = { current: null as Promise<void> | null };
    const earlier = deferred<void>();
    const newer = deferred<void>();
    trackAudioConfiguration(configuration, earlier.promise);
    const ready = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration.current).then(ready);
    trackAudioConfiguration(configuration, newer.promise);
    newer.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    earlier.resolve();
    await pending;
    expect(ready).toHaveBeenCalledOnce();
  });

  it("allows successful routing to supersede a failed operation", async () => {
    const configuration = { current: null as Promise<void> | null };
    const earlier = deferred<void>();
    const newer = deferred<void>();
    trackAudioConfiguration(configuration, earlier.promise);
    const ready = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration.current).then(ready);
    trackAudioConfiguration(configuration, newer.promise);
    earlier.reject(new Error("Old routing failed"));
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    newer.resolve();
    await pending;
    expect(ready).toHaveBeenCalledOnce();
  });

  it("waits for older work to settle before reporting the latest routing failure", async () => {
    const configuration = { current: null as Promise<void> | null };
    const earlier = deferred<void>();
    const newer = deferred<void>();
    trackAudioConfiguration(configuration, earlier.promise);
    const tracked = trackAudioConfiguration(configuration, newer.promise);
    const settled = vi.fn();
    const pending = tracked.catch(settled);
    newer.reject(new Error("Latest routing failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    earlier.resolve();
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "Latest routing failed" }));
  });

  it("waits for configuration that starts before an unconfigured wait settles", async () => {
    let configuration: Promise<void> | null = null;
    const ready = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration).then(ready);
    const startup = deferred<void>();
    configuration = startup.promise;
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    startup.resolve();
    await pending;
    expect(ready).toHaveBeenCalledOnce();
  });

  it("waits for newer settings when the initial configuration is superseded", async () => {
    const initial = deferred<void>();
    const latest = deferred<void>();
    let configuration = initial.promise;
    const ready = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration).then(ready);
    configuration = latest.promise;
    initial.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    latest.resolve();
    await pending;
    expect(ready).toHaveBeenCalledOnce();
  });

  it("does not report readiness if configuration rejects", async () => {
    const configuration = deferred<void>();
    const ready = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration.promise).then(ready);
    configuration.reject(new Error("Configuration failed"));
    await expect(pending).rejects.toThrow("Configuration failed");
    expect(ready).not.toHaveBeenCalled();
  });

  it("waits for the latest configuration even if a superseded one rejects", async () => {
    const previous = deferred<void>();
    const latest = deferred<void>();
    let configuration = previous.promise;
    const play = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration).then(play);
    configuration = latest.promise;
    previous.reject(new Error("Superseded configuration failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(play).not.toHaveBeenCalled();
    latest.resolve();
    await pending;
    expect(play).toHaveBeenCalledOnce();
  });
});
