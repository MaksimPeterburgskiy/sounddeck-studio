const { randomUUID } = require("node:crypto");

function createControlRenderer({ send, timeoutMs = 5000 }) {
  const pending = new Map();

  function cancelPending() {
    for (const request of pending.values()) {
      request.cleanup();
      request.resolve({ ok: false, code: "unavailable" });
    }
    pending.clear();
  }

  function dispatch(message, signal) {
    if (signal?.aborted) return Promise.resolve({ ok: false, code: "unavailable" });
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const cancel = () => {
        try { send({ command: "control.cancel", requestId }); } catch {}
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      // Only receipt is timed out. Accepted operations remain pending until
      // the renderer finishes saving and configuring audio.
      const timer = setTimeout(() => {
        cleanup();
        pending.delete(requestId);
        cancel();
        resolve({ ok: false, code: "unavailable" });
      }, timeoutMs);
      pending.set(requestId, { resolve, cleanup, timer, message });
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        send({ ...message, requestId });
      } catch {
        cleanup();
        pending.delete(requestId);
        resolve({ ok: false, code: "unavailable" });
      }
    });
  }

  function receive(requestId) {
    const request = pending.get(requestId);
    if (!request) return false;
    clearTimeout(request.timer);
    return true;
  }

  function complete(requestId, result) {
    const request = pending.get(requestId);
    if (!request) return false;
    const { command, args } = request.message;
    let response;
    if (command === "sound.play") {
      if (!result || (result.ok !== true && (result.ok !== false || !["unavailable", "not-found", "internal-error"].includes(result.code)))) {
        throw new Error("Invalid control playback result");
      }
      response = result.ok ? { ok: true } : { ok: false, code: result.code };
    } else {
      const data = result?.data;
      const validData = command.startsWith("setting.")
        ? data?.key === args.key && typeof data.value === "boolean"
        : data?.bus === args.bus && Number.isFinite(data.value) && data.value >= 0 && data.value <= 1 && typeof data.muted === "boolean";
      response = result?.ok === true && validData ? { ok: true, data }
        : { ok: false, code: result?.ok === false && result.code === "unavailable" ? "unavailable" : "internal-error" };
    }
    request.cleanup();
    pending.delete(requestId);
    request.resolve(response);
    return true;
  }

  return { dispatch, receive, complete, cancelPending };
}

module.exports = { createControlRenderer };
