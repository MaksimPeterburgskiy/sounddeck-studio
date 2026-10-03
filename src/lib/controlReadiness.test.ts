import { describe, expect, it, vi } from "vitest";
import { waitForAudioConfiguration } from "./controlReadiness";
import { deferred } from "./testing/webAudioFakes";

describe("external control audio readiness", () => {
  it("waits for newer settings when the initial configuration is superseded", async () => {
    const initial = deferred<void>();
    const latest = deferred<void>();
    let configuration = initial.promise;
    const ready = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration).then(ready);
    configuration = latest.promise;
    initial.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    latest.resolve();
    await pending;
    expect(ready).toHaveBeenCalledOnce();
  });

  it("does not report readiness if configuration rejects", async () => {
    const configuration = deferred<void>();
    const ready = vi.fn();
    const pending = waitForAudioConfiguration(() => configuration.promise).then(ready);
    configuration.reject(new Error("Configuration failed"));
    await expect(pending).rejects.toThrow("Configuration failed");
    expect(ready).not.toHaveBeenCalled();
  });
});
