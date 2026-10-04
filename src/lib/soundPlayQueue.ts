import { waitForControlOperation } from "./controlCancellation";

// Serialize preparation and toggle decisions per sound. Cancellation belongs to
// each operation: a stop snapshots the operations that already exist.
export function createSoundPlayQueue() {
  const tails = new Map<string, Promise<unknown>>();
  const pending = new Map<string, Set<AbortController>>();

  function play<T>(soundId: string, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, deadlineSignal = signal): Promise<T> {
    const cancellation = new AbortController();
    const abort = () => cancellation.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const operations = pending.get(soundId) ?? new Set<AbortController>();
    operations.add(cancellation);
    pending.set(soundId, operations);
    const previous = tails.get(soundId);
    const result = waitForControlOperation(
      (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() => operation(cancellation.signal)),
      // A release/stop can abort playback before the external deadline arrives.
      // Keep watching the request so a hung cancelled operation still yields.
      deadlineSignal
    );
    tails.set(soundId, result);
    const clear = () => {
      signal?.removeEventListener("abort", abort);
      operations.delete(cancellation);
      if (!operations.size) pending.delete(soundId);
      if (tails.get(soundId) === result) tails.delete(soundId);
    };
    void result.then(clear, clear);
    return result;
  }
  return Object.assign(play, {
    cancel(soundId: string) {
      for (const cancellation of [...(pending.get(soundId) ?? [])]) cancellation.abort();
    },
    cancelAll() {
      const cancellations = [...pending.values()].flatMap((operations) => [...operations]);
      for (const cancellation of cancellations) cancellation.abort();
    }
  });
}
