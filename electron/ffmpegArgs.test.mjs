import { describe, expect, it } from "vitest";
import ffmpegArgs from "./ffmpegArgs.cjs";

const { buildAtempoChain, buildCropArgs } = ffmpegArgs;

describe("buildAtempoChain", () => {
  it("returns no filters for unchanged speed", () => {
    expect(buildAtempoChain(1)).toEqual([]);
  });

  it("passes through factors already within ffmpeg's 0.5–2.0 range", () => {
    expect(buildAtempoChain(1.5)).toEqual([1.5]);
    expect(buildAtempoChain(0.75)).toEqual([0.75]);
    expect(buildAtempoChain(2)).toEqual([2]);
    expect(buildAtempoChain(0.5)).toEqual([0.5]);
  });

  it("chains factors for speeds above 2.0", () => {
    expect(buildAtempoChain(3)).toEqual([2, 1.5]);
    expect(buildAtempoChain(4)).toEqual([2, 2]);
  });

  it("chains factors for speeds below 0.5", () => {
    expect(buildAtempoChain(0.25)).toEqual([0.5, 0.5]);
  });

  it("product of the chain equals the requested rate", () => {
    for (const rate of [0.25, 0.3, 0.5, 1, 1.5, 2, 3, 3.7, 4]) {
      const product = buildAtempoChain(rate).reduce((acc, f) => acc * f, 1);
      expect(product).toBeCloseTo(rate, 4);
    }
  });

  it("ignores invalid rates", () => {
    expect(buildAtempoChain(0)).toEqual([]);
    expect(buildAtempoChain(-1)).toEqual([]);
    expect(buildAtempoChain(NaN)).toEqual([]);
  });
});

describe("buildCropArgs", () => {
  it("builds an input-seek + duration cut without a filter at rate 1", () => {
    const args = buildCropArgs({ input: "in.mp3", output: "out.mp3", startSec: 2, endSec: 5, rate: 1 });
    expect(args).toEqual(["-y", "-ss", "2.000000", "-t", "3.000000", "-i", "in.mp3", "-vn", "out.mp3"]);
  });

  it("adds an atempo filter when the rate changes", () => {
    const args = buildCropArgs({ input: "in.mp3", output: "out.mp3", startSec: 0, endSec: 4, rate: 3 });
    expect(args).toContain("-filter:a");
    expect(args[args.indexOf("-filter:a") + 1]).toBe("atempo=2,atempo=1.5");
  });
});
