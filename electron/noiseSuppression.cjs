const fs = require("node:fs/promises");
const path = require("node:path");
const MODEL_FILES = Object.freeze({
  dpdfnet2: "dpdfnet2_48khz_hr.onnx",
  dpdfnet8: "dpdfnet8_48khz_hr.onnx",
  "fastenhancer-m": "fastenhancer_m.onnx"
});
const MODEL_IDS = ["dfn3", ...Object.keys(MODEL_FILES)];

async function loadNoiseSuppressionAssets(root, modelId, readFile = fs.readFile) {
  if (!MODEL_IDS.includes(modelId)) throw new Error("Invalid noise suppression model");
  const directory = modelId === "dfn3" ? "deepfilter" : "noise-models";
  const [wasm, model] = await Promise.all([
    readFile(path.join(root, directory, modelId === "dfn3" ? "deep_filter_bg.wasm" : "ort-wasm-simd-threaded.wasm")),
    readFile(path.join(root, directory, modelId === "dfn3" ? "DeepFilterNet3_onnx.tar.gz" : MODEL_FILES[modelId]))
  ]);
  const arrayBuffer = (data) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return { wasm: arrayBuffer(wasm), model: arrayBuffer(model) };
}

module.exports = { loadNoiseSuppressionAssets, MODEL_IDS };
