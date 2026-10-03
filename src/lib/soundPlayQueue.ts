// Keep toggle decisions behind any pending play for the same sound, including
// media decoding and route preparation. Other sounds can start independently.
export function createSoundPlayQueue() {
  const pending = new Map<string, { tail: Promise<unknown>; cancellation: AbortController }>();
  // Operations must check the signal after asynchronous preparation and before
  // starting audio. Keep the tail on cancellation so later plays stay serialized.
  function play<T>(soundId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const previous = pending.get(soundId);
    const cancellation = previous && !previous.cancellation.signal.aborted ? previous.cancellation : new AbortController();
    const result = (previous ? previous.tail.catch(() => undefined) : Promise.resolve()).then(() => operation(cancellation.signal));
    pending.set(soundId, { tail: result, cancellation });
    const clear = () => {
      if (pending.get(soundId)?.tail === result) pending.delete(soundId);
    };
    void result.then(clear, clear);
    return result;
  }
  return Object.assign(play, {
    cancel(soundId: string) {
      pending.get(soundId)?.cancellation.abort();
    },
    cancelAll() {
      for (const { cancellation } of pending.values()) cancellation.abort();
    }
  });
}
