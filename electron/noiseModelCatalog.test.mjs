import { describe, expect, it } from "vitest";
import { NOISE_SUPPRESSION_MODELS } from "../src/lib/noiseSuppressionModels.ts";
import assets from "./noiseSuppression.cjs";
import manifest from "../noise-models/manifest.json";

describe("noise model catalog", () => {
  it("keeps renderer IDs, IPC IDs, and packaged manifest IDs in parity", () => {
    const ids = NOISE_SUPPRESSION_MODELS.map(({ id }) => id).sort();
    expect([...assets.MODEL_IDS].sort()).toEqual(ids);
    expect(["dfn3", ...manifest.models.map(({ id }) => id)].sort()).toEqual(ids);
  });
});
