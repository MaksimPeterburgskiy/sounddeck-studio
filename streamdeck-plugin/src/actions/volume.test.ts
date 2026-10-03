import { afterEach, describe, expect, it, vi } from "vitest";
import streamDeck from "@elgato/streamdeck";
import type { Connection, ConnectionStatus } from "../connection";
import type { ActionSettings } from "../settings";
import type { ControlResult } from "../../../src/lib/controlProtocol";
import { Volume } from "./volume";
import { VolumeMute } from "./volumeMute";
import { volumeVisual } from "../volume";
import { keyTitle } from "../render/keyTitle";
import { VolumeDial } from "./volumeDial";

vi.mock("@elgato/streamdeck", () => ({
  default: { logger: { error: vi.fn(), warn: vi.fn() }, ui: { sendToPropertyInspector: vi.fn() } },
  SingletonAction: class {}, action: () => (target: unknown) => target,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(streamDeck.ui.sendToPropertyInspector).mockReset();
  streamDeck.ui.action = undefined;
});
const success: ControlResult = { type: "result", id: "ack", ok: true };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function setup() {
  const listeners = new Set<() => void>();
  const connection = {
    session: {} as object | null, status: "connected" as ConnectionStatus, statusLabel: "Offline",
    snapshot: { volumes: {
      micVirtual: { value: 0.65, muted: false }, micMonitor: { value: 0.4, muted: false },
      soundboardVirtual: { value: 1, muted: false }, soundboardMonitor: { value: 0, muted: true },
    } },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    command: vi.fn(async (_name: string, _args: unknown): Promise<ControlResult> => success),
    handleDisconnectedPress: vi.fn(), emit: () => { for (const listener of listeners) listener(); },
  };
  const key = {
    id: "key", isKey: () => true, isDial: () => false, showAlert: vi.fn(async () => {}),
    setImage: vi.fn(async () => {}), setTitle: vi.fn(async () => {}), setState: vi.fn(async () => {}),
  };
  const dial = {
    ...key, id: "dial", isKey: () => false, isDial: () => true,
    setFeedbackLayout: vi.fn(async (_layout: string) => {}), setFeedback: vi.fn(async (_payload: unknown) => {}),
  };
  return { connection, key, dial, volume: new Volume(connection as unknown as Connection), volumeMute: new VolumeMute(connection as unknown as Connection), volumeDial: new VolumeDial(connection as unknown as Connection) };
}
function event(action: unknown, settings: ActionSettings = {}, extra = {}) { return { action, payload: { settings, ...extra } } as never; }

describe("volume keys", () => {
  it.each([
    { bus: "micVirtual", mode: "up", limit: 1, away: 0.8, delta: 0.05 },
    { bus: "soundboardMonitor", mode: "down", limit: 0, away: 0.2, delta: -0.05 },
  ] as const)("pauses repeats at the $mode limit and resumes when $bus moves away", async ({ bus, mode, limit, away, delta }) => {
    vi.useFakeTimers();
    const { connection, key, volume } = setup();
    const level = connection.snapshot.volumes[bus];
    level.value = away;
    const down = event(key, { bus, mode });
    await volume.onKeyDown(down);
    await vi.advanceTimersByTimeAsync(400);
    expect(connection.command).toHaveBeenCalledTimes(2);
    level.value = limit;
    connection.emit();
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.command).toHaveBeenCalledTimes(2);
    level.value = away;
    connection.emit();
    await vi.advanceTimersByTimeAsync(125);
    expect(connection.command).toHaveBeenCalledTimes(3);
    expect(connection.command).toHaveBeenLastCalledWith("volume.adjust", { bus, delta });
    volume.onKeyUp(down);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.command).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["up", "down"] as const)("keeps the initial %s press at a limit to unmute but suppresses repeats", async (mode) => {
    vi.useFakeTimers();
    const { connection, key, volume } = setup();
    connection.snapshot.volumes.micVirtual = { value: mode === "up" ? 1 : 0, muted: true };
    const down = event(key, { mode });
    await volume.onKeyDown(down);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.command).toHaveBeenCalledExactlyOnceWith("volume.adjust", { bus: "micVirtual", delta: mode === "up" ? 0.05 : -0.05 });
    volume.onKeyUp(down);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("adjusts immediately, starts at 400 ms, repeats at 8 Hz, and stops on up", async () => {
    vi.useFakeTimers();
    const { connection, key, volume } = setup();
    const down = event(key, { bus: "micMonitor", mode: "down", step: 7 });
    await volume.onKeyDown(down);
    expect(connection.command).toHaveBeenLastCalledWith("volume.adjust", { bus: "micMonitor", delta: -0.07 });
    await vi.advanceTimersByTimeAsync(399);
    expect(connection.command).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 + 250);
    expect(connection.command).toHaveBeenCalledTimes(4);
    volume.onKeyUp(down);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.command).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["up", "disappear", "disconnect", "settings"])("cancels a pending initial press on %s without reviving it on acknowledgement", async (stop) => {
    vi.useFakeTimers();
    const { connection, key, volume } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const down = volume.onKeyDown(event(key));
    if (stop === "up") volume.onKeyUp(event(key));
    if (stop === "disappear") volume.onWillDisappear(event(key));
    if (stop === "settings") volume.onDidReceiveSettings(event(key, { mode: "down" }));
    if (stop === "disconnect") {
      connection.session = null; connection.status = "offline"; connection.emit();
      connection.session = {}; connection.status = "connected"; connection.emit();
    }
    resolve(success); await down;
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.command).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["disappear", "disconnect"])("stops an active repeat on %s", async (stop) => {
    vi.useFakeTimers();
    const { connection, key, volume } = setup();
    await volume.onKeyDown(event(key));
    await vi.advanceTimersByTimeAsync(525);
    expect(connection.command).toHaveBeenCalledTimes(3);
    if (stop === "disappear") volume.onWillDisappear(event(key));
    else { connection.session = null; connection.status = "offline"; connection.emit(); }
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.command).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps repeating through settings reads with equivalent defaults and unrelated changes", async () => {
    vi.useFakeTimers();
    const { connection, key, volume } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const down = volume.onKeyDown(event(key));
    volume.onDidReceiveSettings(event(key, { bus: "micVirtual", mode: "up", step: 4.6, title: "Custom" }));
    await vi.advanceTimersByTimeAsync(525);
    expect(connection.command).toHaveBeenCalledTimes(3);
    volume.onDidReceiveSettings(event(key, {}));
    await vi.advanceTimersByTimeAsync(125);
    expect(connection.command).toHaveBeenCalledTimes(4);
    resolve(success); await down;
    volume.onKeyUp(event(key));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ bus: "micMonitor" }, { mode: "down" }, { step: 6 }] as ActionSettings[])("stops repeating on an effective change to %j", async (settings) => {
    vi.useFakeTimers();
    const { connection, key, volume } = setup();
    await volume.onKeyDown(event(key));
    volume.onDidReceiveSettings(event(key, settings));
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.command).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("honors the separate mute action's multi-action state independently of current mute %s", async (muted) => {
    vi.useFakeTimers();
    const { connection, key, volume, volumeMute } = setup();
    connection.snapshot.volumes.micVirtual.muted = muted;
    for (const desired of [0, 1]) {
      await volumeMute.onKeyDown(event(key, {}, { isInMultiAction: true, userDesiredState: desired }));
      expect(connection.command).toHaveBeenLastCalledWith("volume.mute", { bus: "micVirtual", muted: desired === 1 });
    }
    await volumeMute.onKeyDown(event(key, {}, { isInMultiAction: false, userDesiredState: 1 }));
    expect(connection.command).toHaveBeenLastCalledWith("volume.mute", { bus: "micVirtual" });
    expect(vi.getTimerCount()).toBe(0);
    await volume.onKeyDown(event(key, {}, { isInMultiAction: true, userDesiredState: 1 }));
    expect(connection.command).toHaveBeenLastCalledWith("volume.adjust", { bus: "micVirtual", delta: 0.05 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps muted up/down keys distinguishable and reserves states and the ring for mute", async () => {
    const { connection, key, volume, volumeMute } = setup();
    connection.snapshot.volumes.micVirtual.muted = true;
    for (const mode of ["up", "down"] as const) {
      const visual = volumeVisual(connection as unknown as Connection, { mode });
      expect(visual).toMatchObject({ icon: `speaker-${mode}`, badge: "Muted", iconOn: false, active: false });
      expect(visual).not.toHaveProperty("state");
    }
    volume.onWillAppear(event(key)); await flush();
    expect(key.setState).not.toHaveBeenCalled();
    connection.status = "offline"; connection.emit(); await flush();
    expect(key.setState).not.toHaveBeenCalled();
    connection.status = "connected";
    volume.onWillDisappear(event(key));
    volumeMute.onWillAppear(event(key)); await flush();
    expect(key.setState).toHaveBeenLastCalledWith(1);
    expect(volumeVisual(connection as unknown as Connection, {}, true)).toMatchObject({ icon: "speaker-muted", badge: "Muted", iconOn: false, active: true });
    for (const bus of ["micVirtual", "micMonitor", "soundboardVirtual", "soundboardMonitor"] as const) {
      const title = volumeVisual(connection as unknown as Connection, { bus }).title;
      expect(keyTitle(title)).toBe(title);
      expect(title).not.toMatch(/VM|HP|SB/);
    }
  });
});

describe("volume dials", () => {
  it("ignores held touch gestures while connected and offline, without queuing mute behind a rotation", async () => {
    const { connection, dial, volumeDial } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const rotation = volumeDial.onDialRotate(event(dial, {}, { ticks: 1 }));
    await volumeDial.onTouchTap(event(dial, {}, { hold: true }));
    resolve(success); await rotation;
    expect(connection.command).toHaveBeenCalledTimes(1);
    await volumeDial.onTouchTap(event(dial, {}, { hold: false }));
    expect(connection.command).toHaveBeenLastCalledWith("volume.mute", { bus: "micVirtual" });
    connection.status = "offline"; connection.session = null;
    await volumeDial.onTouchTap(event(dial, {}, { hold: true }));
    expect(connection.command).toHaveBeenCalledTimes(2);
    expect(connection.handleDisconnectedPress).not.toHaveBeenCalled();
    expect(dial.showAlert).not.toHaveBeenCalled();
  });

  it("sends the first rotation immediately but discards pending input on disappearance", async () => {
    const { connection, dial, volumeDial } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = volumeDial.onDialRotate(event(dial, {}, { ticks: 3 }));
    await volumeDial.onDialRotate(event(dial, {}, { ticks: 4 }));
    expect(connection.command).toHaveBeenCalledExactlyOnceWith("volume.adjust", { bus: "micVirtual", delta: 0.06 });
    volumeDial.onWillDisappear(event(dial));
    resolve(success); await first;
    expect(connection.command).toHaveBeenCalledTimes(1);
  });

  it("coalesces only consecutive same-direction ticks and never sends a zero adjustment", async () => {
    const { connection, dial, volumeDial } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const rotate = (ticks: number) => volumeDial.onDialRotate(event(dial, {}, { ticks }));
    const first = rotate(1);
    await rotate(2); await rotate(10); await rotate(-3); await rotate(-5); await rotate(5); await rotate(0);
    expect(connection.command).toHaveBeenCalledTimes(1);
    resolve(success); await first;
    expect(connection.command.mock.calls.map(([name, args]) => [name, (args as { delta: number }).delta])).toEqual([
      ["volume.adjust", 0.02], ["volume.adjust", expect.closeTo(0.24)],
      ["volume.adjust", -0.16], ["volume.adjust", 0.1],
    ]);
  });

  it.each(["press", "touch"])("serializes rotations and %s mute through one FIFO during a deferred acknowledgement", async (gesture) => {
    const { connection, dial, volumeDial } = setup();
    const level = connection.snapshot.volumes.micVirtual;
    let resolve!: (result: ControlResult) => void;
    let firstCommand = true;
    connection.command.mockImplementation(async (name, args) => {
      if (name === "volume.adjust") { level.value += (args as { delta: number }).delta; level.muted = false; }
      else level.muted = !level.muted;
      if (firstCommand) { firstCommand = false; return new Promise((done) => { resolve = done; }); }
      return success;
    });
    const first = volumeDial.onDialRotate(event(dial, {}, { ticks: 1 }));
    await volumeDial.onDialRotate(event(dial, {}, { ticks: 2 }));
    await (gesture === "press" ? volumeDial.onDialDown(event(dial)) : volumeDial.onTouchTap(event(dial)));
    expect(connection.command).toHaveBeenCalledTimes(1);
    resolve(success); await first;
    expect(connection.command.mock.calls.map(([name]) => name)).toEqual(["volume.adjust", "volume.adjust", "volume.mute"]);
    expect(level.muted).toBe(true);
  });

  it("keeps separate dials independent while one acknowledgement is pending", async () => {
    const { connection, dial, volumeDial } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = volumeDial.onDialRotate(event(dial, {}, { ticks: 1 }));
    await volumeDial.onDialDown(event(dial));
    await volumeDial.onDialRotate(event({ ...dial, id: "other-dial" }, { bus: "micMonitor" }, { ticks: 3 }));
    expect(connection.command).toHaveBeenLastCalledWith("volume.adjust", { bus: "micMonitor", delta: 0.06 });
    resolve(success); await first;
    expect(connection.command).toHaveBeenLastCalledWith("volume.mute", { bus: "micVirtual" });
  });

  it("keeps a rotation after a queued mute separate from rotations before it", async () => {
    const { connection, dial, volumeDial } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = volumeDial.onDialRotate(event(dial, {}, { ticks: 1 }));
    await volumeDial.onDialRotate(event(dial, {}, { ticks: 2 }));
    await volumeDial.onDialDown(event(dial));
    await volumeDial.onDialRotate(event(dial, {}, { ticks: 3 }));
    resolve(success); await first;
    expect(connection.command.mock.calls).toEqual([
      ["volume.adjust", { bus: "micVirtual", delta: 0.02 }],
      ["volume.adjust", { bus: "micVirtual", delta: 0.04 }],
      ["volume.mute", { bus: "micVirtual" }],
      ["volume.adjust", { bus: "micVirtual", delta: 0.06 }],
    ]);
  });

  it.each([[0.98, 1, 0.9], [0.02, -1, 0.1]])("preserves reversal order at the limit starting at %s", async (initial, direction, expected) => {
    const { connection, dial, volumeDial } = setup();
    const level = connection.snapshot.volumes.micVirtual;
    level.value = initial;
    let resolve!: (result: ControlResult) => void;
    let firstCommand = true;
    connection.command.mockImplementation(async (_name, args) => {
      level.value = Math.min(1, Math.max(0, level.value + (args as { delta: number }).delta));
      if (firstCommand) { firstCommand = false; return new Promise((done) => { resolve = done; }); }
      return success;
    });
    const first = volumeDial.onDialRotate(event(dial, {}, { ticks: direction }));
    await volumeDial.onDialRotate(event(dial, {}, { ticks: 5 * direction }));
    await volumeDial.onDialRotate(event(dial, {}, { ticks: -5 * direction }));
    resolve(success); await first;
    expect(level.value).toBeCloseTo(expected);
    expect(connection.command).toHaveBeenCalledTimes(3);
  });

  it("preserves queued rotations and mute through unchanged settings responses", async () => {
    const { connection, dial, volumeDial } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = volumeDial.onDialRotate(event(dial, {}, { ticks: 1 }));
    await volumeDial.onDialRotate(event(dial, {}, { ticks: 5 }));
    await volumeDial.onDialDown(event(dial));
    volumeDial.onDidReceiveSettings(event(dial, { bus: "micVirtual", step: 1.6, title: "Custom" }));
    volumeDial.onDidReceiveSettings(event(dial));
    resolve(success); await first;
    expect(connection.command.mock.calls).toEqual([
      ["volume.adjust", { bus: "micVirtual", delta: 0.02 }],
      ["volume.adjust", { bus: "micVirtual", delta: 0.1 }],
      ["volume.mute", { bus: "micVirtual" }],
    ]);
  });

  it.each(["disappear", "disconnect", "failure"])("discards accumulated ticks after %s, including a late acknowledgement", async (stop) => {
    const { connection, dial, volumeDial } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = volumeDial.onDialRotate(event(dial, {}, { ticks: 1 })); await flush();
    await volumeDial.onDialRotate(event(dial, {}, { ticks: 20 }));
    await volumeDial.onDialDown(event(dial));
    if (stop === "disappear") volumeDial.onWillDisappear(event(dial));
    if (stop === "disconnect") {
      connection.session = null; connection.status = "offline"; connection.emit();
      connection.session = {}; connection.status = "connected"; connection.emit();
    }
    resolve(stop === "failure" ? { type: "result", id: "ack", ok: false, code: "busy" } : success);
    await first;
    expect(connection.command).toHaveBeenCalledTimes(1);
    expect(dial.showAlert).toHaveBeenCalledTimes(stop === "failure" ? 1 : 0);
  });

  it.each([{ bus: "micMonitor", step: 4 }, { bus: "micVirtual", step: 4 }] as ActionSettings[])("discards old input while keeping a command slot occupied across a settings change to %j", async (settings) => {
    const { connection, dial, volumeDial } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = volumeDial.onDialRotate(event(dial, {}, { ticks: 1 })); await flush();
    await volumeDial.onDialRotate(event(dial, {}, { ticks: 20 }));
    await volumeDial.onDialDown(event(dial));
    volumeDial.onDidReceiveSettings(event(dial, settings));
    await volumeDial.onDialRotate(event(dial, settings, { ticks: -3 }));
    expect(connection.command).toHaveBeenCalledTimes(1);
    resolve(success); await first;
    expect(connection.command).toHaveBeenCalledTimes(2);
    expect(connection.command).toHaveBeenLastCalledWith("volume.adjust", { bus: settings.bus, delta: -0.12 });
  });

  it("toggles mute once for a press and once for a touch tap; drops offline input", async () => {
    const { connection, dial, volumeDial } = setup();
    const mute = event(dial, { bus: "soundboardMonitor" });
    await volumeDial.onDialDown(mute);
    await volumeDial.onTouchTap(mute);
    expect(connection.command.mock.calls).toEqual([
      ["volume.mute", { bus: "soundboardMonitor" }], ["volume.mute", { bus: "soundboardMonitor" }],
    ]);
    connection.status = "offline"; connection.session = null;
    await volumeDial.onDialRotate(event(dial, {}, { ticks: 10 }));
    await volumeDial.onDialDown(mute);
    expect(connection.command).toHaveBeenCalledTimes(2);
    expect(connection.handleDisconnectedPress).toHaveBeenCalledTimes(1);
    expect(dial.showAlert).toHaveBeenCalledTimes(1);
    await volumeDial.onTouchTap(mute);
    expect(connection.handleDisconnectedPress).toHaveBeenCalledTimes(2);
    expect(connection.command).toHaveBeenCalledTimes(2);
  });

  it("uses the newest bus and offline status after a pending dial title write", async () => {
    const { connection, dial, volumeDial } = setup();
    let release!: () => void;
    dial.setTitle.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    volumeDial.onWillAppear(event(dial));
    await flush();
    volumeDial.onDidReceiveSettings(event(dial, { bus: "micMonitor" }));
    connection.status = "offline";
    connection.session = null;
    connection.emit();
    release();
    await flush();
    expect(dial.setTitle).toHaveBeenLastCalledWith("Mic → headphones");
    expect(dial.setFeedback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      value: { value: "Offline", font: { size: 12 } },
      indicator: expect.objectContaining({ value: 0 }),
    }));
    volumeDial.onWillDisappear(event(dial));
  });

  it("uses B1 for live level and mute feedback, deduplicates writes, and clears stale level when disconnected", async () => {
    const { connection, dial, volumeDial } = setup();
    volumeDial.onWillAppear(event(dial)); await flush();
    expect(dial.setFeedbackLayout).not.toHaveBeenCalled();
    expect(dial.setTitle).toHaveBeenCalledExactlyOnceWith("Mic → virtual mic");
    expect(dial.setFeedback).toHaveBeenLastCalledWith({
      value: { value: "65%", font: { size: 24 } }, icon: expect.stringContaining("data:image/svg+xml;base64,"),
      indicator: { value: 65, range: { min: 0, max: 100 }, bar_fill_c: "#1db7a6", enabled: true },
    });
    connection.emit(); await flush();
    expect(dial.setFeedback).toHaveBeenCalledTimes(1);
    connection.snapshot.volumes.micVirtual = { value: 0.32, muted: false };
    connection.emit(); await flush();
    expect(dial.setFeedback.mock.lastCall![0]).toMatchObject({ value: { value: "32%" }, indicator: { value: 32 } });
    connection.snapshot.volumes.micVirtual.muted = true;
    connection.emit(); await flush();
    expect(dial.setFeedback.mock.lastCall![0]).toMatchObject({ value: { value: "Muted" }, indicator: { value: 32, bar_fill_c: "#8fa5a4", enabled: true } });
    for (const [status, label] of [["offline", "Offline"], ["disabled", "Enable\nin app"], ["not-installed", "Not\ninstalled"], ["auth-error", "Re-pair"], ["protocol-mismatch", "Update\nplugin"]] as const) {
      connection.status = status; connection.statusLabel = label; connection.emit(); await flush();
      expect(dial.setFeedback.mock.lastCall![0]).toMatchObject({ value: { value: label.replace(/\n/g, " "), font: { size: 12 } }, indicator: { value: 0, enabled: true } });
    }
    connection.status = "connected"; connection.snapshot.volumes.micVirtual.muted = false;
    connection.emit(); await flush();
    expect(dial.setFeedback.mock.lastCall![0]).toMatchObject({ value: { value: "32%", font: { size: 24 } }, indicator: { value: 32, enabled: true } });
    expect(dial.setTitle).toHaveBeenCalledTimes(1);
    volumeDial.onDidReceiveSettings(event(dial, { bus: "micMonitor" })); await flush();
    expect(dial.setTitle).toHaveBeenLastCalledWith("Mic → headphones");
    expect(dial.setFeedback.mock.lastCall![0]).not.toHaveProperty("title");
    volumeDial.onWillDisappear(event(dial));
    const writes = dial.setFeedback.mock.calls.length;
    connection.emit(); await flush();
    expect(dial.setFeedback).toHaveBeenCalledTimes(writes);
  });
});


describe("volume inspector recovery", () => {
  it.each(["volume", "volumeMute", "volumeDial"] as const)("supersedes a pending %s inspector batch when the connection goes offline", async (kind) => {
    const fixture = setup();
    const action = fixture[kind];
    const key = { ...(kind === "volumeDial" ? fixture.dial : fixture.key), getSettings: vi.fn(async () => ({})) };
    streamDeck.ui.action = key as never;
    const send = vi.mocked(streamDeck.ui.sendToPropertyInspector);
    let release!: () => void;
    send.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const appearing = action.onPropertyInspectorDidAppear(event(key));
    await flush();
    fixture.connection.status = "offline";
    fixture.connection.session = null;
    fixture.connection.emit();
    await flush();
    expect(send.mock.lastCall).toEqual([{ event: "status", label: "Offline" }]);
    const latestCalls = send.mock.calls.length;
    release();
    await appearing;
    expect(send).toHaveBeenCalledTimes(latestCalls);
  });

  it.each(["volume", "volumeMute", "volumeDial"] as const)("discards a stale %s inspector read after a newer refresh", async (kind) => {
    const fixture = setup();
    const action = fixture[kind];
    const key = { ...(kind === "volumeDial" ? fixture.dial : fixture.key), getSettings: vi.fn(async (): Promise<ActionSettings> => ({})) };
    streamDeck.ui.action = key as never;
    let release!: (settings: ActionSettings) => void;
    key.getSettings.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const oldRead = action.onPropertyInspectorDidAppear(event(key));
    key.getSettings.mockResolvedValueOnce({ bus: "micMonitor" });
    await action.onSendToPlugin({ action: key, payload: { event: "status" } } as never);
    const send = vi.mocked(streamDeck.ui.sendToPropertyInspector);
    expect(send).toHaveBeenCalledTimes(3);
    release({ bus: "micVirtual" });
    await oldRead;
    expect(send).toHaveBeenCalledTimes(3);
  });
});
