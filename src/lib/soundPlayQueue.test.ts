import { describe, expect, it, vi } from "vitest";
import { createSoundPlayQueue } from "./soundPlayQueue";
import { deferred } from "./testing/webAudioFakes";

describe("per-sound play queue", () => {
  it("lets different sounds play while earlier plays of one sound are pending", async () => {
    const queue = createSoundPlayQueue();
    const preparation = deferred<void>();
    const first = queue("sound-a", () => preparation.promise);
    const secondPlay = vi.fn(async () => true);
    const second = queue("sound-a", secondPlay);
    expect(await queue("sound-b", async () => true)).toBe(true);
    expect(secondPlay).not.toHaveBeenCalled();
    preparation.resolve();
    await first;
    expect(await second).toBe(true);
    expect(secondPlay).toHaveBeenCalledOnce();
  });

  it("continues queued and later plays after a play fails", async () => {
    const queue = createSoundPlayQueue();
    const preparation = deferred<void>();
    const failed = queue("sound-a", () => preparation.promise);
    const rejected = expect(failed).rejects.toThrow("Decode failed");
    const next = queue("sound-a", async () => true);
    preparation.reject(new Error("Decode failed"));
    await rejected;
    expect(await next).toBe(true);
    expect(await queue("sound-a", async () => "played again")).toBe("played again");
  });

  it("keeps plays after a stop serialized while cancelling older queued plays", async () => {
    const queue = createSoundPlayQueue();
    const preparation = deferred<void>();
    const first = queue("sound-a", async (signal) => {
      await preparation.promise;
      return !signal.aborted;
    });
    const second = queue("sound-a", async (signal) => !signal.aborted);
    queue.cancel("sound-a");
    const laterPlay = vi.fn(async (signal: AbortSignal) => !signal.aborted);
    const later = queue("sound-a", laterPlay);
    await Promise.resolve();
    expect(laterPlay).not.toHaveBeenCalled();
    preparation.resolve();
    expect(await Promise.all([first, second, later])).toEqual([false, false, true]);
    expect(laterPlay).toHaveBeenCalledOnce();
  });
  it("keeps three queued toggles independent while the first play prepares", async () => {
    const queue = createSoundPlayQueue();
    const preparation = deferred<void>();
    const signals: AbortSignal[] = [];
    const actions: string[] = [];
    let playing = false;
    const toggle = () => queue("sound-a", async (signal) => {
      signals.push(signal);
      if (!actions.length) await preparation.promise;
      if (signal.aborted) return false;
      playing = !playing;
      actions.push(playing ? "play" : "stop");
      return true;
    });
    const plays = [toggle(), toggle(), toggle()];
    preparation.resolve();
    expect(await Promise.all(plays)).toEqual([true, true, true]);
    expect(actions).toEqual(["play", "stop", "play"]);
    expect(new Set(signals).size).toBe(3);
  });

  it("cancels one request during preparation without cancelling its queued neighbours", async () => {
    const queue = createSoundPlayQueue();
    const preparation = deferred<void>();
    const cancellation = new AbortController();
    const first = queue("sound-a", async (signal) => { await preparation.promise; return !signal.aborted; }, cancellation.signal);
    const second = queue("sound-a", async (signal) => !signal.aborted);
    cancellation.abort();
    preparation.resolve();
    expect(await Promise.all([first, second])).toEqual([false, true]);
  });

  it("stop-all cancels every earlier operation and permits later plays on every sound", async () => {
    const queue = createSoundPlayQueue();
    const preparation = deferred<void>();
    const prepare = async (signal: AbortSignal) => { await preparation.promise; return !signal.aborted; };
    const older = [queue("a", prepare), queue("a", prepare), queue("b", prepare)];
    queue.cancelAll();
    const later = [queue("a", prepare), queue("b", prepare)];
    preparation.resolve();
    expect(await Promise.all([...older, ...later])).toEqual([false, false, false, true, true]);
  });

  it.each(["sound", "all"])("a %s stop snapshots operations before abort listeners enqueue later plays", async (stop) => {
    const queue = createSoundPlayQueue();
    const preparation = deferred<void>();
    const later: Promise<boolean>[] = [];
    const first = queue("a", async (signal) => {
      signal.addEventListener("abort", () => {
        later.push(queue("a", async (signal) => !signal.aborted));
        later.push(queue("b", async (signal) => !signal.aborted));
      });
      await preparation.promise;
      return !signal.aborted;
    });
    await Promise.resolve();
    if (stop === "sound") queue.cancel("a");
    else queue.cancelAll();
    preparation.resolve();
    expect(await first).toBe(false);
    expect(await Promise.all(later)).toEqual([true, true]);
  });

});
