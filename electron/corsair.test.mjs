import { describe, expect, it, vi } from "vitest";
import corsairModule from "./corsair.cjs";

const { createCorsairBridge } = corsairModule;

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

  it("reports disconnects and re-subscribes on reconnect", () => {
    const sdk = fakeSdk();
    const onStateChange = vi.fn();
    const bridge = createCorsairBridge({ sdk, platform: "darwin", onStateChange });
    bridge.start();
    sdk.session(sdk.CorsairSessionState.CSS_Connected);
    sdk.session(0);
    expect(bridge.isConnected()).toBe(false);
    expect(onStateChange).toHaveBeenLastCalledWith("disconnected");
    sdk.session(sdk.CorsairSessionState.CSS_Connected);
    expect(sdk.CorsairSubscribeForEvents).toHaveBeenCalledTimes(2);
    bridge.stop();
    expect(sdk.CorsairUnsubscribeFromEvents).toHaveBeenCalledTimes(1);
    expect(sdk.CorsairDisconnect).toHaveBeenCalledTimes(1);
  });
});
