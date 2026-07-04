import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDevBridge } from "../src/lib/devBridge";

const preloadPath = fileURLToPath(new URL("./preload.cjs", import.meta.url));

// The preload script can only run inside Electron (it requires contextBridge),
// so read the exposed API surface out of its source: the two-space-indented
// keys of the object literal passed to exposeInMainWorld.
function preloadExposedKeys() {
  const source = readFileSync(preloadPath, "utf8");
  const keys = [...source.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);
  expect(keys.length).toBeGreaterThan(0);
  return [...keys].sort();
}

describe("dev bridge / preload API contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("implements exactly the API surface the Electron preload exposes", () => {
    vi.stubGlobal("window", {});

    installDevBridge();

    expect(Object.keys(window.sounddeck).sort()).toEqual(preloadExposedKeys());
  });

  it("does not overwrite an existing bridge", () => {
    const real = { marker: true };
    vi.stubGlobal("window", { sounddeck: real });

    installDevBridge();

    expect(window.sounddeck).toBe(real);
  });
});
