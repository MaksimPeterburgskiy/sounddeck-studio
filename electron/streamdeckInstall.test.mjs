import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamDeckInstaller, installedPluginPath, isOlderVersion, PLUGIN_FILE } from "./streamdeckInstall.cjs";

const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture({ version = "0.1.22", platform = "darwin", clients = [], packaged = true, bundled = true, manifest } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sounddeck-plugin-install-"));
  directories.push(directory);
  const options = {
    isPackaged: packaged, resourcesPath: directory, appRoot: directory,
    home: directory, platform, env: {}, appVersion: version,
    openPath: vi.fn(async () => ""), getClients: () => clients
  };
  const bundledPath = path.join(directory, packaged ? "streamdeck" : "streamdeck-plugin/dist", PLUGIN_FILE);
  if (bundled) {
    await mkdir(path.dirname(bundledPath), { recursive: true });
    await writeFile(bundledPath, "packed plugin");
  }
  const installedPath = installedPluginPath(platform, directory, options.env);
  if (manifest !== undefined) {
    await mkdir(installedPath, { recursive: true });
    await writeFile(path.join(installedPath, "manifest.json"), typeof manifest === "object" && !Buffer.isBuffer(manifest) ? JSON.stringify(manifest) : manifest);
  }
  return { installer: createStreamDeckInstaller(options), options, bundledPath };
}

const manifest = (Version) => ({ UUID: "com.sounddeck.studio", Version });

describe("Stream Deck version detection", () => {
  it.each([
    ["0.1.22-beta.9", "0.1.22-beta.10", true],
    ["0.1.22.10", "0.1.22", true],
    ["0.1.22", "0.1.22-beta.10", false],
    ["0.1.22.99999", "0.1.22", false],
    ["0.1.23", "0.1.22", false],
    ["0.1.9", "0.1.10", true],
    ["broken", "0.1.22", false],
    [undefined, "0.1.22", false],
    ["0.1.22", "invalid", false]
  ])("compares %s with %s numerically", (installed, bundled, expected) => {
    expect(isOlderVersion(installed, bundled)).toBe(expected);
  });

  it("finds the supported platform paths without guessing on Linux", () => {
    expect(installedPluginPath("darwin", "/Users/test", {})).toBe("/Users/test/Library/Application Support/com.elgato.StreamDeck/Plugins/com.sounddeck.studio.sdPlugin");
    expect(installedPluginPath("win32", "C:\\Users\\test", { APPDATA: "C:\\Roaming" })).toBe("C:\\Roaming\\Elgato\\StreamDeck\\Plugins\\com.sounddeck.studio.sdPlugin");
    expect(installedPluginPath("win32", "C:\\Users\\test", {})).toBeUndefined();
    expect(installedPluginPath("linux", "/home/test", {})).toBeUndefined();
  });

  it("prefers the authenticated plugin client's app version over the manifest", async () => {
    const { installer } = await fixture({ clients: [{ name: "SoundDeck Stream Deck plugin", version: "0.1.22", distribution: "github" }], manifest: manifest("0.1.21.99999") });
    expect(await installer.status()).toEqual({ bundledVersion: "0.1.22.99999", installed: true, installedVersion: "0.1.22.99999", source: "client", updateAvailable: false });
  });

  it("offers updates for a GitHub client even with an unreadable manifest", async () => {
    const { installer } = await fixture({ clients: [{ name: "SoundDeck Stream Deck plugin", version: "0.1.22-beta.4", distribution: "github" }], manifest: Buffer.from([0, 255, 23, 89, 0]) });
    expect(await installer.status()).toMatchObject({ installed: true, installedVersion: "0.1.22.4", source: "client", updateAvailable: true });
  });

  it.each(["marketplace", undefined, "other"])("suppresses updates for client distribution %s regardless of manifest readability", async (distribution) => {
    for (const installedManifest of [manifest("0.1.21.99999"), Buffer.from([0, 255, 23, 89, 0])]) {
      const { installer } = await fixture({ clients: [{ name: "SoundDeck Stream Deck plugin", version: "0.1.22-beta.4", ...(distribution === undefined ? {} : { distribution }) }], manifest: installedManifest });
      expect(await installer.status()).toMatchObject({ installed: true, installedVersion: "0.1.22.4", source: "client", updateAvailable: false });
    }
  });

  it("does not retain GitHub provenance when a client reconnects without distribution", async () => {
    const clients = [{ name: "SoundDeck Stream Deck plugin", version: "0.1.21", distribution: "github" }];
    const { installer } = await fixture({ clients, manifest: manifest("0.1.21.99999") });
    expect(await installer.status()).toMatchObject({ updateAvailable: true });
    clients.splice(0, 1, { name: "SoundDeck Stream Deck plugin", version: "0.1.21" });
    expect(await installer.status()).toMatchObject({ installed: true, source: "client", updateAvailable: false });
  });

  it("identifies a connected GitHub sideload without an installed folder", async () => {
    const { installer } = await fixture({ clients: [{ name: "SoundDeck Stream Deck plugin", version: "0.1.21", distribution: "github" }] });
    expect(await installer.status()).toMatchObject({ installed: true, source: "client", updateAvailable: true });
  });

  it("falls back to a readable manifest and ignores unrelated clients", async () => {
    const { installer } = await fixture({ clients: [{ name: "Other tool", version: "0.1.22" }, { name: "SoundDeck Stream Deck plugin", version: "invalid" }], manifest: manifest("0.1.21.99999") });
    expect(await installer.status()).toMatchObject({ installed: true, installedVersion: "0.1.21.99999", source: "manifest", updateAvailable: false });
  });

  it.each([Buffer.from([255, 0, 9]), "not JSON", manifest("bad"), { UUID: "other.plugin", Version: "0.1.21.99999" }])("keeps unreadable or unverified manifests unknown", async (manifest) => {
    const { installer } = await fixture({ manifest });
    expect(await installer.status()).toEqual({ bundledVersion: "0.1.22.99999", installed: true, source: "unknown", updateAvailable: false });
  });

  it("does not notify for a missing installation or bundle", async () => {
    expect(await (await fixture()).installer.status()).toMatchObject({ installed: false, source: "unknown", updateAvailable: false });
    expect(await (await fixture({ bundled: false, clients: [{ name: "SoundDeck Stream Deck plugin", version: "0.1.21", distribution: "github" }] })).installer.status()).toMatchObject({ installed: true, updateAvailable: false });
  });

  it("reports unknown on Linux even with a connected client", async () => {
    const { installer } = await fixture({ platform: "linux", clients: [{ name: "SoundDeck Stream Deck plugin", version: "0.1.21" }] });
    expect(await installer.status()).toMatchObject({ installed: false, source: "unknown", updateAvailable: false });
  });
});

describe("Stream Deck install", () => {
  it.each([true, false])("opens only the resolved bundled file (packaged=%s)", async (packaged) => {
    const { installer, options, bundledPath } = await fixture({ packaged });
    await installer.status();
    expect(options.openPath).not.toHaveBeenCalled();
    expect(await installer.install()).toEqual({ ok: true });
    expect(options.openPath).toHaveBeenCalledExactlyOnceWith(bundledPath);
  });

  it("reports a missing file without opening anything", async () => {
    const { installer, options } = await fixture({ bundled: false });
    expect(await installer.install()).toEqual({ ok: false, reason: "missing-file" });
    expect(options.openPath).not.toHaveBeenCalled();
  });

  it("maps shell errors and rejections to no-handler", async () => {
    const { installer, options } = await fixture();
    options.openPath.mockResolvedValueOnce("No application is associated with this file");
    expect(await installer.install()).toEqual({ ok: false, reason: "no-handler" });
    options.openPath.mockRejectedValueOnce(new Error("Failed to open"));
    expect(await installer.install()).toEqual({ ok: false, reason: "no-handler" });
  });
});
