import { describe, expect, it } from "vitest";
import { DpdfStreamingDsp, onnxMetadata } from "./noiseSuppressionDsp";

describe("DPDFNet streaming DSP", () => {
  it("reconstructs a stream through the upstream Vorbis STFT with one hop of delay", () => {
    const dsp = new DpdfStreamingDsp();
    const input = Float32Array.from({ length: 480 * 5 }, (_, index) => Math.sin(index * 0.193) * 0.3 + Math.cos(index * 1.73) * 0.1);
    const output = new Float32Array(input.length + 480);
    for (let at = 0; at <= input.length; at += 480) {
      const frame = at < input.length ? input.subarray(at, at + 480) : new Float32Array(480);
      output.set(dsp.synthesis(dsp.analysis(frame)), at);
    }
    expect(Math.max(...output.subarray(0, 480).map(Math.abs))).toBeLessThan(1e-7);
    for (let i = 0; i < input.length; i += 1) expect(Math.abs(output[i + 480] - input[i])).toBeLessThan(1e-7);
  });

  it("uses the unnormalized 960-point real FFT and interleaved complex spectral contract", () => {
    const dsp = new DpdfStreamingDsp();
    const input = new Float32Array(480);
    input[17] = 1;
    const spectrum = dsp.analysis(input);
    const timeIndex = 480 + 17;
    const window = Math.fround(Math.sin(Math.PI / 2 * Math.sin(Math.PI * (timeIndex + 0.5) / 960) ** 2));
    expect(spectrum.length).toBe(481 * 2);
    for (const bin of [0, 1, 13, 176, 479, 480]) {
      expect(spectrum[bin * 2]).toBeCloseTo(window * Math.cos(-2 * Math.PI * bin * timeIndex / 960), 6);
      expect(spectrum[bin * 2 + 1]).toBeCloseTo(window * Math.sin(-2 * Math.PI * bin * timeIndex / 960), 6);
    }
  });

  it("reads ONNX normalization metadata and rejects truncated protobuf data", () => {
    const encode = new TextEncoder();
    const key = encode.encode("state_size");
    const value = encode.encode("1234");
    const entry = [10, key.length, ...key, 18, value.length, ...value];
    expect(onnxMetadata(Uint8Array.from([8, 9, 114, entry.length, ...entry]))).toEqual({ state_size: "1234" });
    expect(() => onnxMetadata(Uint8Array.from([114, 127]))).toThrow("Truncated");
  });
});
