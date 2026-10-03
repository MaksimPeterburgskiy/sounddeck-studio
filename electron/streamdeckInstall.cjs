const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { toStreamDeckVersion } = require("./streamdeckVersion.cjs");

const PLUGIN_FILE = "com.sounddeck.studio.streamDeckPlugin";
const PLUGIN_DIRECTORY = "com.sounddeck.studio.sdPlugin";
const PLUGIN_CLIENT = "SoundDeck Stream Deck plugin";

function normalizedVersion(version) {
  if (typeof version !== "string") return undefined;
  try {
    const numeric = /^\d+\.\d+\.\d+\.\d+$/.test(version) ? version : toStreamDeckVersion(version);
    const parts = numeric.split(".").map(Number);
    return parts.every(Number.isSafeInteger) ? numeric : undefined;
  } catch {
    return undefined;
  }
}

function isOlderVersion(installed, bundled) {
  const left = normalizedVersion(installed)?.split(".").map(Number);
  const right = normalizedVersion(bundled)?.split(".").map(Number);
  if (!left || !right) return false;
  for (let index = 0; index < 4; index++) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

function installedPluginPath(platform, home, env) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "com.elgato.StreamDeck", "Plugins", PLUGIN_DIRECTORY);
  if (platform === "win32" && env.APPDATA) return path.win32.join(env.APPDATA, "Elgato", "StreamDeck", "Plugins", PLUGIN_DIRECTORY);
  return undefined;
}

function createStreamDeckInstaller({
  isPackaged, resourcesPath, appRoot, appVersion, openPath, getClients,
  platform = process.platform, home = os.homedir(), env = process.env, fileSystem = fs
}) {
  const bundledPath = isPackaged
    ? path.join(resourcesPath, "streamdeck", PLUGIN_FILE)
    : path.join(appRoot, "streamdeck-plugin", "dist", PLUGIN_FILE);
  const installedPath = installedPluginPath(platform, home, env);

  async function bundledFileExists() {
    try { return (await fileSystem.stat(bundledPath)).isFile(); } catch { return false; }
  }

  async function install() {
    if (!await bundledFileExists()) return { ok: false, reason: "missing-file" };
    try {
      const error = await openPath(bundledPath);
      return error ? { ok: false, reason: "no-handler" } : { ok: true };
    } catch {
      return { ok: false, reason: "no-handler" };
    }
  }

  async function status() {
    const bundledVersion = toStreamDeckVersion(appVersion);
    let installed = false;
    let installedVersion;
    let source = "unknown";
    if (installedPath) {
      try { installed = (await fileSystem.stat(installedPath)).isDirectory(); } catch { /* Absent or inaccessible installation. */ }
      // DRM protects manifests after Maker Console processing. There is no
      // documented Marketplace-origin field in the manifest or SDK hello;
      // encryption alone does not establish installation provenance.
      const client = getClients().find((client) => client.name === PLUGIN_CLIENT && normalizedVersion(client.version));
      if (client) {
        installed = true;
        installedVersion = normalizedVersion(client.version);
        source = "client";
      } else if (installed) {
        try {
          const manifest = JSON.parse(await fileSystem.readFile(path.join(installedPath, "manifest.json"), "utf8"));
          if (manifest.UUID === "com.sounddeck.studio") installedVersion = normalizedVersion(manifest.Version);
          if (installedVersion) source = "manifest";
        } catch { /* Encrypted, unreadable, or invalid: version remains unknown. */ }
      }
    }
    return {
      bundledVersion, installed, ...(installedVersion ? { installedVersion } : {}), source,
      updateAvailable: isOlderVersion(installedVersion, bundledVersion) && await bundledFileExists()
    };
  }

  return { install, status };
}

module.exports = { createStreamDeckInstaller, installedPluginPath, isOlderVersion, normalizedVersion, PLUGIN_FILE };
