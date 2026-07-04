import { describe, expect, it } from "vitest";
import { findCableInputDeviceId, findVirtualAudioCandidates, getDefaultDeviceLabel, isRoleDeviceId, isSelectableMediaDevice, makeMicrophoneConstraints } from "./devices";

function device(kind: MediaDeviceKind, label: string, deviceId = label): MediaDeviceInfo {
  return { kind, label, deviceId, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

describe("microphone constraints", () => {
  it("omits deviceId for role and empty ids while disabling browser processing", () => {
    for (const deviceId of ["default", "communications", "", null]) {
      const constraints = makeMicrophoneConstraints(deviceId);

      expect("deviceId" in constraints).toBe(false);
      expect(constraints.echoCancellation).toBe(false);
      expect(constraints.noiseSuppression).toBe(false);
      expect(constraints.autoGainControl).toBe(false);
    }
  });

  it("pins selectable microphone ids exactly", () => {
    expect(makeMicrophoneConstraints("mic-1")).toEqual({
      deviceId: { exact: "mic-1" },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    });
  });
});

describe("virtual audio device detection", () => {
  it("keeps the Windows VB-CABLE compatibility helper", () => {
    const devices = [
      device("audiooutput", "Speakers"),
      device("audiooutput", "CABLE Input (VB-Audio Virtual Cable)", "cable")
    ];

    expect(findCableInputDeviceId(devices)).toBe("cable");
  });

  it("returns an empty cable id when there is no Windows VB-CABLE output", () => {
    const devices = [
      device("audiooutput", "Speakers", "speakers"),
      device("audioinput", "CABLE Output", "cable-output")
    ];

    expect(findCableInputDeviceId(devices)).toBe("");
  });

  it("falls back to Windows VB-CABLE matching for unknown platforms", () => {
    const devices = [
      device("audiooutput", "Speakers", "speakers"),
      device("audiooutput", "CABLE Input (VB-Audio Virtual Cable)", "cable")
    ];

    expect(findVirtualAudioCandidates(devices, "freebsd")).toEqual([
      {
        platform: "win32",
        backend: "windows-vbcable",
        outputDeviceId: "cable",
        outputLabel: "CABLE Input (VB-Audio Virtual Cable)",
        expectedInputLabel: "CABLE Output",
        confidence: "managed",
        recommended: true
      }
    ]);
  });

  it("recommends bundled BlackHole 2ch on macOS", () => {
    const devices = [
      device("audiooutput", "MacBook Pro Speakers", "speaker"),
      device("audiooutput", "BlackHole 2ch", "blackhole")
    ];

    expect(findVirtualAudioCandidates(devices, "darwin")).toEqual([
      {
        platform: "darwin",
        backend: "macos-bundled-blackhole",
        outputDeviceId: "blackhole",
        outputLabel: "BlackHole 2ch",
        expectedInputLabel: "BlackHole 2ch",
        confidence: "managed",
        recommended: true
      }
    ]);
  });

  it("recommends bundled BlackHole 2ch when Chromium reports the virtual suffix on macOS", () => {
    const devices = [
      device("audiooutput", "MacBook Pro Speakers", "speaker"),
      device("audiooutput", "BlackHole 2ch (Virtual)", "blackhole")
    ];

    expect(findVirtualAudioCandidates(devices, "darwin")).toEqual([
      {
        platform: "darwin",
        backend: "macos-bundled-blackhole",
        outputDeviceId: "blackhole",
        outputLabel: "BlackHole 2ch (Virtual)",
        expectedInputLabel: "BlackHole 2ch (Virtual)",
        confidence: "managed",
        recommended: true
      }
    ]);
  });

  it("reports non-2ch BlackHole devices without recommending them for managed macOS", () => {
    const devices = [device("audiooutput", "BlackHole 16ch", "blackhole-16")];

    expect(findVirtualAudioCandidates(devices, "darwin")).toEqual([
      expect.objectContaining({
        outputDeviceId: "blackhole-16",
        confidence: "known",
        recommended: false
      })
    ]);
  });

  it("recommends the managed SoundDeck sink on Linux", () => {
    const devices = [
      device("audiooutput", "Built-in Audio", "speakers"),
      device("audiooutput", "SoundDeck Sink", "sounddeck-sink")
    ];

    expect(findVirtualAudioCandidates(devices, "linux")).toEqual([
      {
        platform: "linux",
        backend: "linux-managed-pactl",
        outputDeviceId: "sounddeck-sink",
        outputLabel: "SoundDeck Sink",
        expectedInputLabel: "SoundDeck Mic",
        confidence: "managed",
        recommended: true
      }
    ]);
  });

  it("ignores unrelated Linux output labels", () => {
    const devices = [
      device("audiooutput", "Built-in Audio", "speakers"),
      device("audiooutput", "SoundDeck Monitor", "sounddeck-monitor")
    ];

    expect(findVirtualAudioCandidates(devices, "linux")).toEqual([]);
  });
});

describe("device labels and role ids", () => {
  it("strips default device prefixes from labels", () => {
    expect(getDefaultDeviceLabel([
      device("audiooutput", "Default - Speakers (Realtek)", "default")
    ], "audiooutput")).toBe("Speakers (Realtek)");
    expect(getDefaultDeviceLabel([
      device("audioinput", "Default: Something", "default")
    ], "audioinput")).toBe("Something");
    expect(getDefaultDeviceLabel([], "audiooutput")).toBe("");
  });

  it("recognizes browser role device ids case-insensitively", () => {
    expect(isRoleDeviceId("default")).toBe(true);
    expect(isRoleDeviceId("DEFAULT")).toBe(true);
    expect(isRoleDeviceId("communications")).toBe(true);
    expect(isRoleDeviceId("abc")).toBe(false);
    expect(isRoleDeviceId(null)).toBe(false);
    expect(isRoleDeviceId(undefined)).toBe(false);
  });

  it("filters browser role devices from selectable media devices", () => {
    expect(isSelectableMediaDevice(device("audiooutput", "Default", "default"))).toBe(false);
    expect(isSelectableMediaDevice(device("audiooutput", "Default", "DEFAULT"))).toBe(false);
    expect(isSelectableMediaDevice(device("audioinput", "Communications", "communications"))).toBe(false);
    expect(isSelectableMediaDevice(device("audioinput", "Mic", "abc"))).toBe(true);
  });
});
