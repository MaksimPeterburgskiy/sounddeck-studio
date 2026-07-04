import { describe, expect, it } from "vitest";
import startupSettings from "./startupSettings.cjs";

const { STARTUP_ARG, WINDOWS_STARTUP_NAME, findWindowsStartupLaunchItem, getWindowsStartupState, hasStartupArg, startupLoginItemOptions } = startupSettings;

const executablePath = "C:\\Program Files\\SoundDeck Studio\\SoundDeck Studio.exe";

describe("hasStartupArg", () => {
  it("detects the startup flag in an argv list", () => {
    expect(hasStartupArg(["app.exe", STARTUP_ARG])).toBe(true);
    expect(hasStartupArg(["app.exe", "--other"])).toBe(false);
    expect(hasStartupArg([])).toBe(false);
  });
});

describe("startupLoginItemOptions", () => {
  it("builds a named Windows login item pointing at the executable with the startup flag", () => {
    expect(startupLoginItemOptions(true, true, { platform: "win32", execPath: executablePath })).toEqual({
      openAtLogin: true,
      enabled: true,
      name: WINDOWS_STARTUP_NAME,
      path: executablePath,
      args: [STARTUP_ARG]
    });
    expect(startupLoginItemOptions(false, true, { platform: "win32", execPath: executablePath })).toMatchObject({
      openAtLogin: false,
      enabled: false
    });
  });

  it("uses openAsHidden on non-Windows platforms", () => {
    expect(startupLoginItemOptions(true, true, { platform: "darwin", execPath: "/Applications/SoundDeck.app" })).toEqual({
      openAtLogin: true,
      openAsHidden: true
    });
    expect(startupLoginItemOptions(true, false, { platform: "darwin", execPath: "/Applications/SoundDeck.app" })).toEqual({
      openAtLogin: true,
      openAsHidden: false
    });
  });
});

describe("findWindowsStartupLaunchItem", () => {
  it("matches by startup item name", () => {
    const item = { name: "SoundDeck Studio", path: "C:\\Different\\SoundDeck.exe", enabled: true };

    expect(findWindowsStartupLaunchItem({ launchItems: [item] }, { name: "SoundDeck Studio", executablePath })).toBe(item);
  });

  it("matches executable paths case-insensitively", () => {
    const item = { name: "Other", path: "c:\\program files\\sounddeck studio\\sounddeck studio.exe", enabled: true };

    expect(findWindowsStartupLaunchItem({ launchItems: [item] }, { name: "SoundDeck Studio", executablePath })).toBe(item);
  });
});

describe("getWindowsStartupState", () => {
  it("treats an exact Electron startup entry as registered and approved", () => {
    expect(getWindowsStartupState({ openAtLogin: true }, { name: "SoundDeck Studio", executablePath })).toMatchObject({
      registered: true,
      approved: true
    });
  });

  it("marks a disabled Windows startup item as registered but not approved", () => {
    expect(getWindowsStartupState({
      openAtLogin: false,
      executableWillLaunchAtLogin: false,
      launchItems: [{ name: "SoundDeck Studio", path: executablePath, enabled: false }]
    }, { name: "SoundDeck Studio", executablePath })).toMatchObject({
      registered: true,
      approved: false,
      status: "not-approved"
    });
  });

  it("uses executableWillLaunchAtLogin when launchItems are unavailable", () => {
    expect(getWindowsStartupState({
      openAtLogin: false,
      executableWillLaunchAtLogin: true
    }, { name: "SoundDeck Studio", executablePath })).toMatchObject({
      registered: true,
      approved: true
    });
  });

  it("does not let a disabled launch item mask an executable that will launch", () => {
    expect(getWindowsStartupState({
      openAtLogin: false,
      executableWillLaunchAtLogin: true,
      launchItems: [{ name: "SoundDeck Studio", path: executablePath, enabled: false }]
    }, { name: "SoundDeck Studio", executablePath })).toMatchObject({
      registered: true,
      approved: true
    });
  });

  it("reports no registered startup entry when Electron sees nothing", () => {
    expect(getWindowsStartupState({
      openAtLogin: false,
      executableWillLaunchAtLogin: false,
      launchItems: []
    }, { name: "SoundDeck Studio", executablePath })).toMatchObject({
      registered: false,
      approved: false
    });
  });
});
