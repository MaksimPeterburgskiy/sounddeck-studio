import { describe, expect, it, vi } from "vitest";
import updateInstallLifecycle from "./updateInstallLifecycle.cjs";

const { createUpdateInstallLifecycle } = updateInstallLifecycle;

describe("createUpdateInstallLifecycle", () => {
  it("allows windows to close while the updater starts the installer", () => {
    const setWindowCloseAllowed = vi.fn();
    const quitAndInstall = vi.fn();
    const lifecycle = createUpdateInstallLifecycle({ setWindowCloseAllowed, isShuttingDown: () => false });

    expect(lifecycle.requestInstall(quitAndInstall)).toBe(true);
    expect(setWindowCloseAllowed).toHaveBeenCalledWith(true);
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("restores normal window behavior after an updater error", () => {
    const setWindowCloseAllowed = vi.fn();
    const lifecycle = createUpdateInstallLifecycle({ setWindowCloseAllowed, isShuttingDown: () => false });

    lifecycle.requestInstall(vi.fn());

    expect(lifecycle.resetAfterFailure()).toBe(true);
    expect(setWindowCloseAllowed).toHaveBeenLastCalledWith(false);
    expect(lifecycle.resetAfterFailure()).toBe(false);
  });

  it("reports a synchronous updater error as a failed start", () => {
    const setWindowCloseAllowed = vi.fn();
    const lifecycle = createUpdateInstallLifecycle({ setWindowCloseAllowed, isShuttingDown: () => false });

    const started = lifecycle.requestInstall(() => lifecycle.resetAfterFailure());

    expect(started).toBe(false);
    expect(setWindowCloseAllowed).toHaveBeenLastCalledWith(false);
  });

  it("restores normal behavior when quitAndInstall throws", () => {
    const setWindowCloseAllowed = vi.fn();
    const error = new Error("installer failed");
    const lifecycle = createUpdateInstallLifecycle({ setWindowCloseAllowed, isShuttingDown: () => false });

    expect(() => lifecycle.requestInstall(() => { throw error; })).toThrow(error);
    expect(setWindowCloseAllowed).toHaveBeenLastCalledWith(false);
  });

  it("does not undo an OS shutdown after a late updater error", () => {
    const setWindowCloseAllowed = vi.fn();
    const lifecycle = createUpdateInstallLifecycle({ setWindowCloseAllowed, isShuttingDown: () => true });

    lifecycle.requestInstall(vi.fn());

    expect(lifecycle.resetAfterFailure()).toBe(true);
    expect(setWindowCloseAllowed).toHaveBeenCalledTimes(1);
    expect(setWindowCloseAllowed).toHaveBeenCalledWith(true);
  });

  it("ignores duplicate install requests while the first is pending", () => {
    const firstInstall = vi.fn();
    const secondInstall = vi.fn();
    const lifecycle = createUpdateInstallLifecycle({ setWindowCloseAllowed: vi.fn(), isShuttingDown: () => false });

    expect(lifecycle.requestInstall(firstInstall)).toBe(true);
    expect(lifecycle.requestInstall(secondInstall)).toBe(false);
    expect(firstInstall).toHaveBeenCalledTimes(1);
    expect(secondInstall).not.toHaveBeenCalled();
  });
});
