import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissPluginUpdate, isPluginUpdateDismissed } from "./streamdeckPrompts";

afterEach(() => vi.unstubAllGlobals());

describe("Stream Deck update prompts", () => {
  it("persists dismissals separately for each bundled version", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
    dismissPluginUpdate("0.1.22.4");
    expect(isPluginUpdateDismissed("0.1.22.4")).toBe(true);
    expect(isPluginUpdateDismissed("0.1.22.99999")).toBe(false);
    dismissPluginUpdate("0.1.22.99999");
    expect(isPluginUpdateDismissed("0.1.22.4")).toBe(true);
    expect(isPluginUpdateDismissed("0.1.22.99999")).toBe(true);
  });

  it("keeps Settings usable when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("Unavailable"); }, setItem: () => { throw new Error("Unavailable"); } });
    expect(isPluginUpdateDismissed("0.1.22.99999")).toBe(false);
    expect(() => dismissPluginUpdate("0.1.22.99999")).not.toThrow();
  });
});
