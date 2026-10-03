import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection, ConnectionStatus } from "../connection";
import type { ActionSettings } from "../settings";
import type { ControlResult } from "../../../src/lib/controlProtocol";
import { Volume } from "./volume";
import { VolumeDial } from "./volumeDial";

vi.mock("@elgato/streamdeck", () => ({
  default: { logger: { error: vi.fn(), warn: vi.fn() }, ui: { sendToPropertyInspector: vi.fn() } },
  SingletonAction: class {}, action: () => (target: unknown) => target,
}));
afterEach(() => vi.useRealTimers());
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
  return { connection, key, dial, volume: new Volume(connection as unknown as Connection), volumeDial: new VolumeDial(connection as unknown as Connection) };
}
function event(action: unknown, settings: ActionSettings = {}, extra = {}) { return { action, payload: { settings, ...extra } } as never; }

describe("volume keys", () => {
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
    if (stop === "settings") volume.onDidReceiveSettings(event(key, { mode: "mute" }));
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

  it.each([false, true])("honors multi-action mute state independently of current mute %s", async (muted) => {
    vi.useFakeTimers();
    const { connection, key, volume } = setup();
    connection.snapshot.volumes.micVirtual.muted = muted;
    for (const desired of [0, 1]) {
      await volume.onKeyDown(event(key, { mode: "mute" }, { isInMultiAction: true, userDesiredState: desired }));
      expect(connection.command).toHaveBeenLastCalledWith("volume.mute", { bus: "micVirtual", muted: desired === 1 });
    }
    await volume.onKeyDown(event(key, { mode: "mute" }, { isInMultiAction: false }));
    expect(connection.command).toHaveBeenLastCalledWith("volume.mute", { bus: "micVirtual" });
    expect(vi.getTimerCount()).toBe(0);
    await volume.onKeyDown(event(key, {}, { isInMultiAction: true, userDesiredState: 1 }));
    expect(connection.command).toHaveBeenLastCalledWith("volume.adjust", { bus: "micVirtual", delta: 0.05 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("volume dials", () => {
  it("cancels a tick burst if the dial disappears before the first command is sent", async () => {
    const { connection, dial, volumeDial } = setup();
    const rotate = volumeDial.onDialRotate(event(dial, {}, { ticks: 3 }));
    volumeDial.onWillDisappear(event(dial));
    await rotate;
    expect(connection.command).not.toHaveBeenCalled();
  });

  it("coalesces bursts, accumulates signed ticks during each pending command, and never sends a zero adjustment", async () => {
    const { connection, dial, volumeDial } = setup();
    const resolves: Array<(result: ControlResult) => void> = [];
    connection.command.mockImplementation(() => new Promise((done) => { resolves.push(done); }));
    const rotate = (ticks: number) => volumeDial.onDialRotate(event(dial, {}, { ticks }));
    const first = rotate(1);
    void rotate(2); await flush();
    expect(connection.command).toHaveBeenCalledTimes(1);
    expect(connection.command).toHaveBeenLastCalledWith("volume.adjust", { bus: "micVirtual", delta: 0.06 });
    await rotate(10); await rotate(-3);
    expect(connection.command).toHaveBeenCalledTimes(1);
    resolves.shift()!(success); await flush();
    expect(connection.command).toHaveBeenCalledTimes(2);
    expect(connection.command.mock.lastCall![1]).toEqual({ bus: "micVirtual", delta: expect.closeTo(0.14) });
    await rotate(-5); await rotate(5);
    resolves.shift()!(success); await first;
    expect(connection.command).toHaveBeenCalledTimes(2);
    await rotate(0);
    expect(connection.command).toHaveBeenCalledTimes(2);
  });

  it.each(["disappear", "disconnect", "failure"])("discards accumulated ticks after %s, including a late acknowledgement", async (stop) => {
    const { connection, dial, volumeDial } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = volumeDial.onDialRotate(event(dial, {}, { ticks: 1 })); await flush();
    await volumeDial.onDialRotate(event(dial, {}, { ticks: 20 }));
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

  it("discards old settings' ticks while keeping a command slot occupied across a bus change", async () => {
    const { connection, dial, volumeDial } = setup();
    let resolve!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = volumeDial.onDialRotate(event(dial, {}, { ticks: 1 })); await flush();
    await volumeDial.onDialRotate(event(dial, {}, { ticks: 20 }));
    const settings: ActionSettings = { bus: "micMonitor", step: 4 };
    volumeDial.onDidReceiveSettings(event(dial, settings));
    await volumeDial.onDialRotate(event(dial, settings, { ticks: -3 }));
    expect(connection.command).toHaveBeenCalledTimes(1);
    resolve(success); await first;
    expect(connection.command).toHaveBeenCalledTimes(2);
    expect(connection.command).toHaveBeenLastCalledWith("volume.adjust", { bus: "micMonitor", delta: -0.12 });
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
    expect(connection.handleDisconnectedPress).toHaveBeenCalledTimes(2);
    expect(dial.showAlert).toHaveBeenCalledTimes(2);
  });

  it("uses B1 for live level and mute feedback, deduplicates writes, and clears stale level when disconnected", async () => {
    const { connection, dial, volumeDial } = setup();
    volumeDial.onWillAppear(event(dial)); await flush();
    expect(dial.setFeedbackLayout).toHaveBeenCalledExactlyOnceWith("$B1");
    expect(dial.setFeedback).toHaveBeenLastCalledWith({
      title: { value: "Mic → virtual mic", font: { size: 10 } },
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
    expect(dial.setFeedback.mock.lastCall![0]).toMatchObject({ value: { value: "Muted" }, indicator: { value: 0, bar_fill_c: "#8fa5a4", enabled: false } });
    for (const [status, label] of [["offline", "Offline"], ["disabled", "Enable\nin app"], ["not-installed", "Not\ninstalled"], ["auth-error", "Re-pair"], ["protocol-mismatch", "Update\nplugin"]] as const) {
      connection.status = status; connection.statusLabel = label; connection.emit(); await flush();
      expect(dial.setFeedback.mock.lastCall![0]).toMatchObject({ value: { value: label.replace(/\n/g, " "), font: { size: 12 } }, indicator: { value: 0, enabled: false } });
    }
    connection.status = "connected"; connection.snapshot.volumes.micVirtual.muted = false;
    connection.emit(); await flush();
    expect(dial.setFeedback.mock.lastCall![0]).toMatchObject({ value: { value: "32%", font: { size: 24 } }, indicator: { value: 32, enabled: true } });
    volumeDial.onWillDisappear(event(dial));
    const writes = dial.setFeedback.mock.calls.length;
    connection.emit(); await flush();
    expect(dial.setFeedback).toHaveBeenCalledTimes(writes);
  });
});
