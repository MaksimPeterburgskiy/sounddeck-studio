import { describe, expect, it } from "vitest";
import { toStreamDeckVersion } from "./streamdeckVersion.cjs";

describe("Stream Deck version mapping", () => {
  it.each([["1.2.3", "1.2.3.99999"], ["1.2.3-beta.0", "1.2.3.0"], ["1.2.3-beta.28", "1.2.3.28"]])("maps %s", (input, output) => {
    expect(toStreamDeckVersion(input)).toBe(output);
  });
  it.each(["1.2", "1.2.3-rc.1", "1.2.3-beta.-1", "1.2.3-beta.99999", "01.2.3"])("rejects %s", (input) => {
    expect(() => toStreamDeckVersion(input)).toThrow(/Unsupported/);
  });
});
