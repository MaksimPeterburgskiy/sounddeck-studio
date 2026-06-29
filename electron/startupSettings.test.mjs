import { describe, expect, it } from "vitest";
import startupSettings from "./startupSettings.cjs";

const { findWindowsStartupLaunchItem, getWindowsStartupState } = startupSettings;

const executablePath = "C:\\Program Files\\SoundDeck Studio\\SoundDeck Studio.exe";

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
