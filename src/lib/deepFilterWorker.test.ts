import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deepFilter = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  frameLength: vi.fn(),
  init: vi.fn(),
  inputPointer: vi.fn(),
  memory: vi.fn(),
  outputPointer: vi.fn(),
  processFrame: vi.fn(),
  setAttenuation: vi.fn(),
  setPostFilter: vi.fn()
}));

vi.mock("../vendor/deepfilter/deep_filter.js", () => ({
  default: deepFilter.init,
  df_create: deepFilter.create,
  df_destroy: deepFilter.destroy,
  df_get_frame_length: deepFilter.frameLength,
  df_get_input_ptr: deepFilter.inputPointer,
  df_get_output_ptr: deepFilter.outputPointer,
  df_memory: deepFilter.memory,
  df_process_frame: deepFilter.processFrame,
  df_set_atten_lim: deepFilter.setAttenuation,
  df_set_post_filter_beta: deepFilter.setPostFilter
}));

describe("DeepFilter worker", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the worker lifecycle while preserving attenuation changes during loading", async () => {
    let finishLoading!: () => void;
    deepFilter.init.mockReturnValue(new Promise<void>((resolve) => {
      finishLoading = resolve;
    }));
    deepFilter.create.mockReturnValue(1);
    deepFilter.frameLength.mockReturnValue(480);
    deepFilter.inputPointer.mockReturnValue(0);
    deepFilter.outputPointer.mockReturnValue(480 * Float32Array.BYTES_PER_ELEMENT);
    deepFilter.memory.mockReturnValue(new WebAssembly.Memory({ initial: 1 }));

    const workerScope = {
      onmessage: undefined as ((event: MessageEvent) => Promise<void>) | undefined,
      postMessage: vi.fn()
    };
    vi.stubGlobal("self", workerScope);
    const closeWorker = vi.fn();
    vi.stubGlobal("close", closeWorker);
    await import("./deepFilterWorker");

    const port = {
      close: vi.fn(),
      onmessage: null as ((event: MessageEvent<{ type: "process"; sequence: number; buffer: ArrayBuffer }>) => void) | null,
      postMessage: vi.fn(),
      start: vi.fn()
    };
    const initialization = workerScope.onmessage!({
      data: {
        type: "init",
        port,
        wasm: new ArrayBuffer(8),
        model: new ArrayBuffer(8),
        attenuationDb: 18
      }
    } as unknown as MessageEvent);
    await workerScope.onmessage!({ data: { type: "attenuation", value: 24 } } as MessageEvent);
    finishLoading();
    await initialization;

    expect(deepFilter.create).toHaveBeenCalledWith(expect.any(Uint8Array), 24);

    const frame = new Float32Array(480).fill(0.25).buffer;
    port.onmessage!({ data: { type: "process", sequence: 7, buffer: frame } } as MessageEvent<{ type: "process"; sequence: number; buffer: ArrayBuffer }>);
    expect(deepFilter.processFrame).toHaveBeenCalledWith(1);
    expect(port.postMessage).toHaveBeenCalledWith({ type: "processed", sequence: 7, buffer: frame }, [frame]);

    await workerScope.onmessage!({ data: { type: "attenuation", value: 12 } } as MessageEvent);
    expect(deepFilter.setAttenuation).toHaveBeenCalledWith(1, 12);

    await workerScope.onmessage!({ data: { type: "dispose" } } as MessageEvent);
    expect(deepFilter.destroy).toHaveBeenCalledWith(1);
    expect(port.close).toHaveBeenCalledOnce();
    expect(closeWorker).toHaveBeenCalledOnce();
  });
});
