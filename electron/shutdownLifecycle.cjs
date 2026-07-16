function createShutdownLifecycle({ onShutdown, killChild, onError } = {}) {
  const children = new Set();
  const terminatedChildren = new WeakSet();
  let shuttingDown = false;
  let cleanupRan = false;

  const terminate = typeof killChild === "function"
    ? killChild
    : (child) => child.kill();
  const reportError = typeof onError === "function" ? onError : () => {};

  function isLive(child) {
    return child && child.exitCode == null && child.signalCode == null && child.killed !== true;
  }

  function terminateChild(child) {
    children.delete(child);
    if (!isLive(child) || terminatedChildren.has(child)) return;

    terminatedChildren.add(child);
    terminate(child);
  }

  function beginShutdown() {
    if (shuttingDown) return;

    shuttingDown = true;

    if (!cleanupRan) {
      cleanupRan = true;
      try {
        onShutdown?.();
      } catch (caught) {
        reportError(caught);
      }
    }

    for (const child of [...children]) {
      try {
        terminateChild(child);
      } catch (caught) {
        reportError(caught);
      }
    }
  }

  function isShuttingDown() {
    return shuttingDown;
  }

  function trackChild(child) {
    if (!child || typeof child !== "object") return child;

    if (shuttingDown) {
      try {
        terminateChild(child);
      } catch (error) {
        reportError(error);
      }
      return child;
    }

    if (children.has(child)) return child;
    children.add(child);

    const removeChild = () => children.delete(child);
    child.once?.("close", removeChild);
    child.once?.("error", removeChild);
    return child;
  }

  return { beginShutdown, isShuttingDown, trackChild };
}

function registerWindowShutdown(window, lifecycle) {
  const handleSessionEnd = () => lifecycle.beginShutdown();
  window.on("session-end", handleSessionEnd);
  return () => window.removeListener?.("session-end", handleSessionEnd);
}

module.exports = { createShutdownLifecycle, registerWindowShutdown };
