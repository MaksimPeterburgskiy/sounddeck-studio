import { describe, expect, it, vi } from "vitest";
import type { AudioEngine } from "./audioEngine";
import { SoundTriggers } from "./soundTriggers";
import { trackAudioConfiguration } from "./controlReadiness";
import { deferred, makeSound, waitForMockCalls } from "./testing/webAudioFakes";

function engine() {
  let playing = false;
  let nextVoice = 0;
  return {
    play: vi.fn(async (_sound: Parameters<AudioEngine["play"]>[0], _signal?: AbortSignal, _options?: { fresh?: boolean }): Promise<string | false> => { playing = true; return `voice-${++nextVoice}`; }),
    stop: vi.fn(() => { playing = false; }),
    stopAll: vi.fn(() => { playing = false; }),
    stopVoice: vi.fn(),
    isPlaying: vi.fn(() => playing),
  };
}

describe("sound trigger ordering", () => {
  it.each(["play", "tap press", "hold press"])("external %s waits for tracked device refresh, retries and overlapping configuration", async (operation) => {
    const audio = engine();
    const configuration = { current: null as Promise<void> | null };
    const initial = deferred<void>();
    const refresh = deferred<void>();
    const retry = deferred<void>();
    const latest = deferred<void>();
    const initialTracked = trackAudioConfiguration(configuration, initial.promise);
    const getConfiguration = vi.fn(() => configuration.current);
    const triggers = new SoundTriggers(() => audio, getConfiguration);
    const sound = makeSound({ triggerMode: operation === "hold press" ? "hold" : "tap", retriggerMode: "overlap" });
    const pressId = operation === "play" ? undefined : "held";
    const pending = triggers.trigger(sound, pressId, true);
    await vi.waitFor(() => expect(getConfiguration).toHaveBeenCalled());
    const retryPreferredDevices = vi.fn(() => retry.promise);
    const retriesTracked = trackAudioConfiguration(configuration, refresh.promise.then(retryPreferredDevices));
    initial.resolve();
    await initialTracked;
    expect(audio.play).not.toHaveBeenCalled();
    refresh.resolve();
    await waitForMockCalls(retryPreferredDevices, 1);
    expect(audio.play).not.toHaveBeenCalled();
    trackAudioConfiguration(configuration, latest.promise);
    retry.resolve();
    await retriesTracked;
    expect(audio.play).not.toHaveBeenCalled();
    latest.resolve();
    expect(await pending).toBe("voice-1");
    expect(audio.play).toHaveBeenCalledExactlyOnceWith(sound, expect.any(AbortSignal), { fresh: operation === "hold press", waitForRouting: expect.any(Function) });
    if (pressId) triggers.release(pressId);
  });

  it("serializes plays and Tap presses for one sound while other sounds can start", async () => {
    const audio = engine();
    const decoded = deferred<string | false>();
    audio.play.mockImplementationOnce(() => decoded.promise);
    const triggers = new SoundTriggers(() => audio, () => null);
    const sound = makeSound({ retriggerMode: "stop" });
    const first = triggers.trigger(sound, undefined, true);
    const second = triggers.trigger(sound, "tap-key", true);
    await waitForMockCalls(audio.play, 1);
    expect(audio.isPlaying).toHaveBeenCalledTimes(1);
    const other = triggers.trigger(makeSound({ id: "other", retriggerMode: "overlap" }), undefined, true);
    expect(await other).toBe("voice-1");
    decoded.resolve("decoded-voice");
    expect(await first).toBe("decoded-voice");
    expect(await second).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.stop).toHaveBeenCalledExactlyOnceWith(sound.id);
  });

  it("cancels a Hold released while routing or another play is pending", async () => {
    const audio = engine();
    const configuration = deferred<void>();
    const triggers = new SoundTriggers(() => audio, () => configuration.promise);
    const sound = makeSound({ triggerMode: "hold", retriggerMode: "overlap" });
    const tap = triggers.trigger(sound, undefined, true);
    const hold = triggers.trigger(sound, "held", true);
    triggers.release("held");
    expect(audio.play).not.toHaveBeenCalled();
    configuration.resolve();
    expect(await tap).toBe("voice-1");
    expect(await hold).toBeNull();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.stopVoice).not.toHaveBeenCalled();
  });

  it("starts independent fresh Hold voices and releases each key's voice", async () => {
    const audio = engine();
    const triggers = new SoundTriggers(() => audio, () => null);
    const sound = makeSound({ triggerMode: "hold", retriggerMode: "stop" });
    expect(await Promise.all([triggers.trigger(sound, "a", true), triggers.trigger(sound, "b", true)]))
      .toEqual(["voice-1", "voice-2"]);
    expect(audio.stop).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledWith(sound, expect.any(AbortSignal), { fresh: true, waitForRouting: expect.any(Function) });
    triggers.release("a");
    expect(audio.stopVoice.mock.calls).toEqual([[sound.id, "voice-1"]]);
    triggers.release("b");
    expect(audio.stopVoice.mock.calls).toEqual([[sound.id, "voice-1"], [sound.id, "voice-2"]]);
  });

  it("allows later commands after a failed configuration", async () => {
    const audio = engine();
    const configuration = deferred<void>();
    let current: Promise<void> | null = configuration.promise;
    const triggers = new SoundTriggers(() => audio, () => current);
    const sound = makeSound();
    const first = triggers.trigger(sound, "first", true);
    const failed = expect(first).rejects.toThrow("routing failed");
    configuration.reject(new Error("routing failed"));
    await failed;
    current = null;
    expect(await triggers.trigger(sound, "second", true)).toBe("voice-1");
  });

  it("releases a queued hold without cancelling later plays or holds", async () => {
    const audio = engine();
    const configuration = deferred<void>();
    const triggers = new SoundTriggers(() => audio, () => configuration.promise);
    const sound = makeSound({ triggerMode: "hold", retriggerMode: "overlap" });
    const first = triggers.trigger(sound, undefined, true);
    const released = triggers.trigger(sound, "released", true);
    const laterPlay = triggers.trigger(sound, undefined, true);
    const laterHold = triggers.trigger(sound, "later", true);
    triggers.release("released");
    configuration.resolve();
    expect(await Promise.all([first, released, laterPlay, laterHold]))
      .toEqual(["voice-1", null, "voice-2", "voice-3"]);
    triggers.release("later");
    expect(audio.stopVoice.mock.calls).toEqual([[sound.id, "voice-3"]]);
  });

  it.each(["sound", "all"])("%s stop releases active holds and cancels earlier queued plays while permitting later triggers", async (stop) => {
    const audio = engine();
    let configuration: Promise<void> | null = null;
    const triggers = new SoundTriggers(() => audio, () => configuration);
    const sound = makeSound({ triggerMode: "hold", retriggerMode: "overlap" });
    const other = makeSound({ id: "other", triggerMode: "hold", retriggerMode: "overlap" });
    await triggers.trigger(sound, "active", true);
    await triggers.trigger(other, "other-active", true);
    const routing = deferred<void>();
    configuration = routing.promise;
    const held = triggers.trigger(sound, "queued", true);
    const play = triggers.trigger(sound, undefined, true);
    if (stop === "sound") triggers.stop(sound.id);
    else triggers.stopAll();
    const stopCall = (stop === "sound" ? audio.stop : audio.stopAll).mock.invocationCallOrder[0];
    expect(stopCall).toBeLessThan(audio.stopVoice.mock.invocationCallOrder[0]);
    const later = triggers.trigger(sound, "later", true);
    routing.resolve();
    expect(await Promise.all([held, play, later])).toEqual([null, false, "voice-3"]);
    expect(audio.stopVoice.mock.calls).toEqual(stop === "sound"
      ? [[sound.id, "voice-1"]]
      : [[sound.id, "voice-1"], [other.id, "voice-2"]]);
    triggers.release("queued");
    triggers.release("active");
    triggers.release("later");
    expect(audio.stopVoice).toHaveBeenLastCalledWith(sound.id, "voice-3");
  });

  it("passes request cancellation through a hold's decode without affecting its neighbour", async () => {
    const audio = engine();
    const decoded = deferred<void>();
    audio.play.mockImplementationOnce(async (_sound, signal) => {
      await decoded.promise;
      return signal?.aborted ? false : "late-voice";
    });
    const triggers = new SoundTriggers(() => audio, () => null);
    const sound = makeSound({ triggerMode: "hold", retriggerMode: "overlap" });
    const cancellation = new AbortController();
    const first = triggers.trigger(sound, "first", true, cancellation.signal);
    const second = triggers.trigger(sound, "second", true);
    await waitForMockCalls(audio.play, 1);
    cancellation.abort();
    decoded.resolve();
    expect(await Promise.all([first, second])).toEqual([null, "voice-1"]);
    expect(audio.stopVoice).not.toHaveBeenCalled();
  });

  it.each(["sound", "all"])("%s stop snapshots held presses before abort listeners enqueue new holds", async (stop) => {
    const audio = engine();
    const decoded = deferred<void>();
    const sound = makeSound({ triggerMode: "hold", retriggerMode: "overlap" });
    const triggers = new SoundTriggers(() => audio, () => null);
    let later: Promise<string | boolean | null>;
    audio.play.mockImplementationOnce(async (_sound, signal) => {
      signal?.addEventListener("abort", () => { later = triggers.trigger(sound, "later", true); });
      await decoded.promise;
      return false;
    });
    const first = triggers.trigger(sound, "first", true);
    await waitForMockCalls(audio.play, 1);
    if (stop === "sound") triggers.stop(sound.id);
    else triggers.stopAll();
    decoded.resolve();
    expect(await first).toBeNull();
    expect(await later!).toBe("voice-1");
    triggers.release("later");
    expect(audio.stopVoice).toHaveBeenCalledExactlyOnceWith(sound.id, "voice-1");
  });
});
