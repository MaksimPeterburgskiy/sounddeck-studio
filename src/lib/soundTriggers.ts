import type { AudioEngine } from "./audioEngine";
import { waitForAudioConfiguration } from "./controlReadiness";
import { PressTracker } from "./pressTracker";
import { createSoundPlayQueue } from "./soundPlayQueue";
import type { SoundSlot } from "../types";

type PlaybackEngine = Pick<AudioEngine, "play" | "stop" | "stopAll" | "stopVoice" | "isPlaying">;

/** Holds register before queuing; every trigger uses the shared play queue. */
export class SoundTriggers {
  private readonly presses = new PressTracker();
  private readonly queue = createSoundPlayQueue();

  constructor(
    private readonly getEngine: () => PlaybackEngine | null,
    private readonly getConfiguration: () => Promise<void> | null
  ) {}

  trigger(sound: SoundSlot, pressId?: string, external = false, cancellation?: AbortSignal): Promise<string | boolean | null> {
    const engine = this.getEngine();
    if (!engine) return Promise.resolve(false);
    const hold = sound.triggerMode === "hold" && pressId !== undefined;
    const start = (signal?: AbortSignal) => this.queue(sound.id, async (signal) => {
      if (signal.aborted) return false;
      if (external) await waitForAudioConfiguration(this.getConfiguration);
      if (signal.aborted) return false;
      if (!hold && sound.retriggerMode === "stop" && engine.isPlaying(sound.id)) {
        engine.stop(sound.id);
        return true;
      }
      return engine.play(sound, signal, {
        fresh: hold,
        waitForRouting: external ? () => waitForAudioConfiguration(this.getConfiguration) : undefined
      });
    }, signal);
    return hold
      ? this.presses.press(pressId, (signal) => start(signal) as Promise<string | false>,
        (voiceId) => engine.stopVoice(sound.id, voiceId), sound.id, cancellation)
      : start(cancellation);
  }

  release(pressId: string) { this.presses.release(pressId); }
  releaseAll() { this.presses.releaseAll(); }
  stop(soundId: string) {
    const release = this.presses.snapshotReleases(soundId);
    this.queue.cancel(soundId);
    release();
    this.getEngine()?.stop(soundId);
  }
  stopAll() {
    const release = this.presses.snapshotReleases();
    this.queue.cancelAll();
    release();
    this.getEngine()?.stopAll();
  }
}
