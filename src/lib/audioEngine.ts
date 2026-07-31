import type { AudioSettings, OutputTarget, SoundEffects, SoundSlot } from "../types";
import { makeMicrophoneConstraints, normalizeSelectableDeviceId } from "./devices";
import { normalizeSoundEffects } from "./model";

interface ActiveEffectChain {
  source: AudioBufferSourceNode;
  baseRate: number;
  low?: BiquadFilterNode;
  mid?: BiquadFilterNode;
  high?: BiquadFilterNode;
  compressor?: DynamicsCompressorNode;
  limiter?: DynamicsCompressorNode;
  reverb?: {
    convolver: ConvolverNode;
    wet: GainNode;
    dry: GainNode;
    decaySec: number;
    mix: number;
  };
  compressorWired: boolean;
  limiterWired: boolean;
  nodes: AudioNode[];
}

interface ActiveVoice {
  id: string;
  soundId: string;
  sources: AudioBufferSourceNode[];
  gains: GainNode[];
  effects: ActiveEffectChain[];
  startedAt: number;
  fadeOutMs: number;
  trimStart: number;
  clipDuration: number;
  baseRate: number;
  rate: number;
  positionOffset: number;
  loop: boolean;
  cleanupHandle?: number;
  cleanedUp?: boolean;
}

interface PreviewVoice {
  sources: AudioBufferSourceNode[];
  gains: GainNode[];
  effects: ActiveEffectChain[];
  soundId: string;
  trimStart: number;
  trimEnd: number;
  baseRate: number;
  rate: number;
  baseOffset: number;
  startedAt: number;
  cleanupHandle?: number;
  cleanedUp?: boolean;
}

interface NoiseSuppressionGraph {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  destination: MediaStreamAudioDestinationNode;
  worker: Worker;
}

type EngineStatus = "idle" | "playing" | "paused";

export interface MicrophoneProcessingStatus {
  echoCancellation: "disabled" | "active" | "unavailable";
  noiseSuppression: "disabled" | "standby" | "loading" | "active" | "unavailable";
}

const disabledMicrophoneProcessingStatus: MicrophoneProcessingStatus = {
  echoCancellation: "disabled",
  noiseSuppression: "disabled"
};

export class AudioEngine {
  private monitorContext: AudioContext;
  private virtualContext: AudioContext;
  private decodeContext: AudioContext;
  private monitorBus: GainNode;
  private virtualBus: GainNode;
  private cache = new Map<string, AudioBuffer>();
  private active = new Map<string, ActiveVoice[]>();
  private tails = new Map<string, ActiveVoice[]>();
  private previewVoice: PreviewVoice | null = null;
  private previewOffset = 0;
  private previewGeneration = 0;
  private micStream?: MediaStream;
  private micNodes: Array<{ source: MediaStreamAudioSourceNode; gain: GainNode; context: AudioContext }> = [];
  private noiseSuppressionGraph?: NoiseSuppressionGraph;
  private micConfigureGeneration = 0;
  private configureGeneration = 0;
  private disposed = false;
  private settings: AudioSettings;
  private virtualSinkId = "";
  private virtualSinkReady = false;
  private statusCallback: (status: EngineStatus, activeSoundIds: string[]) => void;
  private processingStatusCallback: (status: MicrophoneProcessingStatus) => void;
  private processingStatus: MicrophoneProcessingStatus = disabledMicrophoneProcessingStatus;

  constructor(
    settings: AudioSettings,
    statusCallback: (status: EngineStatus, activeSoundIds: string[]) => void,
    processingStatusCallback: (status: MicrophoneProcessingStatus) => void = () => undefined
  ) {
    this.settings = settings;
    this.statusCallback = statusCallback;
    this.processingStatusCallback = processingStatusCallback;
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
    if (this.disposed) return;
    const generation = this.configureGeneration + 1;
    this.configureGeneration = generation;
    const previousVirtualSinkId = this.virtualSinkId;
    const previousVirtualSinkReady = this.virtualSinkReady;
    const echoCancellationChanged = this.settings.echoCancellationEnabled !== settings.echoCancellationEnabled;
    const attenuationChanged = this.settings.noiseSuppressionAttenuationDb !== settings.noiseSuppressionAttenuationDb;
    const shouldConfigureMicForSettings = this.shouldConfigureMic(settings);
    this.settings = settings;
    this.virtualSinkId = virtualSinkId;
    await this.setSink(this.monitorContext, settings.monitorDeviceId, true);
    if (generation !== this.configureGeneration || this.disposed) {
      await this.restoreLatestSinks();
      return;
    }
    const nextVirtualSinkReady = virtualSinkId ? await this.setSink(this.virtualContext, virtualSinkId, false) : false;
    if (generation !== this.configureGeneration || this.disposed) {
      await this.restoreLatestSinks();
      return;
    }
    this.virtualSinkReady = nextVirtualSinkReady;
    const shouldConfigureMic =
      shouldConfigureMicForSettings ||
      previousVirtualSinkId !== virtualSinkId ||
      previousVirtualSinkReady !== this.virtualSinkReady;
    this.applyBusVolumes();
    if (shouldConfigureMic) {
      await this.configureMic();
    } else if (echoCancellationChanged) {
      const updatedInPlace = await this.applyEchoCancellationConstraint();
      if (!updatedInPlace) await this.configureMic();
      else {
        this.applyMicVolumes();
        if (attenuationChanged) this.noiseSuppressionGraph?.worker.postMessage({ type: "attenuation", value: this.settings.noiseSuppressionAttenuationDb });
      }
    } else {
      this.applyMicVolumes();
      if (attenuationChanged) this.noiseSuppressionGraph?.worker.postMessage({ type: "attenuation", value: this.settings.noiseSuppressionAttenuationDb });
    }
  }

  async preload(sound: SoundSlot) {
    // Keyed by media path (not sound id) so a late decode of an old path can't overwrite
    // the buffer for a path the slot has since been re-pointed at (e.g. after a permanent cut).
    if (this.cache.has(sound.mediaPath)) return this.cache.get(sound.mediaPath)!;
    const bytes = await window.sounddeck.readMedia(sound.mediaPath);
    const buffer = await this.decodeContext.decodeAudioData(bytes.slice(0));
    this.cache.set(sound.mediaPath, buffer);
    return buffer;
  }

  async play(sound: SoundSlot) {
    const buffer = await this.preload(sound);
    if (sound.soloPlay) this.stopAllExcept(sound.id);
    if (sound.retriggerMode === "restart") this.stop(sound.id);
    await Promise.all([this.monitorContext.resume(), this.virtualContext.resume()]);
    const contexts = this.contextsForTarget(sound.outputTarget);
    if (!contexts.length) return;
    const trimStart = Math.min(Math.max(0, sound.trimStartSec ?? 0), buffer.duration);
    const trimEnd = Math.min(Math.max(trimStart + 0.01, sound.trimEndSec ?? buffer.duration), buffer.duration);
    const clipDuration = Math.max(0.01, trimEnd - trimStart);
    const rate = Math.max(0.0625, sound.playbackRate ?? 1);
    const effects = normalizeSoundEffects(sound.effects);
    const voice: ActiveVoice = {
      id: crypto.randomUUID(),
      soundId: sound.id,
      sources: [],
      gains: [],
      effects: [],
      startedAt: performance.now(),
      fadeOutMs: sound.fadeOutMs,
      trimStart,
      clipDuration,
      baseRate: rate,
      rate: this.effectivePlaybackRate(rate, effects),
      positionOffset: 0,
      loop: sound.loop
    };

    for (const route of contexts) {
      const context = route.context;
      const source = context.createBufferSource();
      const gain = context.createGain();
      const totalGain = sound.volume;
      source.buffer = buffer;
      source.playbackRate.value = rate;
      if (source.detune) source.detune.value = effects.pitchEnabled ? effects.pitchSemitones * 100 : 0;
      source.loop = sound.loop;
      if (sound.loop) {
        source.loopStart = trimStart;
        source.loopEnd = trimEnd;
      }
      const chain = this.connectEffectChain(context, source, gain, effects, rate);
      gain.connect(route.bus);
      const now = context.currentTime;
      gain.gain.setValueAtTime(sound.fadeInMs > 0 ? 0.0001 : totalGain, now);
      if (sound.fadeInMs > 0) gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, totalGain), now + sound.fadeInMs / 1000);
      source.onended = () => this.finishVoice(sound.id, voice);
      if (sound.loop) source.start(0, trimStart);
      else source.start(0, trimStart, clipDuration);
      voice.sources.push(source);
      voice.gains.push(gain);
      voice.effects.push(chain);
    }

    this.active.set(sound.id, [...(this.active.get(sound.id) || []), voice]);
    this.emitStatus();
  }

  stop(soundId: string) {
    const voices = this.active.get(soundId) || [];
    for (const voice of voices) this.stopVoice(voice, voice.fadeOutMs / 1000);
    this.active.delete(soundId);
    this.stopTails(soundId);
    this.emitStatus();
  }

  stopAllExcept(soundId: string) {
    for (const [activeId, voices] of this.active) {
      if (activeId === soundId) continue;
      for (const voice of voices) this.stopVoice(voice, 0.03);
      this.active.delete(activeId);
    }
    for (const tailId of [...this.tails.keys()]) {
      if (tailId !== soundId) this.stopTails(tailId);
    }
    this.emitStatus();
  }

  stopAll() {
    for (const voices of this.active.values()) {
      for (const voice of voices) this.stopVoice(voice, 0.03);
    }
    this.active.clear();
    this.stopAllTails();
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

  /** Apply new per-sound effects to any currently playing voices and preview audio. */
  setSoundEffects(soundId: string, effects: SoundEffects | undefined) {
    const normalized = normalizeSoundEffects(effects);
    for (const voice of this.active.get(soundId) || []) {
      const currentElapsed = this.voiceElapsed(voice);
      voice.positionOffset = currentElapsed;
      voice.startedAt = performance.now();
      voice.rate = this.effectivePlaybackRate(voice.baseRate, normalized);
      for (const chain of voice.effects) this.applyEffectsToChain(chain, normalized, true);
    }
    if (this.previewVoice?.soundId === soundId) {
      const position = this.getPreviewPosition();
      if (position !== null) {
        this.previewVoice.baseOffset = position;
        this.previewVoice.startedAt = performance.now();
        this.previewVoice.rate = this.effectivePlaybackRate(this.previewVoice.baseRate, normalized);
      }
      for (const chain of this.previewVoice.effects) this.applyEffectsToChain(chain, normalized, true);
    }
  }

  /** Current playback position in seconds within the source buffer, or null when not playing. */
  getPosition(soundId: string): number | null {
    const voices = this.active.get(soundId);
    if (!voices?.length) return null;
    const voice = voices[voices.length - 1];
    const elapsed = this.voiceElapsed(voice);
    if (voice.loop) return voice.trimStart + (elapsed % voice.clipDuration);
    return voice.trimStart + Math.min(elapsed, voice.clipDuration);
  }

  /**
   * Editor-only preview playback (headphones / monitor context only). Independent of the
   * regular soundboard voices so it can be paused in place, restarted, and scrubbed.
   */
  async previewPlay(sound: SoundSlot, fromSec: number, rate: number) {
    // Stop any current preview and claim this generation, so a pause/stop/close (or a
    // newer previewPlay) that happens while we await below cancels this stale start.
    this.stopPreviewSources();
    const generation = this.previewGeneration;
    const buffer = await this.preload(sound);
    if (generation !== this.previewGeneration || this.disposed) return;
    const trimStart = Math.min(Math.max(0, sound.trimStartSec ?? 0), buffer.duration);
    const trimEnd = Math.min(Math.max(trimStart + 0.01, sound.trimEndSec ?? buffer.duration), buffer.duration);
    const safeRate = Math.max(0.0625, rate || 1);
    const offset = Math.min(Math.max(trimStart, fromSec), trimEnd);
    const remaining = Math.max(0.01, trimEnd - offset);
    await this.monitorContext.resume();
    if (generation !== this.previewGeneration || this.disposed) return;
    const source = this.monitorContext.createBufferSource();
    const gain = this.monitorContext.createGain();
    const effects = normalizeSoundEffects(sound.effects);
    source.buffer = buffer;
    source.playbackRate.value = safeRate;
    if (source.detune) source.detune.value = effects.pitchEnabled ? effects.pitchSemitones * 100 : 0;
    const chain = this.connectEffectChain(this.monitorContext, source, gain, effects, safeRate);
    gain.connect(this.monitorBus);
    gain.gain.setValueAtTime(sound.volume, this.monitorContext.currentTime);
    const voice: PreviewVoice = {
      sources: [source],
      gains: [gain],
      effects: [chain],
      soundId: sound.id,
      trimStart,
      trimEnd,
      baseRate: safeRate,
      rate: this.effectivePlaybackRate(safeRate, effects),
      baseOffset: offset,
      startedAt: performance.now()
    };
    source.onended = () => {
      if (this.previewVoice === voice) {
        this.previewOffset = trimEnd;
        this.finishPreviewVoice(voice);
      }
    };
    source.start(0, offset, remaining);
    this.previewVoice = voice;
    this.previewOffset = offset;
  }

  previewPause() {
    const position = this.getPreviewPosition();
    if (position !== null) this.previewOffset = position;
    this.stopPreviewSources();
  }

  async previewRestart(sound: SoundSlot, rate: number) {
    const trimStart = Math.min(Math.max(0, sound.trimStartSec ?? 0), sound.duration ?? Infinity);
    await this.previewPlay(sound, trimStart, rate);
  }

  async previewSeek(sound: SoundSlot, sec: number, isPlaying: boolean, rate: number) {
    if (isPlaying) {
      await this.previewPlay(sound, sec, rate);
    } else {
      this.stopPreviewSources();
      this.previewOffset = sec;
    }
  }

  previewStop() {
    this.stopPreviewSources();
    this.previewOffset = 0;
  }

  /** Current preview position in seconds, or the stored offset when paused/stopped. */
  getPreviewPosition(): number | null {
    const voice = this.previewVoice;
    if (!voice) return this.previewOffset;
    const elapsed = ((performance.now() - voice.startedAt) / 1000) * voice.rate;
    return Math.min(voice.baseOffset + elapsed, voice.trimEnd);
  }

  isPreviewing() {
    return this.previewVoice !== null;
  }

  private stopPreviewSources() {
    this.previewGeneration += 1;
    const voice = this.previewVoice;
    this.previewVoice = null;
    if (!voice) return;
    this.cleanupPreviewVoice(voice, true);
  }

  /** Drop the cached decoded buffer for a media path (e.g. after that file is removed). */
  invalidate(mediaPath: string) {
    this.cache.delete(mediaPath);
  }

  async dispose() {
    this.disposed = true;
    this.configureGeneration += 1;
    this.stopPreviewSources();
    this.stopAll();
    this.micConfigureGeneration += 1;
    this.stopMic();
    await Promise.allSettled([this.monitorContext.close(), this.virtualContext.close(), this.decodeContext.close()]);
  }

  private connectEffectChain(context: AudioContext, source: AudioBufferSourceNode, output: AudioNode, effects: SoundEffects, baseRate: number): ActiveEffectChain {
    const low = context.createBiquadFilter();
    const mid = context.createBiquadFilter();
    const high = context.createBiquadFilter();
    const compressor = context.createDynamicsCompressor();
    const limiter = context.createDynamicsCompressor();
    const convolver = context.createConvolver();
    const wet = context.createGain();
    const dry = context.createGain();

    low.type = "lowshelf";
    low.frequency.value = 320;
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 1;
    high.type = "highshelf";
    high.frequency.value = 3200;

    source.connect(low).connect(mid).connect(high);
    dry.connect(output);
    convolver.connect(wet).connect(output);

    const chain: ActiveEffectChain = {
      source,
      baseRate,
      low,
      mid,
      high,
      compressor,
      limiter,
      reverb: { convolver, wet, dry, decaySec: 0, mix: 0 },
      compressorWired: false,
      limiterWired: false,
      nodes: [low, mid, high, compressor, limiter, convolver, wet, dry]
    };
    this.wireDynamics(chain, effects.compressor.enabled, effects.limiter.enabled);
    this.applyEffectsToChain(chain, effects, false);
    return chain;
  }

  /**
   * Wire high → [compressor] → [limiter] → dry/convolver, including only the enabled nodes.
   * Chromium's DynamicsCompressorNode adds ~5 ms of lookahead latency and fades in from
   * silence while its internal envelope warms up — even at pass-through settings — so
   * disabled dynamics nodes must stay out of the signal path entirely.
   */
  private wireDynamics(chain: ActiveEffectChain, compressorOn: boolean, limiterOn: boolean) {
    const { high, compressor, limiter, reverb } = chain;
    if (!high || !compressor || !limiter || !reverb) return;
    high.disconnect();
    compressor.disconnect();
    limiter.disconnect();
    let tail: AudioNode = high;
    if (compressorOn) tail = tail.connect(compressor);
    if (limiterOn) tail = tail.connect(limiter);
    tail.connect(reverb.dry);
    tail.connect(reverb.convolver);
    chain.compressorWired = compressorOn;
    chain.limiterWired = limiterOn;
  }

  private applyEffectsToChain(chain: ActiveEffectChain, effects: SoundEffects, smooth: boolean) {
    const now = chain.source.context.currentTime;
    const set = (param: AudioParam, value: number) => {
      param.cancelScheduledValues(now);
      if (smooth) param.setTargetAtTime(value, now, 0.02);
      else param.setValueAtTime(value, now);
    };

    const pitchRatio = effects.pitchEnabled ? 2 ** (effects.pitchSemitones / 12) : 1;
    if (chain.source.detune) set(chain.source.detune, effects.pitchEnabled ? effects.pitchSemitones * 100 : 0);
    else set(chain.source.playbackRate, chain.baseRate * pitchRatio);

    if (chain.low && chain.mid && chain.high) {
      set(chain.low.gain, effects.eq.enabled ? effects.eq.lowGainDb : 0);
      set(chain.mid.gain, effects.eq.enabled ? effects.eq.midGainDb : 0);
      set(chain.high.gain, effects.eq.enabled ? effects.eq.highGainDb : 0);
    }

    if (chain.compressor && effects.compressor.enabled) {
      set(chain.compressor.threshold, effects.compressor.thresholdDb);
      set(chain.compressor.knee, 18);
      set(chain.compressor.ratio, effects.compressor.ratio);
      set(chain.compressor.attack, effects.compressor.attackMs / 1000);
      set(chain.compressor.release, effects.compressor.releaseMs / 1000);
    }

    if (chain.limiter && effects.limiter.enabled) {
      set(chain.limiter.threshold, effects.limiter.ceilingDb);
      set(chain.limiter.knee, 0);
      set(chain.limiter.ratio, 20);
      set(chain.limiter.attack, 0.001);
      set(chain.limiter.release, 0.05);
    }

    if (chain.compressorWired !== effects.compressor.enabled || chain.limiterWired !== effects.limiter.enabled) {
      this.wireDynamics(chain, effects.compressor.enabled, effects.limiter.enabled);
    }

    if (chain.reverb) {
      const mix = effects.reverb.enabled ? effects.reverb.mix : 0;
      chain.reverb.mix = mix;
      set(chain.reverb.dry.gain, 1 - mix);
      set(chain.reverb.wet.gain, mix);
      if (mix > 0 && (Math.abs(chain.reverb.decaySec - effects.reverb.decaySec) > 0.001 || !chain.reverb.convolver.buffer)) {
        chain.reverb.decaySec = effects.reverb.decaySec;
        chain.reverb.convolver.buffer = this.getReverbImpulse(chain.source.context, effects.reverb.decaySec);
      } else if (mix === 0) {
        chain.reverb.decaySec = effects.reverb.decaySec;
        chain.reverb.convolver.buffer = null;
      }
    }
  }

  private effectivePlaybackRate(baseRate: number, effects: SoundEffects) {
    return baseRate * (effects.pitchEnabled ? 2 ** (effects.pitchSemitones / 12) : 1);
  }

  private voiceElapsed(voice: ActiveVoice) {
    return voice.positionOffset + ((performance.now() - voice.startedAt) / 1000) * voice.rate;
  }

  private effectTailMs(effects: ActiveEffectChain[]) {
    return Math.max(0, ...effects.map((chain) => chain.reverb && chain.reverb.mix > 0 ? chain.reverb.decaySec * 1000 : 0));
  }

  private getReverbImpulse(context: BaseAudioContext, decaySec: number) {
    const safeDecay = Math.min(6, Math.max(0.1, decaySec));
    const sampleRate = context.sampleRate || 48000;
    const length = Math.max(1, Math.floor(sampleRate * safeDecay));
    const impulse = context.createBuffer(2, length, sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i += 1) {
        const t = i / length;
        data[i] = (Math.random() * 2 - 1) * ((1 - t) ** 2);
      }
    }
    return impulse;
  }

  private contextsForTarget(target: OutputTarget) {
    const contexts: Array<{ context: AudioContext; bus: GainNode }> = [];
    const wantsMonitor = (target === "monitor" || target === "both") && this.settings.monitorToHeadphones;
    const wantsVirtual = (target === "virtual" || target === "both") && this.settings.soundboardToVirtualMic;
    if (wantsMonitor) {
      contexts.push({ context: this.monitorContext, bus: this.monitorBus });
    }
    if (wantsVirtual) {
      if (this.virtualSinkReady) contexts.push({ context: this.virtualContext, bus: this.virtualBus });
    }
    if (!contexts.length && !wantsMonitor && !wantsVirtual) contexts.push({ context: this.monitorContext, bus: this.monitorBus });
    return contexts;
  }

  private applyBusVolumes() {
    this.monitorBus.gain.setTargetAtTime(this.settings.soundboardMonitorVolume, this.monitorContext.currentTime, 0.02);
    this.virtualBus.gain.setTargetAtTime(this.virtualSinkReady ? this.settings.soundboardVirtualVolume : 0, this.virtualContext.currentTime, 0.02);
  }

  private shouldConfigureMic(nextSettings: AudioSettings) {
    return (
      (nextSettings.micPassthrough && !this.micStream) ||
      this.settings.micPassthrough !== nextSettings.micPassthrough ||
      this.settings.microphoneDeviceId !== nextSettings.microphoneDeviceId ||
      this.settings.noiseSuppressionEnabled !== nextSettings.noiseSuppressionEnabled ||
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

  private async setSink(context: AudioContext, deviceId: string, fallbackToDefault: boolean) {
    const maybeContext = context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
    if (!maybeContext.setSinkId) return deviceId === "";
    try {
      await maybeContext.setSinkId(deviceId);
      return true;
    } catch (error) {
      console.warn("Audio output device switch failed", error);
      if (deviceId && fallbackToDefault) {
        try {
          await maybeContext.setSinkId("");
          return true;
        } catch (fallbackError) {
          console.warn("Audio output fallback to system default failed", fallbackError);
        }
      }
      return false;
    }
  }

  private async restoreLatestSinks() {
    if (this.disposed) return;
    const generation = this.configureGeneration;
    await this.setSink(this.monitorContext, this.settings.monitorDeviceId, true);
    if (generation !== this.configureGeneration || this.disposed) return;
    const virtualSinkReady = this.virtualSinkId ? await this.setSink(this.virtualContext, this.virtualSinkId, false) : false;
    if (generation !== this.configureGeneration || this.disposed) return;
    this.virtualSinkReady = virtualSinkReady;
    this.applyBusVolumes();
  }

  private async configureMic() {
    const generation = this.micConfigureGeneration + 1;
    this.micConfigureGeneration = generation;
    this.stopMic();
    if (!this.settings.micPassthrough) {
      this.setProcessingStatus({
        echoCancellation: "disabled",
        noiseSuppression: this.settings.noiseSuppressionEnabled ? "standby" : "disabled"
      });
      return;
    }
    const microphoneDeviceId = normalizeSelectableDeviceId(this.settings.microphoneDeviceId);
    const constraints: MediaStreamConstraints = {
      audio: makeMicrophoneConstraints(microphoneDeviceId, { echoCancellation: this.settings.echoCancellationEnabled })
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      if (!microphoneDeviceId) {
        if (generation === this.micConfigureGeneration) console.warn("Microphone passthrough failed", error);
        return;
      }
      if (generation === this.micConfigureGeneration) console.warn("Selected microphone failed; retrying with system default", error);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: makeMicrophoneConstraints("", { echoCancellation: this.settings.echoCancellationEnabled })
        });
      } catch (fallbackError) {
        if (generation === this.micConfigureGeneration) console.warn("Microphone passthrough fallback failed", fallbackError);
        return;
      }
    }

    if (generation !== this.micConfigureGeneration || !this.settings.micPassthrough) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.micStream = stream;
    this.updateEchoCancellationStatus(stream);

    try {
      const routedStream = this.settings.noiseSuppressionEnabled
        ? await this.createNoiseSuppressionStream(stream, generation)
        : stream;
      if (generation !== this.micConfigureGeneration || !this.settings.micPassthrough) return;
      const contexts = this.contextsForTarget("both");
      for (const route of contexts) {
        if (route.context === this.monitorContext && !this.settings.monitorMicToHeadphones) continue;
        const source = route.context.createMediaStreamSource(routedStream);
        const gain = route.context.createGain();
        gain.gain.value = route.context === this.monitorContext ? this.settings.micMonitorVolume : this.settings.micVirtualVolume;
        source.connect(gain).connect(route.context.destination);
        this.micNodes.push({ source, gain, context: route.context });
      }
    } catch (error) {
      if (generation === this.micConfigureGeneration) console.warn("Microphone passthrough failed", error);
    }
  }

  private stopMic() {
    for (const node of this.micNodes) {
      node.source.disconnect();
      node.gain.disconnect();
    }
    this.micNodes = [];
    this.stopNoiseSuppression();
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = undefined;
    this.setProcessingStatus({ echoCancellation: "disabled" });
  }

  private async applyEchoCancellationConstraint() {
    const track = this.micStream?.getAudioTracks?.()[0] ?? this.micStream?.getTracks()[0];
    if (!track || !track.applyConstraints) return false;
    const microphoneDeviceId = normalizeSelectableDeviceId(this.settings.microphoneDeviceId);
    try {
      await track.applyConstraints(makeMicrophoneConstraints(microphoneDeviceId, {
        echoCancellation: this.settings.echoCancellationEnabled
      }));
      const actual = track.getSettings?.().echoCancellation;
      if (typeof actual === "boolean" && actual !== this.settings.echoCancellationEnabled) return false;
      this.setProcessingStatus({ echoCancellation: this.settings.echoCancellationEnabled ? "active" : "disabled" });
      return true;
    } catch (error) {
      console.warn("Echo cancellation update failed; reopening the microphone", error);
      return false;
    }
  }

  private updateEchoCancellationStatus(stream: MediaStream) {
    if (!this.settings.echoCancellationEnabled) {
      this.setProcessingStatus({ echoCancellation: "disabled" });
      return;
    }
    const track = stream.getAudioTracks?.()[0] ?? stream.getTracks()[0];
    const actual = track?.getSettings?.().echoCancellation;
    this.setProcessingStatus({ echoCancellation: actual === false ? "unavailable" : "active" });
  }

  private async createNoiseSuppressionStream(stream: MediaStream, generation: number) {
    this.setProcessingStatus({ noiseSuppression: "loading" });
    let context: AudioContext | undefined;
    try {
      context = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
      await context.audioWorklet.addModule(new URL("./deepFilterWorklet.js", import.meta.url));
      if (generation !== this.micConfigureGeneration || this.disposed) {
        await context.close();
        return stream;
      }
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "sounddeck-deep-filter", {
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      const destination = context.createMediaStreamDestination();
      const worker = new Worker(new URL("./deepFilterWorker.ts", import.meta.url), { type: "module", name: "sounddeck-deep-filter" });
      const channel = new MessageChannel();
      node.port.postMessage({ type: "connect", port: channel.port1 }, [channel.port1]);
      source.connect(node).connect(destination);
      node.port.onmessage = (event: MessageEvent<{ type: "error" | "underrun" | "recovered"; message?: string }>) => {
        if (this.noiseSuppressionGraph?.worker !== worker) return;
        if (event.data?.type === "error") console.warn("DeepFilterNet audio worklet failed", event.data.message);
        if (event.data?.type === "error" || event.data?.type === "underrun") this.setProcessingStatus({ noiseSuppression: "unavailable" });
        if (event.data?.type === "recovered") this.setProcessingStatus({ noiseSuppression: "active" });
      };
      worker.onmessage = (event: MessageEvent<{ type: "ready" | "error"; message?: string }>) => {
        if (this.noiseSuppressionGraph?.worker !== worker) return;
        if (event.data?.type === "ready") this.setProcessingStatus({ noiseSuppression: "active" });
        if (event.data?.type === "error") {
          console.warn("DeepFilterNet worker failed", event.data.message);
          this.setProcessingStatus({ noiseSuppression: "unavailable" });
        }
      };
      worker.onerror = (event) => {
        if (this.noiseSuppressionGraph?.worker !== worker) return;
        console.warn("DeepFilterNet worker crashed", event.message);
        this.setProcessingStatus({ noiseSuppression: "unavailable" });
      };
      this.noiseSuppressionGraph = { context, source, node, destination, worker };
      void window.sounddeck.getNoiseSuppressionAssets().then(({ wasm, model }) => {
        if (this.noiseSuppressionGraph?.worker !== worker || generation !== this.micConfigureGeneration) {
          channel.port2.close();
          return;
        }
        worker.postMessage({
          type: "init",
          port: channel.port2,
          wasm,
          model,
          attenuationDb: this.settings.noiseSuppressionAttenuationDb
        }, [channel.port2, wasm, model]);
      }).catch((error) => {
        if (this.noiseSuppressionGraph?.worker !== worker) return;
        console.warn("DeepFilterNet assets could not be loaded", error);
        this.setProcessingStatus({ noiseSuppression: "unavailable" });
      });
      await context.resume();
      return destination.stream;
    } catch (error) {
      console.warn("Noise suppression could not be started", error);
      this.setProcessingStatus({ noiseSuppression: "unavailable" });
      if (context) await context.close().catch(() => undefined);
      return stream;
    }
  }

  private stopNoiseSuppression() {
    const graph = this.noiseSuppressionGraph;
    this.noiseSuppressionGraph = undefined;
    if (graph) {
      graph.worker.postMessage({ type: "dispose" });
      graph.worker.terminate();
      graph.source.disconnect();
      graph.node.disconnect();
      graph.destination.disconnect();
      graph.destination.stream.getTracks().forEach((track) => track.stop());
      void graph.context.close();
    }
    this.setProcessingStatus({ noiseSuppression: this.settings.noiseSuppressionEnabled ? "standby" : "disabled" });
  }

  private setProcessingStatus(patch: Partial<MicrophoneProcessingStatus>) {
    const next = { ...this.processingStatus, ...patch };
    if (next.echoCancellation === this.processingStatus.echoCancellation && next.noiseSuppression === this.processingStatus.noiseSuppression) return;
    this.processingStatus = next;
    this.processingStatusCallback(next);
  }

  private stopVoice(voice: ActiveVoice, fadeSeconds: number) {
    voice.gains.forEach((gain) => {
      const now = gain.context.currentTime;
      gain.gain.cancelScheduledValues(now);
      if (fadeSeconds > 0) gain.gain.setTargetAtTime(0.0001, now, fadeSeconds);
      else gain.gain.setValueAtTime(0.0001, now);
    });
    window.setTimeout(() => {
      voice.sources.forEach((source) => {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      });
      this.cleanupVoice(voice);
    }, fadeSeconds * 1000 + 20);
  }

  private finishVoice(soundId: string, voice: ActiveVoice) {
    if (voice.cleanupHandle !== undefined || voice.cleanedUp) return;
    this.removeVoice(soundId, voice.id);
    this.addTail(soundId, voice);
    voice.cleanupHandle = window.setTimeout(() => {
      this.cleanupVoice(voice);
      this.removeTail(soundId, voice.id);
    }, this.effectTailMs(voice.effects));
  }

  private addTail(soundId: string, voice: ActiveVoice) {
    this.tails.set(soundId, [...(this.tails.get(soundId) || []), voice]);
  }

  private removeTail(soundId: string, voiceId: string) {
    const remaining = (this.tails.get(soundId) || []).filter((voice) => voice.id !== voiceId);
    if (remaining.length) this.tails.set(soundId, remaining);
    else this.tails.delete(soundId);
  }

  private stopTails(soundId: string) {
    for (const voice of this.tails.get(soundId) || []) this.cleanupVoice(voice);
    this.tails.delete(soundId);
  }

  private stopAllTails() {
    for (const tailId of [...this.tails.keys()]) this.stopTails(tailId);
  }

  private cleanupVoice(voice: ActiveVoice) {
    if (voice.cleanedUp) return;
    voice.cleanedUp = true;
    if (voice.cleanupHandle !== undefined) {
      window.clearTimeout(voice.cleanupHandle);
      voice.cleanupHandle = undefined;
    }
    for (const source of voice.sources) {
      source.onended = null;
      source.disconnect();
    }
    for (const gain of voice.gains) gain.disconnect();
    for (const chain of voice.effects) {
      for (const node of chain.nodes) node.disconnect();
    }
  }

  private finishPreviewVoice(voice: PreviewVoice) {
    if (voice.cleanupHandle !== undefined || voice.cleanedUp) return;
    voice.cleanupHandle = window.setTimeout(() => {
      this.cleanupPreviewVoice(voice, false);
      if (this.previewVoice === voice) this.previewVoice = null;
    }, this.effectTailMs(voice.effects));
  }

  private cleanupPreviewVoice(voice: PreviewVoice, stopSources: boolean) {
    if (voice.cleanedUp) return;
    voice.cleanedUp = true;
    if (voice.cleanupHandle !== undefined) {
      window.clearTimeout(voice.cleanupHandle);
      voice.cleanupHandle = undefined;
    }
    for (const source of voice.sources) {
      source.onended = null;
      if (stopSources) {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
      source.disconnect();
    }
    for (const gain of voice.gains) gain.disconnect();
    for (const chain of voice.effects) {
      for (const node of chain.nodes) node.disconnect();
    }
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
