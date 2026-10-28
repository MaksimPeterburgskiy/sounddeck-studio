import type { AudioSettings, MicChainEntry, MicFilter, MicFilterParamsByType, NoiseSuppressionModelId } from "../types";
import { HIGH_PASS_QS, highPassQToDb } from "./micCurves";
import { EQ_BAND_KINDS, isMicFilter, micChainEntryEnabled, micFilterLatencyMs } from "./micFilters";
import { noiseSuppressionLatencyMs, noiseSuppressionModelInfo } from "./noiseSuppressionModels";

export type NoiseSuppressionState = "loading" | "active" | "unavailable";

export interface MicMeterReading {
  inputDb: number;
  outputDb: number;
  /** Gain reduction (≤ 0 dB) for each dynamics filter in the chain, by filter id. */
  gainReductionDb: Record<string, number>;
}

type ChainSettings = Pick<AudioSettings, "micChain" | "noiseSuppressionModel" | "noiseSuppressionEnabled" | "noiseSuppressionAttenuationDb">;

interface FilterUnit {
  input: AudioNode;
  output: AudioNode;
  latencyMs: number;
  gainReductionDb?: number;
  update(entry: MicChainEntry, settings: ChainSettings): void;
  setMetering(enabled: boolean): void;
  dispose(): void;
}

const CROSSFADE_SEC = 0.02;
const REWIRE_FADE_SEC = 0.006;
const PARAM_TIME_CONSTANT = 0.015;
const SILENCE_DB = -100;

const workletNames = {
  compressor: "sounddeck-compressor",
  expander: "sounddeck-expander",
  deEsser: "sounddeck-deesser",
  limiter: "sounddeck-limiter"
} as const;

/** Peak level of the analyser's latest window in dBFS, floored at -100. */
export function analyserPeakDb(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(buffer);
  let peak = 0;
  for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
  return peak > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(peak)) : SILENCE_DB;
}

function dbToGain(db: number) {
  return 10 ** (db / 20);
}

/**
 * One position in the chain. The dry path is always wired, so switching a filter on or off is a
 * crossfade between dry and wet with no rewiring. The filter itself only exists while it's on.
 */
interface ChainSlot {
  input: GainNode;
  output: GainNode;
  dry: GainNode;
  wet: GainNode;
  enabled: boolean;
  unit?: FilterUnit;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The live mic filter chain: one 48 kHz context holding every filter in user order. Parameter
 * edits go straight to the running nodes and on/off switches crossfade in place. Adding,
 * removing, or reordering rewires behind a short fade. None of it reopens the microphone.
 */
export class MicChain {
  readonly destination: MediaStreamAudioDestinationNode;
  private readonly input: GainNode;
  private readonly fade: GainNode;
  private readonly inputAnalyser: AnalyserNode;
  private readonly outputAnalyser: AnalyserNode;
  private readonly meterBuffer: Float32Array<ArrayBuffer>;
  private source?: MediaStreamAudioSourceNode;
  private sourceStream?: MediaStream;
  private slots = new Map<string, ChainSlot>();
  private wired: ChainSlot[] = [];
  private edges: Array<[AudioNode, AudioNode]> = [];
  private pending?: ChainSlot[];
  private retired: ChainSlot[] = [];
  private rewireTimer?: ReturnType<typeof setTimeout>;
  private metering = false;
  private disposed = false;
  private noiseSuppression?: NoiseSuppressionState;
  private noiseSuppressionUnit?: FilterUnit;
  private applied = false;

  static async create(onChange: () => void) {
    const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    try {
      await Promise.all([
        context.audioWorklet.addModule(new URL("./deepFilterWorklet.js", import.meta.url)),
        context.audioWorklet.addModule(new URL("./micDynamicsWorklet.js", import.meta.url))
      ]);
      await context.resume();
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
    return new MicChain(context, onChange);
  }

  private constructor(readonly context: AudioContext, private readonly onChange: () => void) {
    this.input = context.createGain();
    this.fade = context.createGain();
    this.destination = context.createMediaStreamDestination();
    this.inputAnalyser = context.createAnalyser();
    this.outputAnalyser = context.createAnalyser();
    this.inputAnalyser.fftSize = 2048;
    this.outputAnalyser.fftSize = 2048;
    this.meterBuffer = new Float32Array(2048);
    this.input.connect(this.inputAnalyser);
    this.fade.connect(this.destination);
    this.fade.connect(this.outputAnalyser);
    this.connect([]);
  }

  get noiseSuppressionState() {
    return this.noiseSuppression;
  }

  /** Total delay the enabled filters add, in milliseconds. */
  get latencyMs() {
    let total = 0;
    for (const slot of this.slots.values()) if (slot.enabled && slot.unit) total += slot.unit.latencyMs;
    return total;
  }

  setSource(stream: MediaStream | undefined) {
    if (stream === this.sourceStream) return;
    this.source?.disconnect();
    this.source = undefined;
    this.sourceStream = stream;
    if (!stream) return;
    this.source = this.context.createMediaStreamSource(stream);
    this.source.connect(this.input);
  }

  apply(settings: ChainSettings) {
    if (this.disposed) return;
    const next: ChainSlot[] = [];
    const keep = new Set<string>();
    for (const entry of settings.micChain) {
      const key = `${entry.type}:${entry.id}${entry.type === "noiseSuppression" ? `:${settings.noiseSuppressionModel}` : ""}`;
      let slot = this.slots.get(key);
      const created = !slot;
      if (!slot) {
        slot = this.createSlot();
        this.slots.set(key, slot);
      }
      // New slots are silent until the rewire fade brings them in, so they switch on at once.
      this.setSlotEnabled(slot, entry, settings, created || !this.applied);
      keep.add(key);
      next.push(slot);
    }
    for (const [key, slot] of this.slots) {
      if (keep.has(key)) continue;
      this.slots.delete(key);
      this.retired.push(slot);
    }
    if (!this.applied) {
      this.applied = true;
      this.connect(next);
      return;
    }
    const current = this.pending ?? this.wired;
    if (next.length !== current.length || next.some((slot, index) => slot !== current[index])) this.rewire(next);
  }

  setMetering(enabled: boolean) {
    this.metering = enabled;
    for (const slot of this.slots.values()) slot.unit?.setMetering(enabled);
  }

  readMeters(): MicMeterReading {
    const gainReductionDb: Record<string, number> = {};
    for (const [key, slot] of this.slots) {
      if (slot.enabled && slot.unit?.gainReductionDb !== undefined) gainReductionDb[key.slice(key.indexOf(":") + 1)] = slot.unit.gainReductionDb;
    }
    return {
      inputDb: analyserPeakDb(this.inputAnalyser, this.meterBuffer),
      outputDb: analyserPeakDb(this.outputAnalyser, this.meterBuffer),
      gainReductionDb
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rewireTimer !== undefined) clearTimeout(this.rewireTimer);
    this.source?.disconnect();
    for (const slot of [...this.slots.values(), ...this.retired]) this.disposeSlot(slot);
    this.slots.clear();
    this.retired = [];
    this.destination.stream.getTracks().forEach((track) => track.stop());
    void this.context.close().catch(() => undefined);
  }

  private createSlot(): ChainSlot {
    const slot: ChainSlot = {
      input: this.context.createGain(),
      output: this.context.createGain(),
      dry: this.context.createGain(),
      wet: this.context.createGain(),
      enabled: false
    };
    slot.wet.gain.value = 0;
    slot.input.connect(slot.dry).connect(slot.output);
    slot.wet.connect(slot.output);
    return slot;
  }

  private setSlotEnabled(slot: ChainSlot, entry: MicChainEntry, settings: ChainSettings, immediate: boolean) {
    const enabled = micChainEntryEnabled(entry, settings);
    if (enabled) {
      if (slot.releaseTimer !== undefined) clearTimeout(slot.releaseTimer);
      slot.releaseTimer = undefined;
      if (slot.unit) slot.unit.update(entry, settings);
      else {
        const unit = this.createUnit(entry, settings);
        unit.setMetering(this.metering);
        slot.input.connect(unit.input);
        unit.output.connect(slot.wet);
        slot.unit = unit;
      }
    }
    if (enabled === slot.enabled) return;
    slot.enabled = enabled;
    this.crossfade(slot.wet.gain, enabled ? 1 : 0, immediate);
    this.crossfade(slot.dry.gain, enabled ? 0 : 1, immediate);
    // Keep a switched-off filter running until its fade-out finishes, then free it.
    if (!enabled && slot.unit) slot.releaseTimer = setTimeout(() => this.releaseUnit(slot), CROSSFADE_SEC * 1000 + 20);
  }

  private crossfade(param: AudioParam, target: number, immediate: boolean) {
    const now = this.context.currentTime;
    param.cancelScheduledValues(now);
    if (immediate) {
      param.setValueAtTime(target, now);
      return;
    }
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + CROSSFADE_SEC);
  }

  private releaseUnit(slot: ChainSlot) {
    slot.releaseTimer = undefined;
    const unit = slot.unit;
    if (!unit || slot.enabled) return;
    slot.unit = undefined;
    try {
      slot.input.disconnect(unit.input);
    } catch {
      // Already disconnected.
    }
    unit.dispose();
    if (unit === this.noiseSuppressionUnit) {
      this.noiseSuppressionUnit = undefined;
      this.noiseSuppression = undefined;
    }
  }

  private disposeSlot(slot: ChainSlot) {
    if (slot.releaseTimer !== undefined) clearTimeout(slot.releaseTimer);
    slot.enabled = false;
    this.releaseUnit(slot);
    for (const node of [slot.input, slot.dry, slot.wet, slot.output]) node.disconnect();
  }

  /** Fade out, swap the wiring, fade back in. */
  private rewire(next: ChainSlot[]) {
    this.pending = next;
    if (this.rewireTimer !== undefined) return;
    const fade = this.fade.gain;
    const now = this.context.currentTime;
    fade.cancelScheduledValues(now);
    fade.setValueAtTime(fade.value, now);
    fade.linearRampToValueAtTime(0, now + REWIRE_FADE_SEC);
    this.rewireTimer = setTimeout(() => {
      this.rewireTimer = undefined;
      if (this.disposed || !this.pending) return;
      this.connect(this.pending);
      this.pending = undefined;
      const resume = this.context.currentTime;
      fade.cancelScheduledValues(resume);
      fade.setValueAtTime(0, resume);
      fade.linearRampToValueAtTime(1, resume + REWIRE_FADE_SEC);
    }, REWIRE_FADE_SEC * 1000 + 2);
  }

  private connect(slots: ChainSlot[]) {
    for (const [from, to] of this.edges) {
      try {
        from.disconnect(to);
      } catch {
        // Already disconnected.
      }
    }
    this.edges = [];
    let tail: AudioNode = this.input;
    for (const slot of slots) {
      tail.connect(slot.input);
      this.edges.push([tail, slot.input]);
      tail = slot.output;
    }
    tail.connect(this.fade);
    this.edges.push([tail, this.fade]);
    this.wired = slots;
    for (const slot of this.retired) this.disposeSlot(slot);
    this.retired = [];
  }

  private createUnit(entry: MicChainEntry, settings: ChainSettings): FilterUnit {
    if (!isMicFilter(entry)) {
      const unit = this.createNoiseSuppressionUnit(settings.noiseSuppressionModel, settings.noiseSuppressionAttenuationDb);
      this.noiseSuppressionUnit = unit;
      return unit;
    }
    switch (entry.type) {
      case "highPass": return this.createHighPassUnit(entry.params);
      case "eq": return this.createEqUnit(entry.params);
      case "gain": return this.createGainUnit(entry.params);
      default: return this.createDynamicsUnit(entry);
    }
  }

  private smooth(param: AudioParam, value: number) {
    const now = this.context.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, PARAM_TIME_CONSTANT);
  }

  private createHighPassUnit(initial: MicFilterParamsByType["highPass"]): FilterUnit {
    // Two cascaded biquads give 24 dB/oct Butterworth; at 12 dB/oct the second becomes an all-pass.
    const first = this.context.createBiquadFilter();
    const second = this.context.createBiquadFilter();
    first.type = "highpass";
    first.connect(second);
    const set = (params: MicFilterParamsByType["highPass"], smooth: boolean) => {
      second.type = params.slope === 24 ? "highpass" : "allpass";
      const qs = params.slope === 24 ? HIGH_PASS_QS[24].map(highPassQToDb) : [highPassQToDb(HIGH_PASS_QS[12][0]), 0.5];
      for (const [index, filter] of [first, second].entries()) {
        if (smooth) {
          this.smooth(filter.frequency, params.frequencyHz);
          this.smooth(filter.Q, qs[index]);
        } else {
          filter.frequency.value = params.frequencyHz;
          filter.Q.value = qs[index];
        }
      }
    };
    set(initial, false);
    return {
      input: first,
      output: second,
      latencyMs: 0,
      update: (entry) => {
        if (entry.type === "highPass") set(entry.params, true);
      },
      setMetering: () => undefined,
      dispose: () => {
        first.disconnect();
        second.disconnect();
      }
    };
  }

  private createEqUnit(initial: MicFilterParamsByType["eq"]): FilterUnit {
    const filters = EQ_BAND_KINDS.map((kind) => {
      const filter = this.context.createBiquadFilter();
      filter.type = kind;
      return filter;
    });
    for (let index = 1; index < filters.length; index += 1) filters[index - 1].connect(filters[index]);
    const set = (params: MicFilterParamsByType["eq"], smooth: boolean) => {
      params.bands.forEach((band, index) => {
        const filter = filters[index];
        if (!filter) return;
        const gain = band.enabled ? band.gainDb : 0;
        if (smooth) {
          this.smooth(filter.frequency, band.frequencyHz);
          this.smooth(filter.gain, gain);
          this.smooth(filter.Q, band.q);
        } else {
          filter.frequency.value = band.frequencyHz;
          filter.gain.value = gain;
          filter.Q.value = band.q;
        }
      });
    };
    set(initial, false);
    return {
      input: filters[0],
      output: filters[filters.length - 1],
      latencyMs: 0,
      update: (entry) => {
        if (entry.type === "eq") set(entry.params, true);
      },
      setMetering: () => undefined,
      dispose: () => filters.forEach((filter) => filter.disconnect())
    };
  }

  private createGainUnit(initial: MicFilterParamsByType["gain"]): FilterUnit {
    const gain = this.context.createGain();
    gain.gain.value = dbToGain(initial.gainDb);
    return {
      input: gain,
      output: gain,
      latencyMs: 0,
      update: (entry) => {
        if (entry.type === "gain") this.smooth(gain.gain, dbToGain(entry.params.gainDb));
      },
      setMetering: () => undefined,
      dispose: () => gain.disconnect()
    };
  }

  private createDynamicsUnit(initial: Extract<MicFilter, { type: keyof typeof workletNames }>): FilterUnit {
    const node = new AudioWorkletNode(this.context, workletNames[initial.type], {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { params: initial.params }
    });
    let applied = JSON.stringify(initial.params);
    const unit: FilterUnit = {
      input: node,
      output: node,
      latencyMs: micFilterLatencyMs(initial),
      gainReductionDb: 0,
      update: (entry) => {
        if (entry.type !== initial.type) return;
        const next = JSON.stringify(entry.params);
        if (next === applied) return;
        applied = next;
        unit.latencyMs = micFilterLatencyMs(entry);
        node.port.postMessage({ type: "params", params: entry.params });
      },
      setMetering: (enabled) => {
        if (!enabled) unit.gainReductionDb = 0;
        node.port.postMessage({ type: "meter", enabled });
      },
      dispose: () => {
        node.port.onmessage = null;
        node.disconnect();
      }
    };
    node.port.onmessage = (event: MessageEvent<{ type?: string; db?: number }>) => {
      if (event.data?.type === "gr" && typeof event.data.db === "number") unit.gainReductionDb = event.data.db;
    };
    return unit;
  }

  private createNoiseSuppressionUnit(modelId: NoiseSuppressionModelId, attenuationDb: number): FilterUnit {
    const model = noiseSuppressionModelInfo(modelId);
    const node = new AudioWorkletNode(this.context, "sounddeck-deep-filter", {
      processorOptions: { frameLength: model.frameLength, latencySamples: model.latencySamples },
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    });
    const worker = modelId === "dfn3"
      ? new Worker(new URL("./deepFilterWorker.ts", import.meta.url), { type: "module", name: "sounddeck-deep-filter" })
      : new Worker(new URL("./onnxNoiseWorker.ts", import.meta.url), { type: "module", name: `sounddeck-${modelId}` });
    const channel = new MessageChannel();
    let disposed = false;
    let appliedAttenuation = attenuationDb;
    const unit: FilterUnit = {
      input: node,
      output: node,
      latencyMs: 0,
      update: (_entry, settings) => {
        if (modelId !== "dfn3" || settings.noiseSuppressionAttenuationDb === appliedAttenuation) return;
        appliedAttenuation = settings.noiseSuppressionAttenuationDb;
        worker.postMessage({ type: "attenuation", value: appliedAttenuation });
      },
      setMetering: () => undefined,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        worker.postMessage({ type: "dispose" });
        worker.terminate();
        node.port.onmessage = null;
        node.disconnect();
      }
    };
    const setState = (state: NoiseSuppressionState) => {
      if (disposed || this.noiseSuppressionUnit !== unit) return;
      if (state === "active") unit.latencyMs = noiseSuppressionLatencyMs(modelId);
      if (this.noiseSuppression === state) return;
      this.noiseSuppression = state;
      this.onChange();
    };
    node.port.postMessage({ type: "connect", port: channel.port1 }, [channel.port1]);
    node.port.onmessage = (event: MessageEvent<{ type: "error" | "underrun" | "recovered"; message?: string }>) => {
      if (event.data?.type === "error") console.warn("Noise suppression audio worklet failed", event.data.message);
      if (event.data?.type === "error" || event.data?.type === "underrun") setState("unavailable");
      if (event.data?.type === "recovered") setState("active");
    };
    worker.onmessage = (event: MessageEvent<{ type: "ready" | "error"; message?: string }>) => {
      if (event.data?.type === "ready") setState("active");
      if (event.data?.type === "error") {
        console.warn("Noise suppression worker failed", event.data.message);
        setState("unavailable");
      }
    };
    worker.onerror = (event) => {
      console.warn("Noise suppression worker crashed", event.message);
      setState("unavailable");
    };
    this.noiseSuppression = "loading";
    void window.sounddeck.getNoiseSuppressionAssets(modelId).then(({ wasm, model }) => {
      if (disposed) {
        channel.port2.close();
        return;
      }
      worker.postMessage({ type: "init", modelId, port: channel.port2, wasm, model, attenuationDb: appliedAttenuation }, [channel.port2, wasm, model]);
    }).catch((error) => {
      console.warn("Noise suppression assets could not be loaded", error);
      setState("unavailable");
    });
    return unit;
  }
}
