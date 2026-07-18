import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import shutdownLifecycle from "./shutdownLifecycle.cjs";

const { createShutdownLifecycle, registerWindowShutdown } = shutdownLifecycle;

function createChild({ exitCode = null, signalCode = null, killed = false } = {}) {
  const child = new EventEmitter();
  child.exitCode = exitCode;
  child.signalCode = signalCode;
  child.killed = killed;
  child.kill = vi.fn();
  return child;
}

describe("createShutdownLifecycle", () => {
  it("runs cleanup and terminates each live child once across repeated shutdown events", () => {
    const onShutdown = vi.fn();
    const firstChild = createChild();
    const secondChild = createChild();
    const lifecycle = createShutdownLifecycle({ onShutdown });

    lifecycle.trackChild(firstChild);
    lifecycle.trackChild(firstChild);
    lifecycle.trackChild(secondChild);

    lifecycle.beginShutdown();
    lifecycle.beginShutdown();

    expect(lifecycle.isShuttingDown()).toBe(true);
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(firstChild.kill).toHaveBeenCalledTimes(1);
    expect(secondChild.kill).toHaveBeenCalledTimes(1);
  });

  it("removes children that close or error before shutdown and skips exited children", () => {
    const killChild = vi.fn();
    const closedChild = createChild();
    const failedChild = createChild();
    const exitedChild = createChild({ exitCode: 0 });
    const lifecycle = createShutdownLifecycle({ killChild });

    lifecycle.trackChild(closedChild);
    lifecycle.trackChild(failedChild);
    lifecycle.trackChild(exitedChild);
    closedChild.emit("close");
    failedChild.emit("error", new Error("spawn failed"));

    lifecycle.beginShutdown();

    expect(killChild).not.toHaveBeenCalled();
  });

  it("immediately terminates a live child registered after shutdown begins", () => {
    const killChild = vi.fn();
    const lifecycle = createShutdownLifecycle({ killChild });
    const child = createChild();

    lifecycle.beginShutdown();
    lifecycle.trackChild(child);
    lifecycle.trackChild(child);

    expect(killChild).toHaveBeenCalledTimes(1);
    expect(killChild).toHaveBeenCalledWith(child);
  });

  it("uses a child-specific process-tree terminator", () => {
    const killChild = vi.fn();
    const terminateTree = vi.fn();
    const child = createChild();
    const lifecycle = createShutdownLifecycle({ killChild });

    lifecycle.trackChild(child, { terminate: terminateTree });
    lifecycle.beginShutdown();

    expect(terminateTree).toHaveBeenCalledWith(child);
    expect(killChild).not.toHaveBeenCalled();
  });

  it("reports cleanup failures without interrupting the remaining shutdown work", () => {
    const error = new Error("cleanup failed");
    const onError = vi.fn();
    const child = createChild();
    const lifecycle = createShutdownLifecycle({
      onShutdown: () => { throw error; },
      onError
    });

    expect(() => lifecycle.beginShutdown()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(error);
    expect(child.kill).not.toHaveBeenCalled();

    lifecycle.trackChild(child);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe("registerWindowShutdown", () => {
  it("defers cleanup until Windows confirms the session is ending", () => {
    const window = new EventEmitter();
    const lifecycle = createShutdownLifecycle({ onShutdown: vi.fn() });
    const unregister = registerWindowShutdown(window, lifecycle);

    window.emit("query-session-end");
    expect(lifecycle.isShuttingDown()).toBe(false);

    window.emit("session-end");
    expect(lifecycle.isShuttingDown()).toBe(true);

    unregister();
    expect(window.listenerCount("session-end")).toBe(0);
  });
});
