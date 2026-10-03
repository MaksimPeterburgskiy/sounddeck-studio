import { describe, expect, it, vi } from "vitest";
import corsairModule from "./corsair.cjs";
import hotkeysModule from "./hotkeys.cjs";

const { createCorsairBridge, createCorsairPressTracker } = corsairModule;
const { isSameHotkeyTarget } = hotkeysModule;

function fakeSdk() {
  let onSession;
  let onEvent;
  const sdk = {
    CorsairEventId: { CEI_KeyEvent: 2 },
    CorsairError: { CE_Success: 0 },
    CorsairSessionState: { CSS_Connected: 6, CSS_Connecting: 1 },
    CorsairConnect: vi.fn((callback) => {
      onSession = callback;
      return { error: 0 };
    }),
    CorsairSubscribeForEvents: vi.fn((callback) => {
      onEvent = callback;
      return { error: 0 };
    }),
    CorsairUnsubscribeFromEvents: vi.fn(),
    CorsairDisconnect: vi.fn(),
    session: (state) => onSession({ data: { state } }),
    key: (keyId, isPressed, id = 2) => onEvent({ data: { id, keyId, isPressed } })
  };
  return sdk;
}

describe("Corsair key events", () => {
  it("forwards G-key presses and releases while ignoring other keys and events", () => {
    const sdk = fakeSdk();
    const onKey = vi.fn();
    const bridge = createCorsairBridge({ sdk, platform: "win32", onKey });
    bridge.start();
    sdk.session(sdk.CorsairSessionState.CSS_Connected);

    sdk.key(1, true);
    sdk.key(1, false);
    sdk.key(20, true);
    sdk.key(20, false);
    sdk.key(0, true);
    sdk.key(21, false);
    sdk.key(1, true, 3);
    expect(onKey.mock.calls).toEqual([["G1", true], ["G1", false], ["G20", true], ["G20", false]]);
  });
});

function makeTracker() {
  const onTrigger = vi.fn();
  const onRelease = vi.fn();
  const tracker = createCorsairPressTracker({ onTrigger, onRelease, isSameTarget: isSameHotkeyTarget });
  const first = { type: "sound", boardId: "board-a", soundId: "sound-a", accelerator: "G1" };
  const second = { ...first, soundId: "sound-b", accelerator: "G2" };
  tracker.register(new Map([["G1", first], ["G2", second]]));
  return { tracker, onTrigger, onRelease, first, second };
}

describe("Corsair held presses", () => {
  it("pairs each press and release, ignores repeats and clears the key for the next press", () => {
    const { tracker, onTrigger, onRelease, first, second } = makeTracker();
    tracker.onKey("G1", false);
    tracker.onKey("G3", true);
    tracker.onKey("G1", true);
    tracker.onKey("G1", true);
    tracker.onKey("G2", true);
    expect(onTrigger.mock.calls).toEqual([[first, expect.any(Object)], [second, expect.any(Object)]]);
    const firstToken = onTrigger.mock.calls[0][1];
    const secondToken = onTrigger.mock.calls[1][1];
    expect(firstToken).not.toBe(secondToken);

    tracker.onKey("G1", false);
    tracker.onKey("G1", false);
    expect(onRelease.mock.calls).toEqual([[first, firstToken]]);
    tracker.onKey("G1", true);
    expect(onTrigger).toHaveBeenCalledTimes(3);
    expect(onTrigger.mock.lastCall[1]).not.toBe(firstToken);
    tracker.onKey("G2", false);
    expect(onRelease).toHaveBeenLastCalledWith(second, secondToken);
  });

  it("keeps a press on the same target across re-registration and releases changed or removed bindings", () => {
    const { tracker, onTrigger, onRelease, first, second } = makeTracker();
    tracker.onKey("G1", true);
    tracker.onKey("G2", true);
    const firstToken = onTrigger.mock.calls[0][1];
    const secondToken = onTrigger.mock.calls[1][1];
    const sameTarget = { ...first, title: "Renamed sound" };
    const changedTarget = { ...second, soundId: "sound-c" };
    tracker.register(new Map([["G1", sameTarget], ["G2", changedTarget]]));
    expect(onRelease.mock.calls).toEqual([[second, secondToken]]);
    tracker.onKey("G1", true);
    expect(onTrigger).toHaveBeenCalledTimes(2);
    tracker.onKey("G1", false);
    expect(onRelease).toHaveBeenLastCalledWith(first, firstToken);
    tracker.onKey("G1", true);
    expect(onTrigger).toHaveBeenLastCalledWith(sameTarget, expect.any(Object));
    tracker.register(new Map());
    expect(onRelease).toHaveBeenCalledTimes(3);
    tracker.onKey("G1", true);
    expect(onTrigger).toHaveBeenCalledTimes(3);
  });

  it.each(["disconnect", "capture", "shutdown"])("releases open presses on %s", (reason) => {
    const { tracker, onTrigger, onRelease, first, second } = makeTracker();
    tracker.onKey("G1", true);
    tracker.onKey("G2", true);
    tracker.onStateChange("connected");
    expect(onRelease).not.toHaveBeenCalled();
    if (reason === "disconnect") tracker.onStateChange("disconnected");
    else if (reason === "capture") tracker.setSuspended(true);
    else tracker.releaseAll();
    expect(onRelease.mock.calls).toEqual([[first, onTrigger.mock.calls[0][1]], [second, onTrigger.mock.calls[1][1]]]);
    tracker.onKey("G1", false);
    tracker.onKey("G2", false);
    expect(onRelease).toHaveBeenCalledTimes(2);

    if (reason === "capture") {
      tracker.onKey("G1", true);
      expect(onTrigger).toHaveBeenCalledTimes(2);
      tracker.setSuspended(false);
    }
    tracker.onKey("G1", true);
    expect(onTrigger).toHaveBeenCalledTimes(3);
  });
});
