interface Press {
  cancellation: AbortController;
  soundId?: string;
  voiceId: string | null;
  stop: (voiceId: string) => void;
}

export class PressTracker {
  private presses = new Map<string, Press>();

  async press(
    pressId: string,
    start: (signal: AbortSignal) => Promise<string | false>,
    stop: Press["stop"],
    soundId?: string,
    signal?: AbortSignal
  ) {
    if (this.presses.has(pressId)) return null;
    const press: Press = { cancellation: new AbortController(), soundId, voiceId: null, stop };
    this.presses.set(pressId, press);
    const abort = () => this.release(pressId);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const voiceId = await start(press.cancellation.signal);
      if (voiceId === false) {
        this.presses.delete(pressId);
        return press.cancellation.signal.aborted ? null : false;
      }
      press.voiceId = voiceId;
      if (press.cancellation.signal.aborted) {
        // Safety net for a start that completed just before cancellation.
        stop(voiceId);
        this.presses.delete(pressId);
        return null;
      }
      return voiceId;
    } catch (error) {
      this.presses.delete(pressId);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  release(pressId: string) {
    const press = this.presses.get(pressId);
    if (!press || press.cancellation.signal.aborted) return;
    press.cancellation.abort();
    if (press.voiceId !== null) {
      press.stop(press.voiceId);
      this.presses.delete(pressId);
    }
  }

  snapshotReleases(soundId?: string) {
    const presses = [...this.presses].filter(([, press]) => soundId === undefined || press.soundId === soundId);
    return () => {
      for (const [pressId, press] of presses) {
        if (this.presses.get(pressId) === press) this.release(pressId);
      }
    };
  }

  releaseAll() { this.snapshotReleases()(); }
}
