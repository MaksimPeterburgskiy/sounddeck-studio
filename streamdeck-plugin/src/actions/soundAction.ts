import streamDeck, { type KeyAction, type KeyDownEvent, type KeyUpEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import type { Connection } from "../connection";
import type { LibrarySound } from "../resolveSound";
import { SoundKeyPresses } from "../soundKeyPresses";
import type { ActionSettings } from "../settings";
import { LiveAction } from "./liveAction";

/** Play sound and Board slot share artwork, animation and hold/release ownership. */
export abstract class SoundAction extends LiveAction {
  private readonly presses: SoundKeyPresses;

  constructor(connection: Connection) {
    super(connection);
    this.presses = new SoundKeyPresses(connection);
  }
  protected abstract sound(settings: ActionSettings, action: KeyAction<ActionSettings>): LibrarySound | null | undefined;
  protected override visual(settings: ActionSettings, action: KeyAction<ActionSettings>) {
    const sound = this.sound(settings, action);
    if (sound === null) return { title: "", color: "#11181b", dimmed: true, blank: true };
    if (!sound) return { title: "Missing", warning: true, dimmed: true };
    const image = this.connection.peekImage(sound.id);
    if (sound.hasImage && image === undefined && this.connection.status === "connected") {
      void this.connection.getImage(sound.id);
    }
    // Repeated voices use the newest start for progress, as a retrigger does.
    const playing = this.connection.snapshot?.playback.filter((voice) => voice.soundId === sound.id)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    return { title: sound.title, glyph: Array.from(sound.title)[0]?.toUpperCase(), color: sound.color, image, playing };
  }
  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    if (this.sound(ev.payload.settings, ev.action) === null) return;
    await super.onKeyDown(ev);
  }
  protected override async press(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    const sound = this.sound(ev.payload.settings, ev.action);
    if (sound === null) return;
    if (!sound) { await ev.action.showAlert(); return; }
    // Both key types resolve against the live library. Fallback titles can
    // exceed protocol limits and are unnecessary with the resolved sound id.
    const session = this.connection.session;
    const result = await this.presses.press(ev.action.id, { soundId: sound.id });
    await this.reportResult(ev.action, "sound.press", result, session);
  }
  override async onKeyUp(ev: KeyUpEvent<ActionSettings>): Promise<void> {
    const session = this.connection.session;
    const result = await this.presses.release(ev.action.id);
    await this.reportResult(ev.action, "sound.release", result, session);
  }
  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    super.onWillDisappear(ev);
    void this.presses.release(ev.action.id).then((result) => {
      if (result && !result.ok) streamDeck.logger.warn(`SoundDeck command sound.release failed: ${result.code}`);
    }).catch((error) => streamDeck.logger.error(error));
  }
}
