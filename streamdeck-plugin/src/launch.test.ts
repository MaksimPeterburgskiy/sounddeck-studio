import { describe, expect, it, vi } from "vitest";
import { launchApp, LaunchThrottle } from "./launch";

describe("offline launch", () => {
  it("passes an argument array without a shell for macOS and executable launches", () => {
    const child = { once: vi.fn(), unref: vi.fn() };
    const spawn = vi.fn(() => child);
    launchApp("/Applications/SoundDeck Studio.app", "darwin", spawn as never);
    expect(spawn).toHaveBeenLastCalledWith("open", ["-g", "-a", "/Applications/SoundDeck Studio.app", "--args", "--sounddeck-external-launch"], { detached: true, stdio: "ignore" });
    launchApp("C:\\Program Files\\SoundDeck Studio.exe", "win32", spawn as never);
    expect(spawn).toHaveBeenLastCalledWith("C:\\Program Files\\SoundDeck Studio.exe", ["--sounddeck-external-launch"], { detached: true, stdio: "ignore" });
    expect(child.once).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.unref).toHaveBeenCalledTimes(2);
  });

  it("throttles all presses for 30 seconds, including failed launch attempts", () => {
    let now = 0;
    const launch = vi.fn(() => { throw new Error("missing app"); });
    const throttle = new LaunchThrottle(launch, () => now);
    expect(throttle.attempt("app")).toBe(true);
    now = 29_999;
    expect(throttle.attempt("app")).toBe(false);
    now = 30_000;
    expect(throttle.attempt("new app")).toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
