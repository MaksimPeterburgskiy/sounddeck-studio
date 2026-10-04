const fs = require("node:fs/promises");
const { renameSync } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function createAtomicLibrarySave(file, { fileSystem = fs, replace = renameSync } = {}) {
  return async (library, signal) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fileSystem.mkdir(path.dirname(file), { recursive: true });
      signal.throwIfAborted();
      await fileSystem.writeFile(temporary, JSON.stringify(library, null, 2), { flag: "wx", signal });
      signal.throwIfAborted();
      // No async gap between checking ownership and replacing the file: an
      // expired write can finish its isolated temp file, but never commit it.
      replace(temporary, file);
      return { ok: true };
    } finally {
      // Cleanup must not hold the save queue if the filesystem is stalled.
      void fileSystem.unlink(temporary).catch(() => {});
    }
  };
}

function createLibrarySaveQueue({ load, save, timeoutMs = 60000 }) {
  let queue = Promise.resolve();
  let pendingSave;

  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  return {
    load() {
      // A read is a barrier: later saves must not replace snapshots ahead of it.
      pendingSave = undefined;
      return enqueue(load);
    },
    save(library) {
      if (pendingSave) {
        pendingSave.library = library;
        return pendingSave.result;
      }
      const batch = { library };
      pendingSave = batch;
      batch.result = enqueue(async () => {
        if (pendingSave === batch) pendingSave = undefined;
        // All callers in this batch wait for the newest cumulative snapshot.
        const controller = new AbortController();
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error("Library save timed out");
            controller.abort(error);
            reject(error);
          }, timeoutMs);
          timer.unref?.();
        });
        try {
          return await Promise.race([save(batch.library, controller.signal), timeout]);
        } finally {
          clearTimeout(timer);
        }
      });
      return batch.result;
    }
  };
}

module.exports = { createLibrarySaveQueue, createAtomicLibrarySave };
