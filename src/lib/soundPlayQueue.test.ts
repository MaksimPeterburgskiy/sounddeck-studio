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
});
