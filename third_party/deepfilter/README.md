# DeepFilterNet3 runtime

The shipped model and WASM runtime come from Rikorose/DeepFilterNet. The source base is commit `d375b2d8309e0935d165700c91da9de862a99c31`, plus SIMD/tract performance commit `9b8790dca0fbc6e3625b5d0b9aef7b90740f3563` from upstream PR 695.

`wasm-persistent-buffers.patch` adds reusable frame buffers and an explicit destructor. Run `scripts/build-deepfilter-wasm.sh` with Rust, the `wasm32-unknown-unknown` target, and wasm-pack 0.15.0 to regenerate the checked-in runtime files.

The DeepFilterNet source and model are dual-licensed under MIT or Apache-2.0. License texts are packaged beside the runtime assets.

Artifact hashes from the checked-in build:

- `DeepFilterNet3_onnx.tar.gz`: `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616`
- `deep_filter_bg.wasm`: `ef0b4127023e0566fa6a331e60a2a079c5abec72e610c5323f246382c7319b9a`
