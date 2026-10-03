import { describe, expect, it, vi } from "vitest";
import queueModule from "./librarySaveQueue.cjs";

const { createLibrarySaveQueue } = queueModule;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("library save queue", () => {
  it("loads the newest pending volume on reload and preserves it on the remounted renderer's first save", async () => {
    const writing = deferred();
    let persisted = { settings: { micVirtualVolume: 0.3 } };
    const updateLibrary = vi.fn();
    const load = vi.fn(() => {
      updateLibrary(persisted);
      return persisted;
    });
    const queue = createLibrarySaveQueue({
      load,
      save: async (library) => {
        await writing.promise;
        persisted = library;
        updateLibrary(library);
        return { ok: true };
      }
    });
    const first = queue.save(persisted);
    await Promise.resolve();
    const newest = { settings: { micVirtualVolume: 0.9 } };
    const pending = queue.save(newest);
    const reload = queue.load();
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    writing.resolve();
    expect(await reload).toEqual(newest);
    expect(updateLibrary).toHaveBeenLastCalledWith(newest);
    await queue.save(await reload);
    expect(persisted.settings.micVirtualVolume).toBe(0.9);
    expect(await Promise.all([first, pending])).toEqual([{ ok: true }, { ok: true }]);
  });

  it("writes only the newest pending cumulative snapshot and holds every waiter until that write completes", async () => {
    const firstWrite = deferred();
    const newestWrite = deferred();
    const save = vi.fn().mockImplementationOnce(() => firstWrite.promise).mockImplementationOnce(() => newestWrite.promise);
    const queue = createLibrarySaveQueue({ load: vi.fn(), save });
    const first = queue.save({ settings: { micVirtualVolume: 0.3, micPassthrough: false } });
    await Promise.resolve();
    const settled = vi.fn();
    const waiters = [queue.save({ settings: { micVirtualVolume: 0.3, micPassthrough: true } }).then(settled)];
    for (let step = 1; step <= 20; step++) {
      waiters.push(queue.save({ settings: { micVirtualVolume: step / 20, micPassthrough: true } }).then(settled));
    }
    expect(save).toHaveBeenCalledTimes(1);
    firstWrite.resolve({ ok: true });
    await first;
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ settings: { micVirtualVolume: 1, micPassthrough: true } });
    expect(settled).not.toHaveBeenCalled();
    newestWrite.resolve({ ok: true });
    await Promise.all(waiters);
    expect(settled).toHaveBeenCalledTimes(21);
    expect(settled).toHaveBeenLastCalledWith({ ok: true });
  });

  it("keeps saves on opposite sides of a load separate and serializes the read with later writes", async () => {
    const reading = deferred();
    let persisted = 0.3;
    const save = vi.fn((library) => { persisted = library; });
    const queue = createLibrarySaveQueue({
      save,
      load: async () => {
        await reading.promise;
        return persisted;
      }
    });
    const before = queue.save(0.9);
    const reload = queue.load();
    const after = queue.save(0.5);
    await before;
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    reading.resolve();
    expect(await reload).toBe(0.9);
    await after;
    expect(persisted).toBe(0.5);
  });

  it("rejects every coalesced waiter on failure and allows subsequent loads and saves", async () => {
    const failedWrite = deferred();
    const save = vi.fn().mockImplementationOnce(() => failedWrite.promise).mockResolvedValue({ ok: true });
    const queue = createLibrarySaveQueue({ load: () => 0.3, save });
    const first = queue.save(0.4);
    const second = queue.save(0.9);
    const results = Promise.allSettled([first, second]);
    const error = new Error("disk full");
    failedWrite.reject(error);
    expect(await results).toEqual([{ status: "rejected", reason: error }, { status: "rejected", reason: error }]);
    expect(await queue.load()).toBe(0.3);
    expect(await queue.save(0.5)).toEqual({ ok: true });
  });
});
