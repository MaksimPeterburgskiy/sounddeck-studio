import { beforeEach, describe, expect, it, vi } from "vitest";
import hotkeysModule from "./hotkeys.cjs";

const { createHotkeyEngine } = hotkeysModule;

// Fake UiohookKey map: every name buildKeycodeMap looks up, with distinct codes.
const keyNames = [];
for (let i = 0; i < 26; i += 1) keyNames.push(String.fromCharCode(65 + i));
for (let digit = 0; digit <= 9; digit += 1) keyNames.push(String(digit), `Numpad${digit}`);
for (let n = 1; n <= 24; n += 1) keyNames.push(`F${n}`);
keyNames.push(
  "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal",
  "Ctrl", "CtrlRight", "Alt", "AltRight", "Shift", "ShiftRight", "Meta", "MetaRight",
  "Space", "Enter", "Tab", "Backspace", "Delete", "Insert", "Home", "End",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Comma", "Period", "Slash", "Semicolon", "Quote", "BracketLeft", "BracketRight",
  "Backslash", "Minus", "Equal", "Backquote",
  "NumpadArrowUp", "NumpadArrowDown", "NumpadArrowLeft", "NumpadArrowRight",
  "NumpadHome", "NumpadEnd", "NumpadPageUp", "NumpadPageDown", "NumpadInsert",
  "NumpadDelete", "NumpadEnter"
);
const UiohookKey = {};
keyNames.forEach((name, index) => {
  UiohookKey[name] = index + 1;
});
const VC_KP_CLEAR = 0xee4c;

function makeFakeHook() {
  const handlers = { keydown: [], keyup: [] };
  return {
    handlers,
    on(event, callback) {
      handlers[event].push(callback);
    },
    emit(event, payload) {
      for (const callback of [...handlers[event]]) callback(payload);
    },
    start: vi.fn(),
    stop: vi.fn()
  };
}

function makeFakeShortcuts() {
  const registered = new Map();
  return {
    registered,
    failNext: false,
    register(accelerator, callback) {
      if (this.failNext) {
        this.failNext = false;
        return false;
      }
      registered.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      registered.delete(accelerator);
    }
  };
}

let hook;
let shortcuts;

function makeEngine(overrides = {}) {
  const onTrigger = vi.fn();
  const engine = createHotkeyEngine({
    onTrigger,
    hook,
    keys: UiohookKey,
    shortcuts,
    engineLoadError: "",
    platform: "win32",
    ...overrides
  });
  return { engine, onTrigger };
}

function press(name) {
  hook.emit("keydown", { keycode: typeof name === "number" ? name : UiohookKey[name] });
}

function release(name) {
  hook.emit("keyup", { keycode: typeof name === "number" ? name : UiohookKey[name] });
}

beforeEach(() => {
  hook = makeFakeHook();
  shortcuts = makeFakeShortcuts();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("hotkey engine registration", () => {
  it("accepts valid combos and rejects unknown tokens", () => {
    const { engine } = makeEngine();
    const results = engine.register([
      { id: "a", accelerator: "Ctrl+A" },
      { id: "b", accelerator: "Ctrl+Bogus" },
      { id: "c", accelerator: "" }
    ]);

    expect(results.map((result) => [result.ok, result.reason])).toEqual([
      [true, ""],
      [false, "invalid-accelerator"],
      [false, "invalid-accelerator"]
    ]);
    expect(hook.start).toHaveBeenCalledTimes(1);
  });

  it("treats the same combo in a different token order as a duplicate", () => {
    const { engine } = makeEngine();
    const results = engine.register([
      { id: "a", accelerator: "Ctrl+A" },
      { id: "b", accelerator: "A+Ctrl" }
    ]);

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].reason).toBe("duplicate");
  });

  it("replaces prior bindings on re-register", () => {
    const { engine, onTrigger } = makeEngine();
    engine.register([{ id: "a", accelerator: "A" }]);
    engine.register([{ id: "b", accelerator: "B" }]);

    press("A");
    release("A");
    expect(onTrigger).not.toHaveBeenCalled();

    press("B");
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger.mock.calls[0][0].id).toBe("b");
  });

  it("does not start the hook until a binding exists and stops it on stop()", () => {
    const { engine } = makeEngine();
    engine.register([{ id: "a", accelerator: "Ctrl+Bogus" }]);
    expect(hook.start).not.toHaveBeenCalled();

    engine.register([{ id: "a", accelerator: "A" }]);
    expect(hook.start).toHaveBeenCalledTimes(1);
    expect(engine.getStatus()).toMatchObject({ advancedHookAvailable: true, started: true, lastFailureReason: "" });

    engine.stop();
    expect(hook.stop).toHaveBeenCalledTimes(1);
    expect(engine.getStatus().started).toBe(false);
  });
});

describe("hotkey engine matching", () => {
  it("fires an exact combo once per press, not on key repeat", () => {
    const { engine, onTrigger } = makeEngine();
    engine.register([{ id: "combo", accelerator: "Ctrl+A" }]);

    press("Ctrl");
    press("A");
    press("A"); // held-key repeat
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger.mock.calls[0][0].id).toBe("combo");

    release("A");
    press("A");
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("does not fire when an extra key is held", () => {
    const { engine, onTrigger } = makeEngine();
    engine.register([{ id: "combo", accelerator: "Ctrl+A" }]);

    press("Ctrl");
    press("B");
    press("A");
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("matches left and right modifier variants of the same token", () => {
    const { engine, onTrigger } = makeEngine();
    engine.register([{ id: "combo", accelerator: "Ctrl+A" }]);

    press("CtrlRight");
    press("A");
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("supports combos of multiple non-modifier keys", () => {
    const { engine, onTrigger } = makeEngine();
    engine.register([{ id: "chord", accelerator: "Num1+Num2" }]);

    press("Numpad1");
    press("Numpad2");
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it("defers a prefix match until keyup so the longer combo can win", () => {
    const { engine, onTrigger } = makeEngine();
    engine.register([
      { id: "short", accelerator: "Num1" },
      { id: "long", accelerator: "Num1+Num2" }
    ]);

    // Tap Num1 alone: deferred on keydown, fires on keyup.
    press("Numpad1");
    expect(onTrigger).not.toHaveBeenCalled();
    release("Numpad1");
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger.mock.calls[0][0].id).toBe("short");

    // Complete the longer combo: only the long binding fires.
    press("Numpad1");
    press("Numpad2");
    release("Numpad1");
    release("Numpad2");
    expect(onTrigger).toHaveBeenCalledTimes(2);
    expect(onTrigger.mock.calls[1][0].id).toBe("long");
  });

  it("maps NumLock-off navigation codes back to numpad keys", () => {
    const { engine, onTrigger } = makeEngine();
    engine.register([
      { id: "one", accelerator: "Num1" },
      { id: "five", accelerator: "Num5" }
    ]);

    press("NumpadEnd"); // Num1 with NumLock off
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger.mock.calls[0][0].id).toBe("one");
    release("NumpadEnd");

    press(VC_KP_CLEAR); // Num5 with NumLock off
    expect(onTrigger).toHaveBeenCalledTimes(2);
    expect(onTrigger.mock.calls[1][0].id).toBe("five");
  });

  it("blocks triggers and clears pending deferrals while suspended", () => {
    const { engine, onTrigger } = makeEngine();
    engine.register([
      { id: "short", accelerator: "Num1" },
      { id: "long", accelerator: "Num1+Num2" }
    ]);

    press("Numpad1"); // deferred
    engine.setSuspended(true);
    release("Numpad1");
    expect(onTrigger).not.toHaveBeenCalled();

    press("A");
    release("A");
    expect(onTrigger).not.toHaveBeenCalled();

    engine.setSuspended(false);
    press("Numpad1");
    release("Numpad1");
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});

describe("hotkey engine globalShortcut fallback after hook start failure", () => {
  beforeEach(() => {
    hook.start.mockImplementation(() => {
      throw new Error("permission denied");
    });
  });

  it("falls back for single-key combos and reports the platform reason for chords", () => {
    const { engine, onTrigger } = makeEngine();

    const results = engine.register([
      { id: "single", accelerator: "Ctrl+A" },
      { id: "chord", accelerator: "Num1+Num2" }
    ]);

    expect(results[0]).toMatchObject({ id: "single", ok: true });
    expect(results[1]).toMatchObject({ id: "chord", ok: false, reason: "hotkey-engine-start-failed" });
    expect(shortcuts.registered.has("Control+A")).toBe(true);
    expect(engine.getStatus()).toMatchObject({ started: false, lastFailureReason: "hotkey-engine-start-failed" });

    // The fallback trigger respects suspension.
    engine.setSuspended(true);
    shortcuts.registered.get("Control+A")();
    expect(onTrigger).not.toHaveBeenCalled();
    engine.setSuspended(false);
    shortcuts.registered.get("Control+A")();
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger.mock.calls[0][0].id).toBe("single");
  });

  it("attributes chord failures to missing input-monitoring permission on macOS", () => {
    const { engine } = makeEngine({ platform: "darwin" });

    const results = engine.register([{ id: "chord", accelerator: "Num1+Num2" }]);

    expect(results[0].reason).toBe("macos-input-monitoring-permission");
    expect(engine.getStatus().lastFailureReason).toBe("macos-input-monitoring-permission");
  });

  it("maps canonical tokens to Electron accelerators per platform", () => {
    const { engine } = makeEngine();
    engine.register([
      { id: "meta", accelerator: "Meta+B" },
      { id: "numadd", accelerator: "Ctrl+NumAdd" },
      { id: "numdigit", accelerator: "Ctrl+Num3" }
    ]);
    expect([...shortcuts.registered.keys()].sort()).toEqual(["Control+num3", "Control+numadd", "Super+B"]);

    shortcuts.registered.clear();
    const { engine: macEngine } = makeEngine({ platform: "darwin" });
    macEngine.register([{ id: "meta", accelerator: "Meta+B" }]);
    expect([...shortcuts.registered.keys()]).toEqual(["Command+B"]);
  });

  it("reports registration failures from globalShortcut", () => {
    const { engine } = makeEngine();

    shortcuts.failNext = true;
    const results = engine.register([{ id: "single", accelerator: "Ctrl+A" }]);

    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toBe("global-shortcut-registration-failed");
  });

  it("reports the start failure when globalShortcut is unavailable too", () => {
    const { engine } = makeEngine({ shortcuts: null });

    const results = engine.register([{ id: "single", accelerator: "Ctrl+A" }]);

    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toBe("global-shortcut-unavailable");
    expect(engine.getStatus().globalShortcutFallbackAvailable).toBe(false);
  });

  it("recovers on the advanced hook once start succeeds again", () => {
    const { engine, onTrigger } = makeEngine();

    engine.register([{ id: "single", accelerator: "A" }]);
    expect(engine.getStatus().started).toBe(false);
    expect(shortcuts.registered.size).toBe(1);

    hook.start.mockImplementation(() => undefined);
    const results = engine.register([{ id: "single", accelerator: "A" }]);
    expect(results[0].ok).toBe(true);
    expect(engine.getStatus()).toMatchObject({ started: true, lastFailureReason: "" });
    // The stale fallback registration is gone; the hook handles the key now.
    expect(shortcuts.registered.size).toBe(0);
    press("A");
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});

describe("hotkey engine when the native hook failed to load", () => {
  it("registers through globalShortcut and reports engine unavailability", () => {
    const { engine, onTrigger } = makeEngine({ hook: null, engineLoadError: "no native module" });

    const results = engine.register([
      { id: "single", accelerator: "Ctrl+A" },
      { id: "dup", accelerator: "Ctrl+A" },
      { id: "chord", accelerator: "Num1+Num2" },
      { id: "empty", accelerator: "" }
    ]);

    expect(results.map((result) => [result.ok, result.reason])).toEqual([
      [true, ""],
      [false, "duplicate"],
      [false, "advanced-hook-required-on-this-platform"],
      [false, "invalid-accelerator"]
    ]);
    expect(engine.getStatus()).toMatchObject({
      advancedHookAvailable: false,
      globalShortcutFallbackAvailable: true,
      started: false,
      lastFailureReason: "hotkey-engine-unavailable"
    });

    shortcuts.registered.get("Control+A")();
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger.mock.calls[0][0].id).toBe("single");
  });

  it("reports a clean status when the hook is absent without a load error", () => {
    const { engine } = makeEngine({ hook: null, engineLoadError: "" });
    expect(engine.getStatus().lastFailureReason).toBe("");
  });
});
