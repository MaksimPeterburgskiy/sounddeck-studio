import type { MicCompressorParams, MicEqParams, MicExpanderParams, MicHighPassParams, MicLimiterParams } from "../types";
import { EQ_BAND_KINDS } from "./micFilters";

const SAMPLE_RATE = 48000;

/** Butterworth section Qs (linear) for the high-pass filter at each slope. */
export const HIGH_PASS_QS = { 12: [Math.SQRT1_2], 24: [0.5412, 1.3066] } as const;

/** Web Audio reads a high-pass Q in dB rather than as a plain ratio. */
export function highPassQToDb(q: number) {
  return 20 * Math.log10(q);
}

type BiquadKind = "lowshelf" | "highshelf" | "peaking" | "highpass";

/** Magnitude response in dB of a Web Audio BiquadFilterNode (Audio EQ Cookbook formulas, shelf slope 1). */
export function biquadMagnitudeDb(kind: BiquadKind, frequencyHz: number, cutoffHz: number, gainDb: number, q: number, sampleRate = SAMPLE_RATE) {
  const w0 = (2 * Math.PI * Math.min(cutoffHz, sampleRate / 2 - 1)) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const A = 10 ** (gainDb / 40);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (kind === "peaking") {
    const alpha = sin / (2 * q);
    [b0, b1, b2, a0, a1, a2] = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A];
  } else if (kind === "highpass") {
    const alpha = sin / (2 * q);
    [b0, b1, b2, a0, a1, a2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha];
  } else {
    const shelf = 2 * Math.sqrt(A) * (sin / 2) * Math.SQRT2;
    const sign = kind === "lowshelf" ? 1 : -1;
    b0 = A * ((A + 1) - sign * (A - 1) * cos + shelf);
    b1 = sign * 2 * A * ((A - 1) - sign * (A + 1) * cos);
    b2 = A * ((A + 1) - sign * (A - 1) * cos - shelf);
    a0 = (A + 1) + sign * (A - 1) * cos + shelf;
    a1 = -sign * 2 * ((A - 1) + sign * (A + 1) * cos);
    a2 = (A + 1) + sign * (A - 1) * cos - shelf;
  }
  const w = (2 * Math.PI * frequencyHz) / sampleRate;
  const [c1, s1, c2, s2] = [Math.cos(w), Math.sin(w), Math.cos(2 * w), Math.sin(2 * w)];
  const numerator = (b0 + b1 * c1 + b2 * c2) ** 2 + (b1 * s1 + b2 * s2) ** 2;
  const denominator = (a0 + a1 * c1 + a2 * c2) ** 2 + (a1 * s1 + a2 * s2) ** 2;
  return 10 * Math.log10(numerator / denominator);
}

export function eqResponseDb(params: MicEqParams, frequencyHz: number) {
  return params.bands.reduce((total, band, index) => {
    if (!band.enabled || band.gainDb === 0) return total;
    return total + biquadMagnitudeDb(EQ_BAND_KINDS[index], frequencyHz, band.frequencyHz, band.gainDb, band.q);
  }, 0);
}

export function highPassResponseDb(params: MicHighPassParams, frequencyHz: number) {
  return HIGH_PASS_QS[params.slope].reduce((total, q) => total + biquadMagnitudeDb("highpass", frequencyHz, params.frequencyHz, 0, q), 0);
}

/** Static output level for an input level, matching the worklet gain computers. */
export function compressorCurveDb(params: MicCompressorParams, inputDb: number) {
  const { thresholdDb: threshold, ratio, kneeDb: knee, makeupDb } = params;
  const over = inputDb - threshold;
  let output = inputDb;
  if (knee > 0 && Math.abs(over) <= knee / 2) output = inputDb + ((1 / ratio - 1) * (over + knee / 2) ** 2) / (2 * knee);
  else if (over > 0) output = threshold + over / ratio;
  return output + makeupDb;
}

export function expanderCurveDb(params: MicExpanderParams, inputDb: number) {
  const below = inputDb - params.thresholdDb;
  return below >= 0 ? inputDb : inputDb + Math.max(below * (params.ratio - 1), params.rangeDb);
}

export function limiterCurveDb(params: MicLimiterParams, inputDb: number) {
  return Math.min(inputDb, params.ceilingDb);
}
