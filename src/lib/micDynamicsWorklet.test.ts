import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SAMPLE_RATE = 48000;
type Params = Record<string, unknown>;
type Processor = {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};
type ProcessorConstructor = new (options?: { processorOptions: { params: Params } }) => Processor;

async function loadProcessors() {
  const processors = new Map<string, ProcessorConstructor>();
  class FakeProcessorBase {
    port = { onmessage: null, postMessage: vi.fn() };
  }
  vi.stubGlobal("sampleRate", SAMPLE_RATE);
  vi.stubGlobal("AudioWorkletProcessor", FakeProcessorBase);
  vi.stubGlobal("registerProcessor", vi.fn((name: string, processor: ProcessorConstructor) => {
    processors.set(name, processor);
  }));
  await import("./micDynamicsWorklet.js");
  return Object.assign((name: string, params: Params = {}) => {
    const Constructor = processors.get(`sounddeck-${name}`);
    if (!Constructor) throw new Error(`Missing processor ${name}`);
    return new Constructor({ processorOptions: { params } });
  }, { names: Array.from(processors.keys()) });
}

function render(processor: Processor, length: number, signal: (index: number) => number) {
  const result = new Float32Array(length);
  for (let offset = 0; offset < length; offset += 128) {
    const size = Math.min(128, length - offset);
    const input = Float32Array.from({ length: size }, (_, index) => signal(offset + index));
    const output = new Float32Array(size);
    expect(processor.process([[input]], [[output]])).toBe(true);
    result.set(output, offset);
  }
  return result;
}

const amplitude = (db: number) => 10 ** (db / 20);
const tone = (frequency: number, peak: number) => (index: number) => peak * Math.sin(2 * Math.PI * frequency * index / SAMPLE_RATE);
function rms(samples: Float32Array, start = 0) {
  let sum = 0;
  for (let index = start; index < samples.length; index += 1) sum += samples[index] ** 2;
  return Math.sqrt(sum / (samples.length - start));
}
function toneGainDb(processor: Processor, frequency: number, peak: number) {
  const output = render(processor, SAMPLE_RATE * 2, tone(frequency, peak));
  return 20 * Math.log10(rms(output, SAMPLE_RATE) / (peak / Math.SQRT2));
}
function message(processor: Processor, data: unknown) {
  processor.port.onmessage({ data });
}

describe("Microphone dynamics audio worklets", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("registers all four processors and handles missing input and invalid params", async () => {
    const create = await loadProcessors();
    expect(create.names).toEqual([
      "sounddeck-compressor", "sounddeck-expander", "sounddeck-deesser", "sounddeck-limiter",
    ]);
    for (const name of ["compressor", "expander", "deesser", "limiter"]) {
      const processor = create(name, { thresholdDb: NaN, ratio: Infinity, mode: "bad", lookaheadMs: -100 });
      message(processor, { type: "params", params: null });
      message(processor, { type: "params", params: { thresholdDb: "loud", releaseMs: NaN, unknown: 42 } });
      message(processor, null);
      render(processor, 128, () => 1);
      const output = new Float32Array(128).fill(1);
      expect(processor.process([[]], [[output]])).toBe(true);
      expect(output.every((sample) => sample === 0)).toBe(true);
      expect(processor.process([], [])).toBe(true);
      expect(render(processor, 128, () => 0.1).every(Number.isFinite)).toBe(true);
    }
  });

  it("limits loud tones and isolated transients at every lookahead without exceeding the ceiling", async () => {
    const create = await loadProcessors();
    for (const ceilingDb of [-12, -1, -0.1, 0]) {
      for (const lookaheadMs of [1, 3, 5]) {
        const processor = create("limiter", { ceilingDb, lookaheadMs });
        const sine = tone(997, 2.5);
        const output = render(processor, 12000, (index) => index % 977 === 0 ? -4 : sine(index));
        expect(output.every((sample) => Math.abs(sample) <= amplitude(ceilingDb))).toBe(true);
      }
    }
    const processor = create("limiter", { lookaheadMs: 3 });
    const output = render(processor, 2048, (index) => index === 512 ? 4 : 0.2);
    expect(output[655]).toBeLessThan(output[600]);
    expect(output[600]).toBeLessThan(output[512]);
    expect(output[656]).toBeCloseTo(amplitude(-1), 6);
  });

  it("passes quiet audio through with the exact delay, including a lookahead update", async () => {
    const create = await loadProcessors();
    const processor = create("limiter", { lookaheadMs: 3 });
    for (const lookaheadMs of [3, 1, 5]) {
      message(processor, { type: "params", params: { lookaheadMs } });
      const signal = tone(431, 0.2);
      const output = render(processor, 4096, signal);
      const delay = Math.round(SAMPLE_RATE * lookaheadMs / 1000);
      const expected = Float32Array.from({ length: output.length }, (_, index) => index < delay ? 0 : signal(index - delay));
      expect(output).toEqual(expected);
    }
  });

  it("compresses above threshold, follows the soft knee, and applies only makeup below it", async () => {
    const create = await loadProcessors();
    const gainDb = toneGainDb(create("compressor", { thresholdDb: -18, ratio: 3, kneeDb: 6, makeupDb: 0 }), 1000, amplitude(-6));
    // The branching peak detector releases slightly between a sine's peaks.
    expect(Math.abs(gainDb - -8)).toBeLessThan(1);
    expect(toneGainDb(create("compressor", { makeupDb: 6 }), 1000, amplitude(-30))).toBeCloseTo(6, 3);
    const knee = render(create("compressor", { thresholdDb: -18, ratio: 4, kneeDb: 12, makeupDb: 0 }), SAMPLE_RATE, () => amplitude(-18));
    expect(20 * Math.log10(knee[knee.length - 1] / amplitude(-18))).toBeCloseTo(-1.125, 3);
  });

  it("expands quiet speech down to its range, follows the ratio, and passes loud speech", async () => {
    const create = await loadProcessors();
    expect(toneGainDb(create("expander"), 1000, amplitude(-70))).toBeCloseTo(-30, 1);
    expect(toneGainDb(create("expander"), 1000, amplitude(-20))).toBeCloseTo(0, 3);
    const output = render(create("expander", { thresholdDb: -40, ratio: 3, rangeDb: -40 }), SAMPLE_RATE * 2, () => amplitude(-50));
    expect(20 * Math.log10(output[output.length - 1] / amplitude(-50))).toBeCloseTo(-20, 2);
  });

  it("holds the expander open across hysteresis and brief pauses before closing", async () => {
    const create = await loadProcessors();
    const processor = create("expander", { thresholdDb: -30, hysteresisDb: 6, holdMs: 60, releaseMs: 10 });
    render(processor, 14400, () => amplitude(-20));
    const between = render(processor, 14400, () => amplitude(-33));
    expect(between[between.length - 1]).toBeCloseTo(amplitude(-33), 6);
    const pause = render(processor, 1440, () => amplitude(-60));
    expect(pause[pause.length - 1]).toBeCloseTo(amplitude(-60), 7);
    const closed = render(processor, 14400, () => amplitude(-60));
    expect(closed[closed.length - 1] / amplitude(-60)).toBeCloseTo(amplitude(-30), 4);
  });

  it("de-esses sibilance while preserving low tones in split mode and supports wide mode", async () => {
    const create = await loadProcessors();
    const params = { frequencyHz: 8000, thresholdDb: -30, maxReductionDb: 6 };
    expect(toneGainDb(create("deesser", params), 8000, amplitude(-12))).toBeLessThan(-1);
    expect(toneGainDb(create("deesser", params), 200, amplitude(-12))).toBeCloseTo(0, 2);
    expect(toneGainDb(create("deesser", { ...params, mode: "wide" }), 8000, amplitude(-12))).toBeCloseTo(-6, 2);
    expect(toneGainDb(create("deesser", { ...params, maxReductionDb: 0 }), 8000, amplitude(-12))).toBeCloseTo(0, 5);
  });

  it("updates compressor behavior through params messages and smoothly changes makeup", async () => {
    const create = await loadProcessors();
    const processor = create("compressor", { thresholdDb: -30, makeupDb: 0, releaseMs: 10 });
    expect(toneGainDb(processor, 1000, amplitude(-6))).toBeLessThan(-12);
    message(processor, { type: "params", params: { thresholdDb: 0, makeupDb: 0, releaseMs: 10 } });
    expect(toneGainDb(processor, 1000, amplitude(-6))).toBeCloseTo(0, 3);
    render(processor, 128, () => 0.1);
    message(processor, { type: "params", params: { thresholdDb: 0, makeupDb: 12 } });
    const transition = render(processor, 4800, () => 0.1);
    expect(transition[0]).toBeGreaterThan(0.1);
    expect(transition[0]).toBeLessThan(0.101);
    expect(transition[transition.length - 1]).toBeCloseTo(0.1 * amplitude(12), 4);
  });

  it("meters each processor only when enabled, at 50 ms intervals with rounded negative reduction", async () => {
    const create = await loadProcessors();
    for (const [name, params, signal] of [
      ["compressor", { makeupDb: 24 }, () => 0.8],
      ["expander", {}, () => amplitude(-70)],
      ["deesser", { mode: "wide", frequencyHz: 8000 }, tone(8000, 0.5)],
      ["limiter", {}, () => 2],
    ] as const) {
      const processor = create(name, params);
      render(processor, 4800, signal);
      expect(processor.port.postMessage).not.toHaveBeenCalled();
      message(processor, { type: "meter", enabled: true });
      render(processor, 2399, signal);
      expect(processor.port.postMessage).not.toHaveBeenCalled();
      render(processor, 2401, signal);
      expect(processor.port.postMessage).toHaveBeenCalledTimes(2);
      for (const [value] of processor.port.postMessage.mock.calls) {
        expect(value.type).toBe("gr");
        expect(value.db).toBeLessThan(0);
        expect(value.db * 10).toBeCloseTo(Math.round(value.db * 10), 8);
        if (name === "compressor") {
          const expectedReduction = -(20 * Math.log10(0.8) + 18) * (1 - 1 / 3);
          expect(Math.abs(value.db - expectedReduction)).toBeLessThan(0.1);
        }
      }
      message(processor, { type: "meter", enabled: false });
      render(processor, 4800, signal);
      expect(processor.port.postMessage).toHaveBeenCalledTimes(2);
    }
  });
});
