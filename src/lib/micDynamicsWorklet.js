const toDb = (value) => 20 * Math.log10(Math.max(1e-12, value));
const toGain = (db) => 10 ** (db / 20);
const timeCoefficient = (ms) => Math.exp(-1 / (sampleRate * ms * 0.001));

function updateNumbers(target, params, ranges) {
  if (!params || typeof params !== "object") return;
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (typeof params[key] === "number" && Number.isFinite(params[key])) {
      target[key] = Math.max(min, Math.min(max, params[key]));
    }
  }
}

class DynamicsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reductionDb = 0;
    this.smoothCoefficient = timeCoefficient(10);
    this.meterEnabled = false;
    this.meterSamples = 0;
    this.meterMinimum = 0;
    this.meterInterval = Math.max(1, Math.round(sampleRate * 0.05));
    this.meterMessage = { type: "gr", db: 0 };
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === "params") this.setParams(message.params);
      if (message?.type === "meter" && typeof message.enabled === "boolean") {
        this.meterEnabled = message.enabled;
        this.meterSamples = 0;
        this.meterMinimum = 0;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    for (let index = 0; index < output.length; index += 1) {
      const raw = input?.[index] ?? 0;
      const processed = this.processSample(Number.isFinite(raw) ? raw : 0);
      output[index] = input ? processed : 0;
      if (!this.meterEnabled) continue;
      this.meterMinimum = Math.min(this.meterMinimum, this.reductionDb);
      this.meterSamples += 1;
      if (this.meterSamples >= this.meterInterval) {
        this.meterMessage.db = Math.round(this.meterMinimum * 10) / 10 || 0;
        this.port.postMessage(this.meterMessage);
        this.meterSamples = 0;
        this.meterMinimum = 0;
      }
    }
    return true;
  }
}

class CompressorProcessor extends DynamicsProcessor {
  constructor(options) {
    super();
    this.params = { thresholdDb: -18, ratio: 3, kneeDb: 6, attackMs: 5, releaseMs: 120, makeupDb: 3 };
    this.setParams(options?.processorOptions?.params);
    this.makeupGain = this.makeupTarget;
  }

  setParams(params) {
    updateNumbers(this.params, params, {
      thresholdDb: [-60, 0], ratio: [1, 20], kneeDb: [0, 24],
      attackMs: [0.1, 200], releaseMs: [10, 2000], makeupDb: [0, 24],
    });
    this.attackCoefficient = timeCoefficient(this.params.attackMs);
    this.releaseCoefficient = timeCoefficient(this.params.releaseMs);
    this.makeupTarget = toGain(this.params.makeupDb);
  }

  processSample(input) {
    const { thresholdDb, ratio, kneeDb } = this.params;
    const over = toDb(Math.abs(input)) - thresholdDb;
    const slope = 1 / ratio - 1;
    let target = 0;
    if (over >= kneeDb / 2) target = slope * over;
    else if (over > -kneeDb / 2) target = slope * (over + kneeDb / 2) ** 2 / (2 * kneeDb);
    // Smooth branching peak detector in the gain computer's log domain.
    const coefficient = target < this.reductionDb ? this.attackCoefficient : this.releaseCoefficient;
    this.reductionDb = target + coefficient * (this.reductionDb - target);
    this.makeupGain = this.makeupTarget + this.smoothCoefficient * (this.makeupGain - this.makeupTarget);
    return input * toGain(this.reductionDb) * this.makeupGain;
  }
}

class ExpanderProcessor extends DynamicsProcessor {
  constructor(options) {
    super();
    this.params = { thresholdDb: -45, ratio: 3, attackMs: 2, holdMs: 60, releaseMs: 150, rangeDb: -30, hysteresisDb: 4 };
    this.envelope = 0;
    this.open = false;
    this.holdRemaining = 0;
    this.detectorAttack = timeCoefficient(1);
    this.detectorRelease = timeCoefficient(10);
    this.setParams(options?.processorOptions?.params);
  }

  setParams(params) {
    updateNumbers(this.params, params, {
      thresholdDb: [-80, 0], ratio: [1, 10], attackMs: [0.1, 100], holdMs: [0, 500],
      releaseMs: [10, 2000], rangeDb: [-80, 0], hysteresisDb: [0, 12],
    });
    this.attackCoefficient = timeCoefficient(this.params.attackMs);
    this.releaseCoefficient = timeCoefficient(this.params.releaseMs);
    this.holdSamples = Math.round(this.params.holdMs * sampleRate * 0.001);
    this.holdRemaining = Math.min(this.holdRemaining, this.holdSamples);
  }

  processSample(input) {
    const magnitude = Math.abs(input);
    const detectorCoefficient = magnitude > this.envelope ? this.detectorAttack : this.detectorRelease;
    this.envelope = magnitude + detectorCoefficient * (this.envelope - magnitude);
    const level = toDb(this.envelope);
    const { thresholdDb, hysteresisDb, ratio, rangeDb } = this.params;
    if (level >= thresholdDb) this.open = true;
    if (this.open) {
      if (level >= thresholdDb - hysteresisDb) this.holdRemaining = this.holdSamples;
      else if (this.holdRemaining > 0) this.holdRemaining -= 1;
      else this.open = false;
    }
    const target = this.open ? 0 : Math.max(rangeDb, Math.min(0, (ratio - 1) * (level - thresholdDb)));
    const coefficient = target > this.reductionDb ? this.attackCoefficient : this.releaseCoefficient;
    this.reductionDb = target + coefficient * (this.reductionDb - target);
    return input * toGain(this.reductionDb);
  }
}

class Biquad {
  constructor() {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  configure(frequency, q, highPass) {
    const omega = 2 * Math.PI * Math.min(frequency, sampleRate * 0.45) / sampleRate;
    const cosine = Math.cos(omega);
    const alpha = Math.sin(omega) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (highPass ? (1 + cosine) / 2 : alpha) / a0;
    this.b1 = highPass ? -(1 + cosine) / a0 : 0;
    this.b2 = highPass ? this.b0 : -this.b0;
    this.a1 = -2 * cosine / a0;
    this.a2 = (1 - alpha) / a0;
  }

  processSample(input) {
    const output = this.b0 * input + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = output;
    return output;
  }
}

class DeesserProcessor extends DynamicsProcessor {
  constructor(options) {
    super();
    this.params = { frequencyHz: 6500, thresholdDb: -30, maxReductionDb: 6, mode: "split" };
    this.bandPass = new Biquad();
    this.highPass = new Biquad();
    this.envelopeDb = -240;
    this.detectorAttack = timeCoefficient(1);
    this.detectorRelease = timeCoefficient(60);
    this.setParams(options?.processorOptions?.params);
    this.wideMix = this.wideTarget;
  }

  setParams(params) {
    const previousFrequency = this.frequency;
    updateNumbers(this.params, params, { frequencyHz: [2000, 12000], thresholdDb: [-60, 0], maxReductionDb: [0, 18] });
    if (params?.mode === "split" || params?.mode === "wide") this.params.mode = params.mode;
    this.wideTarget = this.params.mode === "wide" ? 1 : 0;
    this.frequency = this.params.frequencyHz;
    if (this.frequency !== previousFrequency) {
      // RBJ constant-peak band-pass and Butterworth high-pass; keep filter history.
      this.bandPass.configure(this.frequency, 1.4, false);
      this.highPass.configure(this.frequency * 0.7, Math.SQRT1_2, true);
    }
  }

  processSample(input) {
    const level = toDb(Math.abs(this.bandPass.processSample(input)));
    const coefficient = level > this.envelopeDb ? this.detectorAttack : this.detectorRelease;
    this.envelopeDb = level + coefficient * (this.envelopeDb - level);
    const target = -Math.min(this.params.maxReductionDb, Math.max(0, (this.envelopeDb - this.params.thresholdDb) * 0.75));
    this.reductionDb = target + this.detectorAttack * (this.reductionDb - target);
    const gain = toGain(this.reductionDb);
    const high = this.highPass.processSample(input);
    this.wideMix = this.wideTarget + this.smoothCoefficient * (this.wideMix - this.wideTarget);
    // input - high reconstructs perfectly at unity gain, including phase.
    return input + (high + (input - high) * this.wideMix) * (gain - 1);
  }
}

// Intersample peaks are estimated at 4x by a Hann-windowed sinc over 8 neighbouring samples,
// so the ceiling holds once the signal is reconstructed, not just at the sample points.
const TRUE_PEAK_TAPS = 8;
const TRUE_PEAK_DELAY = TRUE_PEAK_TAPS / 2;
const TRUE_PEAK_PHASES = [0.25, 0.5, 0.75].map((fraction) => {
  const weights = Array.from({ length: TRUE_PEAK_TAPS }, (_, tap) => {
    const distance = tap - (TRUE_PEAK_DELAY - 1) - fraction;
    const sinc = distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance);
    return sinc * 0.5 * (1 + Math.cos((Math.PI * distance) / TRUE_PEAK_DELAY));
  });
  const sum = weights.reduce((total, weight) => total + weight, 0);
  return Float64Array.from(weights, (weight) => weight / sum);
});

class LimiterProcessor extends DynamicsProcessor {
  constructor(options) {
    super();
    this.params = { ceilingDb: -1, releaseMs: 60, lookaheadMs: 3 };
    this.capacity = Math.ceil(sampleRate * 0.005) + 2;
    this.delay = new Float32Array(this.capacity);
    this.dequeGains = new Float64Array(this.capacity);
    this.dequeIndices = new Float64Array(this.capacity);
    this.history = new Float64Array(TRUE_PEAK_TAPS);
    this.historyPosition = 0;
    this.previousSegmentPeak = 0;
    this.setParams(options?.processorOptions?.params);
  }

  setParams(params) {
    updateNumbers(this.params, params, { ceilingDb: [-12, 0], releaseMs: [5, 1000], lookaheadMs: [1, 5] });
    const ceiling = toGain(this.params.ceilingDb);
    // Float32 output rounding must never lift a clamped sample above the ceiling.
    this.ceiling = Math.fround(ceiling);
    if (this.ceiling > ceiling) this.ceiling = Math.fround(ceiling - 2 ** -24);
    this.releaseCoefficient = timeCoefficient(this.params.releaseMs);
    const lookahead = Math.max(1, Math.round(sampleRate * this.params.lookaheadMs * 0.001));
    if (lookahead !== this.lookahead) {
      this.lookahead = lookahead;
      this.delay.fill(0);
      this.delayPosition = 0;
      this.sequence = 0;
      this.head = 0;
      this.count = 0;
      this.gain = 1;
      this.history.fill(0);
      this.previousSegmentPeak = 0;
    }
  }

  /** Peak of the sample TRUE_PEAK_DELAY back and the reconstructed signal on either side of it. */
  detectPeak(input) {
    const history = this.history;
    history[this.historyPosition] = input;
    this.historyPosition = (this.historyPosition + 1) % TRUE_PEAK_TAPS;
    let segmentPeak = 0;
    for (const weights of TRUE_PEAK_PHASES) {
      let value = 0;
      for (let tap = 0; tap < TRUE_PEAK_TAPS; tap += 1) value += weights[tap] * history[(this.historyPosition + tap) % TRUE_PEAK_TAPS];
      segmentPeak = Math.max(segmentPeak, Math.abs(value));
    }
    const sample = Math.abs(history[(this.historyPosition + TRUE_PEAK_DELAY - 1) % TRUE_PEAK_TAPS]);
    const peak = Math.max(sample, segmentPeak, this.previousSegmentPeak);
    this.previousSegmentPeak = segmentPeak;
    return peak;
  }

  processSample(input) {
    const delayed = this.delay[this.delayPosition];
    this.delay[this.delayPosition] = input;
    this.delayPosition = (this.delayPosition + 1) % this.lookahead;
    const earliest = this.sequence - this.lookahead;
    while (this.count > 0 && this.dequeIndices[this.head] < earliest) {
      this.head = (this.head + 1) % this.capacity;
      this.count -= 1;
    }
    // Detection runs TRUE_PEAK_DELAY samples behind the input, still well ahead of the output.
    const required = Math.min(1, this.ceiling / Math.max(1e-12, this.detectPeak(input)));
    while (this.count > 0) {
      const tail = (this.head + this.count - 1) % this.capacity;
      if (this.dequeGains[tail] <= required) break;
      this.count -= 1;
    }
    const next = (this.head + this.count) % this.capacity;
    this.dequeGains[next] = required;
    this.dequeIndices[next] = this.sequence;
    this.count += 1;
    const target = this.dequeGains[this.head];
    if (target < this.gain) {
      // A fixed slope reaches each target within the delay, even if a later,
      // stronger peak replaces it at the front of the deque.
      this.gain = Math.max(target, this.gain - (1 - target) / (this.lookahead - TRUE_PEAK_DELAY + 1));
    } else {
      this.gain = Math.min(target, 1 + this.releaseCoefficient * (this.gain - 1));
    }
    this.sequence += 1;
    const scaled = delayed * this.gain;
    const output = Math.max(-this.ceiling, Math.min(this.ceiling, scaled));
    const appliedGain = delayed === 0 ? this.gain : Math.min(this.gain, Math.abs(output / delayed));
    this.reductionDb = toDb(appliedGain);
    return output;
  }
}

registerProcessor("sounddeck-compressor", CompressorProcessor);
registerProcessor("sounddeck-expander", ExpanderProcessor);
registerProcessor("sounddeck-deesser", DeesserProcessor);
registerProcessor("sounddeck-limiter", LimiterProcessor);
