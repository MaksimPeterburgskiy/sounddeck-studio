import streamDeck, { action, type KeyDownEvent, type KeyUpEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import type { Connection } from "../connection";
import { resolveSound, currentSoundBinding } from "../resolveSound";
import { SoundKeyPresses } from "../soundKeyPresses";
import type { ActionSettings } from "../settings";
import { LiveAction } from "./liveAction";

@action({ UUID: "com.sounddeck.studio.play-sound" })
export class PlaySound extends LiveAction {
  private readonly presses: SoundKeyPresses;

  constructor(connection: Connection) {
    super(connection);
    this.presses = new SoundKeyPresses(connection);
  }

  protected override syncSettings(settings: ActionSettings): ActionSettings {
    return this.connection.snapshot ? currentSoundBinding(this.connection.snapshot.library, settings) : settings;
  }
  protected override visual(settings: ActionSettings) {
    const sound = this.connection.snapshot && resolveSound(this.connection.snapshot.library, settings);
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
  protected override async press(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    const sound = this.connection.snapshot && resolveSound(this.connection.snapshot.library, ev.payload.settings);
    if (!sound) { await ev.action.showAlert(); return; }
    // Fallback already resolved against the live library; saved titles may
    // exceed the protocol's limits and are unnecessary with the current id.
    const result = await this.presses.press(ev.action.id, { soundId: sound.id });
    await this.reportResult(ev.action, "sound.press", result);
  }

  override async onKeyUp(ev: KeyUpEvent<ActionSettings>): Promise<void> {
    const result = await this.presses.release(ev.action.id);
    await this.reportResult(ev.action, "sound.release", result);
  }

  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    super.onWillDisappear(ev);
    void this.presses.release(ev.action.id).then((result) => {
      if (result && !result.ok) streamDeck.logger.warn(`SoundDeck command sound.release failed: ${result.code}`);
    }).catch((error) => streamDeck.logger.error(error));
  }
}
