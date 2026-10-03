const dismissalKey = (version: string) => `sounddeck:streamdeck:dismissed:${version}`;

export function isPluginUpdateDismissed(version: string): boolean {
  try { return localStorage.getItem(dismissalKey(version)) === "true"; } catch { return false; }
}

export function dismissPluginUpdate(version: string): void {
  try { localStorage.setItem(dismissalKey(version), "true"); } catch { /* Keep the current session dismissal if storage is unavailable. */ }
}

export function pluginInstallError(reason?: string): string {
  return reason === "no-handler" ? "Stream Deck software not found"
    : reason === "missing-file" ? "Stream Deck plugin file is unavailable."
    : "Could not open the Stream Deck plugin.";
}
