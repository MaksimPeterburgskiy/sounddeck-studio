import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function preload() {
  let sounddeck;
  const ipcRenderer = Object.assign(new EventEmitter(), { invoke: vi.fn(async () => ({ ok: true })) });
  runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, api) => { sounddeck = api; } } })
  });
  return { ipcRenderer, sounddeck };
}

describe("preload control readiness", () => {
  it("waits for the loaded document's token and retains it for late readiness calls", async () => {
    const outgoing = preload();
    const pending = outgoing.sounddeck.controlReady();
    await Promise.resolve();
    expect(outgoing.ipcRenderer.invoke).not.toHaveBeenCalled();
    outgoing.ipcRenderer.emit("control-ready-token", {}, "old-document");
    await pending;
    expect(outgoing.ipcRenderer.invoke).toHaveBeenLastCalledWith("control:ready", "old-document");
    const current = preload();
    current.ipcRenderer.emit("control-ready-token", {}, "new-document");
    await current.sounddeck.controlReady();
    expect(current.ipcRenderer.invoke).toHaveBeenLastCalledWith("control:ready", "new-document");
    await outgoing.sounddeck.controlReady();
    expect(outgoing.ipcRenderer.invoke).toHaveBeenLastCalledWith("control:ready", "old-document");
  });

  it("tags all cache updates and playback results with their source document", async () => {
    const document = preload();
    const library = { boards: [] };
    const state = { playback: [] };
    const pending = [document.sounddeck.loadLibrary(), document.sounddeck.saveLibrary(library), document.sounddeck.pushControlState(state)];
    expect(document.ipcRenderer.invoke).not.toHaveBeenCalled();
    document.ipcRenderer.emit("control-ready-token", {}, "source-document");
    await Promise.all(pending);
    document.sounddeck.onControlCommand(async () => ({ ok: true }));
    document.ipcRenderer.emit("control-command", {}, { command: "sound.play", args: { soundId: "sound" }, requestId: "request" });
    await vi.waitFor(() => expect(document.ipcRenderer.invoke).toHaveBeenCalledWith("control:result", "request", { ok: true }, "source-document"));
    expect(document.ipcRenderer.invoke.mock.calls).toEqual([
      ["library:load", "source-document"], ["library:save", library, "source-document"],
      ["control:state", state, "source-document"], ["control:result", "request", { ok: true }, "source-document"]
    ]);
  });
});
