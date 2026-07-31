import initDeepFilter, {
  df_create,
  df_destroy,
  df_get_frame_length,
  df_get_input_ptr,
  df_get_output_ptr,
  df_memory,
  df_process_frame,
  df_set_atten_lim,
  df_set_post_filter_beta
} from "../vendor/deepfilter/deep_filter.js";

type InitMessage = {
  type: "init";
  port: MessagePort;
  wasm: ArrayBuffer;
  model: ArrayBuffer;
  attenuationDb: number;
};

let state = 0;
let frameLength = 0;
let inputPointer = 0;
let outputPointer = 0;
let memory: WebAssembly.Memory;
let inputView: Float32Array;
let outputView: Float32Array;
let framePort: MessagePort | undefined;

function refreshViews() {
  inputView = new Float32Array(memory.buffer, inputPointer, frameLength);
  outputView = new Float32Array(memory.buffer, outputPointer, frameLength);
}

function ensureViews() {
  if (inputView.buffer !== memory.buffer || outputView.buffer !== memory.buffer) refreshViews();
}

function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  framePort?.postMessage({ type: "error", message });
  self.postMessage({ type: "error", message });
}

self.onmessage = async (event: MessageEvent<InitMessage | { type: "attenuation"; value: number } | { type: "dispose" }>) => {
  const message = event.data;
  if (message.type === "attenuation") {
    if (state) df_set_atten_lim(state, message.value);
    return;
  }
  if (message.type === "dispose") {
    if (state) df_destroy(state);
    state = 0;
    framePort?.close();
    close();
    return;
  }
  try {
    framePort = message.port;
    await initDeepFilter({ module_or_path: message.wasm });
    state = df_create(new Uint8Array(message.model), message.attenuationDb);
    frameLength = df_get_frame_length(state);
    inputPointer = df_get_input_ptr(state);
    outputPointer = df_get_output_ptr(state);
    memory = df_memory() as WebAssembly.Memory;
    df_set_post_filter_beta(state, 0);
    refreshViews();
    framePort.onmessage = (frameEvent: MessageEvent<{ type: "process"; sequence: number; buffer: ArrayBuffer }>) => {
      const frameMessage = frameEvent.data;
      if (frameMessage.type !== "process") return;
      try {
        ensureViews();
        const samples = new Float32Array(frameMessage.buffer);
        inputView.set(samples);
        df_process_frame(state);
        ensureViews();
        samples.set(outputView);
        framePort?.postMessage({ type: "processed", sequence: frameMessage.sequence, buffer: frameMessage.buffer }, [frameMessage.buffer]);
      } catch (error) {
        reportError(error);
      }
    };
    framePort.start();
    framePort.postMessage({ type: "ready", frameLength });
    self.postMessage({ type: "ready", frameLength });
  } catch (error) {
    reportError(error);
  }
};
