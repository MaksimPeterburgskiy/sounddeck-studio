import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./audioEngine";
import type { AudioSettings } from "../types";
import { FakeAudioContext, FakeAudioWorkletNode, FakeWorker, deferred, fakeStream, makeAudioSettings, makeSound, waitForMockCalls } from "./testing/webAudioFakes";

const settings: AudioSettings = makeAudioSettings();

const playbackSettings: AudioSettings = makeAudioSettings({
  micPassthrough: false,
  soundboardToVirtualMic: false,
  monitorToHeadphones: true,
  monitorMicToHeadphones: false
});

describe("AudioEngine mic routing", () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    FakeWorker.instances = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stops stale mic streams when overlapping reconfiguration resolves out of order", async () => {
    const firstOpen = deferred<MediaStream>();
    const secondOpen = deferred<MediaStream>();
    const getUserMedia = vi.fn()
      .mockReturnValueOnce(firstOpen.promise)
      .mockReturnValueOnce(secondOpen.promise);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const first = fakeStream();
    const second = fakeStream();
    const engine = new AudioEngine(settings, vi.fn());

    const firstConfigure = engine.configure(settings, "cable-device");
    await waitForMockCalls(getUserMedia, 1);

    const secondConfigure = engine.configure(settings, "cable-device");

    secondOpen.resolve(second.stream);
    await secondConfigure;
    firstOpen.resolve(first.stream);
    await firstConfigure;

    const virtualContext = FakeAudioContext.instances[1];
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(first.track.stop).toHaveBeenCalledTimes(1);
    expect(second.track.stop).not.toHaveBeenCalled();
    expect(virtualContext.mediaSources.map((source) => source.stream)).toEqual([second.stream]);

    await engine.dispose();
  });

  it("rebuilds mic routing when virtual sink readiness changes for the same device", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const engine = new AudioEngine(settings, vi.fn());
    const virtualContext = FakeAudioContext.instances[1];
    virtualContext.setSinkId.mockRejectedValueOnce(new DOMException("temporary failure", "AbortError"));

    await engine.configure(settings, "cable-device");
    await engine.configure(settings, "cable-device");

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(first.track.stop).toHaveBeenCalledTimes(1);
    expect(second.track.stop).not.toHaveBeenCalled();
    expect(virtualContext.mediaSources.map((source) => source.stream)).toEqual([second.stream]);

    await engine.dispose();
  });

  it("routes the microphone to the virtual sink even when soundboard virtual output starts disabled", async () => {
    const captured = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(captured.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const micSettings = makeAudioSettings({
      soundboardToVirtualMic: false,
      monitorMicToHeadphones: false
    });
    const engine = new AudioEngine(micSettings, vi.fn());

    await engine.configure(micSettings, "cable-device");

    const monitorContext = FakeAudioContext.instances[0];
    const virtualContext = FakeAudioContext.instances[1];
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(virtualContext.mediaSources.map((source) => source.stream)).toEqual([captured.stream]);
    const micGain = virtualContext.mediaSources[0].connect.mock.calls[0][0];
    expect(virtualContext.gains).toContain(micGain);
    expect(virtualContext.gains.find((gain) => gain === micGain)?.connections).toContain(virtualContext.destination);
    expect(monitorContext.mediaSources).toHaveLength(0);

    await engine.dispose();
  });

  it("captures and monitors a microphone without routing it to a ready virtual sink", async () => {
    const captured = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(captured.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const monitorOnly = makeAudioSettings({
      micPassthrough: false,
      monitorMicToHeadphones: true
    });
    const engine = new AudioEngine(monitorOnly, vi.fn());

    await engine.configure(monitorOnly, "cable-device");

    const monitorContext = FakeAudioContext.instances[0];
    const virtualContext = FakeAudioContext.instances[1];
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(monitorContext.mediaSources.map((source) => source.stream)).toEqual([captured.stream]);
    const micGain = monitorContext.mediaSources[0].connect.mock.calls[0][0];
    expect(monitorContext.gains.find((gain) => gain === micGain)?.connections).toContain(monitorContext.destination);
    expect(virtualContext.mediaSources).toHaveLength(0);

    await engine.dispose();
  });

  it("keeps the active virtual microphone route while soundboard virtual output is toggled", async () => {
    const captured = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(captured.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const enabled = makeAudioSettings({ soundboardToVirtualMic: true });
    const disabled = { ...enabled, soundboardToVirtualMic: false };
    const engine = new AudioEngine(enabled, vi.fn());

    await engine.configure(enabled, "cable-device");
    const virtualContext = FakeAudioContext.instances[1];
    const virtualMicSource = virtualContext.mediaSources[0];

    await engine.configure(disabled, "cable-device");
    await engine.configure({ ...disabled, monitorToHeadphones: true }, "cable-device");
    await engine.configure(enabled, "cable-device");

    // Fake disconnects are recorded but deliberately leave their source arrays intact.
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(virtualContext.mediaSources).toEqual([virtualMicSource]);
    expect(virtualMicSource.disconnect).not.toHaveBeenCalled();
    expect(captured.track.stop).not.toHaveBeenCalled();

    await engine.dispose();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true]
  ])("monitors the microphone independently of soundboard monitoring (%s) and virtual output (%s)", async (monitorToHeadphones, soundboardToVirtualMic) => {
    const captured = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(captured.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const micSettings = makeAudioSettings({
      monitorToHeadphones,
      monitorMicToHeadphones: true,
      soundboardToVirtualMic
    });
    const engine = new AudioEngine(micSettings, vi.fn());

    await engine.configure(micSettings, "cable-device");

    const monitorContext = FakeAudioContext.instances[0];
    const virtualContext = FakeAudioContext.instances[1];
    expect(monitorContext.mediaSources.map((source) => source.stream)).toEqual([captured.stream]);
    expect(virtualContext.mediaSources.map((source) => source.stream)).toEqual([captured.stream]);

    await engine.dispose();
  });

  it("does not route a microphone to headphones when its virtual sink is unavailable and mic monitoring is off", async () => {
    const captured = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(captured.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const micSettings = makeAudioSettings({
      monitorToHeadphones: true,
      monitorMicToHeadphones: false
    });
    const engine = new AudioEngine(micSettings, vi.fn());
    const virtualContext = FakeAudioContext.instances[1];
    virtualContext.setSinkId.mockRejectedValueOnce(new DOMException("cable unavailable", "NotFoundError"));

    await engine.configure(micSettings, "cable-device");

    const monitorContext = FakeAudioContext.instances[0];
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(virtualContext.mediaSources).toHaveLength(0);
    expect(monitorContext.mediaSources).toHaveLength(0);

    await engine.dispose();
  });

  it("keeps capture for monitor-only routing, then stops it when every microphone route is disabled", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const enabled = makeAudioSettings({ monitorMicToHeadphones: true });
    const engine = new AudioEngine(enabled, vi.fn());

    await engine.configure(enabled, "cable-device");
    const monitorContext = FakeAudioContext.instances[0];
    const virtualContext = FakeAudioContext.instances[1];
    const firstMonitorSource = monitorContext.mediaSources[0];
    const firstVirtualSource = virtualContext.mediaSources[0];

    await engine.configure({ ...enabled, micPassthrough: false }, "cable-device");

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(first.track.stop).toHaveBeenCalledOnce();
    expect(firstMonitorSource.disconnect).toHaveBeenCalledOnce();
    expect(firstVirtualSource.disconnect).toHaveBeenCalledOnce();
    expect(monitorContext.mediaSources.at(-1)?.stream).toBe(second.stream);
    expect(virtualContext.mediaSources).toHaveLength(1);
    expect(second.track.stop).not.toHaveBeenCalled();

    await engine.configure({ ...enabled, micPassthrough: false, monitorMicToHeadphones: false }, "cable-device");

    expect(second.track.stop).toHaveBeenCalledOnce();
    expect(monitorContext.mediaSources.at(-1)?.disconnect).toHaveBeenCalledOnce();

    await engine.dispose();
  });

  it("stops a pending monitor-only capture when mic monitoring is disabled", async () => {
    const pendingCapture = deferred<MediaStream>();
    const captured = fakeStream();
    const getUserMedia = vi.fn().mockReturnValue(pendingCapture.promise);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const monitorOnly = makeAudioSettings({ micPassthrough: false, monitorMicToHeadphones: true });
    const engine = new AudioEngine(monitorOnly, vi.fn());

    const opening = engine.configure(monitorOnly, "cable-device");
    await waitForMockCalls(getUserMedia, 1);
    await engine.configure({ ...monitorOnly, monitorMicToHeadphones: false }, "cable-device");
    pendingCapture.resolve(captured.stream);
    await opening;

    expect(captured.track.stop).toHaveBeenCalledOnce();
    expect(FakeAudioContext.instances[0].mediaSources).toHaveLength(0);
    expect(FakeAudioContext.instances[1].mediaSources).toHaveLength(0);

    await engine.dispose();
  });

  it("retries failed monitor-only capture when reconfigured with unchanged settings", async () => {
    const captured = fakeStream();
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(new DOMException("microphone unavailable", "NotFoundError"))
      .mockResolvedValueOnce(captured.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const monitorOnly = makeAudioSettings({ micPassthrough: false, monitorMicToHeadphones: true, microphoneDeviceId: "" });
    const engine = new AudioEngine(monitorOnly, vi.fn());

    await engine.configure(monitorOnly, "cable-device");
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(FakeAudioContext.instances[0].mediaSources).toHaveLength(0);

    await engine.configure(monitorOnly, "cable-device");

    const monitorContext = FakeAudioContext.instances[0];
    const virtualContext = FakeAudioContext.instances[1];
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(monitorContext.mediaSources.map((source) => source.stream)).toEqual([captured.stream]);
    expect(virtualContext.mediaSources).toHaveLength(0);

    await engine.dispose();
  });

  it("ignores stale configure results when cable detection changes during sink switching", async () => {
    const delayedMonitorSwitch = deferred<void>();
    const stream = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const engine = new AudioEngine(settings, vi.fn());
    const monitorContext = FakeAudioContext.instances[0];
    const virtualContext = FakeAudioContext.instances[1];
    monitorContext.setSinkId
      .mockReturnValueOnce(delayedMonitorSwitch.promise)
      .mockResolvedValue(undefined);

    const staleConfigure = engine.configure(settings, "");
    const latestConfigure = engine.configure(settings, "cable-device");

    await latestConfigure;
    delayedMonitorSwitch.resolve();
    await staleConfigure;

    const internals = engine as unknown as { virtualSinkId: string; virtualSinkReady: boolean };
    expect(internals.virtualSinkId).toBe("cable-device");
    expect(internals.virtualSinkReady).toBe(true);
    expect(virtualContext.setSinkId).toHaveBeenLastCalledWith("cable-device");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(stream.track.stop).not.toHaveBeenCalled();

    await engine.dispose();
  });

  it("requests Chromium echo cancellation for live routing", async () => {
    const captured = fakeStream({ echoCancellation: true });
    const getUserMedia = vi.fn().mockResolvedValue(captured.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const engine = new AudioEngine(makeAudioSettings({ echoCancellationEnabled: true }), vi.fn());

    await engine.configure(makeAudioSettings({ echoCancellationEnabled: true }), "cable-device");

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false
      })
    });

    await engine.dispose();
  });

  it("updates echo cancellation in place when the track supports constraints", async () => {
    const captured = fakeStream({ echoCancellation: false });
    const getUserMedia = vi.fn().mockResolvedValue(captured.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const engine = new AudioEngine(makeAudioSettings({ echoCancellationEnabled: false }), vi.fn());
    await engine.configure(makeAudioSettings({ echoCancellationEnabled: false }), "cable-device");

    await engine.configure(makeAudioSettings({ echoCancellationEnabled: true }), "cable-device");

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(captured.track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ echoCancellation: true }));
    expect(captured.track.stop).not.toHaveBeenCalled();

    await engine.dispose();
  });

  it("processes the microphone once and shares that stream with monitor and virtual routes", async () => {
    const captured = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(captured.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("window", {
      sounddeck: {
        getNoiseSuppressionAssets: vi.fn(async () => ({ wasm: new ArrayBuffer(8), model: new ArrayBuffer(8) }))
      }
    });
    const processedSettings = makeAudioSettings({
      monitorToHeadphones: true,
      monitorMicToHeadphones: true,
      noiseSuppressionEnabled: true
    });
    const processingStatus = vi.fn();
    const engine = new AudioEngine(processedSettings, vi.fn(), processingStatus);

    await engine.configure(processedSettings, "cable-device");
    await Promise.resolve();

    const monitorContext = FakeAudioContext.instances[0];
    const virtualContext = FakeAudioContext.instances[1];
    const processingContext = FakeAudioContext.instances[3];
    const processedStream = processingContext.mediaDestinations[0].stream;
    expect(processingContext.options).toEqual({ latencyHint: "interactive", sampleRate: 48000 });
    expect(processingContext.mediaSources.map((source) => source.stream)).toEqual([captured.stream]);
    expect(processingContext.workletNodes).toHaveLength(1);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(monitorContext.mediaSources.map((source) => source.stream)).toEqual([processedStream]);
    expect(virtualContext.mediaSources.map((source) => source.stream)).toEqual([processedStream]);

    processingContext.workletNodes[0].port.onmessage?.({ data: { type: "underrun" } } as MessageEvent);
    expect(processingStatus).toHaveBeenLastCalledWith(expect.objectContaining({ noiseSuppression: "unavailable" }));
    processingContext.workletNodes[0].port.onmessage?.({ data: { type: "recovered" } } as MessageEvent);
    expect(processingStatus).toHaveBeenLastCalledWith(expect.objectContaining({ noiseSuppression: "active" }));

    await engine.configure({ ...processedSettings, noiseSuppressionAttenuationDb: 24 }, "cable-device");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances[0].postMessage).toHaveBeenCalledWith({ type: "attenuation", value: 24 });

    await engine.dispose();
  });

  it("routes noise-suppressed monitor-only capture only to headphones", async () => {
    const captured = fakeStream();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(captured.stream) } });
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("window", {
      sounddeck: {
        getNoiseSuppressionAssets: vi.fn(async () => ({ wasm: new ArrayBuffer(8), model: new ArrayBuffer(8) }))
      }
    });
    const monitorOnly = makeAudioSettings({
      micPassthrough: false,
      monitorMicToHeadphones: true,
      noiseSuppressionEnabled: true
    });
    const engine = new AudioEngine(monitorOnly, vi.fn());

    await engine.configure(monitorOnly, "cable-device");
    await Promise.resolve();

    const monitorContext = FakeAudioContext.instances[0];
    const virtualContext = FakeAudioContext.instances[1];
    const processingContext = FakeAudioContext.instances[3];
    expect(monitorContext.mediaSources.map((source) => source.stream)).toEqual([processingContext.mediaDestinations[0].stream]);
    expect(virtualContext.mediaSources).toHaveLength(0);
    expect(processingContext.mediaSources.map((source) => source.stream)).toEqual([captured.stream]);

    await engine.dispose();
  });

  it("tears down suppression and routes raw audio when its context cannot start", async () => {
    class FailingProcessingAudioContext extends FakeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        if (options?.sampleRate === 48000) this.resume.mockRejectedValue(new DOMException("cannot start", "InvalidStateError"));
      }
    }
    vi.stubGlobal("AudioContext", FailingProcessingAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("Worker", FakeWorker);
    const assets = deferred<{ wasm: ArrayBuffer; model: ArrayBuffer }>();
    vi.stubGlobal("window", { sounddeck: { getNoiseSuppressionAssets: vi.fn(() => assets.promise) } });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => fakeStream().stream) } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failedSettings = makeAudioSettings({
      monitorToHeadphones: true,
      monitorMicToHeadphones: true,
      noiseSuppressionEnabled: true
    });
    const processingStatus = vi.fn();
    const engine = new AudioEngine(failedSettings, vi.fn(), processingStatus);

    await engine.configure(failedSettings, "cable-device");

    const monitorContext = FakeAudioContext.instances[0];
    const virtualContext = FakeAudioContext.instances[1];
    const processingContext = FakeAudioContext.instances[3];
    const rawStream = monitorContext.mediaSources[0].stream;
    expect(virtualContext.mediaSources[0].stream).toBe(rawStream);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(processingContext.mediaSources[0].disconnect).toHaveBeenCalledOnce();
    expect(processingContext.workletNodes[0].disconnect).toHaveBeenCalledOnce();
    expect(processingContext.close).toHaveBeenCalledOnce();
    expect(processingStatus).toHaveBeenLastCalledWith(expect.objectContaining({ noiseSuppression: "unavailable" }));

    assets.resolve({ wasm: new ArrayBuffer(8), model: new ArrayBuffer(8) });
    await assets.promise;
    await Promise.resolve();
    expect(FakeWorker.instances[0].postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "init" }), expect.anything());

    await engine.dispose();
  });
});

describe("AudioEngine live effects", () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("window", {
      sounddeck: {
        readMedia: vi.fn(async () => new ArrayBuffer(8))
      },
      clearTimeout,
      setTimeout
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("builds a per-playback effect chain and applies effect parameters", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.play(makeSound({
      playbackRate: 1.25,
      effects: {
        pitchEnabled: true,
        pitchSemitones: 7,
        eq: { enabled: true, lowGainDb: 3, midGainDb: -2, highGainDb: 5 },
        compressor: { enabled: true, thresholdDb: -30, ratio: 4, attackMs: 10, releaseMs: 200 },
        limiter: { enabled: true, ceilingDb: -2 },
        reverb: { enabled: true, mix: 0.25, decaySec: 1.5 }
      }
    }));

    const monitorContext = FakeAudioContext.instances[0];
    const source = monitorContext.bufferSources[0];
    expect(source.playbackRate.value).toBe(1.25);
    expect(source.detune.value).toBe(700);
    expect(monitorContext.biquads.map((filter) => filter.type)).toEqual(["lowshelf", "peaking", "highshelf"]);
    expect(monitorContext.biquads.map((filter) => filter.gain.value)).toEqual([3, -2, 5]);
    expect(monitorContext.compressors[0].threshold.value).toBe(-30);
    expect(monitorContext.compressors[0].ratio.value).toBe(4);
    expect(monitorContext.compressors[1].threshold.value).toBe(-2);
    expect(monitorContext.compressors[1].ratio.value).toBe(20);
    expect(monitorContext.convolvers[0].buffer).toBeTruthy();
    expect(monitorContext.biquads[2].connections).toContain(monitorContext.compressors[0]);
    expect(monitorContext.compressors[0].connections).toContain(monitorContext.compressors[1]);
    expect(monitorContext.compressors[1].connections).toContain(monitorContext.convolvers[0]);

    await engine.dispose();
  });

  it("keeps disabled compressor and limiter out of the signal path", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.play(makeSound({
      effects: {
        pitchEnabled: false,
        pitchSemitones: 0,
        eq: { enabled: false, lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
        compressor: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 3, releaseMs: 250 },
        limiter: { enabled: false, ceilingDb: -1 },
        reverb: { enabled: false, mix: 0.18, decaySec: 1.4 }
      }
    }));

    const monitorContext = FakeAudioContext.instances[0];
    expect(monitorContext.compressors[0].connections).toHaveLength(0);
    expect(monitorContext.compressors[1].connections).toHaveLength(0);
    expect(monitorContext.biquads[2].connections).toContain(monitorContext.convolvers[0]);

    await engine.dispose();
  });

  it("rewires dynamics into and out of the path on live effect updates", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    const disabledEffects = {
      pitchEnabled: false,
      pitchSemitones: 0,
      eq: { enabled: false, lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
      compressor: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 3, releaseMs: 250 },
      limiter: { enabled: false, ceilingDb: -1 },
      reverb: { enabled: false, mix: 0.18, decaySec: 1.4 }
    };
    await engine.play(makeSound({ effects: disabledEffects }));

    const monitorContext = FakeAudioContext.instances[0];
    const high = monitorContext.biquads[2];
    const limiter = monitorContext.compressors[1];

    engine.setSoundEffects("sound-1", { ...disabledEffects, limiter: { enabled: true, ceilingDb: -3 } });
    expect(high.disconnect).toHaveBeenCalled();
    expect(high.connections).toContain(limiter);
    expect(limiter.connections).toContain(monitorContext.convolvers[0]);
    expect(limiter.threshold.value).toBe(-3);

    engine.setSoundEffects("sound-1", disabledEffects);
    expect(limiter.disconnect).toHaveBeenCalled();
    expect(high.connections.at(-1)).toBe(monitorContext.convolvers[0]);

    await engine.dispose();
  });

  it("updates active effect params without restarting playback", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    await engine.play(makeSound({
      effects: {
        pitchEnabled: false,
        pitchSemitones: 0,
        eq: { enabled: false, lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
        compressor: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 3, releaseMs: 250 },
        limiter: { enabled: false, ceilingDb: -1 },
        reverb: { enabled: true, mix: 0.25, decaySec: 1.4 }
      }
    }));

    const monitorContext = FakeAudioContext.instances[0];
    const source = monitorContext.bufferSources[0];
    expect(monitorContext.convolvers[0].buffer).toBeTruthy();
    engine.setSoundEffects("sound-1", {
      pitchEnabled: true,
      pitchSemitones: -5,
      eq: { enabled: true, lowGainDb: -3, midGainDb: 2, highGainDb: 4 },
      compressor: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 3, releaseMs: 250 },
      limiter: { enabled: false, ceilingDb: -1 },
      reverb: { enabled: false, mix: 0.18, decaySec: 1.4 }
    });

    expect(source.start).toHaveBeenCalledTimes(1);
    expect(source.detune.setTargetAtTime).toHaveBeenLastCalledWith(-500, expect.any(Number), 0.02);
    expect(monitorContext.biquads[0].gain.value).toBe(-3);
    expect(monitorContext.biquads[1].gain.value).toBe(2);
    expect(monitorContext.biquads[2].gain.value).toBe(4);
    expect(monitorContext.convolvers[0].buffer).toBeNull();

    await engine.dispose();
  });

  it("applies effects to preview playback", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    await engine.previewPlay(makeSound({
      effects: {
        pitchEnabled: true,
        pitchSemitones: 12,
        eq: { enabled: false, lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
        compressor: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 3, releaseMs: 250 },
        limiter: { enabled: false, ceilingDb: -1 },
        reverb: { enabled: false, mix: 0.18, decaySec: 1.4 }
      }
    }), 0, 1);

    const monitorContext = FakeAudioContext.instances[0];
    expect(monitorContext.bufferSources[0].detune.value).toBe(1200);
    expect(monitorContext.biquads).toHaveLength(3);

    await engine.dispose();
  });

  it("keeps reverb tails connected without reporting the sound as playing", async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const engine = new AudioEngine(playbackSettings, vi.fn());

    try {
      await engine.play(makeSound({
        effects: {
          pitchEnabled: false,
          pitchSemitones: 0,
          eq: { enabled: false, lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
          compressor: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 3, releaseMs: 250 },
          limiter: { enabled: false, ceilingDb: -1 },
          reverb: { enabled: true, mix: 0.25, decaySec: 1.5 }
        }
      }));

      const monitorContext = FakeAudioContext.instances[0];
      const source = monitorContext.bufferSources[0];
      source.onended?.();

      expect(engine.isPlaying("sound-1")).toBe(false);
      expect(monitorContext.convolvers[0].disconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1499);
      expect(engine.isPlaying("sound-1")).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(engine.isPlaying("sound-1")).toBe(false);
      expect(monitorContext.convolvers[0].disconnect).toHaveBeenCalled();
    } finally {
      await engine.dispose();
      vi.useRealTimers();
    }
  });

  it("lets stop clear a pending reverb tail", async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const engine = new AudioEngine(playbackSettings, vi.fn());

    try {
      await engine.play(makeSound({
        effects: {
          pitchEnabled: false,
          pitchSemitones: 0,
          eq: { enabled: false, lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
          compressor: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 3, releaseMs: 250 },
          limiter: { enabled: false, ceilingDb: -1 },
          reverb: { enabled: true, mix: 0.25, decaySec: 1.5 }
        }
      }));

      const monitorContext = FakeAudioContext.instances[0];
      monitorContext.bufferSources[0].onended?.();
      expect(monitorContext.convolvers[0].disconnect).not.toHaveBeenCalled();

      engine.stop("sound-1");

      expect(engine.isPlaying("sound-1")).toBe(false);
      expect(monitorContext.convolvers[0].disconnect).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1500);
      expect(monitorContext.convolvers[0].disconnect).toHaveBeenCalledTimes(1);
    } finally {
      await engine.dispose();
      vi.useRealTimers();
    }
  });

  it("includes pitch detune in active playback position", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const engine = new AudioEngine(playbackSettings, vi.fn());
    await engine.play(makeSound({
      effects: {
        pitchEnabled: true,
        pitchSemitones: 12,
        eq: { enabled: false, lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
        compressor: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 3, releaseMs: 250 },
        limiter: { enabled: false, ceilingDb: -1 },
        reverb: { enabled: false, mix: 0.18, decaySec: 1.4 }
      }
    }));

    now.mockReturnValue(1250);
    expect(engine.getPosition("sound-1")).toBeCloseTo(0.5);

    await engine.dispose();
  });

  it("keeps active playback position continuous when pitch changes", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const engine = new AudioEngine(playbackSettings, vi.fn());
    await engine.play(makeSound());

    now.mockReturnValue(1500);
    engine.setSoundEffects("sound-1", {
      pitchEnabled: true,
      pitchSemitones: 12,
      eq: { enabled: false, lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
      compressor: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 3, releaseMs: 250 },
      limiter: { enabled: false, ceilingDb: -1 },
      reverb: { enabled: false, mix: 0.18, decaySec: 1.4 }
    });

    now.mockReturnValue(1750);
    expect(engine.getPosition("sound-1")).toBeCloseTo(1);

    await engine.dispose();
  });

  it("includes pitch detune in preview playback position", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const engine = new AudioEngine(playbackSettings, vi.fn());
    await engine.previewPlay(makeSound({
      effects: {
        pitchEnabled: true,
        pitchSemitones: 12,
        eq: { enabled: false, lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
        compressor: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 3, releaseMs: 250 },
        limiter: { enabled: false, ceilingDb: -1 },
        reverb: { enabled: false, mix: 0.18, decaySec: 1.4 }
      }
    }), 0.25, 1);

    now.mockReturnValue(1250);
    expect(engine.getPreviewPosition()).toBeCloseTo(0.75);

    await engine.dispose();
  });

  it("leaves pitch neutral when the pitch module is unchecked", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    await engine.play(makeSound({
      effects: {
        pitchEnabled: false,
        pitchSemitones: 12,
        eq: { enabled: false, lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
        compressor: { enabled: false, thresholdDb: -24, ratio: 3, attackMs: 3, releaseMs: 250 },
        limiter: { enabled: false, ceilingDb: -1 },
        reverb: { enabled: false, mix: 0.18, decaySec: 1.4 }
      }
    }));

    const monitorContext = FakeAudioContext.instances[0];
    expect(monitorContext.bufferSources[0].detune.value).toBe(0);

    await engine.dispose();
  });
});
