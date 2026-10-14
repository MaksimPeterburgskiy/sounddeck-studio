import { describe, expect, it } from "vitest";
import { compressorCurveDb, eqResponseDb, expanderCurveDb, highPassResponseDb, limiterCurveDb } from "./micCurves";
import { normalizeMicFilterParams } from "./micFilters";

describe("mic filter curves", () => {
  it("matches the expected EQ and high-pass responses", () => {
    const eq = normalizeMicFilterParams("eq", {});
    const peak = { ...eq, bands: eq.bands.map((band, index) => ({ ...band, gainDb: index === 2 ? 6 : 0 })) };
    expect(eqResponseDb(peak, 1200)).toBeCloseTo(6, 1);
    expect(Math.abs(eqResponseDb(peak, 60))).toBeLessThan(0.1);
    const shelf = { ...eq, bands: eq.bands.map((band, index) => ({ ...band, gainDb: index === 0 ? -6 : 0 })) };
    expect(eqResponseDb(shelf, 30)).toBeCloseTo(-6, 0);
    expect(eqResponseDb(shelf, 120)).toBeCloseTo(-3, 0);
    expect(highPassResponseDb({ frequencyHz: 80, slope: 24 }, 80)).toBeCloseTo(-3, 1);
    expect(highPassResponseDb({ frequencyHz: 80, slope: 12 }, 40)).toBeCloseTo(-12.3, 0);
    expect(highPassResponseDb({ frequencyHz: 80, slope: 24 }, 40)).toBeCloseTo(-24.1, 0);
  });

  it("follows the static dynamics curves", () => {
    const compressor = { thresholdDb: -18, ratio: 3, kneeDb: 6, attackMs: 5, releaseMs: 120, makeupDb: 3 };
    expect(compressorCurveDb(compressor, -40)).toBe(-37);
    expect(compressorCurveDb(compressor, -6)).toBeCloseTo(-18 + 12 / 3 + 3);
    expect(compressorCurveDb({ ...compressor, kneeDb: 0 }, -18)).toBe(-15);
    const expander = { thresholdDb: -45, ratio: 3, attackMs: 2, holdMs: 60, releaseMs: 150, rangeDb: -30, hysteresisDb: 4 };
    expect(expanderCurveDb(expander, -30)).toBe(-30);
    expect(expanderCurveDb(expander, -50)).toBe(-60);
    expect(expanderCurveDb(expander, -80)).toBe(-110);
    expect(limiterCurveDb({ ceilingDb: -1, releaseMs: 60, lookaheadMs: 3 }, 6)).toBe(-1);
  });
});
