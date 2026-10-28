import type { AudioSettings } from "../types";

// Algorithmic delays measured offline (see noise-models/README.md); exclude worklet framing.
export const NOISE_SUPPRESSION_MODELS = [
  { id: "dpdfnet8", name: "DPDFNet-8", quality: 4, cpu: 4, hint: "Strongest; may clip whispers", frameLength: 480, latencySamples: 2400 },
  { id: "dpdfnet2", name: "DPDFNet-2", quality: 3, cpu: 2, hint: "Strong on snaps & typing", frameLength: 480, latencySamples: 2400 },
  { id: "fastenhancer-m", name: "FastEnhancer Medium", quality: 2, cpu: 3, hint: "Gentlest on quiet voices", frameLength: 320, latencySamples: 704 },
  { id: "dfn3", name: "DeepFilterNet 3", quality: 1, cpu: 1, hint: "Lightest on CPU", frameLength: 480, latencySamples: 1440 }
] as const;

export type NoiseSuppressionModelId = (typeof NOISE_SUPPRESSION_MODELS)[number]["id"];
export const NOISE_SUPPRESSION_UNLIMITED_DB = 100;
export const NOISE_SUPPRESSION_LIMIT_STOPS = [...Array.from({ length: 25 }, (_, index) => index + 6), NOISE_SUPPRESSION_UNLIMITED_DB];

export function formatNoiseSuppressionLimit(db: number): string {
  return db === NOISE_SUPPRESSION_UNLIMITED_DB ? "Unlimited" : `${db} dB`;
}

/** Four hops of worklet buffering (assembly + three queued), plus model delay. */
export function noiseSuppressionLatencyMs(id: NoiseSuppressionModelId): number {
  const model = noiseSuppressionModelInfo(id);
  return (4 * model.frameLength + model.latencySamples) / 48;
}

export function normalizeNoiseSuppressionModel(value: unknown): NoiseSuppressionModelId {
  return NOISE_SUPPRESSION_MODELS.find((model) => model.id === value)?.id ?? "dfn3";
}

export function noiseSuppressionModelInfo(value: NoiseSuppressionModelId) {
  return NOISE_SUPPRESSION_MODELS.find((model) => model.id === value)!;
}

export function normalizeNoiseSuppressionAttenuation(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value > 30) return NOISE_SUPPRESSION_UNLIMITED_DB;
  return Math.max(6, Math.round(value));
}

export function noiseSuppressionSummary(settings: Pick<AudioSettings, "noiseSuppressionModel" | "noiseSuppressionAttenuationDb">): string {
  const name = noiseSuppressionModelInfo(settings.noiseSuppressionModel).name;
  if (settings.noiseSuppressionModel !== "dfn3") return name;
  return `${name} · ${settings.noiseSuppressionAttenuationDb === NOISE_SUPPRESSION_UNLIMITED_DB ? formatNoiseSuppressionLimit(settings.noiseSuppressionAttenuationDb).toLowerCase() : `up to ${formatNoiseSuppressionLimit(settings.noiseSuppressionAttenuationDb)}`}`;
}
