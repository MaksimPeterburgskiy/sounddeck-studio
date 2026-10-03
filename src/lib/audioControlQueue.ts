import type { AudioSettings } from "../types";
import type { RendererControlResult } from "./controlProtocol";
import { applyAudioControlCommand, type AudioControlCommand } from "./controlSettings";

export function createAudioControlQueue({ getSettings, writeSettings, persist, waitForConfiguration }: {
  getSettings: () => AudioSettings | null;
  // Writes must start audio configuration before returning.
  writeSettings: (settings: AudioSettings) => void;
  persist: () => Promise<unknown>;
  waitForConfiguration: () => Promise<void>;
}) {
  let tail = Promise.resolve();
  const versions = new Map<keyof AudioSettings, number>();

  function recordWrites(keys: Array<keyof AudioSettings>) {
    for (const key of keys) versions.set(key, (versions.get(key) ?? 0) + 1);
  }

  async function run(command: AudioControlCommand, cancellation?: AbortSignal): Promise<RendererControlResult> {
    // Disconnects cancel commands waiting in the FIFO. Once applied, a mutation
    // owns its persistence, configuration, and rollback through completion.
    if (cancellation?.aborted) return { ok: false, code: "unavailable" };
    const previous = getSettings();
    if (!previous) return { ok: false, code: "unavailable" };
    const applied = applyAudioControlCommand(previous, command);
    const keys: Array<keyof AudioSettings> = "key" in command.args ? [command.args.key]
      : command.command === "volume.mute" ? [`${command.args.bus}Muted`]
      : [`${command.args.bus}Volume`, `${command.args.bus}Muted`];
    if (keys.every((key) => previous[key] === applied.settings[key])) {
      // Unchanged settings still acknowledge only after pending audio work settles.
      await waitForConfiguration().catch(() => undefined);
      return { ok: true, data: applied.data };
    }
    recordWrites(keys);
    const ownedVersions = keys.map((key) => versions.get(key));
    writeSettings(applied.settings);
    try {
      await persist();
    } catch {
      const current = getSettings();
      if (current) {
        let restored = current;
        for (const [index, key] of keys.entries()) {
          // A newer UI write owns the field, even if it wrote the same value.
          if (versions.get(key) === ownedVersions[index] && current[key] === applied.settings[key] && previous[key] !== applied.settings[key]) {
            restored = { ...restored, [key]: previous[key] };
          }
        }
        if (restored !== current) writeSettings(restored);
      }
      await waitForConfiguration().catch(() => undefined);
      return { ok: false, code: "internal-error" };
    }
    // Persistence commits the mutation. Audio failures are surfaced by the app
    // and must not turn a saved change into a failed command.
    await waitForConfiguration().catch(() => undefined);
    return { ok: true, data: applied.data };
  }

  return {
    // Call for every UI field write, including idempotent writes.
    recordWrites,
    enqueue(command: AudioControlCommand, cancellation?: AbortSignal): Promise<RendererControlResult> {
      const result = tail.then(() => run(command, cancellation)).catch((): RendererControlResult => ({ ok: false, code: "internal-error" }));
      tail = result.then(() => undefined);
      return result;
    }
  };
}
