import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCableCaptureDemandSupervisor } from "./cableCaptureDemand.cjs";

const standard = "CABLE Input (VB-Audio Virtual Cable)";
const cableB = "Studio feed (VB-Audio Cable B)";

function setup(platform = "win32") {
  const children = [];
  const spawnFn = vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; };
    children.push(child);
    return child;
  });
  const trackChild = vi.fn();
  const onDemand = vi.fn();
  const { setEndpoint } = createCableCaptureDemandSupervisor({
    platform, arch: "x64", appIsPackaged: true, resourcesPath: "/resources", spawnFn, trackChild, onDemand
  });
  return { children, setEndpoint, spawnFn, trackChild, onDemand };
}

describe("cable recorder detection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs only for the selected Windows cable and serializes device changes", () => {
    const app = setup();
    const mac = setup("darwin");
    mac.setEndpoint(standard);
    expect(mac.spawnFn).not.toHaveBeenCalled();
    app.setEndpoint("CABLE Input (USB interface)");
    expect(app.spawnFn).not.toHaveBeenCalled();
    app.setEndpoint(standard);
    app.setEndpoint(standard);
    const [first] = app.children;
    expect(app.trackChild).toHaveBeenCalledExactlyOnceWith(first);
    first.stdout.write("fal");
    first.stdout.write("se\r\ntrue\nnull\n");
    expect(app.onDemand.mock.calls).toEqual([[standard, null], [standard, false], [standard, true], [standard, null]]);
    app.setEndpoint(cableB);
    first.stdout.write("false\n");
    expect(app.onDemand).toHaveBeenLastCalledWith(cableB, null);
    expect(app.children).toHaveLength(1);
    first.emit("close");
    expect(app.spawnFn.mock.lastCall[1]).toEqual([cableB]);
    app.setEndpoint(null);
    app.children[1].emit("close");
    vi.advanceTimersByTime(60_000);
    expect(app.children).toHaveLength(2);
  });

  it.each(["bad\n", "a".repeat(40), "exit", "spawn error"])("restores passthrough on %s and restarts the helper", (fault) => {
    const app = setup();
    app.setEndpoint(standard);
    const [first] = app.children;
    first.stdout.write("false\n");
    if (fault === "spawn error") first.emit("error", new Error("ENOENT"));
    else if (fault !== "exit") first.stdout.write(fault);
    first.emit("close");
    expect(app.onDemand).toHaveBeenLastCalledWith(standard, null);
    vi.advanceTimersByTime(999);
    expect(app.children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    app.children[1].stdout.write("false\n");
    expect(app.onDemand).toHaveBeenLastCalledWith(standard, false);
  });

  it("backs off repeated spawn failures, caps the delay, and cancels pending retries", () => {
    const app = setup();
    app.spawnFn.mockImplementation(() => { throw new Error("cannot start"); });
    app.setEndpoint(standard);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      app.spawnFn.mockClear();
      vi.advanceTimersByTime(delay - 1);
      expect(app.spawnFn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(app.spawnFn).toHaveBeenCalledOnce();
    }
    app.setEndpoint(null);
    vi.advanceTimersByTime(60_000);
    expect(app.spawnFn).toHaveBeenCalledOnce();
  });
});
