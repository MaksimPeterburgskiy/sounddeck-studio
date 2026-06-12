import { describe, expect, it } from "vitest";
import { formatAccelerator, normalizeAccelerator, orderTokens } from "./hotkeys";

describe("accelerator normalization", () => {
  it("maps legacy Electron tokens to canonical ones", () => {
    expect(normalizeAccelerator("CommandOrControl+Alt+Space")).toBe("Ctrl+Alt+Space");
    expect(normalizeAccelerator("num3")).toBe("Num3");
    expect(normalizeAccelerator("Shift+numadd")).toBe("Shift+NumAdd");
    expect(normalizeAccelerator("CommandOrControl+Shift+P")).toBe("Ctrl+Shift+P");
  });

  it("keeps canonical and multi-key combos intact", () => {
    expect(normalizeAccelerator("Ctrl+Num1")).toBe("Ctrl+Num1");
    expect(normalizeAccelerator("Num1+Num2")).toBe("Num1+Num2");
    expect(normalizeAccelerator("A+S+D")).toBe("A+S+D");
  });

  it("orders modifiers first", () => {
    expect(normalizeAccelerator("A+Shift+Ctrl")).toBe("Ctrl+Shift+A");
    expect(orderTokens(["Num2", "Shift", "Num1"])).toEqual(["Shift", "Num2", "Num1"]);
  });

  it("passes Corsair G-keys through untouched", () => {
    expect(normalizeAccelerator("G5")).toBe("G5");
    expect(normalizeAccelerator("g12")).toBe("G12");
  });

  it("formats numpad tokens for display", () => {
    expect(formatAccelerator("Ctrl+NumAdd")).toBe("Ctrl+Num+");
    expect(formatAccelerator("num1")).toBe("Num1");
  });
});
