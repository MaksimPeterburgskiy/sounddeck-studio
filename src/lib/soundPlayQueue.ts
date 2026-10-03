// Keep toggle decisions behind any pending play for the same sound, including
// media decoding and route preparation. Other sounds can start independently.
export function createSoundPlayQueue() {
  const pending = new Map<string, Promise<unknown>>();
  return function play<T>(soundId: string, operation: () => Promise<T>): Promise<T> {
    const previous = pending.get(soundId);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation);
    pending.set(soundId, result);
    const clear = () => {
      if (pending.get(soundId) === result) pending.delete(soundId);
    };
    void result.then(clear, clear);
    return result;
  };
}
