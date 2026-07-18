function createShutdownLifecycle({ onShutdown, killChild, onError } = {}) {
  const children = new Map();
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
    const childTerminator = children.get(child) || terminate;
    children.delete(child);
    if (!isLive(child) || terminatedChildren.has(child)) return;

    terminatedChildren.add(child);
    childTerminator(child);
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

    for (const child of [...children.keys()]) {
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

  function trackChild(child, { terminate: childTerminator } = {}) {
    if (!child || typeof child !== "object") return child;

    const resolvedTerminator = typeof childTerminator === "function" ? childTerminator : terminate;

    if (shuttingDown) {
      children.set(child, resolvedTerminator);
      try {
        terminateChild(child);
      } catch (error) {
        reportError(error);
      }
      return child;
    }

    if (children.has(child)) return child;
    children.set(child, resolvedTerminator);

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
