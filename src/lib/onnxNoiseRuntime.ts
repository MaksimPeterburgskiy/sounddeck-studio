import * as ort from "onnxruntime-web/wasm";
import wasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import type { NoiseSuppressionModelId } from "../types";
import { DpdfStreamingDsp, onnxMetadata } from "./noiseSuppressionDsp";
import { noiseSuppressionModelInfo } from "./noiseSuppressionModels";

/** Shared by the dedicated worker and the offline parity/performance harness. */
export async function createOnnxNoiseRuntime(modelId: Exclude<NoiseSuppressionModelId, "dfn3">, bytes: Uint8Array, wasm: ArrayBuffer) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  // Vite emits the matching Emscripten module locally; the large WASM binary
  // arrives through IPC from packaged resources, never a CDN or remote URL.
  ort.env.wasm.wasmPaths = { mjs: new URL(wasmModuleUrl, import.meta.url).href };
  ort.env.wasm.wasmBinary = new Uint8Array(wasm);
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  try {
    const definition = noiseSuppressionModelInfo(modelId);
    const spectral = modelId !== "fastenhancer-m";
    let dsp: DpdfStreamingDsp | undefined;
    const tensor = (data: Float32Array, shape: readonly number[]) => new ort.Tensor("float32", data, shape);
    const shape = (name: string) => {
      const metadata = session.inputMetadata.find((entry) => entry.name === name);
      if (!metadata?.isTensor || metadata.type !== "float32" || metadata.shape.some((dimension) => typeof dimension !== "number" || dimension <= 0)) throw new Error(`Invalid noise model input: ${name}`);
      return metadata.shape as number[];
    };
    let state: Record<string, ort.Tensor> = {};
    const initialState: Record<string, ort.Tensor> = {};
    if (spectral) {
      const metadata = onnxMetadata(bytes);
      const dims = shape("state_in");
      const size = dims.reduce((a, b) => a * b, 1);
      const erb = metadata.erb_norm_init?.split(",").map(Number);
      const spec = metadata.spec_norm_init?.split(",").map(Number);
      if (!erb || !spec || Number(metadata.state_size) !== size || erb.length !== Number(metadata.erb_norm_state_size) || spec.length !== Number(metadata.spec_norm_state_size) || erb.length + spec.length > size || [...erb, ...spec].some((value) => !Number.isFinite(value))) throw new Error("Invalid DPDFNet normalization metadata");
      const initial = new Float32Array(size);
      initial.set(erb);
      initial.set(spec, erb.length);
      initialState.state_in = tensor(initial, dims);
    } else {
      for (const name of session.inputNames.filter((name) => name.startsWith("cache_in_"))) {
        const dims = shape(name);
        initialState[name] = tensor(new Float32Array(dims.reduce((a, b) => a * b, 1)), dims);
      }
    }
    const reset = () => {
      dsp = spectral ? new DpdfStreamingDsp() : undefined;
      // session.run() doesn't mutate CPU input tensors, so the initial tensors
      // remain pristine while returned recurrent tensors become the live state.
      state = { ...initialState };
    };
    reset();
    return {
      reset,
      frameLength: definition.frameLength,
      latencySamples: definition.latencySamples,
      async process(input: Float32Array) {
        if (input.length !== definition.frameLength) throw new Error("Invalid noise suppression frame size");
        const feeds = dsp ? { spec: tensor(dsp.analysis(input), [1, 1, 481, 2]), ...state } : { wav_in: tensor(input, [1, definition.frameLength]), ...state };
        const output = await session.run(feeds);
        state = dsp ? { state_in: output.state_out } : Object.fromEntries(session.outputNames.slice(1).map((name, index) => [`cache_in_${index}`, output[name]]));
        const data = output[session.outputNames[0]].data as Float32Array;
        return dsp ? dsp.synthesis(data) : data;
      },
      dispose: () => session.release()
    };
  } catch (error) {
    await session.release();
    throw error;
  }
}
