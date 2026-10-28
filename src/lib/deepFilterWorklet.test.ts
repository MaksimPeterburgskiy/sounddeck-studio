import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOISE_SUPPRESSION_MODELS } from "./noiseSuppressionModels";

type Processor = {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};
type Frame = { type: string; sequence: number; buffer: ArrayBuffer };
const signal = (index: number) => index < 0 ? 0 : Math.fround(Math.sin(index * 0.017) * 0.2 + 0.1);

async function setup(frameLength: number, latencySamples: number, infer?: (frame: Frame) => Float32Array | undefined) {
  let Constructor!: new (options: { processorOptions: { frameLength: number; latencySamples: number } }) => Processor;
  vi.stubGlobal("AudioWorkletProcessor", class { port = { onmessage: null, postMessage: vi.fn() }; });
  vi.stubGlobal("registerProcessor", vi.fn((_name, processor) => { Constructor = processor; }));
  await import("./deepFilterWorklet.js");
  const processor = new Constructor({ processorOptions: { frameLength, latencySamples } });
  const worker = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    start: vi.fn(),
    postMessage: vi.fn((frame: Frame) => {
      const result = infer?.(frame);
      if (!result) return;
      new Float32Array(frame.buffer).set(result);
      worker.onmessage?.({ data: { type: "processed", sequence: frame.sequence, buffer: frame.buffer } });
    })
  };
  processor.port.onmessage({ data: { type: "connect", port: worker } });
  return { processor, worker, ready: () => worker.onmessage?.({ data: { type: "ready", frameLength } }) };
}

function render(processor: Processor, samples: number, start = 0, source = signal) {
  const output = new Float32Array(samples);
  for (let at = 0; at < samples; at += 128) {
    const length = Math.min(128, samples - at);
    const input = Float32Array.from({ length }, (_, i) => source(start + at + i));
    const quantum = new Float32Array(length);
    processor.process([[input]], [[quantum]]);
    output.set(quantum, at);
  }
  return output;
}

describe("noise suppression audio worklet", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("passes raw audio before ready and asserts the configured frame size without reallocating", async () => {
    const { processor, worker } = await setup(256, 0);
    expect(render(processor, 128)).toEqual(Float32Array.from({ length: 128 }, (_, i) => signal(i)));
    worker.onmessage?.({ data: { type: "ready", frameLength: 320 } });
    expect(processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it.each([...new Set(NOISE_SUPPRESSION_MODELS.map((model) => model.frameLength))])("frames render quanta into the configured %s samples", async (frameLength) => {
    const { processor, worker, ready } = await setup(frameLength, 0);
    ready();
    render(processor, frameLength);
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(new Float32Array(worker.postMessage.mock.calls[0][0].buffer)).toEqual(Float32Array.from({ length: frameLength }, (_, i) => signal(i)));
  });

  it.each(NOISE_SUPPRESSION_MODELS)("keeps $id fallback aligned to processed output, including partial-hop delay", async ({ frameLength, latencySamples }) => {
    const { processor, ready } = await setup(frameLength, latencySamples, ({ sequence }) => {
      if (sequence >= 14 && sequence < 19) return undefined;
      return Float32Array.from({ length: frameLength }, (_, i) => signal(sequence * frameLength + i - latencySamples));
    });
    ready();
    const output = render(processor, frameLength * 36);
    const totalDelay = 4 * frameLength + latencySamples;
    let maxError = 0;
    for (let i = 4 * frameLength + 960; i < output.length; i += 1) maxError = Math.max(maxError, Math.abs(output[i] - signal(i - totalDelay)));
    expect(maxError).toBeLessThan(1e-7);
  });

  it("crossfades both processed-to-raw and raw-to-processed without a boundary jump", async () => {
    const hop = 480;
    const { processor, ready } = await setup(hop, 1440, ({ sequence }) => sequence >= 15 && sequence < 18 ? undefined : new Float32Array(hop).fill(0.5));
    ready();
    const output = render(processor, hop * 30, 0, () => 1);
    for (const [at, from, to] of [[19 * hop, 0.5, 1], [22 * hop, 1, 0.5]]) {
      expect(output[at]).toBeCloseTo(from, 6);
      expect(output[at + 240]).toBeCloseTo(to, 6);
      let maxStep = 0;
      for (let i = at; i <= at + 240; i += 1) maxStep = Math.max(maxStep, Math.abs(output[i] - output[i - 1]));
      expect(maxStep).toBeLessThan(0.004);
    }
  });

  it.each(NOISE_SUPPRESSION_MODELS)("rejects stale and reset-warmup audio for $id before recovery", async ({ frameLength, latencySamples }) => {
    let recoveryStart: number | undefined;
    const warmup = Math.ceil(latencySamples / frameLength);
    const { processor, worker, ready } = await setup(frameLength, latencySamples, ({ sequence }) => {
      if (recoveryStart === undefined) return undefined;
      return Float32Array.from({ length: frameLength }, (_, i) => sequence < recoveryStart! + warmup ? 999 : signal(sequence * frameLength + i - latencySamples));
    });
    ready();
    render(processor, frameLength * 30);
    expect(worker.postMessage).toHaveBeenCalledTimes(12);
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "underrun" });
    // Return obsolete buffers after pool exhaustion. Their audio must never play.
    for (const [frame] of worker.postMessage.mock.calls) {
      new Float32Array(frame.buffer).fill(999);
      worker.onmessage?.({ data: { type: "processed", sequence: frame.sequence, buffer: frame.buffer } });
    }
    recoveryStart = 30;
    const beforeRecovery = render(processor, frameLength * (warmup + 3), frameLength * 30);
    expect(processor.port.postMessage).not.toHaveBeenCalledWith({ type: "recovered" });
    const recovered = render(processor, frameLength * 4, frameLength * (33 + warmup));
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "recovered" });
    expect(Math.max(...beforeRecovery, ...recovered)).toBeLessThan(0.301);
  });
});
