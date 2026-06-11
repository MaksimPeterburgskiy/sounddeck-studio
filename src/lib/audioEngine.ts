import type { AudioSettings, OutputTarget, SoundSlot } from "../types";

interface ActiveVoice {
  id: string;
  soundId: string;
  sources: AudioBufferSourceNode[];
  gains: GainNode[];
  startedAt: number;
  fadeOutMs: number;
}

type EngineStatus = "idle" | "playing" | "paused";

export class AudioEngine {
  private monitorContext: AudioContext;
  private virtualContext: AudioContext;
  private decodeContext: AudioContext;
  private cache = new Map<string, AudioBuffer>();
  private active = new Map<string, ActiveVoice[]>();
  private micStream?: MediaStream;
  private micNodes: Array<{ source: MediaStreamAudioSourceNode; gain: GainNode; context: AudioContext }> = [];
  private settings: AudioSettings;
  private statusCallback: (status: EngineStatus) => void;

  constructor(settings: AudioSettings, statusCallback: (status: EngineStatus) => void) {
    this.settings = settings;
    this.statusCallback = statusCallback;
    this.monitorContext = new AudioContext({ latencyHint: "interactive" });
    this.virtualContext = new AudioContext({ latencyHint: "interactive" });
    this.decodeContext = new AudioContext({ latencyHint: "interactive" });
  }

  async configure(settings: AudioSettings) {
    this.settings = settings;
    await this.setSink(this.monitorContext, settings.monitorDeviceId);
    await this.setSink(this.virtualContext, settings.virtualMicDeviceId);
    await this.configureMic();
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
    if (sound.retriggerMode === "restart") this.stop(sound.id);
    await Promise.all([this.monitorContext.resume(), this.virtualContext.resume()]);
    const contexts = this.contextsForTarget(sound.outputTarget);
    const voice: ActiveVoice = { id: crypto.randomUUID(), soundId: sound.id, sources: [], gains: [], startedAt: performance.now(), fadeOutMs: sound.fadeOutMs };

    for (const route of contexts) {
      const context = route.context;
      const source = context.createBufferSource();
      const gain = context.createGain();
      const totalGain = sound.volume * this.settings.soundboardVolume * route.volume;
      source.buffer = buffer;
      source.loop = sound.loop;
      source.connect(gain).connect(context.destination);
      const now = context.currentTime;
      gain.gain.setValueAtTime(sound.fadeInMs > 0 ? 0.0001 : totalGain, now);
      if (sound.fadeInMs > 0) gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, totalGain), now + sound.fadeInMs / 1000);
      source.onended = () => this.removeVoice(sound.id, voice.id);
      source.start();
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

  stopAll() {
    for (const voices of this.active.values()) {
      for (const voice of voices) this.stopVoice(voice, 0.03);
    }
    this.active.clear();
    this.emitStatus();
  }

  async pauseAll() {
    await Promise.all([this.monitorContext.suspend(), this.virtualContext.suspend()]);
    this.statusCallback("paused");
  }

  async resumeAll() {
    await Promise.all([this.monitorContext.resume(), this.virtualContext.resume()]);
    this.emitStatus();
  }

  isPlaying(soundId: string) {
    return (this.active.get(soundId) || []).length > 0;
  }

  async dispose() {
    this.stopAll();
    this.stopMic();
    await Promise.allSettled([this.monitorContext.close(), this.virtualContext.close(), this.decodeContext.close()]);
  }

  private contextsForTarget(target: OutputTarget) {
    const contexts: Array<{ context: AudioContext; volume: number }> = [];
    if ((target === "monitor" || target === "both") && this.settings.monitorToHeadphones) {
      contexts.push({ context: this.monitorContext, volume: this.settings.monitorVolume });
    }
    if ((target === "virtual" || target === "both") && this.settings.soundboardToVirtualMic) {
      contexts.push({ context: this.virtualContext, volume: 1 });
    }
    if (!contexts.length) contexts.push({ context: this.monitorContext, volume: this.settings.monitorVolume });
    return contexts;
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
        gain.gain.value = this.settings.micVolume * route.volume;
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
      gain.gain.setTargetAtTime(0.0001, now, fadeSeconds);
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
    this.statusCallback(this.active.size ? "playing" : "idle");
  }
}
