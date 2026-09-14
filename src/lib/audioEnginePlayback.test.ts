import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./audioEngine";
import { FakeAudioContext, deferred, makeAudioSettings, makeSound, voiceGains } from "./testing/webAudioFakes";

const playbackSettings = makeAudioSettings({
  micPassthrough: false,
  soundboardToVirtualMic: false,
  monitorToHeadphones: true,
  monitorMicToHeadphones: false
});

// Monitor + virtual routes both enabled; the virtual sink still needs a
// successful configure() before the engine will route to it.
const dualRouteSettings = makeAudioSettings({
  micPassthrough: false,
  soundboardToVirtualMic: true,
  monitorToHeadphones: true,
  monitorMicToHeadphones: false
});

function monitorContext() {
  return FakeAudioContext.instances[0];
}

function virtualContext() {
  return FakeAudioContext.instances[1];
}

function decodeContext() {
  return FakeAudioContext.instances[2];
}

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

describe("AudioEngine output routing", () => {
  it("routes a monitor-target sound to the monitor context only", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.play(makeSound({ outputTarget: "monitor" }));

    expect(monitorContext().bufferSources).toHaveLength(1);
    expect(virtualContext().bufferSources).toHaveLength(0);

    await engine.dispose();
  });

  it("routes a virtual-target sound to the virtual context once the sink is ready", async () => {
    const engine = new AudioEngine(dualRouteSettings, vi.fn());
    await engine.configure(dualRouteSettings, "cable-device");

    await engine.play(makeSound({ outputTarget: "virtual" }));

    expect(monitorContext().bufferSources).toHaveLength(0);
    expect(virtualContext().bufferSources).toHaveLength(1);

    await engine.dispose();
  });

  it("plays nothing on a virtual-only target when the sink is not ready", async () => {
    const engine = new AudioEngine(dualRouteSettings, vi.fn());
    // No configure(): the virtual sink was never established.

    await engine.play(makeSound({ outputTarget: "virtual" }));

    expect(monitorContext().bufferSources).toHaveLength(0);
    expect(virtualContext().bufferSources).toHaveLength(0);
    expect(engine.isPlaying("sound-1")).toBe(false);

    await engine.dispose();
  });

  it("plays nothing when both routes are disabled", async () => {
    const status = vi.fn();
    const engine = new AudioEngine(makeAudioSettings({
      micPassthrough: false,
      soundboardToVirtualMic: false,
      monitorToHeadphones: false,
      monitorMicToHeadphones: false
    }), status);

    const started = await engine.play(makeSound({ outputTarget: "both" }));

    expect(monitorContext().bufferSources).toHaveLength(0);
    expect(virtualContext().bufferSources).toHaveLength(0);
    expect(engine.isPlaying("sound-1")).toBe(false);
    expect(status).not.toHaveBeenCalled();
    expect(started).toBe(false);

    await engine.dispose();
  });

  it("does not reroute a disabled monitor target to an enabled virtual route", async () => {
    const monitorDisabled = makeAudioSettings({
      micPassthrough: false,
      soundboardToVirtualMic: true,
      monitorToHeadphones: false,
      monitorMicToHeadphones: false
    });
    const engine = new AudioEngine(monitorDisabled, vi.fn());
    await engine.configure(monitorDisabled, "cable-device");

    await engine.play(makeSound({ outputTarget: "monitor" }));

    expect(monitorContext().bufferSources).toHaveLength(0);
    expect(virtualContext().bufferSources).toHaveLength(0);
    expect(engine.isPlaying("sound-1")).toBe(false);

    await engine.dispose();
  });

  it("creates both-target routes while the disabled monitor bus stays muted", async () => {
    const monitorDisabled = makeAudioSettings({
      micPassthrough: false,
      soundboardToVirtualMic: true,
      monitorToHeadphones: false,
      monitorMicToHeadphones: false
    });
    const engine = new AudioEngine(monitorDisabled, vi.fn());
    await engine.configure(monitorDisabled, "cable-device");

    const started = await engine.play(makeSound({ outputTarget: "both" }));

    expect(monitorContext().bufferSources).toHaveLength(1);
    expect(virtualContext().bufferSources).toHaveLength(1);
    expect(monitorContext().gains[0].gain.value).toBe(0);
    expect(engine.isPlaying("sound-1")).toBe(true);
    expect(started).toBe(true);

    await engine.dispose();
  });

  it("routes a both-target sound to monitor and virtual as one voice", async () => {
    const engine = new AudioEngine(dualRouteSettings, vi.fn());
    await engine.configure(dualRouteSettings, "cable-device");

    await engine.play(makeSound({ outputTarget: "both", volume: 0.8 }));

    expect(monitorContext().bufferSources).toHaveLength(1);
    expect(virtualContext().bufferSources).toHaveLength(1);
    // One voice, two routes: stopping the sound silences both.
    engine.stop("sound-1");
    expect(engine.isPlaying("sound-1")).toBe(false);

    await engine.dispose();
  });

  it("mutes the monitor bus when monitoring is disabled during playback", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    await engine.play(makeSound({ outputTarget: "monitor" }));
    const monitorBus = monitorContext().gains[0];

    await engine.configure({ ...playbackSettings, monitorToHeadphones: false }, "");

    expect(engine.isPlaying("sound-1")).toBe(true);
    // Disabled routes are silenced with an immediate value, never a decaying target.
    expect(monitorBus.gain.setValueAtTime).toHaveBeenLastCalledWith(0, monitorContext().currentTime);
    expect(monitorBus.gain.value).toBe(0);

    await engine.dispose();
  });

  it("silences a disabled route immediately even while its context is suspended", async () => {
    const engine = new AudioEngine(makeAudioSettings({
      micPassthrough: false,
      soundboardToVirtualMic: true,
      monitorToHeadphones: false,
      monitorMicToHeadphones: false
    }), vi.fn());
    const context = monitorContext();
    const monitorBus = context.gains[0];
    context.state = "suspended";
    monitorBus.gain.value = 1;
    monitorBus.gain.setValueAtTime.mockClear();
    monitorBus.gain.setTargetAtTime.mockClear();

    await engine.configure(makeAudioSettings({ monitorToHeadphones: false, soundboardToVirtualMic: true }), "cable-device");

    expect(monitorBus.gain.setValueAtTime).toHaveBeenCalledWith(0, context.currentTime);
    expect(monitorBus.gain.setTargetAtTime).not.toHaveBeenCalled();
    expect(monitorBus.gain.value).toBe(0);

    await engine.dispose();
  });

  it("assigns an enabled route's volume directly while its context is suspended", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    const context = monitorContext();
    const monitorBus = context.gains[0];
    context.state = "suspended";
    monitorBus.gain.setValueAtTime.mockClear();

    await engine.configure({ ...playbackSettings, soundboardMonitorVolume: 0.6 }, "");

    expect(monitorBus.gain.setValueAtTime).toHaveBeenLastCalledWith(0.6, context.currentTime);
    expect(monitorBus.gain.value).toBe(0.6);

    await engine.dispose();
  });

  it("unmutes an existing both-target monitor voice when monitoring is enabled mid-play", async () => {
    const monitorDisabled = makeAudioSettings({
      micPassthrough: false,
      soundboardToVirtualMic: true,
      monitorToHeadphones: false,
      monitorMicToHeadphones: false,
      soundboardMonitorVolume: 0.7
    });
    const engine = new AudioEngine(monitorDisabled, vi.fn());
    await engine.configure(monitorDisabled, "cable-device");
    await engine.play(makeSound({ outputTarget: "both" }));
    const monitorBus = monitorContext().gains[0];
    const monitorSource = monitorContext().bufferSources[0];

    await engine.configure({ ...monitorDisabled, monitorToHeadphones: true }, "cable-device");

    expect(monitorBus.gain.value).toBe(0.7);
    expect(monitorContext().bufferSources).toEqual([monitorSource]);
    expect(monitorSource.stop).not.toHaveBeenCalled();
    expect(engine.isPlaying("sound-1")).toBe(true);

    await engine.dispose();
  });

  it("unmutes an existing both-target virtual voice when its sink becomes ready", async () => {
    const engine = new AudioEngine(dualRouteSettings, vi.fn());
    await engine.play(makeSound({ outputTarget: "both" }));
    const virtualBus = virtualContext().gains[0];
    const virtualSource = virtualContext().bufferSources[0];
    expect(virtualBus.gain.value).toBe(0);

    await engine.configure(dualRouteSettings, "cable-device");

    expect(virtualBus.gain.value).toBe(1);
    expect(virtualContext().bufferSources).toEqual([virtualSource]);
    expect(virtualSource.stop).not.toHaveBeenCalled();
    expect(engine.isPlaying("sound-1")).toBe(true);

    await engine.dispose();
  });
});

describe("AudioEngine solo and retrigger semantics", () => {
  it("restart mode stops the prior voice of the same sound", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    const sound = makeSound({ retriggerMode: "restart" });

    await engine.play(sound);
    await engine.play(sound);

    expect(monitorContext().bufferSources).toHaveLength(2);
    // The first voice's gain was slammed to silence; the second still plays.
    const gains = voiceGains(monitorContext());
    expect(gains[0].gain.value).toBeCloseTo(0.0001);
    expect(gains[1].gain.value).toBe(1);
    expect(engine.isPlaying("sound-1")).toBe(true);

    await engine.dispose();
  });

  it("overlap mode stacks voices and stop silences them all", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    const sound = makeSound({ retriggerMode: "overlap" });

    await engine.play(sound);
    await engine.play(sound);
    expect(engine.isPlaying("sound-1")).toBe(true);

    const gains = voiceGains(monitorContext());
    expect(gains.map((gain) => gain.gain.value)).toEqual([1, 1]);

    engine.stop("sound-1");
    expect(engine.isPlaying("sound-1")).toBe(false);
    expect(gains.map((gain) => gain.gain.value)).toEqual([0.0001, 0.0001]);

    await engine.dispose();
  });

  it("solo play stops other sounds but not other voices of itself", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.play(makeSound({ id: "other", soloPlay: false }));
    await engine.play(makeSound({ id: "solo", soloPlay: true, retriggerMode: "overlap" }));
    await engine.play(makeSound({ id: "solo", soloPlay: true, retriggerMode: "overlap" }));

    expect(engine.isPlaying("other")).toBe(false);
    expect(engine.isPlaying("solo")).toBe(true);
    const gains = voiceGains(monitorContext());
    // Voice order: other (silenced), solo #1, solo #2 (both still audible).
    expect(gains[0].gain.value).toBeCloseTo(0.0001);
    expect(gains[1].gain.value).toBe(1);
    expect(gains[2].gain.value).toBe(1);

    await engine.dispose();
  });

  it("does not stop an active sound when a solo sound has no live route", async () => {
    const status = vi.fn();
    const engine = new AudioEngine(playbackSettings, status);
    await engine.play(makeSound({ id: "active" }));
    const activeSource = monitorContext().bufferSources[0];
    const statusCallsBeforeTrigger = status.mock.calls.length;

    const started = await engine.play(makeSound({
      id: "muted-solo",
      outputTarget: "virtual",
      soloPlay: true
    }));

    expect(started).toBe(false);
    expect(engine.isPlaying("active")).toBe(true);
    expect(engine.isPlaying("muted-solo")).toBe(false);
    expect(activeSource.stop).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(statusCallsBeforeTrigger);

    await engine.dispose();
  });

  it("does not stop other sounds or start a voice when the route is disabled while decoding", async () => {
    const status = vi.fn();
    const engine = new AudioEngine(playbackSettings, status);
    await engine.play(makeSound({ id: "active" }));
    const activeSource = monitorContext().bufferSources[0];
    const statusCallsBeforeTrigger = status.mock.calls.length;
    const media = deferred<ArrayBuffer>();
    (window.sounddeck.readMedia as ReturnType<typeof vi.fn>).mockReturnValue(media.promise);

    const pending = engine.play(makeSound({ id: "late-solo", mediaPath: "late.wav", outputTarget: "monitor", soloPlay: true }));
    await engine.configure({ ...playbackSettings, monitorToHeadphones: false }, "");
    media.resolve(new ArrayBuffer(8));
    const started = await pending;

    expect(started).toBe(false);
    expect(engine.isPlaying("late-solo")).toBe(false);
    expect(engine.isPlaying("active")).toBe(true);
    expect(activeSource.stop).not.toHaveBeenCalled();
    expect(monitorContext().bufferSources).toHaveLength(1);
    expect(status).toHaveBeenCalledTimes(statusCallsBeforeTrigger);

    await engine.dispose();
  });

  it("does not stop other sounds when the route is disabled while the contexts resume", async () => {
    const status = vi.fn();
    const engine = new AudioEngine(playbackSettings, status);
    await engine.play(makeSound({ id: "active" }));
    const activeSource = monitorContext().bufferSources[0];
    const statusCallsBeforeTrigger = status.mock.calls.length;
    const resumed = deferred<void>();
    monitorContext().resume.mockReturnValueOnce(resumed.promise);

    const pending = engine.play(makeSound({ id: "late-solo", outputTarget: "monitor", soloPlay: true }));
    await Promise.resolve();
    await engine.configure({ ...playbackSettings, monitorToHeadphones: false }, "");
    resumed.resolve();
    const started = await pending;

    expect(started).toBe(false);
    expect(engine.isPlaying("late-solo")).toBe(false);
    expect(engine.isPlaying("active")).toBe(true);
    expect(activeSource.stop).not.toHaveBeenCalled();
    expect(monitorContext().bufferSources).toHaveLength(1);
    expect(status).toHaveBeenCalledTimes(statusCallsBeforeTrigger);

    await engine.dispose();
  });

  it("does not restart an active sound when its route is no longer live", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    const sound = makeSound({ retriggerMode: "restart" });
    await engine.play(sound);
    const activeSource = monitorContext().bufferSources[0];
    await engine.configure({ ...playbackSettings, monitorToHeadphones: false }, "");

    const started = await engine.play(sound);

    expect(started).toBe(false);
    expect(engine.isPlaying(sound.id)).toBe(true);
    expect(monitorContext().bufferSources).toEqual([activeSource]);
    expect(activeSource.stop).not.toHaveBeenCalled();

    await engine.dispose();
  });
});

describe("AudioEngine trim and loop math", () => {
  it("starts playback at the trim window", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.play(makeSound({ trimStartSec: 0.5, trimEndSec: 1.5 }));

    expect(monitorContext().bufferSources[0].start).toHaveBeenCalledWith(0, 0.5, 1);

    await engine.dispose();
  });

  it("clamps trim values to the buffer duration", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());

    // Fake decoded buffers are 2 seconds long.
    await engine.play(makeSound({ trimStartSec: 5, trimEndSec: 9 }));

    expect(monitorContext().bufferSources[0].start).toHaveBeenCalledWith(0, 2, 0.01);

    await engine.dispose();
  });

  it("loops within the trim window without an end time", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.play(makeSound({ loop: true, trimStartSec: 0.5, trimEndSec: 1.5 }));

    const source = monitorContext().bufferSources[0];
    expect(source.loop).toBe(true);
    expect(source.loopStart).toBe(0.5);
    expect(source.loopEnd).toBe(1.5);
    expect(source.start).toHaveBeenCalledWith(0, 0.5);

    await engine.dispose();
  });

  it("wraps the reported position for looping sounds and clamps it otherwise", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.play(makeSound({ id: "looping", loop: true, trimStartSec: 0.5, trimEndSec: 1.5 }));
    await engine.play(makeSound({ id: "oneshot", trimStartSec: 0.5, trimEndSec: 1.5 }));

    now.mockReturnValue(3200); // 2.2s elapsed on a 1s clip
    expect(engine.getPosition("looping")).toBeCloseTo(0.7);
    expect(engine.getPosition("oneshot")).toBeCloseTo(1.5);
    expect(engine.getPosition("missing")).toBeNull();

    await engine.dispose();
  });
});

describe("AudioEngine fades", () => {
  it("ramps up from silence when a fade-in is set", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.play(makeSound({ fadeInMs: 500, volume: 0.8 }));

    const gain = voiceGains(monitorContext())[0];
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.0001, 0);
    expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.8, 0.5);

    await engine.dispose();
  });

  it("fades out on stop and defers stopping the source", async () => {
    vi.useFakeTimers();
    window.setTimeout = setTimeout;
    window.clearTimeout = clearTimeout;
    const engine = new AudioEngine(playbackSettings, vi.fn());

    try {
      await engine.play(makeSound({ fadeOutMs: 1000 }));
      const source = monitorContext().bufferSources[0];
      const gain = voiceGains(monitorContext())[0];
      gain.gain.setValueAtTime.mockClear();

      engine.stop("sound-1");

      expect(gain.gain.setValueAtTime).toHaveBeenLastCalledWith(1, 0);
      expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, 1);
      expect(source.stop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1021);
      expect(source.stop).toHaveBeenCalledTimes(1);
      expect(source.disconnect).toHaveBeenCalled();
    } finally {
      await engine.dispose();
      vi.useRealTimers();
    }
  });
});

describe("AudioEngine preview lifecycle", () => {
  it("keeps editor preview audible when soundboard monitoring is disabled", async () => {
    const previewSettings = makeAudioSettings({
      micPassthrough: false,
      soundboardToVirtualMic: false,
      monitorToHeadphones: false,
      monitorMicToHeadphones: false,
      soundboardMonitorVolume: 0.65
    });
    const engine = new AudioEngine(previewSettings, vi.fn());

    await engine.previewPlay(makeSound(), 0, 1);

    const context = monitorContext();
    const [monitorBus, previewBus] = context.gains;
    const previewVoiceGain = context.gains.find((gain) => gain.connections.includes(previewBus));
    expect(context.bufferSources).toHaveLength(1);
    expect(monitorBus.gain.value).toBe(0);
    expect(previewBus.gain.value).toBe(0.65);
    expect(previewBus.connections).toContain(context.destination);
    expect(previewVoiceGain).toBeDefined();

    await engine.dispose();
  });

  it("cancels a preview start that resolves after the preview was stopped", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    const media = deferred<ArrayBuffer>();
    (window.sounddeck.readMedia as ReturnType<typeof vi.fn>).mockReturnValue(media.promise);

    const pending = engine.previewPlay(makeSound(), 0, 1);
    engine.previewStop();
    media.resolve(new ArrayBuffer(8));
    await pending;

    expect(monitorContext().bufferSources).toHaveLength(0);
    expect(engine.isPreviewing()).toBe(false);

    await engine.dispose();
  });

  it("only stores the offset when seeking while paused", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.previewSeek(makeSound(), 1.2, false, 1);

    expect(monitorContext().bufferSources).toHaveLength(0);
    expect(engine.getPreviewPosition()).toBe(1.2);

    await engine.dispose();
  });

  it("pause keeps the current position for the next play", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.previewPlay(makeSound(), 0.2, 1);
    now.mockReturnValue(1400);
    engine.previewPause();

    expect(engine.isPreviewing()).toBe(false);
    expect(engine.getPreviewPosition()).toBeCloseTo(0.6);

    await engine.dispose();
  });

  it("applies live per-sound volume changes to the matching preview", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    await engine.previewPlay(makeSound({ volume: 0.8 }), 0, 1);
    const previewBus = monitorContext().gains[1];
    const previewGain = monitorContext().gains.find((gain) => gain.connections.includes(previewBus));

    engine.setSoundVolume("sound-1", 0.45);

    expect(previewGain?.gain.cancelScheduledValues).toHaveBeenCalledWith(0);
    expect(previewGain?.gain.setTargetAtTime).toHaveBeenCalledWith(0.45, 0, 0.02);
    expect(previewGain?.gain.value).toBe(0.45);

    await engine.dispose();
  });
});

describe("AudioEngine lifecycle and cache", () => {
  it("dispose closes all contexts and makes configure a no-op", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());
    const monitor = monitorContext();

    await engine.dispose();

    expect(FakeAudioContext.instances.map((context) => context.close.mock.calls.length)).toEqual([1, 1, 1]);
    await engine.configure(playbackSettings, "cable-device");
    expect(monitor.setSinkId).not.toHaveBeenCalled();

    await engine.dispose();
  });

  it("caches decoded buffers by media path across sounds until invalidated", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.play(makeSound({ id: "a", mediaPath: "shared.wav" }));
    await engine.play(makeSound({ id: "b", mediaPath: "shared.wav" }));
    expect(decodeContext().decodeAudioData).toHaveBeenCalledTimes(1);

    engine.invalidate("shared.wav");
    await engine.play(makeSound({ id: "a", mediaPath: "shared.wav" }));
    expect(decodeContext().decodeAudioData).toHaveBeenCalledTimes(2);

    await engine.dispose();
  });

  it("reports playing and idle states through the status callback", async () => {
    const status = vi.fn();
    const engine = new AudioEngine(playbackSettings, status);

    await engine.play(makeSound());
    expect(status).toHaveBeenLastCalledWith("playing", ["sound-1"]);

    monitorContext().bufferSources[0].onended?.();
    expect(status).toHaveBeenLastCalledWith("idle", []);

    await engine.dispose();
  });

  it("applies live per-sound volume changes to active voices", async () => {
    const engine = new AudioEngine(playbackSettings, vi.fn());

    await engine.play(makeSound());
    engine.setSoundVolume("sound-1", 0.5);

    expect(voiceGains(monitorContext())[0].gain.value).toBe(0.5);

    await engine.dispose();
  });
});
