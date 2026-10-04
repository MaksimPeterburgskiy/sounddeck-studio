import type { AudioSettings, SoundLibrary } from "../types";
import type { RendererControlResult } from "./controlProtocol";
import { waitForControlOperation } from "./controlCancellation";
import { applyAudioControlCommand, type AudioControlCommand } from "./controlSettings";

export function createAudioControlQueue({ getSettings, writeSettings, persist, waitForConfiguration }: {
  getSettings: () => AudioSettings | null;
  // Writes must start audio configuration before returning.
  writeSettings: (settings: AudioSettings) => void;
  persist: (deadlineSignal?: AbortSignal) => Promise<unknown>;
  waitForConfiguration: () => Promise<void>;
}) {
  let tail = Promise.resolve();
  const versions = new Map<keyof AudioSettings, number>();

  function recordWrites(keys: Array<keyof AudioSettings>) {
    for (const key of keys) versions.set(key, (versions.get(key) ?? 0) + 1);
  }

  async function run(command: AudioControlCommand, cancellation?: AbortSignal, deadlineSignal?: AbortSignal): Promise<RendererControlResult> {
    // Disconnects cancel commands waiting in the FIFO. Once applied, a mutation
    // owns its persistence, configuration, and rollback until the deadline.
    if (cancellation?.aborted || deadlineSignal?.aborted) return { ok: false, code: "unavailable" };
    const previous = getSettings();
    if (!previous) return { ok: false, code: "unavailable" };
    const applied = applyAudioControlCommand(previous, command);
    const keys: Array<keyof AudioSettings> = "key" in command.args ? [command.args.key]
      : command.command === "volume.mute" ? [`${command.args.bus}Muted`]
      : [`${command.args.bus}Volume`, `${command.args.bus}Muted`];
    recordWrites(keys);
    const ownedVersions = keys.map((key) => versions.get(key));
    writeSettings(applied.settings);
    try {
      await waitForControlOperation(persist(deadlineSignal), deadlineSignal);
    } catch {
      // A timed-out filesystem write can still land. Preserve the mutation,
      // report its unconfirmed outcome, and release the FIFO without rollback.
      if (deadlineSignal?.reason === "operation-timeout") return { ok: false, code: "unavailable" };
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
      await waitForControlOperation(waitForConfiguration(), deadlineSignal).catch(() => undefined);
      return { ok: false, code: "internal-error" };
    }
    // Persistence commits the mutation. A deadline ends the configuration wait,
    // but must report the saved change as applied even if routing finishes later.
    await waitForControlOperation(waitForConfiguration(), deadlineSignal).catch(() => undefined);
    return { ok: true, data: applied.data };
  }

  return {
    // Call for every UI field write, including idempotent writes.
    recordWrites,
    enqueue(command: AudioControlCommand, cancellation?: AbortSignal, deadlineSignal = cancellation): Promise<RendererControlResult> {
      const result = tail.then(() => run(command, cancellation, deadlineSignal)).catch((): RendererControlResult => ({ ok: false, code: "internal-error" }));
      tail = result.then(() => undefined);
      return result;
    }
  };
}

export async function persistControlLibrary(
  snapshot: SoundLibrary,
  savedLibraries: WeakSet<SoundLibrary>,
  saveLibrary: (library: SoundLibrary) => Promise<{ ok: boolean }>,
  cancellation?: AbortSignal,
  requestPersistence?: () => void
) {
  // Reserve the snapshot while saving so the UI persistence effect skips it.
  savedLibraries.add(snapshot);
  try {
    const result = await waitForControlOperation(saveLibrary(snapshot), cancellation);
    if (!result.ok) throw new Error("Library save failed");
  } catch (error) {
    // An unconfirmed (including timed-out) save must remain eligible for the
    // UI's normal persistence. Late completion cannot mark it saved again.
    savedLibraries.delete(snapshot);
    // Releasing the reservation does not change React's library dependency.
    // Retry once through normal UI persistence; its failures do not requeue.
    if (cancellation?.reason === "operation-timeout") requestPersistence?.();
    throw error;
  }
}
