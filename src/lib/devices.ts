const roleDeviceIds = new Set(["default", "communications"]);

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
  const cableOutputs = devices.filter((device) => device.kind === "audiooutput" && /cable input/i.test(device.label));
  return cableOutputs.find(isSelectableMediaDevice)?.deviceId ?? "";
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
