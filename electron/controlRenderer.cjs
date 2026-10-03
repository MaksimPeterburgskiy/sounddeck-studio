const { randomUUID } = require("node:crypto");

function createControlRenderer({ send, timeoutMs = 5000 }) {
  const pending = new Map();

  function cancelPending() {
    const requests = [...pending.values()];
    pending.clear();
    for (const request of requests) {
      request.cleanup();
      request.cancel();
      request.resolve({ ok: false, code: "unavailable" });
    }
  }

  function dispatch(message, signal) {
    if (signal?.aborted) return Promise.resolve({ ok: false, code: "unavailable" });
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const sendCancellation = () => {
        try { send({ command: "control.cancel", requestId }); } catch {}
      };
      const cancel = () => {
        const request = pending.get(requestId);
        if (!request) return;
        // Plays and commands awaiting receipt can fail immediately. Accepted
        // mutations must let the FIFO distinguish queued work from applied work.
        if (["sound.play", "sound.press"].includes(message.command) || !request.received) {
          cleanup();
          pending.delete(requestId);
          resolve({ ok: false, code: "unavailable" });
        }
        sendCancellation();
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
        sendCancellation();
        resolve({ ok: false, code: "unavailable" });
      }, timeoutMs);
      pending.set(requestId, { resolve, cleanup, timer, message, cancel: sendCancellation, received: false });
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
    request.received = true;
    return true;
  }

  function complete(requestId, result) {
    const request = pending.get(requestId);
    if (!request) return false;
    const { command, args } = request.message;
    let response;
    if (["sound.play", "sound.press"].includes(command)) {
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
