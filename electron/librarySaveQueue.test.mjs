import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import queueModule from "./librarySaveQueue.cjs";

const { createLibrarySaveQueue, createAtomicLibrarySave } = queueModule;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

function fakeFileSystem() {
  return { mkdir: vi.fn().mockResolvedValue(), writeFile: vi.fn().mockResolvedValue(), unlink: vi.fn().mockResolvedValue() };
}

describe("atomic library replacement", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("retries transient Windows %s failures before committing", async (code) => {
    vi.useFakeTimers();
    const fileSystem = fakeFileSystem();
    const error = Object.assign(new Error("File locked"), { code });
    const replace = vi.fn().mockImplementationOnce(() => { throw error; })
      .mockImplementationOnce(() => { throw error; }).mockReturnValue(undefined);
    const save = createAtomicLibrarySave("library.json", { fileSystem, replace, platform: "win32" });
    const result = Promise.allSettled([save({ volume: 0.9 }, new AbortController().signal)]);
    await vi.runAllTimersAsync();
    expect(await result).toEqual([{ status: "fulfilled", value: { ok: true } }]);
    expect(replace).toHaveBeenCalledTimes(3);
    expect(new Set(replace.mock.calls.map(([temporary]) => temporary)).size).toBe(1);
    expect(fileSystem.unlink).toHaveBeenCalledOnce();
  });

  it("bounds Windows lock retries to one second and leaves other failures immediate", async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error("File locked"), { code: "EBUSY" });
    const replace = vi.fn(() => { throw error; });
    const save = createAtomicLibrarySave("library.json", { fileSystem: fakeFileSystem(), replace, platform: "win32" });
    const settled = vi.fn();
    const result = Promise.allSettled([save({}, new AbortController().signal)]).then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(settled).toHaveBeenCalledWith([{ status: "rejected", reason: error }]);
    const attempts = replace.mock.calls.length;
    expect(attempts).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(replace).toHaveBeenCalledTimes(attempts);
    for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EACCES"], ["win32", "ENOSPC"]]) {
      const failure = Object.assign(new Error("Cannot rename"), { code });
      const replace = vi.fn(() => { throw failure; });
      const save = createAtomicLibrarySave("library.json", { fileSystem: fakeFileSystem(), replace, platform });
      await expect(save({}, new AbortController().signal)).rejects.toBe(failure);
      expect(replace).toHaveBeenCalledOnce();
    }
  });

  it("never retries a cancelled Windows save over the newer queued snapshot", async () => {
    vi.useFakeTimers();
    const fileSystem = fakeFileSystem();
    const error = Object.assign(new Error("File locked"), { code: "EPERM" });
    const replace = vi.fn().mockImplementationOnce(() => { throw error; });
    const atomicSave = createAtomicLibrarySave("library.json", { fileSystem, replace, platform: "win32" });
    const queue = createLibrarySaveQueue({ load: vi.fn(), save: atomicSave, timeoutMs: 5 });
    const first = Promise.allSettled([queue.save({ volume: 0.3 })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(replace).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5);
    expect(await first).toMatchObject([{ status: "rejected", reason: { message: "Library save timed out" } }]);
    expect(await queue.save({ volume: 0.9 })).toEqual({ ok: true });
    await vi.runAllTimersAsync();
    expect(replace).toHaveBeenCalledTimes(2);
    expect(fileSystem.writeFile.mock.calls.map(([, data]) => JSON.parse(data))).toEqual([{ volume: 0.3 }, { volume: 0.9 }]);
    expect(replace.mock.calls[1][0]).toBe(fileSystem.writeFile.mock.calls[1][0]);
    expect(fileSystem.unlink).toHaveBeenCalledTimes(2);
  });
});

describe("library save queue", () => {
  it("releases a hung write for the newest retry and prevents a late stale write from replacing it", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sounddeck-save-"));
    const file = path.join(directory, "library.json");
    const stalled = deferred();
    const finished = deferred();
    const writeFile = vi.fn().mockImplementationOnce(async (temporary, data) => {
      await stalled.promise;
      // Simulate an OS write that ignores cancellation and finishes late.
      await fs.writeFile(temporary, data);
    }).mockImplementation(fs.writeFile);
    const atomicSave = createAtomicLibrarySave(file, { fileSystem: { ...fs, writeFile } });
    const queue = createLibrarySaveQueue({ load: () => fs.readFile(file, "utf8"), timeoutMs: 100,
      save: (library, signal) => atomicSave(library, signal).finally(() => { if (library.volume === 0.3) finished.resolve(); }) });
    try {
      const first = queue.save({ volume: 0.3 });
      const failure = expect(first).rejects.toThrow("Library save timed out");
      await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce());
      await failure;
      expect(await queue.save({ volume: 0.9 })).toEqual({ ok: true });
      expect(JSON.parse(await queue.load())).toEqual({ volume: 0.9 });
      stalled.resolve();
      await finished.promise;
      expect(JSON.parse(await queue.load())).toEqual({ volume: 0.9 });
      await vi.waitFor(async () => expect(await fs.readdir(directory)).toEqual(["library.json"]));
    } finally {
      stalled.resolve();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

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
    expect(save).toHaveBeenLastCalledWith({ settings: { micVirtualVolume: 1, micPassthrough: true } }, expect.any(AbortSignal));
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
