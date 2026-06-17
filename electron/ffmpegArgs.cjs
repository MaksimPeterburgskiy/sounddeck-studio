"use strict";

// ffmpeg's `atempo` filter only accepts a tempo factor between 0.5 and 2.0.
// To reach factors outside that range we chain multiple `atempo` instances whose
// product equals the requested rate. (Tempo-only fallback: preserves pitch.)
function buildAtempoChain(rate) {
  const target = Number(rate);
  if (!Number.isFinite(target) || target <= 0) return [];
  let remaining = target;
  const factors = [];
  while (remaining > 2.0 + 1e-9) {
    factors.push(2.0);
    remaining /= 2.0;
  }
  while (remaining < 0.5 - 1e-9) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  // Drop a trailing 1.0 (e.g. rate exactly 2 or 0.5 already lands on the bounds).
  if (Math.abs(remaining - 1) > 1e-6) factors.push(Number(remaining.toFixed(6)));
  return factors;
}

// Returns the audio filter that bakes a playback-rate change. We mirror the renderer's
// `AudioBufferSourceNode.playbackRate` (which resamples and shifts pitch) using `asetrate`
// so a permanently cut clip sounds the same as the preview. When the source sample rate is
// unknown we fall back to the pitch-preserving `atempo` chain rather than guessing the rate.
function buildSpeedFilter({ rate, sampleRate }) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0 || Math.abs(r - 1) < 1e-6) return "";
  const sr = Math.round(Number(sampleRate));
  if (Number.isFinite(sr) && sr > 0) {
    return `asetrate=${Math.round(sr * r)},aresample=${sr}`;
  }
  const factors = buildAtempoChain(r);
  return factors.map((factor) => `atempo=${factor}`).join(",");
}

// Builds the ffmpeg argument list to cut [startSec, endSec] from `input`, optionally
// re-timing by `rate`, and re-encode into `output` (codec inferred from the extension).
function buildCropArgs({ input, output, startSec, endSec, rate, sampleRate }) {
  const start = Math.max(0, Number(startSec) || 0);
  const duration = Math.max(0.01, (Number(endSec) || 0) - start);
  const args = ["-y", "-ss", start.toFixed(6), "-t", duration.toFixed(6), "-i", input];
  const filter = buildSpeedFilter({ rate, sampleRate });
  if (filter) args.push("-filter:a", filter);
  args.push("-vn", output);
  return args;
}

module.exports = { buildAtempoChain, buildSpeedFilter, buildCropArgs };
