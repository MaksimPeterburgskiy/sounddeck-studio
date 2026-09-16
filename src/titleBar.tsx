import React, { useEffect, useState } from "react";
import { Copy, Minus, Radio, Square, X } from "lucide-react";
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
            <Minus size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={windowState.maximized ? "Restore" : "Maximize"}
            title={windowState.maximized ? "Restore" : "Maximize"}
            onClick={() => void window.sounddeck.toggleMaximizeWindow()}
          >
            {windowState.maximized ? <Copy size={13} strokeWidth={1.5} aria-hidden="true" /> : <Square size={13} strokeWidth={1.5} aria-hidden="true" />}
          </button>
          <button type="button" className="windowControlClose" aria-label="Close" title="Close" onClick={() => void window.sounddeck.closeWindow()}>
            <X size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
