import { describe, expect, it } from "vitest";
import { findCableInputDeviceId, findVirtualAudioCandidates } from "./devices";

function device(kind: MediaDeviceKind, label: string, deviceId = label): MediaDeviceInfo {
  return { kind, label, deviceId, groupId: "", toJSON: () => ({}) } as MediaDeviceInfo;
}

describe("virtual audio device detection", () => {
  it("keeps the Windows VB-CABLE compatibility helper", () => {
    const devices = [
      device("audiooutput", "Speakers"),
      device("audiooutput", "CABLE Input (VB-Audio Virtual Cable)", "cable")
    ];

    expect(findCableInputDeviceId(devices)).toBe("cable");
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
});
