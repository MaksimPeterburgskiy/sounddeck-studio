import { describe, expect, it } from "vitest";
import { makeWaveform } from "./waveform";

function audioBuffer(data: Float32Array): AudioBuffer {
  return { getChannelData: () => data } as unknown as AudioBuffer;
}

describe("makeWaveform", () => {
  it("returns the default number of buckets", () => {
    const peaks = makeWaveform(audioBuffer(new Float32Array(96).fill(0.25)));

    expect(peaks).toHaveLength(48);
  });

  it("returns the requested number of buckets", () => {
    const peaks = makeWaveform(audioBuffer(new Float32Array(32).fill(0.25)), 8);

    expect(peaks).toHaveLength(8);
  });

  it("returns zero peaks for silent data", () => {
    expect(makeWaveform(audioBuffer(new Float32Array(8)), 4)).toEqual([0, 0, 0, 0]);
  });

  it("clamps loud peaks to one", () => {
    expect(makeWaveform(audioBuffer(new Float32Array(8).fill(1)), 4)).toEqual([1, 1, 1, 1]);
  });

  it("handles data shorter than the bucket count", () => {
    const peaks = makeWaveform(audioBuffer(new Float32Array([0.25, 0.5])), 5);

    expect(peaks).toHaveLength(5);
    expect(peaks.slice(2)).toEqual([0, 0, 0]);
  });
});
