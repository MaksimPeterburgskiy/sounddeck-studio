// Global hotkey engine built on a low-level keyboard hook (uiohook-napi)
// instead of Electron's globalShortcut. This supports arbitrary key
// combinations (several non-modifier keys at once, e.g. "Num1+Num2") and is
// not affected by NumLock state or shortcut registration conflicts.
//
// Token names mirror src/lib/hotkeys.ts: Ctrl, Alt, Shift, Meta, A-Z, 0-9,
// F1-F24, Num0-Num9, NumAdd/NumSub/NumMult/NumDiv/NumDec, Space, Enter, Tab,
// Backspace, Delete, Insert, Home, End, PageUp, PageDown, Up, Down, Left,
// Right and punctuation characters.

let uIOhook = null;
let UiohookKey = null;
let loadError = "";
let globalShortcut = null;
try {
  ({ uIOhook, UiohookKey } = require("uiohook-napi"));
} catch (error) {
  loadError = error?.message || String(error);
  console.error("uiohook-napi unavailable, global hotkeys disabled:", error);
}
try {
  ({ globalShortcut } = require("electron"));
} catch {
  globalShortcut = null;
}

function macOSPermissionReason() {
  return process.platform === "darwin" ? "macos-input-monitoring-permission" : "hotkey-engine-start-failed";
}

function electronAcceleratorFromTokens(tokens) {
  const modifiers = [];
  const keys = [];
  for (const token of [...new Set(tokens)]) {
    if (token === "Ctrl") modifiers.push("CommandOrControl");
    else if (token === "Alt") modifiers.push("Alt");
    else if (token === "Shift") modifiers.push("Shift");
    else if (token === "Meta") modifiers.push(process.platform === "darwin" ? "Command" : "Super");
    else keys.push(token);
  }
  if (keys.length !== 1) return "";
  const key = keys[0];
  const mappedKey = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Up: "Up",
    Down: "Down",
    Left: "Left",
    Right: "Right",
    NumAdd: "numadd",
    NumSub: "numsub",
    NumMult: "nummult",
    NumDiv: "numdiv",
    NumDec: "numdec"
  }[key] || (/^Num[0-9]$/.test(key) ? `num${key.slice(3)}` : key);
  return [...modifiers, mappedKey].join("+");
}

function createGlobalShortcutFallback(onTrigger) {
  let registered = [];

  function unregisterAll() {
    if (!globalShortcut) return;
    for (const accelerator of registered) globalShortcut.unregister(accelerator);
    registered = [];
  }

  function register(validResults) {
    unregisterAll();
    if (!globalShortcut) {
      return validResults.map((result) => ({ ...result, ok: false, reason: "global-shortcut-unavailable" }));
    }
    const accelerators = new Set();
    return validResults.map((result) => {
      const tokens = String(result.accelerator || "").split("+").map((token) => token.trim()).filter(Boolean);
      const accelerator = electronAcceleratorFromTokens(tokens);
      if (!accelerator) return { ...result, ok: false, reason: "advanced-hook-required-on-this-platform" };
      if (accelerators.has(accelerator)) return { ...result, ok: false, reason: "duplicate" };
      accelerators.add(accelerator);
      const ok = globalShortcut.register(accelerator, () => onTrigger(result));
      if (!ok) return { ...result, ok: false, reason: "global-shortcut-registration-failed" };
      registered.push(accelerator);
      return { ...result, ok: true, reason: "" };
    });
  }

  return {
    register,
    unregisterAll,
    isAvailable: () => Boolean(globalShortcut)
  };
}

function buildKeycodeMap() {
  const map = new Map();
  const assign = (name, token) => {
    const code = UiohookKey[name];
    if (code !== undefined) map.set(code, token);
  };
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);
    assign(letter, letter);
  }
  for (let digit = 0; digit <= 9; digit++) {
    assign(String(digit), String(digit));
    assign(`Numpad${digit}`, `Num${digit}`);
  }
  for (let n = 1; n <= 24; n++) assign(`F${n}`, `F${n}`);
  assign("NumpadAdd", "NumAdd");
  assign("NumpadSubtract", "NumSub");
  assign("NumpadMultiply", "NumMult");
  assign("NumpadDivide", "NumDiv");
  assign("NumpadDecimal", "NumDec");
  assign("Ctrl", "Ctrl");
  assign("CtrlRight", "Ctrl");
  assign("Alt", "Alt");
  assign("AltRight", "Alt");
  assign("Shift", "Shift");
  assign("ShiftRight", "Shift");
  assign("Meta", "Meta");
  assign("MetaRight", "Meta");
  assign("Space", "Space");
  assign("Enter", "Enter");
  assign("Tab", "Tab");
  assign("Backspace", "Backspace");
  assign("Delete", "Delete");
  assign("Insert", "Insert");
  assign("Home", "Home");
  assign("End", "End");
  assign("PageUp", "PageUp");
  assign("PageDown", "PageDown");
  assign("ArrowUp", "Up");
  assign("ArrowDown", "Down");
  assign("ArrowLeft", "Left");
  assign("ArrowRight", "Right");
  assign("Comma", ",");
  assign("Period", ".");
  assign("Slash", "/");
  assign("Semicolon", ";");
  assign("Quote", "'");
  assign("BracketLeft", "[");
  assign("BracketRight", "]");
  assign("Backslash", "\\");
  assign("Minus", "-");
  assign("Equal", "=");
  assign("Backquote", "`");
  // With NumLock off, the hook reports numpad keys as separate
  // navigation-style codes. Map those back to the physical key so numpad
  // bindings work in either NumLock state.
  assign("NumpadArrowUp", "Num8");
  assign("NumpadArrowDown", "Num2");
  assign("NumpadArrowLeft", "Num4");
  assign("NumpadArrowRight", "Num6");
  assign("NumpadHome", "Num7");
  assign("NumpadEnd", "Num1");
  assign("NumpadPageUp", "Num9");
  assign("NumpadPageDown", "Num3");
  assign("NumpadInsert", "Num0");
  assign("NumpadDelete", "NumDec");
  map.set(0xee4c, "Num5"); // VC_KP_CLEAR: numpad 5 with NumLock off
  assign("NumpadEnter", "Enter");
  return map;
}

function createHotkeyEngine({ onTrigger }) {
  const fallback = createGlobalShortcutFallback(onTrigger);

  if (!uIOhook) {
    return {
      register: (bindings) => {
        const seen = new Set();
        const results = bindings.map((binding) => {
          const accelerator = String(binding.accelerator || "").trim();
          if (!accelerator) return { ...binding, ok: false, reason: "invalid-accelerator" };
          if (seen.has(accelerator)) return { ...binding, ok: false, reason: "duplicate" };
          seen.add(accelerator);
          return { ...binding, ok: true, reason: "" };
        });
        const valid = results.filter((result) => result.ok);
        const fallbackResults = fallback.register(valid);
        const byAccelerator = new Map(fallbackResults.map((result) => [result.accelerator, result]));
        return results.map((result) => result.ok ? byAccelerator.get(result.accelerator) || result : result);
      },
      setSuspended: () => {},
      stop: () => fallback.unregisterAll(),
      getStatus: () => ({
        advancedHookAvailable: false,
        globalShortcutFallbackAvailable: fallback.isAvailable(),
        started: false,
        lastFailureReason: loadError ? "hotkey-engine-unavailable" : ""
      })
    };
  }

  const keycodeToToken = buildKeycodeMap();
  const validTokens = new Set(keycodeToToken.values());
  let bindings = new Map(); // signature -> { binding, tokens, hasSuperset }
  let pressed = new Map(); // keycode -> token
  let pending = null; // matched binding deferred because a longer combo may still complete
  let started = false;
  let suspended = false;
  let lastFailureReason = "";

  const signatureOf = (tokens) => [...new Set(tokens)].sort().join("+");

  uIOhook.on("keydown", (event) => {
    const token = keycodeToToken.get(event.keycode);
    if (!token) return;
    if (pressed.has(event.keycode)) return; // key repeat while held
    pressed.set(event.keycode, token);
    if (suspended || !bindings.size) return;
    const entry = bindings.get(signatureOf([...pressed.values()]));
    if (!entry) return;
    // If this match is a strict prefix of a longer binding (e.g. "Num1" with
    // "Num1+Num2" also bound), hold it until the next keyup so the longer
    // combo gets a chance to complete and win.
    if (entry.hasSuperset) {
      pending = entry.binding;
      return;
    }
    pending = null;
    onTrigger(entry.binding);
  });

  uIOhook.on("keyup", (event) => {
    if (!pressed.delete(event.keycode)) return;
    if (pending && !suspended) {
      const binding = pending;
      pending = null;
      onTrigger(binding);
    }
  });

  function ensureStarted() {
    if (started) return true;
    try {
      uIOhook.start();
      started = true;
      lastFailureReason = "";
      return true;
    } catch (error) {
      console.error("Failed to start keyboard hook:", error);
      lastFailureReason = macOSPermissionReason();
      return false;
    }
  }

  return {
    register(list) {
      fallback.unregisterAll();
      bindings = new Map();
      pending = null;
      const results = [];
      for (const binding of list) {
        const tokens = String(binding.accelerator || "").split("+").map((token) => token.trim()).filter(Boolean);
        if (!tokens.length || tokens.some((token) => !validTokens.has(token))) {
          results.push({ ...binding, ok: false, reason: "invalid-accelerator" });
          continue;
        }
        const signature = signatureOf(tokens);
        if (bindings.has(signature)) {
          results.push({ ...binding, ok: false, reason: "duplicate" });
          continue;
        }
        bindings.set(signature, { binding, tokens: [...new Set(tokens)], hasSuperset: false });
        results.push({ ...binding, ok: true, reason: "" });
      }
      const entries = [...bindings.values()];
      for (const entry of entries) {
        entry.hasSuperset = entries.some(
          (other) => other.tokens.length > entry.tokens.length && entry.tokens.every((token) => other.tokens.includes(token))
        );
      }
      if (bindings.size && !ensureStarted()) {
        const fallbackResults = fallback.register(results.filter((result) => result.ok));
        const byAccelerator = new Map(fallbackResults.map((result) => [result.accelerator, result]));
        bindings = new Map();
        return results.map((result) => (result.ok ? byAccelerator.get(result.accelerator) || { ...result, ok: false, reason: lastFailureReason || "hotkey-engine-start-failed" } : result));
      }
      return results;
    },
    // Pause triggering while the renderer is capturing a new bind so existing
    // hotkeys don't fire mid-capture.
    setSuspended(value) {
      suspended = Boolean(value);
      if (suspended) pending = null;
    },
    stop() {
      fallback.unregisterAll();
      if (!started) return;
      started = false;
      try {
        uIOhook.stop();
      } catch (error) {
        console.error("Failed to stop keyboard hook:", error);
      }
    },
    getStatus() {
      return {
        advancedHookAvailable: true,
        globalShortcutFallbackAvailable: fallback.isAvailable(),
        started,
        lastFailureReason
      };
    }
  };
}

module.exports = { createHotkeyEngine };
