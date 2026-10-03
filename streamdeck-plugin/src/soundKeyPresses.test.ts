import { describe, expect, it, vi } from "vitest";
import type { ControlCommandArgs, ControlCommandName, ControlResult } from "../../src/lib/controlProtocol";
import { SoundKeyPresses } from "./soundKeyPresses";

const success: ControlResult = { type: "result", id: "ack", ok: true };
const failure: ControlResult = { type: "result", id: "ack", ok: false, code: "unavailable" };
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

  it("replaces repeated downs and releases failed or timed-out presses", async () => {
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
    expect(connection.command).toHaveBeenLastCalledWith("sound.release", { pressId: failedId });
    await keys.release("key");
    expect(connection.command).toHaveBeenCalledTimes(6);
  });
});
