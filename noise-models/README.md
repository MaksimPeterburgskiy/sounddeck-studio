# Microphone noise suppression

The default model is DeepFilterNet 3, using libDF/Tract WASM. DPDFNet-2, DPDFNet-8, and FastEnhancer Medium use ONNX Runtime Web **1.31.1**, single-thread WASM CPU, with proxy mode disabled. All inference runs in workers. ONNX models run at full strength; DFN3 has a 6–30 dB attenuation limit or Unlimited (`100`, the default).

The worklet delays raw fallback by the model's algorithmic latency and smooths processed/fallback transitions over 5 ms. A sequence gap discards obsolete queued/in-flight outputs and resets DSP/recurrent state. Recovery waits for fresh contiguous input to fill the algorithmic delay. ORT retains its session; the bundled libDF binding has no reset export, so DFN3 recreates its native state from retained model bytes and keeps the loaded WASM and current attenuation.

## Assets and licenses

`manifest.json` pins URLs and SHA-256 checksums. `pnpm run fetch:noise-models` downloads verified files atomically; `prebuild` runs it automatically, including through `start`. Cached files are verified before reuse. The matching ORT WASM is copied from the exact pinned npm package and hash-checked. Binaries are gitignored.

Windows and macOS package the assets alongside `deepfilter/`; `after-pack.cjs` verifies them again. Vite emits the local ORT Emscripten `.mjs`. Trusted IPC requires an explicit catalog model ID. Model/runtime assets require no runtime network requests.

- DPDFNet: Apache-2.0, `LICENSE-DPDFNet`.
- FastEnhancer: MIT, `LICENSE-FastEnhancer`.
- ONNX Runtime: MIT, `LICENSE-ONNX-Runtime`.
- See `NOTICE.txt` for sources, pinned revisions, and DSP port attribution; existing DFN3 licenses remain in `deepfilter/`.

## Delay at 48 kHz

| Model | Algorithmic delay | Worklet buffering | Total stage delay |
| --- | --- | --- | --- |
| DeepFilterNet 3 | 1,440 samples / 30 ms | 40 ms | 70 ms |
| DPDFNet-2 / DPDFNet-8 | 2,400 samples / 50 ms | 40 ms | 90 ms |
| FastEnhancer Medium | 704 samples / 14.67 ms | 26.67 ms | 41.33 ms |

All models use the same latency formula: algorithmic delay plus four hops (one assembled frame and three queued sequences), excluding device buffering. Impulse measurements supply the algorithmic delays; DFN3 uses a finite attenuation limit for that measurement because Unlimited suppresses the isolated impulse.

## DSP verification

The TypeScript DSP port was checked against upstream DPDFNet's Python streaming reference on a five-second 48 kHz fixture, running the app's DSP and ORT WASM: 112.10 dB SNR for DPDFNet-2 and 118.97 dB for DPDFNet-8 (maximum sample error 2.98e-7 / 5.96e-7).
