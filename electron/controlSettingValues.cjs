const { MODEL_IDS } = require("./noiseSuppression.cjs");
const NOISE_SUPPRESSION_UNLIMITED_DB = 100;
function normalizeAttenuation(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value > 30) return NOISE_SUPPRESSION_UNLIMITED_DB;
  return Math.max(6, Math.round(value));
}
const TOGGLE_SETTING_KEYS = ["micPassthrough", "soundboardToVirtualMic", "noiseSuppressionEnabled", "echoCancellationEnabled", "monitorToHeadphones"];
function validControlSettingValue(key, value) {
  if (key === "noiseSuppressionModel") return MODEL_IDS.includes(value);
  if (key === "noiseSuppressionAttenuationDb") return Number.isInteger(value) && value >= 6 && normalizeAttenuation(value) === value;
  return TOGGLE_SETTING_KEYS.includes(key) && typeof value === "boolean";
}
module.exports = { TOGGLE_SETTING_KEYS, validControlSettingValue, normalizeAttenuation, NOISE_SUPPRESSION_UNLIMITED_DB };
