import { connectNoiseFrames } from "./noiseFrameQueue";
import { createOnnxNoiseRuntime } from "./onnxNoiseRuntime";
import type { NoiseSuppressionModelId } from "../types";

type InitMessage = { type: "init"; modelId: Exclude<NoiseSuppressionModelId, "dfn3">; model: ArrayBuffer; wasm: ArrayBuffer; port: MessagePort };
let runtime: Awaited<ReturnType<typeof createOnnxNoiseRuntime>> | undefined;
let framePort: MessagePort | undefined;
let disposed = false;
let frames: ReturnType<typeof connectNoiseFrames> | undefined;

function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  framePort?.postMessage({ type: "error", message });
  self.postMessage({ type: "error", message });
}

self.onmessage = async (event: MessageEvent<InitMessage | { type: "dispose" }>) => {
  const message = event.data;
  if (message.type === "dispose") {
    disposed = true;
    await frames?.dispose();
    framePort?.close();
    await runtime?.dispose();
    close();
    return;
  }
  try {
    framePort = message.port;
    runtime = await createOnnxNoiseRuntime(message.modelId, new Uint8Array(message.model), message.wasm);
    if (disposed) { await runtime.dispose(); return; }
    frames = connectNoiseFrames(framePort, {
      frameLength: runtime.frameLength,
      latencySamples: runtime.latencySamples,
      process: runtime.process,
      reset: runtime.reset,
      onError: reportError
    });
    const ready = { type: "ready", frameLength: runtime.frameLength };
    framePort.postMessage(ready);
    self.postMessage(ready);
  } catch (error) { reportError(error); }
};
