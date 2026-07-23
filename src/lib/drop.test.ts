import { describe, expect, it, vi } from "vitest";
import { cancelTopLevelDrag } from "./drop";

describe("cancelTopLevelDrag", () => {
  it("cancels URL drops before rejecting the non-file payload", () => {
    const preventDefault = vi.fn();

    expect(cancelTopLevelDrag({
      preventDefault,
      dataTransfer: { types: ["text/uri-list", "text/plain"] }
    })).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("cancels and accepts file payloads", () => {
    const preventDefault = vi.fn();

    expect(cancelTopLevelDrag({
      preventDefault,
      dataTransfer: { types: ["Files"] }
    })).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("still cancels when dataTransfer is unavailable", () => {
    const preventDefault = vi.fn();

    expect(cancelTopLevelDrag({ preventDefault })).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
