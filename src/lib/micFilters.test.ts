import { describe, expect, it } from "vitest";
import type { MicChainEntry, MicFilter } from "../types";
import { activeMicChainCount, addMicFilter, createMicFilter, EQ_BAND_FIELDS, formatParamValue, MIC_FILTER_TYPES, micFilterDefinition, micFilterLatencyMs, micFilterSummary, moveMicChainEntry, normalizeMicChain, normalizeMicFilterParams, removeMicFilter, updateMicFilter } from "./micFilters";
import { normalizeLibrary } from "./model";

const noiseSlot = { id: "noise-suppression", type: "noiseSuppression" } as const;

describe("mic filter chain model", () => {
  it("starts existing libraries with only the noise suppression slot", () => {
    const library = normalizeLibrary({ version: 1, activeBoardId: "", boards: [], settings: { noiseSuppressionEnabled: true } } as never);
    expect(library.settings.micChain).toEqual([noiseSlot]);
    expect(library.settings.noiseSuppressionEnabled).toBe(true);
  });

  it("keeps exactly one noise suppression slot, drops unknown entries, and clamps params", () => {
    const chain = normalizeMicChain([
      { id: "a", type: "compressor", enabled: true, params: { ratio: 99, thresholdDb: "loud" } },
      { id: "x", type: "reverb", enabled: true, params: {} },
      noiseSlot,
      { id: "a", type: "highPass", enabled: false, params: { frequencyHz: 5, slope: 18 } },
      noiseSlot
    ]);
    expect(chain.map((entry) => entry.type)).toEqual(["compressor", "noiseSuppression", "highPass"]);
    const [compressor, , highPass] = chain as [MicFilter, MicChainEntry, MicFilter];
    expect(compressor.params).toMatchObject({ ratio: 20, thresholdDb: -18 });
    expect(highPass).toMatchObject({ enabled: false, params: { frequencyHz: 20, slope: 24 } });
    expect(highPass.id).not.toBe("a");
    expect(normalizeMicChain([{ id: "a", type: "gain", enabled: true, params: {} }]).map((entry) => entry.type)).toEqual(["noiseSuppression", "gain"]);
  });

  it("adds at the bottom switched on, never removes noise suppression, and moves entries", () => {
    let chain: MicChainEntry[] = [noiseSlot];
    chain = addMicFilter(chain, "eq");
    chain = addMicFilter(chain, "eq");
    expect(chain.map((entry) => entry.type)).toEqual(["noiseSuppression", "eq", "eq"]);
    expect(chain[1]).toMatchObject({ enabled: true });
    expect(chain[1].id).not.toBe(chain[2].id);
    expect(removeMicFilter(chain, "noise-suppression")).toEqual(chain);
    expect(removeMicFilter(chain, chain[1].id).map((entry) => entry.id)).toEqual([noiseSlot.id, chain[2].id]);
    expect(moveMicChainEntry(chain, 0, 2).map((entry) => entry.id)).toEqual([chain[1].id, chain[2].id, noiseSlot.id]);
    expect(activeMicChainCount({ micChain: chain, noiseSuppressionEnabled: false })).toBe(2);
  });

  it("summarizes settings for the filter cards", () => {
    const [, eq] = normalizeMicChain([noiseSlot, { id: "eq", type: "eq", enabled: true }]) as [MicChainEntry, MicFilter];
    expect(micFilterSummary(eq)).toBe("5 bands · −2 / +2 / +1.5");
    expect(micFilterSummary({ id: "c", type: "compressor", enabled: true, params: { thresholdDb: -18, ratio: 3, kneeDb: 6, attackMs: 5, releaseMs: 120, makeupDb: 3 } })).toBe("−18 dB · 3:1 · +3 dB makeup");
    expect(micFilterSummary({ id: "h", type: "highPass", enabled: true, params: { frequencyHz: 80, slope: 24 } })).toBe("80 Hz · 24 dB/oct");
  });
});

describe("mic filter catalog", () => {
  it.each(MIC_FILTER_TYPES)("round-trips %s defaults and formats every control", (type) => {
    const filter = createMicFilter(type);
    expect(normalizeMicFilterParams(type, filter.params)).toEqual(filter.params);
    expect(normalizeMicFilterParams(type, null)).toEqual(filter.params);
    expect(micFilterSummary(filter)).not.toBe("");
    expect(micFilterLatencyMs(filter)).toBe(type === "limiter" ? 3 : 0);
    for (const field of micFilterDefinition(type).fields) {
      expect(formatParamValue(field, (filter.params as unknown as Record<string, number>)[field.key])).toMatch(/\d/);
    }
  });

  it("formats values with units and updates one filter in place", () => {
    expect(formatParamValue(EQ_BAND_FIELDS.gainDb, 3)).toBe("+3 dB");
    expect(formatParamValue(EQ_BAND_FIELDS.frequencyHz, 12500)).toBe("12.5 kHz");
    expect(formatParamValue({ unit: "ms", min: 0, max: 10 }, 2.5)).toBe("2.5 ms");
    const chain = [noiseSlot, createMicFilter("gain", "trim")];
    const updated = updateMicFilter(chain, "trim", (filter) => ({ ...filter, enabled: false }));
    expect(updated[1]).toMatchObject({ id: "trim", enabled: false });
    expect(updated[0]).toBe(chain[0]);
  });
});
