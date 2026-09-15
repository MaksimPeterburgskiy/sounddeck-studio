import React, { useEffect, useState } from "react";
import { Radio } from "lucide-react";
import type { WindowState } from "./types";

// Custom window chrome. The native title bar is hidden by the main process on
// every platform; macOS keeps its traffic lights (inset into this bar), while
// Windows and Linux get caption buttons drawn here. The whole bar is a drag
// region, so double-clicking it maximizes/zooms just like a native title bar.
export function TitleBar({ status }: { status: string }) {
  const platform = window.sounddeck.getPlatformSync();
  const drawsControls = platform === "win32" || platform === "linux";
  const [windowState, setWindowState] = useState<WindowState>({ maximized: false, fullscreen: false });

  useEffect(() => {
    let cancelled = false;
    void window.sounddeck.getWindowState().then((state) => {
      if (!cancelled) setWindowState(state);
    }).catch(() => undefined);
    const unsubscribe = window.sounddeck.onWindowState(setWindowState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    <div className="titlebar" data-platform={platform} data-fullscreen={windowState.fullscreen || undefined}>
      <div className="brand" data-status={status}>
        <Radio size={15} />
        <strong>SoundDeck</strong>
        <span>{status}</span>
      </div>
      {drawsControls && (
        <div className="windowControls">
          <button type="button" aria-label="Minimize" title="Minimize" onClick={() => void window.sounddeck.minimizeWindow()}>
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" /></svg>
          </button>
          <button
            type="button"
            aria-label={windowState.maximized ? "Restore" : "Maximize"}
            title={windowState.maximized ? "Restore" : "Maximize"}
            onClick={() => void window.sounddeck.toggleMaximizeWindow()}
          >
            {windowState.maximized ? (
              <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5v-2h7v7h-2" /><rect x="0.5" y="2.5" width="7" height="7" /></svg>
            ) : (
              <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
            )}
          </button>
          <button type="button" className="windowControlClose" aria-label="Close" title="Close" onClick={() => void window.sounddeck.closeWindow()}>
            <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}
