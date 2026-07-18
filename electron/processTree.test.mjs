import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import processTree from "./processTree.cjs";

const { terminateProcessTree, shouldDetachProcessTree } = processTree;

function createChild(pid = 4321) {
  return { pid, kill: vi.fn(() => true) };
}

describe("terminateProcessTree", () => {
  it("force-terminates the detached POSIX process group", () => {
    const child = createChild();
    const killProcessGroup = vi.fn();

    expect(terminateProcessTree(child, { platform: "linux", killProcessGroup })).toBe(true);

    expect(killProcessGroup).toHaveBeenCalledWith(-4321, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to the child handle when POSIX group termination fails", () => {
    const child = createChild();
    const killProcessGroup = vi.fn(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });

    expect(terminateProcessTree(child, { platform: "darwin", killProcessGroup })).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("treats an absent POSIX process group as already terminated", () => {
    const child = createChild();
    const killProcessGroup = vi.fn(() => {
      throw Object.assign(new Error("not found"), { code: "ESRCH" });
    });

    expect(terminateProcessTree(child, { platform: "linux", killProcessGroup })).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("uses taskkill to terminate the complete Windows process tree", () => {
    const child = createChild();
    const killer = new EventEmitter();
    killer.unref = vi.fn();
    const runTaskkill = vi.fn(() => killer);

    expect(terminateProcessTree(child, { platform: "win32", runTaskkill })).toBe(true);

    expect(runTaskkill).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      { windowsHide: true, stdio: "ignore", shell: false }
    );
    expect(killer.unref).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(["error", "close"])("falls back to the child handle after a taskkill %s", (event) => {
    const child = createChild();
    const killer = new EventEmitter();
    killer.unref = vi.fn();

    expect(terminateProcessTree(child, { platform: "win32", runTaskkill: () => killer })).toBe(true);
    killer.emit(event, event === "close" ? 1 : new Error("failed"));
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("only runs the taskkill fallback once", () => {
    const child = createChild();
    const killer = new EventEmitter();

    terminateProcessTree(child, { platform: "win32", runTaskkill: () => killer });
    killer.emit("error", new Error("failed"));
    killer.emit("close", 1);

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("falls back to the child handle when taskkill throws", () => {
    const child = createChild();
    const runTaskkill = () => { throw new Error("failed"); };

    expect(terminateProcessTree(child, { platform: "win32", runTaskkill })).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("falls back to the child handle when no valid PID is available", () => {
    const child = createChild(undefined);

    expect(terminateProcessTree(child, { platform: "win32", runTaskkill: vi.fn() })).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe("shouldDetachProcessTree", () => {
  it("creates a process group on POSIX but not Windows", () => {
    expect(shouldDetachProcessTree("linux")).toBe(true);
    expect(shouldDetachProcessTree("darwin")).toBe(true);
    expect(shouldDetachProcessTree("win32")).toBe(false);
  });
});
