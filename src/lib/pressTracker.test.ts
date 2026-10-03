import { describe, expect, it, vi } from "vitest";
import { PressTracker } from "./pressTracker";
import { deferred } from "./testing/webAudioFakes";

describe("held presses", () => {
  it("releases only the voice belonging to that press, once", async () => {
    const tracker = new PressTracker();
    const stop = vi.fn();
    await tracker.press("a", async () => "voice-a", stop);
    await tracker.press("b", async () => "voice-b", stop);
    tracker.release("unknown");
    tracker.release("a");
    tracker.release("a");
    expect(stop.mock.calls).toEqual([["voice-a"]]);
    tracker.release("b");
    expect(stop.mock.calls).toEqual([["voice-a"], ["voice-b"]]);
  });

  it("cancels a pending start and stops a voice that still starts", async () => {
    const tracker = new PressTracker();
    const decoded = deferred<string | false>();
    const stop = vi.fn();
    let cancellation: AbortSignal;
    const pending = tracker.press("a", (signal) => {
      cancellation = signal;
      return decoded.promise;
    }, stop);
    expect(cancellation!.aborted).toBe(false);
    tracker.release("a");
    expect(cancellation!.aborted).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    decoded.resolve("late-voice");
    expect(await pending).toBeNull();
    expect(stop).toHaveBeenCalledWith("late-voice");
    tracker.release("a");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("cleans up failed starts and ignores repeated press events while held", async () => {
    const tracker = new PressTracker();
    const start = vi.fn(async () => "voice");
    const stop = vi.fn();
    expect(await tracker.press("a", async () => false, stop)).toBe(false);
    expect(await tracker.press("a", start, stop)).toBe("voice");
    expect(await tracker.press("a", start, stop)).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    tracker.release("a");
    await expect(tracker.press("a", async () => { throw new Error("decode failed"); }, stop)).rejects.toThrow("decode failed");
    await tracker.press("a", start, stop);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("distinguishes cancellation during decode from a missing route", async () => {
    const tracker = new PressTracker();
    const decoded = deferred<string | false>();
    const stop = vi.fn();
    const pending = tracker.press("a", () => decoded.promise, stop);
    tracker.release("a");
    decoded.resolve(false);
    expect(await pending).toBeNull();
    expect(stop).not.toHaveBeenCalled();
    expect(await tracker.press("a", async () => false, stop)).toBe(false);
  });

  it("releases active and pending holds on cleanup", async () => {
    const tracker = new PressTracker();
    const pendingStart = deferred<string | false>();
    const stop = vi.fn();
    await tracker.press("active", async () => "active-voice", stop);
    const pending = tracker.press("pending", () => pendingStart.promise, stop);
    tracker.releaseAll();
    pendingStart.resolve("pending-voice");
    await pending;
    expect(stop.mock.calls).toEqual([["active-voice"], ["pending-voice"]]);
  });
});
