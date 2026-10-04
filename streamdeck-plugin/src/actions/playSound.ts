import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { resolveSound, currentSoundBinding } from "../resolveSound";
import type { ActionSettings } from "../settings";
import { LiveAction } from "./liveAction";

@action({ UUID: "com.sounddeck.studio.play-sound" })
export class PlaySound extends LiveAction {
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
    await this.playOnKeyDown(ev, sound.id);
  }
  // This is the single tap trigger boundary. The later hold PR can add its
  // press/release pair here and onKeyUp without changing rendering or binding.
  private async playOnKeyDown(ev: KeyDownEvent<ActionSettings>, soundId: string): Promise<void> {
    // Fallback already resolved against the live library; saved titles may
    // exceed the protocol's limits and are unnecessary with the current id.
    await this.command(ev, "sound.play", { soundId });
  }
}
