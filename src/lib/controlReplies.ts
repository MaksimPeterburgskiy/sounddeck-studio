import type { RendererControlResult } from "./controlProtocol";

export function createControlReplies() {
  const pending: Array<{ result: RendererControlResult; rollback?: () => void; resolve: (result: RendererControlResult) => void }> = [];

  return {
    get length() { return pending.length; },
    add(result: RendererControlResult, rollback?: () => void) {
      return new Promise<RendererControlResult>((resolve) => pending.push({ result, rollback, resolve }));
    },
    async save(persist: () => Promise<unknown>) {
      const replies = pending.splice(0);
      try {
        await persist();
        for (const reply of replies) reply.resolve(reply.result);
      } catch {
        // Undo cumulative changes in the opposite order they were applied.
        for (const reply of [...replies].reverse()) reply.rollback?.();
        for (const reply of replies) reply.resolve({ ok: false, code: "internal-error" });
      }
    }
  };
}
