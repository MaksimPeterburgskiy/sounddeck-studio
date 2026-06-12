// Corsair iCUE SDK bridge: surfaces keyboard G-key (macro key) presses so they
// can be used as soundboard binds alongside regular global shortcuts.
// Runs in shared mode, so iCUE keeps working normally for everything else.

const GKEY_MIN = 1;
const GKEY_MAX = 20;

function createCorsairBridge({ onKey, onStateChange }) {
  let sdk = null;
  let loadError = "";
  try {
    sdk = require("cue-sdk");
  } catch (error) {
    loadError = error.message;
  }

  let state = sdk ? "idle" : "unavailable";
  let started = false;
  let subscribed = false;

  function setState(next) {
    if (state === next) return;
    state = next;
    onStateChange?.(state);
  }

  function subscribe() {
    if (subscribed) return;
    const { error } = sdk.CorsairSubscribeForEvents((event) => {
      const data = event?.data;
      if (!data || data.id !== sdk.CorsairEventId.CEI_KeyEvent) return;
      if (!data.isPressed) return;
      if (data.keyId >= GKEY_MIN && data.keyId <= GKEY_MAX) onKey?.(`G${data.keyId}`);
    });
    subscribed = error === sdk.CorsairError.CE_Success;
  }

  function start() {
    if (!sdk || started) return;
    started = true;
    const { error } = sdk.CorsairConnect((event) => {
      const sessionState = event?.data?.state;
      if (sessionState === sdk.CorsairSessionState.CSS_Connected) {
        subscribe();
        setState("connected");
      } else if (sessionState === sdk.CorsairSessionState.CSS_Connecting) {
        setState("connecting");
      } else {
        subscribed = false;
        setState("disconnected");
      }
    });
    if (error !== sdk.CorsairError.CE_Success) {
      started = false;
      setState("disconnected");
    }
  }

  function stop() {
    if (!sdk || !started) return;
    try {
      if (subscribed) sdk.CorsairUnsubscribeFromEvents();
      sdk.CorsairDisconnect();
    } catch {
      // best effort: app is quitting
    }
    subscribed = false;
    started = false;
  }

  return {
    start,
    stop,
    getState: () => state,
    isConnected: () => state === "connected",
    loadError: () => loadError
  };
}

const GKEY_ACCELERATOR_PATTERN = /^G([1-9]|1[0-9]|20)$/i;

function isGKeyAccelerator(accelerator) {
  return GKEY_ACCELERATOR_PATTERN.test(String(accelerator || "").trim());
}

module.exports = { createCorsairBridge, isGKeyAccelerator };
