import { stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONTROL_PROTOCOL_VERSION, type ControlDiscovery } from "../../src/lib/controlProtocol";

export type ConnectionStatus = "not-installed" | "disabled" | "offline" | "auth-error" | "protocol-mismatch" | "connected";
export interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
}
export interface DiscoveryFile { path: string; state: ControlDiscovery | null }

export function discoveryPaths({ platform = process.platform, home = os.homedir(), env = process.env }: DiscoveryOptions = {}): string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const base = platform === "darwin" ? paths.join(home, "Library", "Application Support")
    : platform === "win32" ? (env.APPDATA || paths.join(home, "AppData", "Roaming"))
      : (env.XDG_CONFIG_HOME || paths.join(home, ".config"));
  return ["sounddeck-studio", "SoundDeck Studio"].map((name) => paths.join(base, name, "external-control.json"));
}

export function parseDiscovery(value: unknown): ControlDiscovery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as ControlDiscovery;
  if (typeof state.enabled !== "boolean" || !Number.isInteger(state.protocol) || state.protocol < 1
    || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535
    || typeof state.token !== "string" || !state.token.length || state.token.length > 256
    || !["127.0.0.1", "0.0.0.0"].includes(state.host) || typeof state.allowLan !== "boolean"
    || typeof state.appVersion !== "string" || typeof state.appPath !== "string" || !state.appPath.length
    || /[\x00-\x1f\x7f]/.test(state.appPath)) return null;
  return state;
}

/** A malformed newest file means an offline installation, never an older token. */
export async function discover(options: DiscoveryOptions = {}): Promise<DiscoveryFile | null> {
  const candidates = await Promise.all(discoveryPaths(options).map(async (file) => {
    try {
      const info = await stat(file);
      return info.isFile() ? { path: file, mtime: info.mtimeMs } : null;
    } catch { return null; }
  }));
  const newest = candidates.filter((file) => file !== null).sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return null;
  try { return { path: newest.path, state: parseDiscovery(JSON.parse(await readFile(newest.path, "utf8"))) }; }
  catch { return { path: newest.path, state: null }; }
}

export function discoveryStatus(file: DiscoveryFile | null): ConnectionStatus {
  if (!file) return "not-installed";
  if (!file.state) return "offline";
  if (!file.state.enabled) return "disabled";
  if (file.state.protocol !== CONTROL_PROTOCOL_VERSION) return "protocol-mismatch";
  return "offline";
}

export function protocolLabel(serverProtocol: number): string {
  return serverProtocol > CONTROL_PROTOCOL_VERSION ? "Update\nplugin" : "Update\napp";
}
