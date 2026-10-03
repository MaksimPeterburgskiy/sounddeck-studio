import type { FeedbackPayload } from "@elgato/streamdeck";
import type { ControlVolumeBus } from "../../src/lib/controlProtocol";
import type { Connection } from "./connection";
import { keyIcons } from "./render/icons";
import type { ActionSettings } from "./settings";

export const volumeBuses: Record<ControlVolumeBus, { name: string; short: string }> = {
  micVirtual: { name: "Mic → virtual mic", short: "Mic→VM" },
  micMonitor: { name: "Mic → headphones", short: "Mic→HP" },
  soundboardVirtual: { name: "Soundboard → virtual mic", short: "SB→VM" },
  soundboardMonitor: { name: "Soundboard → headphones", short: "SB→HP" },
};

export function volumeBus(settings: ActionSettings): ControlVolumeBus | undefined {
  const bus = settings.bus ?? "micVirtual";
  return typeof bus === "string" && Object.hasOwn(volumeBuses, bus) ? bus : undefined;
}

/** Steps are stored as whole percentages; commands use fractions of full scale. */
export function volumeStep(settings: ActionSettings, fallback: number): number {
  return (typeof settings.step === "number" && Number.isFinite(settings.step)
    ? Math.min(25, Math.max(1, Math.round(settings.step))) : fallback) / 100;
}

export function volumeVisual(connection: Connection, settings: ActionSettings) {
  const bus = volumeBus(settings);
  const level = bus && connection.snapshot?.volumes[bus];
  if (!bus || !level) return { title: "Missing", warning: true, dimmed: true, state: 0 as const };
  const mode = settings.mode ?? "up";
  const icon: keyof typeof keyIcons = level.muted ? "speaker-muted" : mode === "up" ? "speaker-up" : mode === "down" ? "speaker-down" : "speaker";
  return {
    title: `${volumeBuses[bus].short}\n${Math.round(level.value * 100)}%`, icon,
    iconOn: level.muted, active: level.muted, state: level.muted ? 1 as const : 0 as const,
  };
}

export function volumeFeedback(connection: Connection, settings: ActionSettings): FeedbackPayload {
  const bus = volumeBus(settings);
  const connected = connection.status === "connected";
  const level = connected && bus ? connection.snapshot?.volumes[bus] : undefined;
  const muted = !!level?.muted;
  const color = !level || muted ? "#8fa5a4" : "#1db7a6";
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"><g color="${color}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${keyIcons[muted ? "speaker-muted" : "speaker"]}</g></svg>`;
  return {
    // B1's title is 136px wide: a smaller font keeps the full bus name visible.
    title: { value: bus ? volumeBuses[bus].name : "Missing", font: { size: 10 } },
    value: { value: !connected ? connection.statusLabel.replace(/\n/g, " ") : !level ? "Missing" : muted ? "Muted" : `${Math.round(level.value * 100)}%`, font: { size: level ? 24 : 12 } },
    icon: `data:image/svg+xml;base64,${Buffer.from(icon).toString("base64")}`,
    indicator: { value: level && !muted ? level.value * 100 : 0, range: { min: 0, max: 100 }, bar_fill_c: color, enabled: !!level && !muted },
  };
}
