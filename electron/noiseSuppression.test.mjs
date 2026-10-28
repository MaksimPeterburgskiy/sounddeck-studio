import { describe, expect, it, vi } from "vitest";
import { NOISE_SUPPRESSION_MODELS } from "../src/lib/noiseSuppressionModels.ts";
import assets from "./noiseSuppression.cjs";

const { loadNoiseSuppressionAssets } = assets;
describe("noise suppression assets IPC boundary", () => {
  it.each(NOISE_SUPPRESSION_MODELS.map(({ id }) => id))("serves only pinned local resources for %s", async (model) => {
    // Slices must exclude unrelated bytes in Node's shared Buffer pool.
    const readFile = vi.fn(async () => Buffer.from([9, 1, 2, 8]).subarray(1, 3));
    const result = await loadNoiseSuppressionAssets("/resources", model, readFile);
    expect(new Uint8Array(result.wasm)).toEqual(new Uint8Array([1, 2]));
    expect(new Uint8Array(result.model)).toEqual(new Uint8Array([1, 2]));
    const paths = readFile.mock.calls.map(([file]) => file);
    expect(paths[0]).toBe(`/resources/${model === "dfn3" ? "deepfilter/deep_filter_bg.wasm" : "noise-models/ort-wasm-simd-threaded.wasm"}`);
    const expected = {
      dfn3: "deepfilter/DeepFilterNet3_onnx.tar.gz",
      dpdfnet2: "noise-models/dpdfnet2_48khz_hr.onnx",
      dpdfnet8: "noise-models/dpdfnet8_48khz_hr.onnx",
      "fastenhancer-m": "noise-models/fastenhancer_m.onnx"
    };
    expect(paths[1]).toBe(`/resources/${expected[model]}`);
  });
  it.each(["../secret", "toString", "", null, {}, 3])("rejects invalid model %s before accessing files", async (model) => {
    const readFile = vi.fn();
    await expect(loadNoiseSuppressionAssets("/resources", model, readFile)).rejects.toThrow("Invalid noise suppression model");
    expect(readFile).not.toHaveBeenCalled();
  });
});
