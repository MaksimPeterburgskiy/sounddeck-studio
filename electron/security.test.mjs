import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import security from "./security.cjs";

const {
  rendererPolicy,
  isTrustedRendererUrl,
  isTrustedIpcSender,
  installNavigationGuards,
  isAllowedExternalUrl
} = security;

function policies() {
  const builtIndex = path.join(os.tmpdir(), "sounddeck", "dist", "index.html");
  return {
    builtIndex,
    packaged: rendererPolicy({
      isPackaged: true,
      builtIndex,
      devServerUrl: "http://127.0.0.1:5173"
    }),
    development: rendererPolicy({
      isPackaged: false,
      builtIndex,
      devServerUrl: "http://127.0.0.1:5173"
    })
  };
}

describe("renderer URL policy", () => {
  it("allows only the packaged index file in production", () => {
    const { builtIndex, packaged } = policies();
    const expected = pathToFileURL(builtIndex).href;

    expect(isTrustedRendererUrl(expected, packaged)).toBe(true);
    expect(isTrustedRendererUrl(`${expected}?launch=startup#settings`, packaged)).toBe(true);
    expect(isTrustedRendererUrl(pathToFileURL(path.join(path.dirname(builtIndex), "other.html")).href, packaged)).toBe(false);
    expect(isTrustedRendererUrl("https://attacker.example/", packaged)).toBe(false);
  });

  it("allows only the configured Vite origin in development", () => {
    const { development } = policies();

    expect(isTrustedRendererUrl("http://127.0.0.1:5173/", development)).toBe(true);
    expect(isTrustedRendererUrl("http://127.0.0.1:5173/settings?tab=audio", development)).toBe(true);
    expect(isTrustedRendererUrl("http://localhost:5173/", development)).toBe(false);
    expect(isTrustedRendererUrl("http://127.0.0.1:5174/", development)).toBe(false);
    expect(isTrustedRendererUrl("file:///tmp/dist/index.html", development)).toBe(false);
    expect(isTrustedRendererUrl("not a URL", development)).toBe(false);
  });
});

describe("IPC sender validation", () => {
  it("accepts the trusted main frame at an allowlisted URL", () => {
    const { development } = policies();
    const mainFrame = { url: "http://127.0.0.1:5173/" };
    const webContents = { mainFrame, isDestroyed: () => false };

    expect(isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, webContents, development)).toBe(true);
  });

  it("rejects other contents, subframes, navigated renderers, and destroyed contents", () => {
    const { development } = policies();
    const mainFrame = { url: "http://127.0.0.1:5173/" };
    const webContents = { mainFrame, isDestroyed: () => false };

    expect(isTrustedIpcSender({ sender: {}, senderFrame: mainFrame }, webContents, development)).toBe(false);
    expect(isTrustedIpcSender({ sender: webContents, senderFrame: { url: mainFrame.url } }, webContents, development)).toBe(false);
    mainFrame.url = "https://attacker.example/";
    expect(isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, webContents, development)).toBe(false);
    expect(isTrustedIpcSender(null, webContents, development)).toBe(false);
    expect(isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, null, development)).toBe(false);
    mainFrame.url = "http://127.0.0.1:5173/";
    webContents.isDestroyed = () => true;
    expect(isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, webContents, development)).toBe(false);
  });
});

describe("navigation guards", () => {
  it("blocks untrusted navigation, redirects, and all renderer-created windows", () => {
    const { development } = policies();
    const handlers = {};
    let openHandler;
    const webContents = {
      on: vi.fn((event, handler) => {
        handlers[event] = handler;
      }),
      setWindowOpenHandler: vi.fn((handler) => {
        openHandler = handler;
      })
    };
    installNavigationGuards(webContents, development);
    const trustedEvent = { preventDefault: vi.fn() };
    const untrustedEvent = { preventDefault: vi.fn() };
    const redirectEvent = {
      url: "https://attacker.example/redirected",
      preventDefault: vi.fn()
    };

    handlers["will-navigate"]({
      url: "http://127.0.0.1:5173/settings",
      preventDefault: trustedEvent.preventDefault
    });
    handlers["will-navigate"]({
      url: "https://attacker.example/",
      preventDefault: untrustedEvent.preventDefault
    });
    handlers["will-redirect"](redirectEvent);

    expect(trustedEvent.preventDefault).not.toHaveBeenCalled();
    expect(untrustedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce();
    expect(openHandler({ url: "https://attacker.example/" })).toEqual({ action: "deny" });
  });

  it("supports Electron's legacy string navigation argument", () => {
    const { development } = policies();
    let willNavigate;
    installNavigationGuards({
      on: (_event, handler) => { willNavigate = handler; },
      setWindowOpenHandler: () => undefined
    }, development);
    const event = { preventDefault: vi.fn() };

    willNavigate(event, "https://attacker.example/");

    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("external URL policy", () => {
  it("allows only the app's known HTTPS and macOS settings destinations", () => {
    expect(isAllowedExternalUrl("https://github.com/MaksimPeterburgskiy/sounddeck-studio/releases/latest")).toBe(true);
    expect(isAllowedExternalUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")).toBe(true);
    expect(isAllowedExternalUrl("https://attacker.example/")).toBe(false);
    expect(isAllowedExternalUrl("http://example.com/")).toBe(false);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("not a URL")).toBe(false);
  });
});

describe("main-process IPC registration", () => {
  it("routes every invoke handler through sender validation", () => {
    const source = readFileSync(new URL("./main.cjs", import.meta.url), "utf8");

    expect(source).not.toMatch(/\bipcMain\.handle\s*\(/);
    expect(source.match(/\bhandleTrustedIpc\s*\(/g)?.length).toBeGreaterThan(10);
  });
});
