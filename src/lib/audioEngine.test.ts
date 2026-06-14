import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./audioEngine";
import type { AudioSettings } from "../types";

class FakeAudioParam {
  value = 1;
  cancelScheduledValues = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  setTargetAtTime = vi.fn();
  setValueAtTime = vi.fn();
}

class FakeGainNode {
  gain = new FakeAudioParam();

  constructor(public context: FakeAudioContext) {}

  connect = vi.fn((destination: unknown) => destination);
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
  destination = {};
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

  createMediaStreamSource(stream: MediaStream) {
    const source = new FakeMediaStreamAudioSourceNode(this, stream);
    this.mediaSources.push(source);
    return source as unknown as MediaStreamAudioSourceNode;
  }

  close = vi.fn(async () => undefined);
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
  microphoneDeviceId: "device-1",
  stopAllHotkey: "",
  cycleBoardsHotkey: ""
};

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
