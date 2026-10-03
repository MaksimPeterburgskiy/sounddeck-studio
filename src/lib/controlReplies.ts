import type { RendererControlResult } from "./controlProtocol";

export function createControlReplies() {
  const pending: Array<{ result: RendererControlResult; resolve: (result: RendererControlResult) => void }> = [];

  return {
    get length() { return pending.length; },
    add(result: RendererControlResult) {
      return new Promise<RendererControlResult>((resolve) => pending.push({ result, resolve }));
    },
    async save(persist: () => Promise<unknown>) {
      const replies = pending.splice(0);
      try {
        await persist();
        for (const reply of replies) reply.resolve(reply.result);
      } catch {
        for (const reply of replies) reply.resolve({ ok: false, code: "internal-error" });
      }
    }
  };
}
