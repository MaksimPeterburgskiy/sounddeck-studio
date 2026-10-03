import { describe, expect, it, vi } from "vitest";
import { createControlReplies } from "./controlReplies";
import type { RendererControlResult } from "./controlProtocol";

const result: RendererControlResult = { ok: true, data: { bus: "micVirtual", value: 0.9, muted: false } };

describe("persisted control replies", () => {
  it("holds replies until their save completes and leaves later commands for the next save", async () => {
    const replies = createControlReplies();
    const settled = vi.fn();
    const first = replies.add(result).then(settled);
    let finishSave!: () => void;
    const saving = replies.save(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const later = replies.add(result).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(replies.length).toBe(1);
    finishSave();
    await saving;
    await first;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenLastCalledWith(result);
    await replies.save(() => Promise.resolve());
    await later;
    expect(settled).toHaveBeenCalledTimes(2);
    expect(replies.length).toBe(0);
  });

  it("returns internal-error to every reply in a failed save and allows the next save", async () => {
    const replies = createControlReplies();
    const first = replies.add(result);
    const second = replies.add(result);
    await replies.save(() => Promise.reject(new Error("disk full")));
    expect(await Promise.all([first, second])).toEqual([
      { ok: false, code: "internal-error" },
      { ok: false, code: "internal-error" }
    ]);
    const next = replies.add(result);
    await replies.save(() => Promise.resolve());
    expect(await next).toEqual(result);
  });
});
