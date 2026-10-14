import type { AudioSettings, MicChainEntry, MicEqBand, MicFilter, MicFilterParamsByType, MicFilterType, MicNoiseSuppressionSlot } from "../types";

export const NOISE_SUPPRESSION_SLOT: MicNoiseSuppressionSlot = { id: "noise-suppression", type: "noiseSuppression" };
/** DeepFilterNet runs three 10 ms frames behind its input. */
export const NOISE_SUPPRESSION_LATENCY_MS = 30;

export interface MicParamField<Type extends MicFilterType = MicFilterType> {
  key: Extract<keyof MicFilterParamsByType[Type], string>;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Map the slider logarithmically (frequencies and times). */
  log?: boolean;
}

interface MicFilterDefinition<Type extends MicFilterType> {
  label: string;
  description: string;
  defaults: () => MicFilterParamsByType[Type];
  normalize: (value: Partial<MicFilterParamsByType[Type]>) => MicFilterParamsByType[Type];
  summary: (params: MicFilterParamsByType[Type]) => string;
  fields: MicParamField<Type>[];
  latencyMs?: (params: MicFilterParamsByType[Type]) => number;
  /** The engine reports gain reduction for this filter. */
  reducesGain?: boolean;
}

export const EQ_BAND_KINDS = ["lowshelf", "peaking", "peaking", "peaking", "highshelf"] as const;
export const EQ_BAND_LABELS = ["Low", "Mid 1", "Mid 2", "Mid 3", "High"];
const defaultEqBands: MicEqBand[] = [
  { enabled: true, frequencyHz: 120, gainDb: 0, q: 0.7 },
  { enabled: true, frequencyHz: 300, gainDb: -2, q: 1.2 },
  { enabled: true, frequencyHz: 1200, gainDb: 0, q: 1 },
  { enabled: true, frequencyHz: 3500, gainDb: 2, q: 1 },
  { enabled: true, frequencyHz: 10000, gainDb: 1.5, q: 0.7 }
];
export const EQ_BAND_FIELDS = {
  frequencyHz: { label: "Freq", min: 20, max: 20000, step: 1, unit: "Hz", log: true },
  gainDb: { label: "Gain", min: -15, max: 15, step: 0.5, unit: "dB" },
  q: { label: "Q", min: 0.3, max: 8, step: 0.01, unit: "", log: true }
} as const;

function clamp(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Signed dB with a real minus sign, e.g. "−18 dB" or "+3 dB". */
export function formatDb(value: number, digits = 1, signed = false) {
  const rounded = Number(value.toFixed(digits));
  const text = Math.abs(rounded).toString();
  if (rounded < 0) return `−${text} dB`;
  return `${signed && rounded > 0 ? "+" : ""}${text} dB`;
}

export function formatHz(value: number) {
  return value >= 1000 ? `${Number((value / 1000).toFixed(value >= 10000 ? 1 : 2))} kHz` : `${Math.round(value)} Hz`;
}

export function formatParamValue(field: { unit: string; min: number; max: number }, value: number) {
  if (field.unit === "Hz") return formatHz(value);
  // Boost/cut controls show an explicit plus sign.
  if (field.unit === "dB") return formatDb(value, 1, field.min < 0 && field.max > 0);
  if (field.unit === "ms") return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} ms`;
  if (field.unit === ":1") return `${Number(value.toFixed(1))}:1`;
  if (field.unit === "1:") return `1:${Number(value.toFixed(1))}`;
  return String(Number(value.toFixed(2)));
}

function fields<Type extends MicFilterType>(...list: MicParamField<Type>[]) {
  return list;
}

const catalog: { [Type in MicFilterType]: MicFilterDefinition<Type> } = {
  highPass: {
    label: "High-pass",
    description: "Removes rumble, desk thumps, and hum.",
    defaults: () => ({ frequencyHz: 80, slope: 24 }),
    normalize: (value) => ({ frequencyHz: clamp(value.frequencyHz, 80, 20, 400), slope: value.slope === 12 ? 12 : 24 }),
    summary: (params) => `${formatHz(params.frequencyHz)} · ${params.slope} dB/oct`,
    fields: fields<"highPass">({ key: "frequencyHz", label: "Frequency", min: 20, max: 400, step: 1, unit: "Hz", log: true })
  },
  expander: {
    label: "Downward expander",
    description: "Turns down room noise and breaths between phrases.",
    defaults: () => ({ thresholdDb: -45, ratio: 3, attackMs: 2, holdMs: 60, releaseMs: 150, rangeDb: -30, hysteresisDb: 4 }),
    normalize: (value) => ({
      thresholdDb: clamp(value.thresholdDb, -45, -80, 0),
      ratio: clamp(value.ratio, 3, 1, 10),
      attackMs: clamp(value.attackMs, 2, 0.1, 100),
      holdMs: clamp(value.holdMs, 60, 0, 500),
      releaseMs: clamp(value.releaseMs, 150, 10, 2000),
      rangeDb: clamp(value.rangeDb, -30, -80, 0),
      hysteresisDb: clamp(value.hysteresisDb, 4, 0, 12)
    }),
    summary: (params) => `${formatDb(params.thresholdDb, 0)} · 1:${Number(params.ratio.toFixed(1))} · range ${formatDb(params.rangeDb, 0)}`,
    fields: fields<"expander">(
      { key: "thresholdDb", label: "Threshold", min: -80, max: 0, step: 1, unit: "dB" },
      { key: "ratio", label: "Ratio", min: 1, max: 10, step: 0.1, unit: "1:" },
      { key: "rangeDb", label: "Range", min: -80, max: 0, step: 1, unit: "dB" },
      { key: "attackMs", label: "Attack", min: 0.1, max: 100, step: 0.1, unit: "ms", log: true },
      { key: "holdMs", label: "Hold", min: 0, max: 500, step: 1, unit: "ms" },
      { key: "releaseMs", label: "Release", min: 10, max: 2000, step: 1, unit: "ms", log: true },
      { key: "hysteresisDb", label: "Hysteresis", min: 0, max: 12, step: 0.5, unit: "dB" }
    ),
    reducesGain: true
  },
  deEsser: {
    label: "De-esser",
    description: "Tames harsh s, sh, and t sounds.",
    defaults: () => ({ frequencyHz: 6500, thresholdDb: -30, maxReductionDb: 6, mode: "split" }),
    normalize: (value) => ({
      frequencyHz: clamp(value.frequencyHz, 6500, 2000, 12000),
      thresholdDb: clamp(value.thresholdDb, -30, -60, 0),
      maxReductionDb: clamp(value.maxReductionDb, 6, 0, 18),
      mode: value.mode === "wide" ? "wide" : "split"
    }),
    summary: (params) => `${formatHz(params.frequencyHz)} · up to ${formatDb(-params.maxReductionDb, 0)}`,
    fields: fields<"deEsser">(
      { key: "frequencyHz", label: "Frequency", min: 2000, max: 12000, step: 10, unit: "Hz", log: true },
      { key: "thresholdDb", label: "Threshold", min: -60, max: 0, step: 1, unit: "dB" },
      { key: "maxReductionDb", label: "Max cut", min: 0, max: 18, step: 0.5, unit: "dB" }
    ),
    reducesGain: true
  },
  eq: {
    label: "EQ",
    description: "Five-band tone shaping.",
    defaults: () => ({ bands: defaultEqBands.map((band) => ({ ...band })) }),
    normalize: (value) => ({
      bands: defaultEqBands.map((fallback, index) => {
        const band = (Array.isArray(value.bands) ? value.bands[index] : undefined) as Partial<MicEqBand> | undefined;
        return {
          enabled: typeof band?.enabled === "boolean" ? band.enabled : fallback.enabled,
          frequencyHz: clamp(band?.frequencyHz, fallback.frequencyHz, EQ_BAND_FIELDS.frequencyHz.min, EQ_BAND_FIELDS.frequencyHz.max),
          gainDb: clamp(band?.gainDb, fallback.gainDb, EQ_BAND_FIELDS.gainDb.min, EQ_BAND_FIELDS.gainDb.max),
          q: clamp(band?.q, fallback.q, EQ_BAND_FIELDS.q.min, EQ_BAND_FIELDS.q.max)
        };
      })
    }),
    summary: (params) => {
      const gains = params.bands.filter((band) => band.enabled && Math.abs(band.gainDb) >= 0.05).map((band) => formatDb(band.gainDb, 1, true).replace(" dB", ""));
      return gains.length ? `5 bands · ${gains.join(" / ")}` : "5 bands · flat";
    },
    fields: []
  },
  compressor: {
    label: "Compressor",
    description: "Evens out your level.",
    defaults: () => ({ thresholdDb: -18, ratio: 3, kneeDb: 6, attackMs: 5, releaseMs: 120, makeupDb: 3 }),
    normalize: (value) => ({
      thresholdDb: clamp(value.thresholdDb, -18, -60, 0),
      ratio: clamp(value.ratio, 3, 1, 20),
      kneeDb: clamp(value.kneeDb, 6, 0, 24),
      attackMs: clamp(value.attackMs, 5, 0.1, 200),
      releaseMs: clamp(value.releaseMs, 120, 10, 2000),
      makeupDb: clamp(value.makeupDb, 3, 0, 24)
    }),
    summary: (params) => `${formatDb(params.thresholdDb, 0)} · ${Number(params.ratio.toFixed(1))}:1 · ${formatDb(params.makeupDb, 1, true)} makeup`,
    fields: fields<"compressor">(
      { key: "thresholdDb", label: "Threshold", min: -60, max: 0, step: 0.5, unit: "dB" },
      { key: "ratio", label: "Ratio", min: 1, max: 20, step: 0.1, unit: ":1", log: true },
      { key: "kneeDb", label: "Knee", min: 0, max: 24, step: 0.5, unit: "dB" },
      { key: "attackMs", label: "Attack", min: 0.1, max: 200, step: 0.1, unit: "ms", log: true },
      { key: "releaseMs", label: "Release", min: 10, max: 2000, step: 1, unit: "ms", log: true },
      { key: "makeupDb", label: "Makeup", min: 0, max: 24, step: 0.5, unit: "dB" }
    ),
    reducesGain: true
  },
  limiter: {
    label: "Limiter",
    description: "A hard ceiling so your voice never clips.",
    defaults: () => ({ ceilingDb: -1, releaseMs: 60, lookaheadMs: 3 }),
    normalize: (value) => ({
      ceilingDb: clamp(value.ceilingDb, -1, -12, 0),
      releaseMs: clamp(value.releaseMs, 60, 5, 1000),
      lookaheadMs: clamp(value.lookaheadMs, 3, 1, 5)
    }),
    summary: (params) => `Ceiling ${formatDb(params.ceilingDb)} · ${Number(params.lookaheadMs.toFixed(1))} ms lookahead`,
    fields: fields<"limiter">(
      { key: "ceilingDb", label: "Ceiling", min: -12, max: 0, step: 0.1, unit: "dB" },
      { key: "releaseMs", label: "Release", min: 5, max: 1000, step: 1, unit: "ms", log: true },
      { key: "lookaheadMs", label: "Lookahead", min: 1, max: 5, step: 0.1, unit: "ms" }
    ),
    latencyMs: (params) => params.lookaheadMs,
    reducesGain: true
  },
  gain: {
    label: "Gain",
    description: "Turns the level up or down at this point.",
    defaults: () => ({ gainDb: 0 }),
    normalize: (value) => ({ gainDb: clamp(value.gainDb, 0, -24, 24) }),
    summary: (params) => formatDb(params.gainDb, 1, true),
    fields: fields<"gain">({ key: "gainDb", label: "Gain", min: -24, max: 24, step: 0.5, unit: "dB" })
  }
};

export const MIC_FILTER_TYPES = Object.keys(catalog) as MicFilterType[];

export function micFilterDefinition<Type extends MicFilterType>(type: Type): MicFilterDefinition<Type> {
  return catalog[type] as unknown as MicFilterDefinition<Type>;
}

export function micFilterSummary(filter: MicFilter) {
  return (micFilterDefinition(filter.type).summary as (params: MicFilter["params"]) => string)(filter.params);
}

export function micFilterLatencyMs(filter: MicFilter) {
  const latency = micFilterDefinition(filter.type).latencyMs as ((params: MicFilter["params"]) => number) | undefined;
  return latency ? latency(filter.params) : 0;
}

export function normalizeMicFilterParams<Type extends MicFilterType>(type: Type, value: unknown): MicFilterParamsByType[Type] {
  const incoming = value && typeof value === "object" ? value : {};
  return micFilterDefinition(type).normalize(incoming as Partial<MicFilterParamsByType[Type]>);
}

export function createMicFilter(type: MicFilterType, id = `mic-filter-${crypto.randomUUID()}`): MicFilter {
  return { id, type, enabled: true, params: micFilterDefinition(type).defaults() } as MicFilter;
}

export function defaultMicChain(): MicChainEntry[] {
  return [{ ...NOISE_SUPPRESSION_SLOT }];
}

/** Drops unknown entries, clamps params, and keeps exactly one noise suppression slot. */
export function normalizeMicChain(value: unknown): MicChainEntry[] {
  if (!Array.isArray(value)) return defaultMicChain();
  const chain: MicChainEntry[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { id?: unknown; type?: unknown; enabled?: unknown; params?: unknown };
    if (entry.type === "noiseSuppression") {
      if (!ids.has(NOISE_SUPPRESSION_SLOT.id)) chain.push({ ...NOISE_SUPPRESSION_SLOT });
      ids.add(NOISE_SUPPRESSION_SLOT.id);
      continue;
    }
    if (!MIC_FILTER_TYPES.includes(entry.type as MicFilterType)) continue;
    const type = entry.type as MicFilterType;
    let id = typeof entry.id === "string" && entry.id && entry.id !== NOISE_SUPPRESSION_SLOT.id ? entry.id : "";
    if (!id || ids.has(id)) id = `mic-filter-${crypto.randomUUID()}`;
    ids.add(id);
    chain.push({ id, type, enabled: entry.enabled !== false, params: normalizeMicFilterParams(type, entry.params) } as MicFilter);
  }
  if (!ids.has(NOISE_SUPPRESSION_SLOT.id)) chain.unshift({ ...NOISE_SUPPRESSION_SLOT });
  return chain;
}

export function isMicFilter(entry: MicChainEntry): entry is MicFilter {
  return entry.type !== "noiseSuppression";
}

export function addMicFilter(chain: MicChainEntry[], type: MicFilterType) {
  return [...chain, createMicFilter(type)];
}

/** Noise suppression can't be removed, only switched off. */
export function removeMicFilter(chain: MicChainEntry[], id: string) {
  return chain.filter((entry) => !isMicFilter(entry) || entry.id !== id);
}

export function moveMicChainEntry(chain: MicChainEntry[], from: number, to: number) {
  if (from === to || from < 0 || from >= chain.length) return chain;
  const next = [...chain];
  const [entry] = next.splice(from, 1);
  next.splice(Math.min(Math.max(0, to), next.length), 0, entry);
  return next;
}

export function updateMicFilter(chain: MicChainEntry[], id: string, update: (filter: MicFilter) => MicFilter) {
  return chain.map((entry) => isMicFilter(entry) && entry.id === id ? update(entry) : entry);
}

type ChainSettings = Pick<AudioSettings, "micChain" | "noiseSuppressionEnabled">;

export function micChainEntryEnabled(entry: MicChainEntry, settings: Pick<AudioSettings, "noiseSuppressionEnabled">) {
  return isMicFilter(entry) ? entry.enabled : settings.noiseSuppressionEnabled;
}

export function activeMicChainCount(settings: ChainSettings) {
  return settings.micChain.filter((entry) => micChainEntryEnabled(entry, settings)).length;
}
