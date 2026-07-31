// Shared Web Audio fakes and fixtures for AudioEngine tests. Extracted from
// audioEngine.test.ts so multiple test files can drive the engine without a
// real AudioContext.
import { expect, vi } from "vitest";
import type { AudioSettings, SoundSlot } from "../../types";

export class FakeAudioParam {
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

export class FakeGainNode {
  gain = new FakeAudioParam();
  connections: unknown[] = [];

  constructor(public context: FakeAudioContext) {}

  connect = vi.fn((destination: unknown) => {
    this.connections.push(destination);
    return destination;
  });
  disconnect = vi.fn();
}

export class FakeAudioBuffer {
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

export class FakeAudioBufferSourceNode {
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

export class FakeBiquadFilterNode {
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

export class FakeDynamicsCompressorNode {
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

export class FakeConvolverNode {
  buffer: AudioBuffer | null = null;
  connections: unknown[] = [];

  constructor(public context: FakeAudioContext) {}

  connect = vi.fn((destination: unknown) => {
    this.connections.push(destination);
    return destination;
  });
  disconnect = vi.fn();
}

export class FakeMediaStreamAudioSourceNode {
  connections: unknown[] = [];

  constructor(
    public context: FakeAudioContext,
    public stream: MediaStream
  ) {}

  connect = vi.fn((destination: unknown) => {
    this.connections.push(destination);
    return destination;
  });
  disconnect = vi.fn();
}

export class FakeMediaStreamAudioDestinationNode {
  connections: unknown[] = [];
  stream = fakeStream().stream;

  constructor(public context: FakeAudioContext) {}

  connect = vi.fn((destination: unknown) => {
    this.connections.push(destination);
    return destination;
  });
  disconnect = vi.fn();
}

export class FakeAudioWorkletNode {
  connections: unknown[] = [];
  port = { postMessage: vi.fn(), onmessage: null as ((event: MessageEvent) => void) | null };

  constructor(public context: FakeAudioContext, public name: string, public options?: AudioWorkletNodeOptions) {
    context.workletNodes.push(this);
  }

  connect = vi.fn((destination: unknown) => {
    this.connections.push(destination);
    return destination;
  });
  disconnect = vi.fn();
}

export class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor(public url: URL, public options?: WorkerOptions) {
    FakeWorker.instances.push(this);
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  bufferSources: FakeAudioBufferSourceNode[] = [];
  gains: FakeGainNode[] = [];
  biquads: FakeBiquadFilterNode[] = [];
  compressors: FakeDynamicsCompressorNode[] = [];
  convolvers: FakeConvolverNode[] = [];
  mediaSources: FakeMediaStreamAudioSourceNode[] = [];
  mediaDestinations: FakeMediaStreamAudioDestinationNode[] = [];
  workletNodes: FakeAudioWorkletNode[] = [];
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  sinkId = "";
  setSinkId = vi.fn(async (sinkId: string) => {
    this.sinkId = sinkId;
  });

  constructor(public options?: AudioContextOptions) {
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    const gain = new FakeGainNode(this);
    this.gains.push(gain);
    return gain as unknown as GainNode;
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

  createMediaStreamDestination() {
    const destination = new FakeMediaStreamAudioDestinationNode(this);
    this.mediaDestinations.push(destination);
    return destination as unknown as MediaStreamAudioDestinationNode;
  }

  close = vi.fn(async () => undefined);
  decodeAudioData = vi.fn(async () => new FakeAudioBuffer() as unknown as AudioBuffer);
  resume = vi.fn(async () => undefined);
  suspend = vi.fn(async () => undefined);
}

/**
 * Per-voice gain nodes: the first gain a context creates is its bus, and each
 * playing voice's gain connects straight to that bus (the effect chain sits
 * between the source and the voice gain, not after it).
 */
export function voiceGains(context: FakeAudioContext) {
  const bus = context.gains[0];
  return context.gains.filter((gain) => gain !== bus && gain.connections.includes(bus));
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function fakeStream(initialSettings: MediaTrackSettings = {}) {
  let settings = { ...initialSettings };
  const track = {
    stop: vi.fn(),
    applyConstraints: vi.fn(async (constraints: MediaTrackConstraints) => {
      if (typeof constraints.echoCancellation === "boolean") settings.echoCancellation = constraints.echoCancellation;
    }),
    getSettings: vi.fn(() => ({ ...settings }))
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

export async function waitForMockCalls(mock: ReturnType<typeof vi.fn>, count: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mock.mock.calls.length >= count) return;
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalledTimes(count);
}

const baseSettings: AudioSettings = {
  micPassthrough: true,
  echoCancellationEnabled: false,
  noiseSuppressionEnabled: false,
  noiseSuppressionAttenuationDb: 18,
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

export function makeAudioSettings(patch: Partial<AudioSettings> = {}): AudioSettings {
  return { ...baseSettings, ...patch };
}

export function makeSound(patch: Partial<SoundSlot> = {}): SoundSlot {
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
