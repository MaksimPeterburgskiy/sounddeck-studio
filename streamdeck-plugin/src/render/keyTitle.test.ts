import { describe, expect, it } from "vitest";
import { keyTitle } from "./keyTitle";

describe("title fitting", () => {
  it.each([
    ["MMMMM", "MMMMM"], ["MMMMMM", "MMMM…"],
    ["i".repeat(17), "i".repeat(17)], ["i".repeat(18), `${"i".repeat(15)}…`],
    ["😀".repeat(8), "😀".repeat(8)], ["😀".repeat(9), `${"😀".repeat(7)}…`],
    ["Wide \nFine", "Wide\nFine"],
  ])("preserves fitting and ellipsis boundaries for %j", (input, expected) => {
    expect(keyTitle(input)).toBe(expected);
  });
  it("fits very long pasted or imported names, including explicit lines and Unicode", () => {
    expect(keyTitle("M".repeat(100_000))).toBe("MMMM…");
    expect(keyTitle(`${"M".repeat(100_000)}\nFine`)).toBe("MMMM…\nFine");
    expect(keyTitle(`Fine ${"😀".repeat(100_000)}`)).toBe(`Fine\n${"😀".repeat(7)}…`);
  });
});
