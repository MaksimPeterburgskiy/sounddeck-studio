function createLibrarySaveQueue({ load, save }) {
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
      batch.result = enqueue(() => {
        if (pendingSave === batch) pendingSave = undefined;
        // All callers in this batch wait for the newest cumulative snapshot.
        return save(batch.library);
      });
      return batch.result;
    }
  };
}

module.exports = { createLibrarySaveQueue };
