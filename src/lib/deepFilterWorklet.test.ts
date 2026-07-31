import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("DeepFilter audio worklet", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers and passes raw microphone audio through before the model is ready", async () => {
    let Processor: new () => { process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean };
    class FakeProcessorBase {
      port = { onmessage: null, postMessage: vi.fn() };
    }
    vi.stubGlobal("AudioWorkletProcessor", FakeProcessorBase);
    const registerProcessorMock = vi.fn((_name: string, processor: typeof Processor) => {
      Processor = processor;
    });
    vi.stubGlobal("registerProcessor", registerProcessorMock);

    await import("./deepFilterWorklet.js");
    const processor = new Processor!();
    const input = Float32Array.from({ length: 128 }, (_, index) => Math.sin(index / 10));
    const output = new Float32Array(128);

    expect(processor.process([[input]], [[output]])).toBe(true);
    expect(output).toEqual(input);
    expect(registerProcessorMock).toHaveBeenCalledWith("sounddeck-deep-filter", expect.any(Function));

  });

  it("collects browser render quanta into 480-sample model frames", async () => {
    let Processor: new () => {
      port: { onmessage: (event: { data: unknown }) => void };
      process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
    };
    class FakeProcessorBase {
      port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn() };
    }
    vi.stubGlobal("AudioWorkletProcessor", FakeProcessorBase);
    vi.stubGlobal("registerProcessor", vi.fn((_name: string, processor: typeof Processor) => {
      Processor = processor;
    }));
    await import("./deepFilterWorklet.js");
    const processor = new Processor!();
    const workerPort = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn(), start: vi.fn() };
    processor.port.onmessage({ data: { type: "connect", port: workerPort } });
    workerPort.onmessage?.({ data: { type: "ready", frameLength: 480 } });

    for (const length of [128, 128, 128, 96]) {
      processor.process([[new Float32Array(length).fill(0.25)]], [[new Float32Array(length)]]);
    }

    expect(workerPort.postMessage).toHaveBeenCalledTimes(1);
    const frameMessage = workerPort.postMessage.mock.calls[0][0];
    expect(frameMessage.type).toBe("process");
    expect(frameMessage.sequence).toBe(0);
    expect(new Float32Array(frameMessage.buffer)).toEqual(new Float32Array(480).fill(0.25));
  });

  it("reports recovery when processed audio resumes after an underrun", async () => {
    let Processor: new () => {
      port: { onmessage: (event: { data: unknown }) => void; postMessage: ReturnType<typeof vi.fn> };
      process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
    };
    class FakeProcessorBase {
      port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn() };
    }
    vi.stubGlobal("AudioWorkletProcessor", FakeProcessorBase);
    vi.stubGlobal("registerProcessor", vi.fn((_name: string, processor: typeof Processor) => {
      Processor = processor;
    }));
    await import("./deepFilterWorklet.js");
    const processor = new Processor!();
    const workerPort = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn(), start: vi.fn() };
    processor.port.onmessage({ data: { type: "connect", port: workerPort } });
    workerPort.onmessage?.({ data: { type: "ready", frameLength: 480 } });

    for (let frame = 0; frame < 23; frame += 1) {
      processor.process([[new Float32Array(480)]], [[new Float32Array(480)]]);
    }
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "underrun" });

    workerPort.onmessage?.({ data: { type: "processed", sequence: 20, buffer: new ArrayBuffer(480 * Float32Array.BYTES_PER_ELEMENT) } });
    processor.process([[new Float32Array(480)]], [[new Float32Array(480)]]);

    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "recovered" });
  });
});
