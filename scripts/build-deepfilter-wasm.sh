#!/bin/sh
set -eu

task_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
task_source_dir=$(mktemp -d)
trap 'rm -rf "$task_source_dir"' EXIT INT TERM

command -v git >/dev/null
command -v wasm-pack >/dev/null

git clone --filter=blob:none https://github.com/Rikorose/DeepFilterNet.git "$task_source_dir/DeepFilterNet"
git -C "$task_source_dir/DeepFilterNet" checkout 9b8790dca0fbc6e3625b5d0b9aef7b90740f3563
git -C "$task_source_dir/DeepFilterNet" apply "$task_repo_root/third_party/deepfilter/wasm-persistent-buffers.patch"

RUSTFLAGS='-C target-feature=+simd128 --cfg getrandom_backend="wasm_js"' \
  wasm-pack build "$task_source_dir/DeepFilterNet/libDF" \
    --target web \
    --release \
    --out-dir pkg \
    --out-name deep_filter \
    -- \
    --features wasm \
    --no-default-features \
    --locked

mkdir -p "$task_repo_root/src/vendor/deepfilter" "$task_repo_root/deepfilter"
cp "$task_source_dir/DeepFilterNet/libDF/pkg/deep_filter.js" "$task_repo_root/src/vendor/deepfilter/deep_filter.js"
cp "$task_source_dir/DeepFilterNet/libDF/pkg/deep_filter.d.ts" "$task_repo_root/src/vendor/deepfilter/deep_filter.d.ts"
cp "$task_source_dir/DeepFilterNet/libDF/pkg/deep_filter_bg.wasm.d.ts" "$task_repo_root/src/vendor/deepfilter/deep_filter_bg.wasm.d.ts"
cp "$task_source_dir/DeepFilterNet/libDF/pkg/deep_filter_bg.wasm" "$task_repo_root/deepfilter/deep_filter_bg.wasm"
cp "$task_source_dir/DeepFilterNet/models/DeepFilterNet3_onnx.tar.gz" "$task_repo_root/deepfilter/DeepFilterNet3_onnx.tar.gz"
cp "$task_source_dir/DeepFilterNet/LICENSE-MIT" "$task_repo_root/deepfilter/LICENSE-MIT"
cp "$task_source_dir/DeepFilterNet/LICENSE-APACHE" "$task_repo_root/deepfilter/LICENSE-APACHE"

perl -0pi -e "s/module_or_path = new URL\('deep_filter_bg\.wasm', import\.meta\.url\);/throw new Error('DeepFilterNet WASM bytes are required');/" \
  "$task_repo_root/src/vendor/deepfilter/deep_filter.js"

actual_model_hash=$(shasum -a 256 "$task_repo_root/deepfilter/DeepFilterNet3_onnx.tar.gz" | awk '{print $1}')
test "$actual_model_hash" = "c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616"
actual_wasm_hash=$(shasum -a 256 "$task_repo_root/deepfilter/deep_filter_bg.wasm" | awk '{print $1}')
test "$actual_wasm_hash" = "ef0b4127023e0566fa6a331e60a2a079c5abec72e610c5323f246382c7319b9a"
