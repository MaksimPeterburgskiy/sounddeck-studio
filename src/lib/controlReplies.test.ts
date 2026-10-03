import { describe, expect, it, vi } from "vitest";
import { createControlReplies } from "./controlReplies";
import { applyAudioControlCommand, rollbackAudioControlSettings, type AudioControlCommand } from "./controlSettings";
import type { RendererControlResult } from "./controlProtocol";
import { makeAudioSettings } from "./testing/webAudioFakes";

const result: RendererControlResult = { ok: true, data: { bus: "micVirtual", value: 0.9, muted: false } };

describe("persisted control replies", () => {
  it("holds replies until their save completes and leaves later commands for the next save", async () => {
    const replies = createControlReplies();
    const settled = vi.fn();
    const first = replies.add(result).then(settled);
    let finishSave!: () => void;
    const saving = replies.save(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const later = replies.add(result).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(replies.length).toBe(1);
    finishSave();
    await saving;
    await first;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenLastCalledWith(result);
    await replies.save(() => Promise.resolve());
    await later;
    expect(settled).toHaveBeenCalledTimes(2);
    expect(replies.length).toBe(0);
  });

  it("returns internal-error to every reply in a failed save and allows the next save", async () => {
    const replies = createControlReplies();
    const first = replies.add(result);
    const second = replies.add(result);
    await replies.save(() => Promise.reject(new Error("disk full")));
    expect(await Promise.all([first, second])).toEqual([
      { ok: false, code: "internal-error" },
      { ok: false, code: "internal-error" }
    ]);
    const next = replies.add(result);
    await replies.save(() => Promise.resolve());
    expect(await next).toEqual(result);
  });

  it.each<AudioControlCommand>([
    { command: "setting.set", args: { key: "micPassthrough", value: true } },
    { command: "setting.toggle", args: { key: "micPassthrough" } },
    { command: "volume.set", args: { bus: "micVirtual", value: 0.9 } },
    { command: "volume.adjust", args: { bus: "micVirtual", delta: 0.2 } },
    { command: "volume.mute", args: { bus: "micVirtual" } }
  ])("rolls back $command before reporting a failed save", async (command) => {
    const replies = createControlReplies();
    const previous = makeAudioSettings({ micPassthrough: false, micVirtualVolume: 0.4, micVirtualMuted: true });
    const applied = applyAudioControlCommand(previous, command);
    let settings = applied.settings;
    const reply = replies.add({ ok: true, data: applied.data }, () => {
      settings = rollbackAudioControlSettings(settings, previous, applied.settings);
    }).then((result) => ({ result, settings }));
    await replies.save(() => Promise.reject(new Error("disk full")));
    expect(await reply).toEqual({ result: { ok: false, code: "internal-error" }, settings: previous });
  });

  it("unwinds multiple changes to the same fields in a failed batch", async () => {
    const replies = createControlReplies();
    const initial = makeAudioSettings({ micPassthrough: false, micVirtualVolume: 0.4, micVirtualMuted: true });
    let settings = initial;
    const pending = [
      { command: "setting.toggle", args: { key: "micPassthrough" } },
      { command: "setting.toggle", args: { key: "micPassthrough" } },
      { command: "volume.set", args: { bus: "micVirtual", value: 0.9 } },
      { command: "volume.adjust", args: { bus: "micVirtual", delta: -0.2 } }
    ].map((command) => {
      const previous = settings;
      const applied = applyAudioControlCommand(previous, command as AudioControlCommand);
      settings = applied.settings;
      return replies.add({ ok: true, data: applied.data }, () => {
        settings = rollbackAudioControlSettings(settings, previous, applied.settings);
      });
    });
    await replies.save(() => Promise.reject(new Error("disk full")));
    expect(settings).toEqual(initial);
    expect(await Promise.all(pending)).toEqual(Array(4).fill({ ok: false, code: "internal-error" }));
  });

  it("preserves newer changes while restoring other fields changed by the failed command", async () => {
    const replies = createControlReplies();
    const previous = makeAudioSettings({ micVirtualVolume: 0.4, micVirtualMuted: true });
    const applied = applyAudioControlCommand(previous, { command: "volume.set", args: { bus: "micVirtual", value: 0.9 } });
    let settings = applied.settings;
    const failed = replies.add({ ok: true, data: applied.data }, () => {
      settings = rollbackAudioControlSettings(settings, previous, applied.settings);
    });
    let failSave!: (error: Error) => void;
    const saving = replies.save(() => new Promise<void>((_resolve, reject) => { failSave = reject; }));
    const newer = applyAudioControlCommand(settings, { command: "volume.set", args: { bus: "micVirtual", value: 0.6 } });
    settings = { ...newer.settings, monitorDeviceId: "new-headphones", soundboardVirtualVolume: 0.3 };
    const rollback = vi.fn();
    const later = replies.add({ ok: true, data: newer.data }, rollback);
    failSave(new Error("disk full"));
    await saving;
    expect(await failed).toEqual({ ok: false, code: "internal-error" });
    expect(settings).toEqual({ ...previous, micVirtualVolume: 0.6, monitorDeviceId: "new-headphones", soundboardVirtualVolume: 0.3 });
    expect(rollback).not.toHaveBeenCalled();
    await replies.save(() => Promise.resolve());
    expect(await later).toEqual({ ok: true, data: newer.data });
  });

  it("does not roll back fields a mute command left unchanged", async () => {
    const replies = createControlReplies();
    const previous = makeAudioSettings({ micVirtualVolume: 0.4 });
    const applied = applyAudioControlCommand(previous, { command: "volume.mute", args: { bus: "micVirtual" } });
    let settings = { ...applied.settings, micVirtualVolume: 0.7 };
    const reply = replies.add({ ok: true, data: applied.data }, () => {
      settings = rollbackAudioControlSettings(settings, previous, applied.settings);
    });
    await replies.save(() => Promise.reject(new Error("disk full")));
    expect(await reply).toEqual({ ok: false, code: "internal-error" });
    expect(settings).toEqual({ ...previous, micVirtualVolume: 0.7 });
  });
});
