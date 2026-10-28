import type { ControlPlaybackVoice } from "./controlProtocol";
import type { AudioSettings, OutputTarget, SoundEffects, SoundSlot } from "../types";
import { makeMicrophoneConstraints, normalizeSelectableDeviceId } from "./devices";
import { normalizeSoundEffects } from "./model";
import { MicChain, analyserPeakDb, type MicMeterReading } from "./micChain";
import { activeMicChainCount } from "./micFilters";

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
  epochStartedAt: number;
  fadeOutMs: number;
  trimStart: number;
  clipDuration: number;
  baseRate: number;
  rate: number;
  positionOffset: number;
  loop: boolean;
  cleanupHandle?: number;
  releaseFadeEndsAt?: number;
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

interface MicRoute {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  context: AudioContext;
  /** Unprocessed mic for hold-to-bypass, added to the monitor route the first time it's used. */
  raw?: { source: MediaStreamAudioSourceNode; gain: GainNode };
}

type EngineStatus = "idle" | "playing";

export interface MicrophoneProcessingStatus {
  echoCancellation: "disabled" | "active" | "unavailable";
  noiseSuppression: "disabled" | "standby" | "loading" | "active" | "unavailable";
  /** "disabled" when no filter in the chain is switched on. */
  filterChain: "disabled" | "standby" | "loading" | "active" | "unavailable";
  /** Delay the enabled filters add, in milliseconds. */
  latencyMs: number;
}

export interface ProcessedMicLease {
  stream: MediaStream;
  release: () => void;
}

export interface DeviceRouteStatus {
  state: "closed" | "selected" | "fallback" | "unavailable";
  requestedDeviceId: string;
  activeDeviceId: string;
}

export interface AudioDeviceStatus {
  microphone: DeviceRouteStatus;
  monitor: DeviceRouteStatus;
}

export const disabledMicrophoneProcessingStatus: MicrophoneProcessingStatus = {
  echoCancellation: "disabled",
  noiseSuppression: "disabled",
  filterChain: "disabled",
  latencyMs: 0
};

const METER_INTERVAL_MS = 33;

export class AudioEngine {
  private monitorContext: AudioContext;
  private virtualContext: AudioContext;
  private decodeContext: AudioContext;
  private monitorBus: GainNode;
  private previewBus: GainNode;
  private virtualBus: GainNode;
  private cache = new Map<string, AudioBuffer>();
  private active = new Map<string, ActiveVoice[]>();
  private tails = new Map<string, ActiveVoice[]>();
  private previewVoice: PreviewVoice | null = null;
  private previewOffset = 0;
  private previewGeneration = 0;
  private micStream?: MediaStream;
  private micNodes: MicRoute[] = [];
  private micRoutedStream?: MediaStream;
  private micChain?: MicChain;
  private micChainCreating?: Promise<void>;
  private micChainFailed = false;
  private recorderLeases = 0;
  private monitorBypass = false;
  private meterSubscribers = new Set<(reading: MicMeterReading | null) => void>();
  private meterTimer?: ReturnType<typeof setInterval>;
  private meterFallback?: { analyser: AnalyserNode; route: MicRoute; buffer: Float32Array<ArrayBuffer> };
  private micConfigureGeneration = 0;
  private configureGeneration = 0;
  private micAppliedSettings?: AudioSettings;
  private micAppliedVirtualSinkId = "";
  private micAppliedVirtualSinkReady = false;
  private disposed = false;
  private settings: AudioSettings;
  // A new monitor context uses the system default until a sink switch is attempted.
  private monitorSinkReady = true;
  private virtualSinkId = "";
  private virtualSinkReady = false;
  private statusCallback: (status: EngineStatus, activeSoundIds: string[], playback: ControlPlaybackVoice[]) => void;
  private processingStatusCallback: (status: MicrophoneProcessingStatus) => void;
  private processingStatus: MicrophoneProcessingStatus = disabledMicrophoneProcessingStatus;
  private deviceStatusCallback: (status: AudioDeviceStatus) => void;
  private deviceStatus: AudioDeviceStatus;

  constructor(
    settings: AudioSettings,
    statusCallback: (status: EngineStatus, activeSoundIds: string[], playback: ControlPlaybackVoice[]) => void,
    processingStatusCallback: (status: MicrophoneProcessingStatus) => void = () => undefined,
    deviceStatusCallback: (status: AudioDeviceStatus) => void = () => undefined
  ) {
    this.settings = settings;
    this.statusCallback = statusCallback;
    this.processingStatusCallback = processingStatusCallback;
    this.deviceStatusCallback = deviceStatusCallback;
    this.deviceStatus = {
      microphone: {
        state: "closed",
        requestedDeviceId: normalizeSelectableDeviceId(settings.microphoneDeviceId),
        activeDeviceId: ""
      },
      monitor: {
        state: "selected",
        requestedDeviceId: normalizeSelectableDeviceId(settings.monitorDeviceId),
        activeDeviceId: ""
      }
    };
    this.monitorContext = new AudioContext({ latencyHint: "interactive" });
    this.virtualContext = new AudioContext({ latencyHint: "interactive" });
    this.decodeContext = new AudioContext({ latencyHint: "interactive" });
    this.monitorBus = this.monitorContext.createGain();
    this.monitorBus.connect(this.monitorContext.destination);
    this.previewBus = this.monitorContext.createGain();
    this.previewBus.connect(this.monitorContext.destination);
    this.virtualBus = this.virtualContext.createGain();
    this.virtualBus.connect(this.virtualContext.destination);
    this.applyBusVolumes();
  }

  async configure(settings: AudioSettings, virtualSinkId: string) {
    if (this.disposed) return;
    const generation = this.configureGeneration + 1;
    this.configureGeneration = generation;
    const applied = this.micAppliedSettings;
    const echoCancellationChanged = applied?.echoCancellationEnabled !== settings.echoCancellationEnabled;
    const chainChanged =
      applied?.micChain !== settings.micChain ||
      applied?.noiseSuppressionModel !== settings.noiseSuppressionModel ||
      applied?.noiseSuppressionEnabled !== settings.noiseSuppressionEnabled ||
      applied?.noiseSuppressionAttenuationDb !== settings.noiseSuppressionAttenuationDb;
    const shouldConfigureMicForSettings = this.shouldConfigureMic(settings);
    this.settings = settings;
    this.virtualSinkId = virtualSinkId;
    // Mute and bus gains take effect even while asynchronous routes are opening.
    this.applyBusVolumes();
    this.applyMicVolumes();
    await this.applyMonitorSink(generation);
    if (generation !== this.configureGeneration || this.disposed) {
      await this.restoreLatestSinks();
      return;
    }
    const virtualSinkResult = virtualSinkId ? await this.setSink(this.virtualContext, virtualSinkId, false) : "failed";
    if (generation !== this.configureGeneration || this.disposed) {
      await this.restoreLatestSinks();
      return;
    }
    this.virtualSinkReady = virtualSinkResult === "selected";
    const shouldConfigureMic =
      shouldConfigureMicForSettings ||
      this.micAppliedVirtualSinkId !== virtualSinkId ||
      this.micAppliedVirtualSinkReady !== this.virtualSinkReady;
    this.applyBusVolumes();
    if (shouldConfigureMic) {
      this.micAppliedSettings = undefined;
      await this.configureMic(generation);
    } else if (echoCancellationChanged) {
      this.micAppliedSettings = undefined;
      const updatedInPlace = await this.applyEchoCancellationConstraint();
      if (generation !== this.configureGeneration || this.disposed) return;
      if (!updatedInPlace) await this.configureMic(generation);
      else {
        this.applyMicVolumes();
        if (chainChanged) await this.syncMicChain();
        this.markMicApplied(generation);
      }
    } else {
      this.applyMicVolumes();
      // Filter changes rewire the running chain; they never reopen the microphone.
      if (chainChanged) await this.syncMicChain();
      this.markMicApplied(generation);
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

  async play(sound: SoundSlot, signal?: AbortSignal, options: { fresh?: boolean; waitForRouting?: () => Promise<void> } | (() => Promise<void>) = {}): Promise<string | false> {
    const { fresh, waitForRouting } = typeof options === "function" ? { waitForRouting: options } : options;
    if (signal?.aborted || !this.hasLiveRoute(sound.outputTarget)) return false;
    const buffer = await this.preload(sound);
    if (waitForRouting) await waitForRouting();
    // Settings may have changed while decoding; re-check before any side effects.
    if (signal?.aborted || this.disposed || !this.hasLiveRoute(sound.outputTarget)) return false;
    await Promise.all([this.monitorContext.resume(), this.virtualContext.resume()]);
    if (waitForRouting) await waitForRouting();
    if (signal?.aborted || this.disposed || !this.hasLiveRoute(sound.outputTarget)) return false;
    // Only stop other voices once nothing else can bail out; a muted trigger must not silence what is playing.
    if (sound.soloPlay) this.stopAllExcept(sound.id);
    if (!fresh && sound.retriggerMode === "restart") this.stop(sound.id);
    const contexts = this.contextsForTarget(sound.outputTarget);
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
      epochStartedAt: Date.now(),
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
    return voice.id;
  }

  stop(soundId: string) {
    const voices = this.active.get(soundId) || [];
    for (const voice of voices) this.fadeVoice(voice, voice.fadeOutMs / 1000);
    this.active.delete(soundId);
    this.stopTails(soundId);
    this.emitStatus();
  }

  stopVoice(soundId: string, voiceId: string) {
    const voice = [...(this.active.get(soundId) || []), ...(this.tails.get(soundId) || [])].find((candidate) => candidate.id === voiceId);
    if (!voice || voice.releaseFadeEndsAt !== undefined) return;
    if (voice.cleanupHandle !== undefined) window.clearTimeout(voice.cleanupHandle);
    this.removeTail(soundId, voiceId);
    voice.releaseFadeEndsAt = performance.now() + voice.fadeOutMs;
    voice.cleanupHandle = this.fadeVoice(voice, voice.fadeOutMs / 1000);
    this.addTail(soundId, voice);
    this.removeVoice(soundId, voiceId);
  }

  stopAllExcept(soundId: string) {
    for (const [activeId, voices] of this.active) {
      if (activeId === soundId) continue;
      for (const voice of voices) this.fadeVoice(voice, 0.03);
      this.active.delete(activeId);
    }
    for (const tailId of [...this.tails.keys()]) {
      if (tailId !== soundId) this.stopTails(tailId, 0.03);
    }
    this.emitStatus();
  }

  stopAll() {
    for (const voices of this.active.values()) {
      for (const voice of voices) this.fadeVoice(voice, 0.03);
    }
    this.active.clear();
    this.stopAllTails(0.03);
    this.emitStatus();
  }

  isPlaying(soundId: string) {
    return (this.active.get(soundId) || []).length > 0;
  }

  /** Apply a new per-sound volume to any currently playing voices of that sound. */
  setSoundVolume(soundId: string, volume: number) {
    for (const voice of this.active.get(soundId) || []) {
      for (const gain of voice.gains) this.setGainVolume(gain, volume);
    }
    if (this.previewVoice?.soundId === soundId) {
      for (const gain of this.previewVoice.gains) this.setGainVolume(gain, volume);
    }
  }

  /** Apply new per-sound effects to any currently playing voices and preview audio. */
  setSoundEffects(soundId: string, effects: SoundEffects | undefined) {
    const normalized = normalizeSoundEffects(effects);
    const voices = this.active.get(soundId) || [];
    for (const voice of voices) {
      const currentElapsed = this.voiceElapsed(voice);
      voice.positionOffset = currentElapsed;
      voice.startedAt = performance.now();
      voice.rate = this.effectivePlaybackRate(voice.baseRate, normalized);
      voice.epochStartedAt = Date.now() - (currentElapsed / voice.rate) * 1000;
      for (const chain of voice.effects) this.applyEffectsToChain(chain, normalized, true);
    }
    if (voices.length) this.emitStatus();
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
    gain.connect(this.previewBus);
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
    this.stopMeters();
    this.stopMic();
    this.disposeMicChain();
    await Promise.allSettled([this.monitorContext.close(), this.virtualContext.close(), this.decodeContext.close()]);
  }

  async retryPreferredDevices(options: { recheckMonitor?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    const generation = this.configureGeneration;
    const monitorState = this.deviceStatus.monitor.state;
    const shouldReapplyMonitor =
      monitorState === "fallback" ||
      monitorState === "unavailable" ||
      (options.recheckMonitor === true && this.deviceStatus.monitor.requestedDeviceId !== "");
    if (shouldReapplyMonitor) {
      await this.applyMonitorSink(generation);
      if (generation !== this.configureGeneration || this.disposed) {
        if (!this.disposed) await this.restoreLatestSinks();
        return;
      }
    }
    await this.retryPreferredMicrophone();
  }

  getDeviceStatus(): AudioDeviceStatus {
    return this.deviceStatus;
  }

  /** Hold-to-bypass: while held, only the headphones hear the unprocessed mic. */
  setMonitorBypass(held: boolean) {
    if (this.monitorBypass === held) return;
    this.monitorBypass = held;
    this.applyMonitorBypass();
  }

  /** Level and gain-reduction readings at ~30 Hz while subscribed; null when the mic is closed. */
  subscribeMicMeters(callback: (reading: MicMeterReading | null) => void) {
    this.meterSubscribers.add(callback);
    this.micChain?.setMetering(true);
    this.meterTimer ??= setInterval(() => this.emitMeters(), METER_INTERVAL_MS);
    return () => {
      this.meterSubscribers.delete(callback);
      if (this.meterSubscribers.size) return;
      this.micChain?.setMetering(false);
      if (this.meterTimer !== undefined) clearInterval(this.meterTimer);
      this.meterTimer = undefined;
    };
  }

  /**
   * The mic after the filter chain, for recording. Opens the mic if no route has it open and keeps
   * the chain (and so the stream) alive until released, even across device switches.
   */
  async acquireProcessedMic(): Promise<ProcessedMicLease> {
    if (this.disposed) throw new Error("Audio engine has stopped.");
    this.recorderLeases += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.recorderLeases -= 1;
      void this.reconcileMicDemand();
    };
    try {
      await this.reconcileMicDemand();
      const stream = this.micStream && this.micChain?.destination.stream;
      if (!stream) throw new Error("The microphone could not be opened.");
      return { stream, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async reconcileMicDemand() {
    if (this.disposed) return;
    if (this.needsMicrophone() !== Boolean(this.micStream)) await this.configureMic(this.configureGeneration);
    else await this.syncMicChain();
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
    if (target === "monitor" || target === "both") contexts.push({ context: this.monitorContext, bus: this.monitorBus });
    if (target === "virtual" || target === "both") contexts.push({ context: this.virtualContext, bus: this.virtualBus });
    return contexts;
  }

  private hasLiveRoute(target: OutputTarget) {
    const monitorEnabled =
      (target === "monitor" || target === "both") &&
      this.settings.monitorToHeadphones &&
      this.monitorSinkReady;
    const virtualEnabled =
      (target === "virtual" || target === "both") &&
      this.settings.soundboardToVirtualMic &&
      this.virtualSinkReady;
    return monitorEnabled || virtualEnabled;
  }

  private applyBusVolumes() {
    this.setBusGain(this.monitorBus, this.settings.monitorToHeadphones && !this.settings.soundboardMonitorMuted ? this.settings.soundboardMonitorVolume : 0);
    this.setBusGain(this.previewBus, this.settings.soundboardMonitorMuted ? 0 : this.settings.soundboardMonitorVolume);
    this.setBusGain(this.virtualBus, this.virtualSinkReady && this.settings.soundboardToVirtualMic && !this.settings.soundboardVirtualMuted ? this.settings.soundboardVirtualVolume : 0);
  }

  /**
   * Bus gain is what enforces the global route toggles, so a disabled route must read zero
   * immediately. Automation only advances while a context is running: on a suspended context a
   * setTargetAtTime toward zero would still start from the default gain of 1 once play() resumes
   * it, leaking the first slice of a sound through a disabled route.
   */
  private setBusGain(bus: GainNode, target: number) {
    const context = bus.context;
    const now = context.currentTime;
    bus.gain.cancelScheduledValues(now);
    if (target <= 0 || context.state !== "running") {
      bus.gain.setValueAtTime(target, now);
      return;
    }
    bus.gain.setTargetAtTime(target, now, 0.02);
  }

  private needsMicrophone(settings: AudioSettings = this.settings) {
    return settings.micPassthrough || settings.monitorMicToHeadphones || this.recorderLeases > 0;
  }

  private shouldConfigureMic(nextSettings: AudioSettings) {
    const applied = this.micAppliedSettings;
    return (
      !applied ||
      (this.needsMicrophone(nextSettings) && !this.micStream) ||
      applied.micPassthrough !== nextSettings.micPassthrough ||
      applied.microphoneDeviceId !== nextSettings.microphoneDeviceId ||
      applied.monitorMicToHeadphones !== nextSettings.monitorMicToHeadphones
    );
  }

  private markMicApplied(generation: number) {
    if (generation !== this.configureGeneration || this.disposed) return;
    this.micAppliedSettings = { ...this.settings };
    this.micAppliedVirtualSinkId = this.virtualSinkId;
    this.micAppliedVirtualSinkReady = this.virtualSinkReady;
  }

  private setGainVolume(gain: GainNode, volume: number) {
    const now = gain.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(Math.max(0.0001, volume), now, 0.02);
  }

  private applyMicVolumes() {
    for (const node of this.micNodes) {
      const volume = this.micVolumeFor(node.context);
      if (!node.raw) {
        this.setBusGain(node.gain, volume);
        continue;
      }
      this.setMixGain(node.gain, this.monitorBypass ? 0 : volume, volume);
      this.setMixGain(node.raw.gain, this.monitorBypass ? volume : 0, volume);
    }
  }

  /** Crossfade for hold-to-bypass; a muted route still drops to zero at once. */
  private setMixGain(gain: GainNode, target: number, volume: number) {
    if (volume <= 0) {
      this.setBusGain(gain, 0);
      return;
    }
    const now = gain.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(target, now, 0.01);
  }

  private micVolumeFor(context: AudioContext) {
    return context === this.monitorContext
      ? (this.settings.micMonitorMuted ? 0 : this.settings.micMonitorVolume)
      : (this.settings.micVirtualMuted ? 0 : this.settings.micVirtualVolume);
  }

  private async setSink(context: AudioContext, deviceId: string, fallbackToDefault: boolean): Promise<"selected" | "fallback" | "failed"> {
    const maybeContext = context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
    if (!maybeContext.setSinkId) return deviceId === "" ? "selected" : "failed";
    try {
      await maybeContext.setSinkId(deviceId);
      return "selected";
    } catch (error) {
      console.warn("Audio output device switch failed", error);
      if (deviceId && fallbackToDefault) {
        try {
          await maybeContext.setSinkId("");
          return "fallback";
        } catch (fallbackError) {
          console.warn("Audio output fallback to system default failed", fallbackError);
        }
      }
      return "failed";
    }
  }

  private async applyMonitorSink(generation: number) {
    const requestedDeviceId = normalizeSelectableDeviceId(this.settings.monitorDeviceId);
    const result = await this.setSink(this.monitorContext, requestedDeviceId, true);
    if (generation !== this.configureGeneration || this.disposed) return;
    this.monitorSinkReady = result !== "failed";
    const sinkId = (this.monitorContext as { sinkId?: unknown }).sinkId;
    this.setMonitorDeviceStatus({
      state: result === "selected" ? "selected" : result === "fallback" ? "fallback" : "unavailable",
      requestedDeviceId,
      activeDeviceId: typeof sinkId === "string" ? sinkId : ""
    });
  }

  private async restoreLatestSinks() {
    while (!this.disposed) {
      const generation = this.configureGeneration;
      await this.applyMonitorSink(generation);
      if (this.disposed) return;
      if (generation !== this.configureGeneration) continue;
      const virtualSinkResult = this.virtualSinkId ? await this.setSink(this.virtualContext, this.virtualSinkId, false) : "failed";
      if (this.disposed) return;
      if (generation !== this.configureGeneration) continue;
      this.virtualSinkReady = virtualSinkResult === "selected";
      this.applyBusVolumes();
      return;
    }
  }

  private async configureMic(configureGeneration: number, preacquired?: MediaStream) {
    this.micAppliedSettings = undefined;
    const generation = this.micConfigureGeneration + 1;
    this.micConfigureGeneration = generation;
    this.stopMic(generation);
    if (!this.needsMicrophone()) {
      preacquired?.getTracks().forEach((track) => track.stop());
      this.disposeMicChain();
      this.setProcessingStatus({ echoCancellation: "disabled" });
      this.refreshChainStatus();
      this.markMicApplied(configureGeneration);
      return;
    }
    const microphoneDeviceId = normalizeSelectableDeviceId(this.settings.microphoneDeviceId);
    const constraints: MediaStreamConstraints = {
      audio: makeMicrophoneConstraints(microphoneDeviceId, { echoCancellation: this.settings.echoCancellationEnabled })
    };
    let stream: MediaStream;
    let usedFallback = false;
    if (preacquired) {
      stream = preacquired;
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        if (generation !== this.micConfigureGeneration || !this.needsMicrophone()) return;
        if (!microphoneDeviceId) {
          console.warn("Microphone passthrough failed", error);
          this.setMicrophoneDeviceStatus({ state: "unavailable", requestedDeviceId: microphoneDeviceId, activeDeviceId: "" });
          return;
        }
        console.warn("Selected microphone failed; retrying with system default", error);
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: makeMicrophoneConstraints("", { echoCancellation: this.settings.echoCancellationEnabled })
          });
          usedFallback = true;
        } catch (fallbackError) {
          if (generation !== this.micConfigureGeneration || !this.needsMicrophone()) return;
          console.warn("Microphone passthrough fallback failed", fallbackError);
          this.setMicrophoneDeviceStatus({ state: "unavailable", requestedDeviceId: microphoneDeviceId, activeDeviceId: "" });
          return;
        }
      }
    }

    if (generation !== this.micConfigureGeneration || configureGeneration !== this.configureGeneration || this.disposed || !this.needsMicrophone()) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.micStream = stream;
    const track = stream.getAudioTracks?.()[0] ?? stream.getTracks()[0];
    track?.addEventListener?.("ended", () => {
      if (generation !== this.micConfigureGeneration || this.disposed || !this.needsMicrophone()) return;
      void this.configureMic(this.configureGeneration);
    });
    this.setMicrophoneDeviceStatus({
      state: usedFallback ? "fallback" : "selected",
      requestedDeviceId: microphoneDeviceId,
      activeDeviceId: track?.getSettings?.().deviceId ?? ""
    });
    if (preacquired) {
      const updatedInPlace = await this.applyEchoCancellationConstraint();
      if (generation !== this.micConfigureGeneration || this.disposed || !this.needsMicrophone()) return;
      if (!updatedInPlace) {
        await this.configureMic(configureGeneration);
        return;
      }
    }
    this.updateEchoCancellationStatus(stream);

    // Reopening already interrupts the audio, so a chain nothing needs can go now.
    if (!this.chainWanted()) this.disposeMicChain();
    await this.syncMicChain();
    if (generation !== this.micConfigureGeneration || configureGeneration !== this.configureGeneration || this.disposed || !this.needsMicrophone()) return;
    this.markMicApplied(configureGeneration);
  }

  private async retryPreferredMicrophone() {
    if (this.disposed || !this.needsMicrophone()) return;
    const microphoneState = this.deviceStatus.microphone.state;
    if (microphoneState === "unavailable") {
      await this.configureMic(this.configureGeneration);
      return;
    }
    if (microphoneState !== "fallback") return;
    const probeGeneration = this.micConfigureGeneration;
    const requested = normalizeSelectableDeviceId(this.settings.microphoneDeviceId);
    if (requested === "") return;
    let probeStream: MediaStream;
    try {
      probeStream = await navigator.mediaDevices.getUserMedia({
        audio: makeMicrophoneConstraints(requested, { echoCancellation: this.settings.echoCancellationEnabled })
      });
    } catch (error) {
      console.warn("Selected microphone is still unavailable", error);
      return;
    }
    if (
      probeGeneration !== this.micConfigureGeneration ||
      this.disposed ||
      !this.needsMicrophone() ||
      requested !== normalizeSelectableDeviceId(this.settings.microphoneDeviceId)
    ) {
      probeStream.getTracks().forEach((track) => track.stop());
      return;
    }
    await this.configureMic(this.configureGeneration, probeStream);
  }

  private stopMic(generation = this.micConfigureGeneration) {
    this.disconnectMicRoutes();
    // The chain outlives a reopen so a recording keeps a stable stream across device changes.
    this.micChain?.setSource(undefined);
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = undefined;
    this.setProcessingStatus({ echoCancellation: "disabled" });
    this.refreshChainStatus();
    if (generation === this.micConfigureGeneration) {
      this.setMicrophoneDeviceStatus({
        state: "closed",
        requestedDeviceId: normalizeSelectableDeviceId(this.settings.microphoneDeviceId),
        activeDeviceId: ""
      });
    }
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

  private chainWanted() {
    return activeMicChainCount(this.settings) > 0 || this.recorderLeases > 0;
  }

  /**
   * Bring the filter chain and the mic routes in line with the current settings: build the chain
   * the first time a filter is switched on and update it in place afterwards. Once built it stays
   * up while the mic is open, so switching the last filter off and on again (say, noise
   * suppression from a Stream Deck key) never reroutes the mic. It's dropped when the mic closes.
   */
  private async syncMicChain() {
    if (this.micStream && this.chainWanted() && !this.micChain) {
      this.micChainCreating ??= this.createMicChain().finally(() => {
        this.micChainCreating = undefined;
      });
      this.refreshChainStatus();
      await this.micChainCreating;
    }
    if (this.disposed) return;
    const chain = this.micChain;
    if (chain && !this.micStream && this.recorderLeases === 0) {
      this.micChain = undefined;
      this.connectMicRoutes();
      chain.dispose();
    } else if (chain) {
      chain.setSource(this.micStream);
      chain.apply(this.settings);
      this.connectMicRoutes();
    } else {
      this.connectMicRoutes();
    }
    this.refreshChainStatus();
  }

  private async createMicChain() {
    this.micChainFailed = false;
    let chain: MicChain;
    try {
      chain = await MicChain.create(() => this.refreshChainStatus());
    } catch (error) {
      console.warn("Microphone filters could not be started", error);
      this.micChainFailed = true;
      return;
    }
    if (this.disposed || this.micChain || !this.micStream || !this.chainWanted()) {
      chain.dispose();
      return;
    }
    chain.setMetering(this.meterSubscribers.size > 0);
    this.micChain = chain;
  }

  private disposeMicChain() {
    const chain = this.micChain;
    this.micChain = undefined;
    chain?.dispose();
  }

  private refreshChainStatus() {
    const open = Boolean(this.micStream);
    const chain = this.micChain;
    const chainState: MicrophoneProcessingStatus["filterChain"] = !open
      ? "standby"
      : chain
        ? "active"
        : this.micChainFailed && !this.micChainCreating
          ? "unavailable"
          : "loading";
    this.setProcessingStatus({
      filterChain: activeMicChainCount(this.settings) > 0 ? chainState : "disabled",
      noiseSuppression: !this.settings.noiseSuppressionEnabled
        ? "disabled"
        : chainState === "active"
          ? chain?.noiseSuppressionState ?? "loading"
          : chainState,
      latencyMs: open && chain ? Math.round(chain.latencyMs * 10) / 10 : 0
    });
  }

  /** Route the processed mic (or the raw mic when no filter is on) to headphones and the virtual mic. */
  private connectMicRoutes() {
    const stream = this.micStream ? this.micChain?.destination.stream ?? this.micStream : undefined;
    // Microphone routes are independent of the soundboard's output toggles.
    const contexts: AudioContext[] = [];
    if (stream && this.settings.monitorMicToHeadphones) contexts.push(this.monitorContext);
    if (stream && this.settings.micPassthrough && this.virtualSinkReady) contexts.push(this.virtualContext);
    const unchanged =
      stream === this.micRoutedStream &&
      contexts.length === this.micNodes.length &&
      contexts.every((context, index) => this.micNodes[index].context === context);
    if (unchanged) return;
    this.disconnectMicRoutes();
    if (!stream) return;
    this.micRoutedStream = stream;
    for (const context of contexts) {
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      gain.gain.value = this.micVolumeFor(context);
      source.connect(gain).connect(context.destination);
      this.micNodes.push({ source, gain, context });
    }
    this.applyMonitorBypass();
  }

  private disconnectMicRoutes() {
    if (this.meterFallback) {
      this.meterFallback.route.source.disconnect(this.meterFallback.analyser);
      this.meterFallback = undefined;
    }
    for (const node of this.micNodes) {
      node.source.disconnect();
      node.gain.disconnect();
      node.raw?.source.disconnect();
      node.raw?.gain.disconnect();
    }
    this.micNodes = [];
    this.micRoutedStream = undefined;
  }

  private applyMonitorBypass() {
    const route = this.micNodes.find((node) => node.context === this.monitorContext);
    if (route && this.monitorBypass && !route.raw && this.micChain && this.micStream) {
      const source = this.monitorContext.createMediaStreamSource(this.micStream);
      const gain = this.monitorContext.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(this.monitorContext.destination);
      route.raw = { source, gain };
    }
    this.applyMicVolumes();
  }

  private emitMeters() {
    let reading: MicMeterReading | null = null;
    if (this.micStream && this.micChain) reading = this.micChain.readMeters();
    else if (this.micStream && this.micNodes[0]) {
      // Without a chain the mic goes straight to the routes, so in and out are the same signal.
      const route = this.micNodes[0];
      if (this.meterFallback?.route !== route) {
        const analyser = route.context.createAnalyser();
        analyser.fftSize = 2048;
        route.source.connect(analyser);
        this.meterFallback = { analyser, route, buffer: new Float32Array(2048) };
      }
      const level = analyserPeakDb(this.meterFallback.analyser, this.meterFallback.buffer);
      reading = { inputDb: level, outputDb: level, gainReductionDb: {} };
    }
    for (const subscriber of this.meterSubscribers) subscriber(reading);
  }

  private stopMeters() {
    if (this.meterTimer !== undefined) clearInterval(this.meterTimer);
    this.meterTimer = undefined;
    this.meterSubscribers.clear();
  }

  private setProcessingStatus(patch: Partial<MicrophoneProcessingStatus>) {
    const next = { ...this.processingStatus, ...patch };
    const current = this.processingStatus;
    if (
      next.echoCancellation === current.echoCancellation &&
      next.noiseSuppression === current.noiseSuppression &&
      next.filterChain === current.filterChain &&
      next.latencyMs === current.latencyMs
    ) return;
    this.processingStatus = next;
    this.processingStatusCallback(next);
  }

  private setMicrophoneDeviceStatus(status: DeviceRouteStatus) {
    const current = this.deviceStatus.microphone;
    if (
      status.state === current.state &&
      status.requestedDeviceId === current.requestedDeviceId &&
      status.activeDeviceId === current.activeDeviceId
    ) return;
    this.deviceStatus = { ...this.deviceStatus, microphone: status };
    this.deviceStatusCallback(this.deviceStatus);
  }

  private setMonitorDeviceStatus(status: DeviceRouteStatus) {
    const current = this.deviceStatus.monitor;
    if (
      status.state === current.state &&
      status.requestedDeviceId === current.requestedDeviceId &&
      status.activeDeviceId === current.activeDeviceId
    ) return;
    this.deviceStatus = { ...this.deviceStatus, monitor: status };
    this.deviceStatusCallback(this.deviceStatus);
  }

  private fadeVoice(voice: ActiveVoice, fadeSeconds: number) {
    voice.gains.forEach((gain) => {
      const now = gain.context.currentTime;
      const currentGain = Math.max(0.0001, gain.gain.value);
      gain.gain.cancelScheduledValues(now);
      if (fadeSeconds > 0) {
        gain.gain.setValueAtTime(currentGain, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + fadeSeconds);
      }
      else gain.gain.setValueAtTime(0.0001, now);
    });
    return window.setTimeout(() => {
      this.cleanupVoice(voice);
      this.removeTail(voice.soundId, voice.id);
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

  private stopTails(soundId: string, stopFadeSeconds?: number) {
    for (const voice of this.tails.get(soundId) || []) {
      if (!this.disposed && voice.releaseFadeEndsAt !== undefined) {
        // A released Hold voice is still audible during its fade. Stops may
        // shorten that fade, but must neither cut it nor extend its deadline.
        const remaining = Math.max(0, (voice.releaseFadeEndsAt - performance.now()) / 1000);
        const fadeSeconds = Math.min(remaining, stopFadeSeconds ?? voice.fadeOutMs / 1000);
        if (voice.cleanupHandle !== undefined) window.clearTimeout(voice.cleanupHandle);
        voice.releaseFadeEndsAt = performance.now() + fadeSeconds * 1000;
        voice.cleanupHandle = this.fadeVoice(voice, fadeSeconds);
      } else {
        this.cleanupVoice(voice);
        this.removeTail(soundId, voice.id);
      }
    }
  }

  private stopAllTails(stopFadeSeconds?: number) {
    for (const tailId of [...this.tails.keys()]) this.stopTails(tailId, stopFadeSeconds);
  }

  private cleanupVoice(voice: ActiveVoice) {
    if (voice.cleanedUp) return;
    voice.cleanedUp = true;
    // Stop looping sources before cancelling the fade's deferred cleanup.
    for (const source of voice.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    if (voice.cleanupHandle !== undefined) {
      window.clearTimeout(voice.cleanupHandle);
      voice.cleanupHandle = undefined;
    }
    for (const source of voice.sources) {
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
    const playback = [...this.active.values()].flat().map((voice) => ({
      soundId: voice.soundId,
      startedAt: voice.epochStartedAt,
      duration: voice.clipDuration / voice.rate,
      loop: voice.loop
    }));
    this.statusCallback(this.active.size ? "playing" : "idle", [...this.active.keys()], playback);
  }
}
