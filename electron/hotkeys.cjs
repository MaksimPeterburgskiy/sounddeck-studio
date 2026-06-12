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
try {
  ({ uIOhook, UiohookKey } = require("uiohook-napi"));
} catch (error) {
  console.error("uiohook-napi unavailable, global hotkeys disabled:", error);
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
  if (!uIOhook) {
    return {
      register: (bindings) => bindings.map((binding) => ({ ...binding, ok: false, reason: "hotkey-engine-unavailable" })),
      setSuspended: () => {},
      stop: () => {}
    };
  }

  const keycodeToToken = buildKeycodeMap();
  const validTokens = new Set(keycodeToToken.values());
  let bindings = new Map(); // signature -> binding
  let pressed = new Map(); // keycode -> token
  let started = false;
  let suspended = false;

  const signatureOf = (tokens) => [...new Set(tokens)].sort().join("+");

  uIOhook.on("keydown", (event) => {
    const token = keycodeToToken.get(event.keycode);
    if (!token) return;
    if (pressed.has(event.keycode)) return; // key repeat while held
    pressed.set(event.keycode, token);
    if (suspended || !bindings.size) return;
    const binding = bindings.get(signatureOf([...pressed.values()]));
    if (binding) onTrigger(binding);
  });

  uIOhook.on("keyup", (event) => {
    pressed.delete(event.keycode);
  });

  function ensureStarted() {
    if (started) return;
    try {
      uIOhook.start();
      started = true;
    } catch (error) {
      console.error("Failed to start keyboard hook:", error);
    }
  }

  return {
    register(list) {
      bindings = new Map();
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
        bindings.set(signature, binding);
        results.push({ ...binding, ok: true, reason: "" });
      }
      if (bindings.size) ensureStarted();
      return results;
    },
    // Pause triggering while the renderer is capturing a new bind so existing
    // hotkeys don't fire mid-capture.
    setSuspended(value) {
      suspended = Boolean(value);
    },
    stop() {
      if (!started) return;
      started = false;
      try {
        uIOhook.stop();
      } catch (error) {
        console.error("Failed to stop keyboard hook:", error);
      }
    }
  };
}

module.exports = { createHotkeyEngine };
