import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./testing/webAudioFakes";

const runtime = vi.hoisted(() => ({ create: vi.fn(), process: vi.fn(), reset: vi.fn(), dispose: vi.fn() }));
vi.mock("./onnxNoiseRuntime", () => ({ createOnnxNoiseRuntime: runtime.create }));

describe("ONNX noise worker", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => vi.unstubAllGlobals());

  it("serializes recurrent inference, transfers frames, and reports processing failures to both ports", async () => {
    const first = deferred<Float32Array>();
    runtime.process.mockReturnValueOnce(first.promise).mockResolvedValueOnce(new Float32Array(320).fill(0.4)).mockRejectedValueOnce(new Error("inference failed"));
    runtime.create.mockResolvedValue({ frameLength: 320, latencySamples: 0, reset: runtime.reset, process: runtime.process, dispose: runtime.dispose });
    const scope = { onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined, postMessage: vi.fn() };
    const port = { onmessage: undefined as ((event: MessageEvent) => void) | undefined, start: vi.fn(), close: vi.fn(), postMessage: vi.fn() };
    vi.stubGlobal("self", scope);
    vi.stubGlobal("close", vi.fn());
    await import("./onnxNoiseWorker");
    const model = new ArrayBuffer(8);
    const wasm = new ArrayBuffer(8);
    await scope.onmessage!({ data: { type: "init", modelId: "fastenhancer-m", model, wasm, port } } as MessageEvent);
    expect(runtime.create).toHaveBeenCalledWith("fastenhancer-m", new Uint8Array(model), wasm);
    expect(port.postMessage).toHaveBeenCalledWith({ type: "ready", frameLength: 320 });
    const buffers = [new ArrayBuffer(1280), new ArrayBuffer(1280)];
    buffers.forEach((buffer, sequence) => port.onmessage!({ data: { type: "process", sequence, buffer } } as MessageEvent));
    await vi.waitFor(() => expect(runtime.process).toHaveBeenCalledOnce());
    first.resolve(new Float32Array(320).fill(0.2));
    await vi.waitFor(() => expect(runtime.process).toHaveBeenCalledTimes(2));
    expect(new Float32Array(buffers[0])[0]).toBeCloseTo(0.2);
    expect(new Float32Array(buffers[1])[0]).toBeCloseTo(0.4);
    expect(port.postMessage).toHaveBeenCalledWith({ type: "processed", sequence: 1, buffer: buffers[1] }, [buffers[1]]);
    port.onmessage!({ data: { type: "process", sequence: 2, buffer: new ArrayBuffer(1280) } } as MessageEvent);
    await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledWith({ type: "error", message: "inference failed" }));
    expect(port.postMessage).toHaveBeenCalledWith({ type: "error", message: "inference failed" });
    await scope.onmessage!({ data: { type: "dispose" } } as MessageEvent);
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(port.close).toHaveBeenCalledOnce();
  });
  it("resets on a gap, discards queued/in-flight audio, and waits for fresh delay history", async () => {
    const first = deferred<Float32Array>();
    runtime.process.mockImplementationOnce(() => first.promise).mockImplementation(async (input: Float32Array) => input.slice());
    runtime.create.mockResolvedValue({ frameLength: 4, latencySamples: 6, reset: runtime.reset, process: runtime.process, dispose: runtime.dispose });
    const scope = { onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined, postMessage: vi.fn() };
    const port = { onmessage: undefined as ((event: MessageEvent) => void) | undefined, start: vi.fn(), close: vi.fn(), postMessage: vi.fn() };
    vi.stubGlobal("self", scope);
    vi.stubGlobal("close", vi.fn());
    await import("./onnxNoiseWorker");
    await scope.onmessage!({ data: { type: "init", modelId: "fastenhancer-m", model: new ArrayBuffer(8), wasm: new ArrayBuffer(8), port } } as MessageEvent);
    const send = (sequence: number) => port.onmessage!({ data: { type: "process", sequence, buffer: new Float32Array(4).fill(sequence).buffer } } as MessageEvent);
    send(0);
    send(1); // Queued behind the first inference.
    send(20); // Discontinuity invalidates both preceding frames.
    first.resolve(new Float32Array(4).fill(999));
    await vi.waitFor(() => expect(runtime.reset).toHaveBeenCalledOnce());
    send(21);
    send(22);
    await vi.waitFor(() => expect(port.postMessage.mock.calls.filter(([message]) => message.type === "processed")).toHaveLength(1));
    expect(runtime.process.mock.calls.map(([input]) => input[0])).toEqual([0, 20, 21, 22]);
    const output = port.postMessage.mock.calls.find(([message]) => message.type === "processed")![0];
    expect(output.sequence).toBe(22);
    expect(new Float32Array(output.buffer)).toEqual(new Float32Array(4).fill(22));
    expect(runtime.create).toHaveBeenCalledOnce(); // The loaded ORT session is retained.
    await scope.onmessage!({ data: { type: "dispose" } } as MessageEvent);
  });

});
