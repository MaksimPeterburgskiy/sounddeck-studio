const roleDeviceIds = new Set(["default", "communications"]);
const macBlackHole2chPattern = /^blackhole\s+2ch(?:\s+\(virtual\))?$/i;

export interface VirtualAudioCandidate {
  platform: "win32" | "darwin" | "linux";
  backend: string;
  outputDeviceId: string;
  outputLabel: string;
  expectedInputLabel: string;
  confidence: "managed" | "known" | "possible";
  recommended: boolean;
}

export function isRoleDeviceId(deviceId: string | undefined | null) {
  return roleDeviceIds.has((deviceId || "").toLowerCase());
}

export function normalizeSelectableDeviceId(deviceId: string | undefined | null) {
  return isRoleDeviceId(deviceId) ? "" : deviceId || "";
}

export function isSelectableMediaDevice(device: MediaDeviceInfo) {
  return !isRoleDeviceId(device.deviceId);
}

export function findCableInputDeviceId(devices: MediaDeviceInfo[]) {
  return findVirtualAudioCandidates(devices, "win32").find((candidate) => candidate.recommended)?.outputDeviceId ?? "";
}

function candidateFromDevice(device: MediaDeviceInfo, platform: VirtualAudioCandidate["platform"], backend: string, expectedInputLabel: string, recommended: boolean, confidence: VirtualAudioCandidate["confidence"] = "managed"): VirtualAudioCandidate {
  return {
    platform,
    backend,
    outputDeviceId: device.deviceId,
    outputLabel: device.label,
    expectedInputLabel,
    confidence,
    recommended
  };
}

export function findVirtualAudioCandidates(devices: MediaDeviceInfo[], platform: string): VirtualAudioCandidate[] {
  const outputs = devices.filter((device) => device.kind === "audiooutput" && isSelectableMediaDevice(device));
  const normalizedPlatform = platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "win32";
  const candidates: VirtualAudioCandidate[] = [];

  if (normalizedPlatform === "win32") {
    for (const output of outputs) {
      if (/cable input|vb-audio virtual cable/i.test(output.label)) {
        candidates.push(candidateFromDevice(output, "win32", "windows-vbcable", "CABLE Output", true));
      }
    }
  }

  if (normalizedPlatform === "darwin") {
    for (const output of outputs) {
      if (macBlackHole2chPattern.test(output.label.trim())) {
        candidates.push(candidateFromDevice(output, "darwin", "macos-bundled-blackhole", output.label.trim(), true));
      } else if (/blackhole/i.test(output.label)) {
        candidates.push(candidateFromDevice(output, "darwin", "macos-bundled-blackhole", "BlackHole 2ch", false, "known"));
      }
    }
  }

  if (normalizedPlatform === "linux") {
    for (const output of outputs) {
      if (/^sounddeck sink$/i.test(output.label.trim())) {
        candidates.push(candidateFromDevice(output, "linux", "linux-managed-pactl", "SoundDeck Mic", true));
      }
    }
  }

  return candidates;
}

export function getDefaultDeviceLabel(devices: MediaDeviceInfo[], kind: MediaDeviceKind) {
  const label = devices.find((device) => device.kind === kind && device.deviceId.toLowerCase() === "default")?.label || "";
  return label.replace(/^default\s*[-:]\s*/i, "");
}

export function makeMicrophoneConstraints(deviceId: string | undefined | null): MediaTrackConstraints {
  const selectableDeviceId = normalizeSelectableDeviceId(deviceId);
  return {
    ...(selectableDeviceId ? { deviceId: { exact: selectableDeviceId } } : {}),
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  };
}
