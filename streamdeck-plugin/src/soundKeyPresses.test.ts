import { describe, expect, it, vi } from "vitest";
import type { ControlCommandArgs, ControlCommandName, ControlResult } from "../../src/lib/controlProtocol";
import { SoundKeyPresses } from "./soundKeyPresses";

const success: ControlResult = { type: "result", id: "ack", ok: true };
const failure: ControlResult = { type: "result", id: "ack", ok: false, code: "unavailable" };
const unknownCommand: ControlResult = { type: "result", id: "ack", ok: false, code: "unknown-command" };
const binding = { soundId: "sound", boardId: "board", title: "Horn" };

function setup() {
  const connection = {
    session: {} as object | null,
    command: vi.fn((_name: ControlCommandName, _args: ControlCommandArgs[ControlCommandName]): Promise<ControlResult> => Promise.resolve(success)),
  };
  return { connection, keys: new SoundKeyPresses(connection) };
}
function pressId(args: ControlCommandArgs[ControlCommandName]): string {
  return (args as ControlCommandArgs["sound.press"]).pressId;
}

describe("sound key presses", () => {
  it.each([success, failure])("retries an unsupported press as play and shares that capability for the session: %j", async (playResult) => {
    const { connection, keys } = setup();
    connection.command.mockResolvedValueOnce(unknownCommand).mockResolvedValueOnce(playResult);
    expect(await keys.press("key", binding)).toEqual(playResult);
    expect(connection.command.mock.calls).toEqual([
      ["sound.press", { ...binding, pressId: expect.any(String) }],
      ["sound.play", binding],
    ]);
    await keys.release("key");
    await keys.press("key", binding);
    await keys.press("key", binding);
    await keys.release("key");
    const otherKeys = new SoundKeyPresses(connection);
    await otherKeys.press("other-key", binding);
    await otherKeys.release("other-key");
    expect(connection.command.mock.calls.slice(2)).toEqual(Array.from({ length: 3 }, () => ["sound.play", binding]));
  });

  it("tries press again after reconnect without releasing the old fallback", async () => {
    const { connection, keys } = setup();
    connection.command.mockResolvedValueOnce(unknownCommand);
    await keys.press("key", binding);
    await keys.press("other-key", binding);
    connection.session = {};
    await keys.release("key");
    await keys.release("other-key");
    await keys.press("key", binding);
    const id = pressId(connection.command.mock.lastCall![1]);
    await keys.release("key");
    expect(connection.command.mock.calls.map(([name]) => name)).toEqual([
      "sound.press", "sound.play", "sound.play", "sound.press", "sound.release",
    ]);
    expect(connection.command).toHaveBeenLastCalledWith("sound.release", { pressId: id });
  });

  it("retries concurrent unsupported presses and suppresses releases for pending keys", async () => {
    const { connection, keys } = setup();
    let acknowledge!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    const pending = keys.press("a", binding);
    connection.command.mockResolvedValueOnce(unknownCommand);
    expect(await keys.press("b", binding)).toEqual(success);
    await keys.release("a");
    await keys.release("b");
    acknowledge(unknownCommand);
    expect(await pending).toEqual(success);
    expect(connection.command.mock.calls.map(([name]) => name)).toEqual([
      "sound.press", "sound.press", "sound.play", "sound.play",
    ]);
  });

  it.each(["invalid-args", "unavailable"] as const)("does not treat %s as an unsupported command", async (code) => {
    const { connection, keys } = setup();
    const result: ControlResult = { type: "result", id: "ack", ok: false, code };
    connection.command.mockResolvedValueOnce(result);
    expect(await keys.press("key", binding)).toEqual(result);
    await keys.release("key");
    await keys.press("key", binding);
    expect(connection.command.mock.calls.map(([name]) => name)).toEqual(["sound.press", "sound.release", "sound.press"]);
  });

  it("does not replay or downgrade a reconnected session for a late unknown-command result", async () => {
    const { connection, keys } = setup();
    let acknowledge!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    const pending = keys.press("key", binding);
    connection.session = {};
    await keys.press("key", binding);
    const id = pressId(connection.command.mock.lastCall![1]);
    acknowledge(unknownCommand);
    expect(await pending).toEqual(unknownCommand);
    await keys.release("key");
    expect(connection.command.mock.calls.map(([name]) => name)).toEqual(["sound.press", "sound.press", "sound.release"]);
    expect(connection.command).toHaveBeenLastCalledWith("sound.release", { pressId: id });
  });

  it("preserves bindings, gives each down a fresh id, and releases a key only once", async () => {
    const { connection, keys } = setup();
    await keys.press("key", binding);
    const id = pressId(connection.command.mock.calls[0][1]);
    expect(connection.command).toHaveBeenLastCalledWith("sound.press", { ...binding, pressId: id });
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    await keys.release("key");
    expect(connection.command).toHaveBeenLastCalledWith("sound.release", { pressId: id });
    await keys.release("key");
    await keys.release("unknown");
    expect(connection.command).toHaveBeenCalledTimes(2);
    await keys.press("key", binding);
    expect(pressId(connection.command.mock.lastCall![1])).not.toBe(id);
  });

  it("keeps keys bound to the same sound independent", async () => {
    const { connection, keys } = setup();
    await Promise.all([keys.press("a", binding), keys.press("b", binding)]);
    const [a, b] = connection.command.mock.calls.map(([, args]) => pressId(args));
    expect(a).not.toBe(b);
    await keys.release("a");
    expect(connection.command).toHaveBeenLastCalledWith("sound.release", { pressId: a });
    await keys.release("b");
    expect(connection.command).toHaveBeenLastCalledWith("sound.release", { pressId: b });
  });

  it.each([false, true])("drops releases after disconnect, including an already reconnected socket: %s", async (reconnected) => {
    const { connection, keys } = setup();
    await keys.press("key", binding);
    connection.session = reconnected ? {} : null;
    await keys.release("key");
    expect(connection.command).toHaveBeenCalledTimes(1);
    connection.session = {};
    await keys.release("key");
    expect(connection.command).toHaveBeenCalledTimes(1);
    await keys.press("key", binding);
    await keys.release("key");
    expect(connection.command.mock.calls.map(([name]) => name)).toEqual(["sound.press", "sound.press", "sound.release"]);
  });

  it("releases before the press acknowledgement without releasing a later press on failure", async () => {
    const { connection, keys } = setup();
    let acknowledge!: (result: ControlResult) => void;
    connection.command.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    const pending = keys.press("key", binding);
    const oldId = pressId(connection.command.mock.calls[0][1]);
    await keys.release("key");
    expect(connection.command).toHaveBeenLastCalledWith("sound.release", { pressId: oldId });
    await keys.press("key", binding);
    const newId = pressId(connection.command.mock.lastCall![1]);
    acknowledge(failure);
    expect(await pending).toEqual(failure);
    expect(connection.command).toHaveBeenCalledTimes(3);
    await keys.release("key");
    expect(connection.command).toHaveBeenLastCalledWith("sound.release", { pressId: newId });
  });

  it("replaces repeated downs and keeps failed or timed-out presses held until key up", async () => {
    const { connection, keys } = setup();
    await keys.press("key", binding);
    const firstId = pressId(connection.command.mock.lastCall![1]);
    await keys.press("key", binding);
    const secondId = pressId(connection.command.mock.lastCall![1]);
    expect(connection.command.mock.calls[1]).toEqual(["sound.release", { pressId: firstId }]);
    expect(secondId).not.toBe(firstId);
    await keys.release("key");
    connection.command.mockResolvedValueOnce(failure);
    expect(await keys.press("key", binding)).toEqual(failure);
    const failedId = pressId(connection.command.mock.calls[4][1]);
    expect(connection.command).toHaveBeenLastCalledWith("sound.press", { ...binding, pressId: failedId });
    expect(connection.command).toHaveBeenCalledTimes(5);
    await keys.release("key");
    expect(connection.command).toHaveBeenLastCalledWith("sound.release", { pressId: failedId });
    await keys.release("key");
    expect(connection.command).toHaveBeenCalledTimes(6);
  });
});
