import type { AudioSettings, OutputTarget, SoundSlot } from "../types";

interface ActiveVoice {
  id: string;
  soundId: string;
  sources: AudioBufferSourceNode[];
  gains: GainNode[];
  startedAt: number;
  fadeOutMs: number;
  trimStart: number;
  clipDuration: number;
  loop: boolean;
}

type EngineStatus = "idle" | "playing" | "paused";

export class AudioEngine {
  private monitorContext: AudioContext;
  private virtualContext: AudioContext;
  private decodeContext: AudioContext;
  private monitorBus: GainNode;
  private virtualBus: GainNode;
  private cache = new Map<string, AudioBuffer>();
  private active = new Map<string, ActiveVoice[]>();
  private micStream?: MediaStream;
  private micNodes: Array<{ source: MediaStreamAudioSourceNode; gain: GainNode; context: AudioContext }> = [];
  private settings: AudioSettings;
  private statusCallback: (status: EngineStatus, activeSoundIds: string[]) => void;

  constructor(settings: AudioSettings, statusCallback: (status: EngineStatus, activeSoundIds: string[]) => void) {
    this.settings = settings;
    this.statusCallback = statusCallback;
    this.monitorContext = new AudioContext({ latencyHint: "interactive" });
    this.virtualContext = new AudioContext({ latencyHint: "interactive" });
    this.decodeContext = new AudioContext({ latencyHint: "interactive" });
    this.monitorBus = this.monitorContext.createGain();
    this.monitorBus.connect(this.monitorContext.destination);
    this.virtualBus = this.virtualContext.createGain();
    this.virtualBus.connect(this.virtualContext.destination);
    this.applyBusVolumes();
  }

  async configure(settings: AudioSettings, virtualSinkId: string) {
    const shouldConfigureMic = this.shouldConfigureMic(settings);
    this.settings = settings;
    this.applyBusVolumes();
    await this.setSink(this.monitorContext, settings.monitorDeviceId);
    await this.setSink(this.virtualContext, virtualSinkId);
    if (shouldConfigureMic) await this.configureMic();
    else this.applyMicVolumes();
  }

  async preload(sound: SoundSlot) {
    if (this.cache.has(sound.id)) return this.cache.get(sound.id)!;
    const bytes = await window.sounddeck.readMedia(sound.mediaPath);
    const buffer = await this.decodeContext.decodeAudioData(bytes.slice(0));
    this.cache.set(sound.id, buffer);
    return buffer;
  }

  async play(sound: SoundSlot) {
    const buffer = await this.preload(sound);
    if (sound.soloPlay) this.stopAllExcept(sound.id);
    if (sound.retriggerMode === "restart") this.stop(sound.id);
    await Promise.all([this.monitorContext.resume(), this.virtualContext.resume()]);
    const contexts = this.contextsForTarget(sound.outputTarget);
    const trimStart = Math.min(Math.max(0, sound.trimStartSec ?? 0), buffer.duration);
    const trimEnd = Math.min(Math.max(trimStart + 0.01, sound.trimEndSec ?? buffer.duration), buffer.duration);
    const clipDuration = Math.max(0.01, trimEnd - trimStart);
    const voice: ActiveVoice = { id: crypto.randomUUID(), soundId: sound.id, sources: [], gains: [], startedAt: performance.now(), fadeOutMs: sound.fadeOutMs, trimStart, clipDuration, loop: sound.loop };

    for (const route of contexts) {
      const context = route.context;
      const source = context.createBufferSource();
      const gain = context.createGain();
      const totalGain = sound.volume;
      source.buffer = buffer;
      source.loop = sound.loop;
      if (sound.loop) {
        source.loopStart = trimStart;
        source.loopEnd = trimEnd;
      }
      source.connect(gain).connect(route.bus);
      const now = context.currentTime;
      gain.gain.setValueAtTime(sound.fadeInMs > 0 ? 0.0001 : totalGain, now);
      if (sound.fadeInMs > 0) gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, totalGain), now + sound.fadeInMs / 1000);
      source.onended = () => this.removeVoice(sound.id, voice.id);
      if (sound.loop) source.start(0, trimStart);
      else source.start(0, trimStart, clipDuration);
      voice.sources.push(source);
      voice.gains.push(gain);
    }

    this.active.set(sound.id, [...(this.active.get(sound.id) || []), voice]);
    this.emitStatus();
  }

  stop(soundId: string) {
    const voices = this.active.get(soundId) || [];
    for (const voice of voices) this.stopVoice(voice, voice.fadeOutMs / 1000);
    this.active.delete(soundId);
    this.emitStatus();
  }

  stopAllExcept(soundId: string) {
    for (const [activeId, voices] of this.active) {
      if (activeId === soundId) continue;
      for (const voice of voices) this.stopVoice(voice, 0.03);
      this.active.delete(activeId);
    }
    this.emitStatus();
  }

  stopAll() {
    for (const voices of this.active.values()) {
      for (const voice of voices) this.stopVoice(voice, 0.03);
    }
    this.active.clear();
    this.emitStatus();
  }

  async pauseAll() {
    await Promise.all([this.monitorContext.suspend(), this.virtualContext.suspend()]);
    this.statusCallback("paused", [...this.active.keys()]);
  }

  async resumeAll() {
    await Promise.all([this.monitorContext.resume(), this.virtualContext.resume()]);
    this.emitStatus();
  }

  isPlaying(soundId: string) {
    return (this.active.get(soundId) || []).length > 0;
  }

  /** Apply a new per-sound volume to any currently playing voices of that sound. */
  setSoundVolume(soundId: string, volume: number) {
    for (const voice of this.active.get(soundId) || []) {
      for (const gain of voice.gains) {
        const now = gain.context.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(Math.max(0.0001, volume), now, 0.02);
      }
    }
  }

  /** Current playback position in seconds within the source buffer, or null when not playing. */
  getPosition(soundId: string): number | null {
    const voices = this.active.get(soundId);
    if (!voices?.length) return null;
    const voice = voices[voices.length - 1];
    const elapsed = (performance.now() - voice.startedAt) / 1000;
    if (voice.loop) return voice.trimStart + (elapsed % voice.clipDuration);
    return voice.trimStart + Math.min(elapsed, voice.clipDuration);
  }

  async dispose() {
    this.stopAll();
    this.stopMic();
    await Promise.allSettled([this.monitorContext.close(), this.virtualContext.close(), this.decodeContext.close()]);
  }

  private contextsForTarget(target: OutputTarget) {
    const contexts: Array<{ context: AudioContext; bus: GainNode }> = [];
    if ((target === "monitor" || target === "both") && this.settings.monitorToHeadphones) {
      contexts.push({ context: this.monitorContext, bus: this.monitorBus });
    }
    if ((target === "virtual" || target === "both") && this.settings.soundboardToVirtualMic) {
      contexts.push({ context: this.virtualContext, bus: this.virtualBus });
    }
    if (!contexts.length) contexts.push({ context: this.monitorContext, bus: this.monitorBus });
    return contexts;
  }

  private applyBusVolumes() {
    this.monitorBus.gain.setTargetAtTime(this.settings.soundboardMonitorVolume, this.monitorContext.currentTime, 0.02);
    this.virtualBus.gain.setTargetAtTime(this.settings.soundboardVirtualVolume, this.virtualContext.currentTime, 0.02);
  }

  private shouldConfigureMic(nextSettings: AudioSettings) {
    return (
      (nextSettings.micPassthrough && !this.micStream) ||
      this.settings.micPassthrough !== nextSettings.micPassthrough ||
      this.settings.microphoneDeviceId !== nextSettings.microphoneDeviceId ||
      this.settings.soundboardToVirtualMic !== nextSettings.soundboardToVirtualMic ||
      this.settings.monitorToHeadphones !== nextSettings.monitorToHeadphones ||
      this.settings.monitorMicToHeadphones !== nextSettings.monitorMicToHeadphones
    );
  }

  private applyMicVolumes() {
    for (const node of this.micNodes) {
      const targetVolume = node.context === this.monitorContext ? this.settings.micMonitorVolume : this.settings.micVirtualVolume;
      const now = node.context.currentTime;
      node.gain.gain.cancelScheduledValues(now);
      node.gain.gain.setTargetAtTime(targetVolume, now, 0.02);
    }
  }

  private async setSink(context: AudioContext, deviceId: string) {
    const maybeContext = context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
    if (!maybeContext.setSinkId || !deviceId) return;
    try {
      await maybeContext.setSinkId(deviceId);
    } catch (error) {
      console.warn("Audio output device switch failed", error);
    }
  }

  private async configureMic() {
    this.stopMic();
    if (!this.settings.micPassthrough) return;
    const constraints: MediaStreamConstraints = {
      audio: this.settings.microphoneDeviceId ? { deviceId: { exact: this.settings.microphoneDeviceId }, echoCancellation: false, noiseSuppression: false } : true
    };
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
      const contexts = this.contextsForTarget("both");
      for (const route of contexts) {
        if (route.context === this.monitorContext && !this.settings.monitorMicToHeadphones) continue;
        const source = route.context.createMediaStreamSource(this.micStream);
        const gain = route.context.createGain();
        gain.gain.value = route.context === this.monitorContext ? this.settings.micMonitorVolume : this.settings.micVirtualVolume;
        source.connect(gain).connect(route.context.destination);
        this.micNodes.push({ source, gain, context: route.context });
      }
    } catch (error) {
      console.warn("Microphone passthrough failed", error);
    }
  }

  private stopMic() {
    for (const node of this.micNodes) {
      node.source.disconnect();
      node.gain.disconnect();
    }
    this.micNodes = [];
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = undefined;
  }

  private stopVoice(voice: ActiveVoice, fadeSeconds: number) {
    voice.gains.forEach((gain) => {
      const now = gain.context.currentTime;
      gain.gain.cancelScheduledValues(now);
      if (fadeSeconds > 0) gain.gain.setTargetAtTime(0.0001, now, fadeSeconds);
      else gain.gain.setValueAtTime(0.0001, now);
    });
    window.setTimeout(() => voice.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }), fadeSeconds * 1000 + 20);
  }

  private removeVoice(soundId: string, voiceId: string) {
    const remaining = (this.active.get(soundId) || []).filter((voice) => voice.id !== voiceId);
    if (remaining.length) this.active.set(soundId, remaining);
    else this.active.delete(soundId);
    this.emitStatus();
  }

  private emitStatus() {
    this.statusCallback(this.active.size ? "playing" : "idle", [...this.active.keys()]);
  }
}
