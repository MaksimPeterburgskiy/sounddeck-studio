/** Mixed-radix FFT: the upstream DPDFNet transform is 960 points (not a power of 2). */
class FourierPlan {
  private readonly radix: number;
  private readonly child?: FourierPlan;
  private readonly real: Float64Array;
  private readonly imag: Float64Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(private readonly size: number) {
    this.radix = [2, 3, 5].find((factor) => size % factor === 0) ?? size;
    if (size > 1) this.child = new FourierPlan(size / this.radix);
    this.real = new Float64Array(size);
    this.imag = new Float64Array(size);
    this.cos = Float64Array.from({ length: size * this.radix }, (_, index) => Math.cos(-2 * Math.PI * Math.floor(index / size) * (index % size) / size));
    this.sin = Float64Array.from({ length: size * this.radix }, (_, index) => Math.sin(-2 * Math.PI * Math.floor(index / size) * (index % size) / size));
  }

  run(real: Float64Array, imag: Float64Array, outReal: Float64Array, outImag: Float64Array, start = 0, stride = 1, offset = 0) {
    if (this.size === 1) {
      outReal[offset] = real[start];
      outImag[offset] = imag[start];
      return;
    }
    const width = this.size / this.radix;
    for (let q = 0; q < this.radix; q += 1) this.child!.run(real, imag, outReal, outImag, start + q * stride, stride * this.radix, offset + q * width);
    for (let k = 0; k < this.size; k += 1) {
      let re = 0;
      let im = 0;
      for (let q = 0; q < this.radix; q += 1) {
        const at = offset + q * width + k % width;
        const twiddle = q * this.size + k;
        re += outReal[at] * this.cos[twiddle] - outImag[at] * this.sin[twiddle];
        im += outReal[at] * this.sin[twiddle] + outImag[at] * this.cos[twiddle];
      }
      this.real[k] = re;
      this.imag[k] = im;
    }
    outReal.set(this.real, offset);
    outImag.set(this.imag, offset);
  }
}

/** Port of upstream real_time_demo.py's STFTStreamingPreprocess/ISTFTStreamingPostprocess.
 * ERB/compression and normalization run inside the ONNX graph, with metadata-initialized state.
 */
export class DpdfStreamingDsp {
  private readonly window = Float32Array.from({ length: 960 }, (_, i) => Math.sin(Math.PI / 2 * Math.sin(Math.PI * (i + 0.5) / 960) ** 2));
  private readonly history = new Float32Array(960);
  private readonly overlap = new Float32Array(960);
  private readonly plan = new FourierPlan(960);
  private readonly real = new Float64Array(960);
  private readonly imag = new Float64Array(960);
  private readonly outReal = new Float64Array(960);
  private readonly outImag = new Float64Array(960);
  private readonly spectrum = new Float32Array(962);
  private readonly output = new Float32Array(480);

  analysis(input: Float32Array): Float32Array {
    if (input.length !== 480) throw new Error("DPDFNet expects 480 samples");
    this.history.copyWithin(0, 480);
    this.history.set(input, 480);
    for (let i = 0; i < 960; i += 1) this.real[i] = Math.fround(this.history[i] * this.window[i]);
    this.imag.fill(0);
    this.plan.run(this.real, this.imag, this.outReal, this.outImag);
    for (let k = 0; k <= 480; k += 1) {
      this.spectrum[k * 2] = this.outReal[k];
      this.spectrum[k * 2 + 1] = this.outImag[k];
    }
    return this.spectrum;
  }

  synthesis(spectrum: Float32Array): Float32Array {
    for (let k = 0; k < 960; k += 1) {
      const bin = k <= 480 ? k : 960 - k;
      this.real[k] = spectrum[bin * 2];
      // Conjugate for inverse FFT; DC/Nyquist are real.
      this.imag[k] = k === 0 || k === 480 ? 0 : spectrum[bin * 2 + 1] * (k < 480 ? -1 : 1);
    }
    this.plan.run(this.real, this.imag, this.outReal, this.outImag);
    this.overlap.copyWithin(0, 480);
    this.overlap.fill(0, 480);
    for (let i = 0; i < 960; i += 1) this.overlap[i] += Math.fround(Math.fround(this.outReal[i] / 960) * this.window[i]);
    this.output.set(this.overlap.subarray(0, 480));
    return this.output;
  }
}

/** ONNX Runtime Web doesn't expose ModelProto metadata. Decode only its metadata_props. */
export function onnxMetadata(input: Uint8Array): Record<string, string> {
  function varint(at: number): [number, number] {
    let value = 0;
    for (let shift = 0; shift < 53 && at < input.length; shift += 7) {
      const byte = input[at++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return [value, at];
    }
    throw new Error("Invalid ONNX protobuf varint");
  }
  const result: Record<string, string> = {};
  let pos = 0;
  while (pos < input.length) {
    let tag: number;
    [tag, pos] = varint(pos);
    const wire = tag & 7;
    if (wire === 0) { [, pos] = varint(pos); continue; }
    if (wire === 1 || wire === 5) { pos += wire === 1 ? 8 : 4; continue; }
    if (wire !== 2) throw new Error("Invalid ONNX protobuf wire type");
    let length: number;
    [length, pos] = varint(pos);
    const end = pos + length;
    if (end > input.length) throw new Error("Truncated ONNX protobuf");
    if (tag >>> 3 === 14) {
      let key = "";
      let value = "";
      while (pos < end) {
        let entryTag: number;
        [entryTag, pos] = varint(pos);
        if ((entryTag & 7) !== 2) throw new Error("Invalid ONNX metadata entry");
        [length, pos] = varint(pos);
        if (pos + length > end) throw new Error("Truncated ONNX metadata");
        const text = new TextDecoder().decode(input.subarray(pos, pos + length));
        if (entryTag >>> 3 === 1) key = text;
        if (entryTag >>> 3 === 2) value = text;
        pos += length;
      }
      result[key] = value;
    }
    pos = end;
  }
  return result;
}
