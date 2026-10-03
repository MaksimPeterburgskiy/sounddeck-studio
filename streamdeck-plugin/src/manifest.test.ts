import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../com.sounddeck.studio.sdPlugin/manifest.json", import.meta.url), "utf8"));

describe("layout action availability", () => {
  it.each(["board-slot", "page-next", "page-previous"])("excludes %s from multi-actions", (id) => {
    const action = manifest.Actions.find((item: { UUID: string }) => item.UUID === `com.sounddeck.studio.${id}`);
    expect(action).toBeDefined();
    expect(action.SupportedInMultiActions).toBe(false);
  });
});
