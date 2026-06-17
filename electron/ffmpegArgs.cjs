"use strict";

// ffmpeg's `atempo` filter only accepts a tempo factor between 0.5 and 2.0.
// To reach factors outside that range we chain multiple `atempo` instances whose
// product equals the requested rate.
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

// Builds the ffmpeg argument list to cut [startSec, endSec] from `input`, optionally
// re-timing by `rate`, and re-encode into `output` (codec inferred from the extension).
function buildCropArgs({ input, output, startSec, endSec, rate }) {
  const start = Math.max(0, Number(startSec) || 0);
  const duration = Math.max(0.01, (Number(endSec) || 0) - start);
  const args = ["-y", "-ss", start.toFixed(6), "-t", duration.toFixed(6), "-i", input];
  const factors = buildAtempoChain(rate);
  if (factors.length) {
    args.push("-filter:a", factors.map((factor) => `atempo=${factor}`).join(","));
  }
  args.push("-vn", output);
  return args;
}

module.exports = { buildAtempoChain, buildCropArgs };
