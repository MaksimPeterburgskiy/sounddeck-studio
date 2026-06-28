import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./audioEngine";
import type { AudioSettings, SoundSlot } from "../types";

class FakeAudioParam {
  value = 1;
  cancelScheduledValues = vi.fn();
  exponentialRampToValueAtTime = vi.fn((value: number) => {
    this.value = value;
  });
  setTargetAtTime = vi.fn((value: number) => {
    this.value = value;
  });
  setValueAtTime = vi.fn((value: number) => {
    this.value = value;
  });
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connections: unknown[] = [];

  constructor(public context: FakeAudioContext) {}

  connect = vi.fn((destination: unknown) => {
    this.connections.push(destination);
    return destination;
  });
  disconnect = vi.fn();
}

class FakeAudioBuffer {
  duration = 2;
  sampleRate = 48000;
  numberOfChannels = 2;
  private data: Float32Array[];

  constructor(numberOfChannels = 2, public length = 96000, sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.numberOfChannels = numberOfChannels;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number) {
    return this.data[channel];
  }
}

class FakeAudioBufferSourceNode {
  buffer: AudioBuffer | null = null;
  playbackRate = new FakeAudioParam();
  detune = new FakeAudioParam();
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  connections: unknown[] = [];
  start = vi.fn();
  stop = vi.fn();

  constructor(public context: FakeAudioContext) {}

  connect = vi.fn((destination: unknown) => {
    this.connections.push(destination);
    return destination;
  });
  disconnect = vi.fn();
}

class FakeBiquadFilterNode {
  type: BiquadFilterType = "lowpass";
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
  gain = new FakeAudioParam();
  connections: unknown[] = [];

  constructor(public context: FakeAudioContext) {}

  connect = vi.fn((destination: unknown) => {
    this.connections.push(destination);
    return destination;
  });
  disconnect = vi.fn();
}

class FakeDynamicsCompressorNode {
  threshold = new FakeAudioParam();
  knee = new FakeAudioParam();
  ratio = new FakeAudioParam();
  attack = new FakeAudioParam();
  release = new FakeAudioParam();
  connections: unknown[] = [];

  constructor(public context: FakeAudioContext) {}

  connect = vi.fn((destination: unknown) => {
    this.connections.push(destination);
    return destination;
  });
  disconnect = vi.fn();
}

class FakeConvolverNode {
  buffer: AudioBuffer | null = null;
  connections: unknown[] = [];

  constructor(public context: FakeAudioContext) {}

  connect = vi.fn((destination: unknown) => {
    this.connections.push(destination);
    return destination;
  });
  disconnect = vi.fn();
}

class FakeMediaStreamAudioSourceNode {
  constructor(
    public context: FakeAudioContext,
    public stream: MediaStream
  ) {}

  connect = vi.fn((destination: unknown) => destination);
  disconnect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  bufferSources: FakeAudioBufferSourceNode[] = [];
  biquads: FakeBiquadFilterNode[] = [];
  compressors: FakeDynamicsCompressorNode[] = [];
  convolvers: FakeConvolverNode[] = [];
  mediaSources: FakeMediaStreamAudioSourceNode[] = [];
  sinkId = "";
  setSinkId = vi.fn(async (sinkId: string) => {
    this.sinkId = sinkId;
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    return new FakeGainNode(this) as unknown as GainNode;
  }

  createBuffer(numberOfChannels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(numberOfChannels, length, sampleRate) as unknown as AudioBuffer;
  }

  createBufferSource() {
    const source = new FakeAudioBufferSourceNode(this);
    this.bufferSources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createBiquadFilter() {
    const filter = new FakeBiquadFilterNode(this);
    this.biquads.push(filter);
    return filter as unknown as BiquadFilterNode;
  }

  createDynamicsCompressor() {
    const compressor = new FakeDynamicsCompressorNode(this);
    this.compressors.push(compressor);
    return compressor as unknown as DynamicsCompressorNode;
  }

  createConvolver() {
    const convolver = new FakeConvolverNode(this);
    this.convolvers.push(convolver);
    return convolver as unknown as ConvolverNode;
  }

  createMediaStreamSource(stream: MediaStream) {
    const source = new FakeMediaStreamAudioSourceNode(this, stream);
    this.mediaSources.push(source);
    return source as unknown as MediaStreamAudioSourceNode;
  }

  close = vi.fn(async () => undefined);
  decodeAudioData = vi.fn(async () => new FakeAudioBuffer() as unknown as AudioBuffer);
  resume = vi.fn(async () => undefined);
  suspend = vi.fn(async () => undefined);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeStream() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

async function waitForMockCalls(mock: ReturnType<typeof vi.fn>, count: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mock.mock.calls.length >= count) return;
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalledTimes(count);
}

const settings: AudioSettings = {
  micPassthrough: true,
  soundboardToVirtualMic: true,
  monitorToHeadphones: false,
  monitorMicToHeadphones: false,
  micVirtualVolume: 1,
  micMonitorVolume: 1,
  soundboardVirtualVolume: 1,
  soundboardMonitorVolume: 1,
  monitorDeviceId: "",
  virtualOutputDeviceId: "",
  virtualOutputMode: "managed",
  virtualBackend: "windows-vbcable",
  microphoneDeviceId: "device-1",
  stopAllHotkey: "",
  cycleBoardsHotkey: ""
};

const playbackSettings: AudioSettings = {
  ...settings,
  micPassthrough: false,
  soundboardToVirtualMic: false,
  monitorToHeadphones: true,
  monitorMicToHeadphones: false
};

function makeSound(patch: Partial<SoundSlot> = {}): SoundSlot {
  return {
    id: "sound-1",
    title: "Sound",
    mediaPath: "media.wav",
    storedName: "media.wav",
    mime: "audio/wav",
    ext: ".wav",
    size: 100,
    duration: 2,
    color: "#fff",
    icon: "zap",
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    loop: false,
    soloPlay: false,
    retriggerMode: "overlap",
    hotkey: "",
    outputTarget: "monitor",
    createdAt: "",
    updatedAt: "",
    ...patch
  };
}

describe("AudioEngine mic routing", () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
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

    await engine.dispose();
  });

  it("updates active effect params without restarting playback", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    await engine.play(makeSound());

    const monitorContext = FakeAudioContext.instances[0];
    const source = monitorContext.bufferSources[0];
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

  it("keeps reverb tails active until their cleanup timer expires", async () => {
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

      expect(engine.isPlaying("sound-1")).toBe(true);
      expect(monitorContext.convolvers[0].disconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1499);
      expect(engine.isPlaying("sound-1")).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(engine.isPlaying("sound-1")).toBe(false);
      expect(monitorContext.convolvers[0].disconnect).toHaveBeenCalled();
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
