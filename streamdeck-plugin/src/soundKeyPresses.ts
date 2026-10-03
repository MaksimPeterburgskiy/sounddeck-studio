import { randomUUID } from "node:crypto";
import type { ControlCommandArgs, ControlResult } from "../../src/lib/controlProtocol";
import type { Connection } from "./connection";

type Press = { pressId: string; session: object };
type SoundBinding = Omit<ControlCommandArgs["sound.press"], "pressId">;

/** Reusable for sound keys and board slots; ownership follows keys and sockets. */
export class SoundKeyPresses {
  private readonly held = new Map<string, Press>();

  constructor(private readonly connection: Pick<Connection, "session" | "command">) {}

  async press(keyId: string, sound: SoundBinding): Promise<ControlResult> {
    // A repeated down replaces its old press without waiting for an ack, so an
    // up/disappearance can always release the new press while it is pending.
    const previous = this.release(keyId);
    const pressId = randomUUID();
    const session = this.connection.session;
    const press = session ? { pressId, session } : undefined;
    if (press) this.held.set(keyId, press);
    try {
      const [, response] = await Promise.all([
        previous,
        this.connection.command("sound.press", { ...sound, pressId }),
      ]);
      if (!response.ok && this.held.get(keyId) === press) await this.release(keyId);
      return response;
    } catch (error) {
      if (this.held.get(keyId) === press) await this.release(keyId);
      throw error;
    }
  }

  async release(keyId: string): Promise<ControlResult | undefined> {
    const press = this.held.get(keyId);
    if (!press) return;
    this.held.delete(keyId);
    // The server releases closed sockets. Never replay an old release on a
    // new connection, even if it has already returned to "connected".
    if (this.connection.session !== press.session) return;
    return this.connection.command("sound.release", { pressId: press.pressId });
  }
}
