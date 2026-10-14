import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioSettings, MicChainEntry } from "../types";
import { MicChain } from "./micChain";
import { createMicFilter } from "./micFilters";
import { FakeAudioContext, FakeAudioWorkletNode, FakeWorker, fakeStream } from "./testing/webAudioFakes";

const noiseSlot = { id: "noise-suppression", type: "noiseSuppression" } as const;

function chainSettings(micChain: MicChainEntry[], patch: Partial<AudioSettings> = {}) {
  return { micChain, noiseSuppressionEnabled: true, noiseSuppressionAttenuationDb: 18, ...patch };
}

describe("MicChain", () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    FakeWorker.instances = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("window", {
      sounddeck: { getNoiseSuppressionAssets: vi.fn(async () => ({ wasm: new ArrayBuffer(8), model: new ArrayBuffer(8) })) }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("builds every filter type, applies edits in place, and tracks noise suppression", async () => {
    const onChange = vi.fn();
    const chain = await MicChain.create(onChange);
    const context = FakeAudioContext.instances[0];
    const entries: MicChainEntry[] = [noiseSlot, ...(["highPass", "expander", "deEsser", "eq", "compressor", "limiter", "gain"] as const).map((type) => createMicFilter(type, type))];
    chain.setSource(fakeStream().stream);
    chain.apply(chainSettings(entries));
    expect(context.workletNodes.map((node) => node.name)).toEqual([
      "sounddeck-deep-filter", "sounddeck-expander", "sounddeck-deesser", "sounddeck-compressor", "sounddeck-limiter"
    ]);
    expect(context.biquads.map((filter) => filter.type)).toEqual(["highpass", "highpass", "lowshelf", "peaking", "peaking", "peaking", "highshelf"]);
    expect(chain.latencyMs).toBe(3);
    expect(chain.noiseSuppressionState).toBe("loading");

    const worker = FakeWorker.instances[0];
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "init", attenuationDb: 18 }), expect.any(Array)));
    worker.onmessage?.({ data: { type: "ready" } } as MessageEvent);
    expect(chain.noiseSuppressionState).toBe("active");
    expect(chain.latencyMs).toBe(33);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    context.workletNodes[0].port.onmessage?.({ data: { type: "error", message: "boom" } } as MessageEvent);
    expect(chain.noiseSuppressionState).toBe("unavailable");
    worker.onerror?.({ message: "crash" } as ErrorEvent);
    expect(onChange).toHaveBeenCalledTimes(2);

    const edited = entries.map((entry) => {
      if (entry.type === "eq") return { ...entry, params: { bands: entry.params.bands.map((band, index) => index === 0 ? { ...band, enabled: false, gainDb: 6 } : band) } };
      if (entry.type === "gain") return { ...entry, params: { gainDb: -6 } };
      if (entry.type === "limiter") return { ...entry, params: { ...entry.params, lookaheadMs: 5 } };
      return entry;
    });
    chain.apply(chainSettings(edited, { noiseSuppressionAttenuationDb: 24 }));
    expect(context.biquads[2].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, expect.any(Number));
    expect(context.gains[2].gain.setTargetAtTime).toHaveBeenLastCalledWith(expect.closeTo(0.501, 2), 0, expect.any(Number));
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "attenuation", value: 24 });
    expect(chain.latencyMs).toBe(35);

    chain.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(context.workletNodes.every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("closes its context when the worklet modules fail to load", async () => {
    class BrokenContext extends FakeAudioContext {
      audioWorklet = { addModule: vi.fn(async () => { throw new Error("missing module"); }) };
    }
    vi.stubGlobal("AudioContext", BrokenContext);
    await expect(MicChain.create(vi.fn())).rejects.toThrow("missing module");
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce();
  });
});
