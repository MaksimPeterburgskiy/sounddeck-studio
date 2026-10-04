// A deadline can stop waiting for preparation after cancellation has made its
// eventual completion harmless. Disconnects keep existing completion semantics.
export function waitForControlOperation<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => {
      if (signal.reason === "operation-timeout") {
        signal.removeEventListener("abort", abort);
        reject(new Error("Control operation cancelled"));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
