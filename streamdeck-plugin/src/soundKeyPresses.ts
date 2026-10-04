import { randomUUID } from "node:crypto";
import type { ControlCommandArgs, ControlResult } from "../../src/lib/controlProtocol";
import type { Connection } from "./connection";

type Press = { pressId: string; session: object };
type SoundBinding = Omit<ControlCommandArgs["sound.press"], "pressId">;

// Share the capability across key owners, but retry it on every new socket.
const playOnlySessions = new WeakSet<object>();

/** Reusable for sound keys and board slots; ownership follows keys and sockets. */
export class SoundKeyPresses {
  private readonly held = new Map<string, Press>();

  constructor(private readonly connection: Pick<Connection, "session" | "command">) {}

  async press(keyId: string, sound: SoundBinding): Promise<ControlResult> {
    // A repeated down replaces its old press without waiting for an ack, so an
    // up/disappearance can always release the new press while it is pending.
    const previous = this.release(keyId);
    const session = this.connection.session;
    if (session && playOnlySessions.has(session)) {
      const [, response] = await Promise.all([previous, this.connection.command("sound.play", sound)]);
      return response;
    }
    const pressId = randomUUID();
    const press = session ? { pressId, session } : undefined;
    if (press) this.held.set(keyId, press);
    const [, response] = await Promise.all([
      previous,
      this.connection.command("sound.press", { ...sound, pressId }).then((result) => {
        // Protocol-1 servers predating hold-to-play reject unknown commands.
        // Never retry a stale key down or carry its capability to a new socket.
        if (!result.ok && result.code === "unknown-command" && session && this.connection.session === session) {
          playOnlySessions.add(session);
          if (this.held.get(keyId) === press) this.held.delete(keyId);
          return this.connection.command("sound.play", sound);
        }
        return result;
      }),
    ]);
    // An acknowledgement timeout can precede playback. Ownership follows the
    // physical key even on failure, until key up or disappearance releases it.
    return response;
  }

  async release(keyId: string): Promise<ControlResult | undefined> {
    const press = this.held.get(keyId);
    if (!press) return;
    this.held.delete(keyId);
    // The server releases closed sockets. Never replay an old release on a
    // new connection, even if it has already returned to "connected".
    if (this.connection.session !== press.session || playOnlySessions.has(press.session)) return;
    const result = await this.connection.command("sound.release", { pressId: press.pressId });
    // A release can beat the press's capability check. Servers predating hold-to-play
    // reject it, and the pending press then falls back to sound.play, so it isn't a failure.
    if (!result.ok && result.code === "unknown-command") {
      playOnlySessions.add(press.session);
      return;
    }
    return result;
  }
}
