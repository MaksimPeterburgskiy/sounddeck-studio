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
      const cancel = () => send({ command: message.command === "sound.play" ? "sound.cancel" : "control.cancel", requestId });
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      // Playback waits for the latest audio configuration, which can take
      // longer than the settings acknowledgement timeout to open a device.
      const timer = message.command === "sound.play" ? undefined : setTimeout(() => {
        cleanup();
        pending.delete(requestId);
        cancel();
        resolve({ ok: false, code: "unavailable" });
      }, timeoutMs);
      pending.set(requestId, { resolve, cleanup, message });
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

  return { dispatch, complete, cancelPending };
}

module.exports = { createControlRenderer };
