import { describe, expect, it } from "vitest";
import { claimCaptureSlot, eventToToken, formatAccelerator, normalizeAccelerator, orderTokens } from "./hotkeys";

describe("eventToToken", () => {
  const tokenFor = (code: string) => eventToToken({ code } as KeyboardEvent);

  it("maps physical keyboard codes to canonical tokens", () => {
    expect(tokenFor("KeyA")).toBe("A");
    expect(tokenFor("Digit7")).toBe("7");
    expect(tokenFor("Numpad7")).toBe("Num7");
    expect(tokenFor("F1")).toBe("F1");
    expect(tokenFor("F24")).toBe("F24");
    expect(tokenFor("F25")).toBe("");
    expect(tokenFor("ControlLeft")).toBe("Ctrl");
    expect(tokenFor("ControlRight")).toBe("Ctrl");
    expect(tokenFor("MetaRight")).toBe("Meta");
    expect(tokenFor("Space")).toBe("Space");
    expect(tokenFor("NumpadEnter")).toBe("Enter");
    expect(tokenFor("Comma")).toBe(",");
    expect(tokenFor("Backquote")).toBe("`");
    expect(tokenFor("Fn")).toBe("");
    expect(tokenFor("")).toBe("");
  });
});

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

  it("normalizes empty, whitespace, duplicate, lowercase, and legacy plus tokens", () => {
    expect(normalizeAccelerator("")).toBe("");
    expect(normalizeAccelerator("  Ctrl + A  ")).toBe("Ctrl+A");
    expect(normalizeAccelerator("Ctrl+Ctrl+A")).toBe("Ctrl+A");
    expect(normalizeAccelerator("a")).toBe("A");
    expect(normalizeAccelerator("Ctrl+plus")).toBe("Ctrl+=");
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

describe("claimCaptureSlot", () => {
  it("releases the slot when the current owner calls its release function", () => {
    const release = claimCaptureSlot(() => {});

    expect(release()).toBe(true);
    expect(release()).toBe(false);
  });

  it("cancels the previous owner and keeps newer claims active", () => {
    let firstCancelCount = 0;
    let secondCancelCount = 0;
    const releaseFirst = claimCaptureSlot(() => {
      firstCancelCount += 1;
    });
    const releaseSecond = claimCaptureSlot(() => {
      secondCancelCount += 1;
    });

    expect(firstCancelCount).toBe(1);
    expect(secondCancelCount).toBe(0);
    expect(releaseFirst()).toBe(false);
    expect(releaseSecond()).toBe(true);
  });
});
