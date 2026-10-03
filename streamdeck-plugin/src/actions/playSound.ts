import { action } from "@elgato/streamdeck";
import { resolveSound, currentSoundBinding } from "../resolveSound";
import type { ActionSettings } from "../settings";
import { SoundAction } from "./soundAction";

@action({ UUID: "com.sounddeck.studio.play-sound" })
export class PlaySound extends SoundAction {
  protected override syncSettings(settings: ActionSettings): ActionSettings {
    return this.connection.snapshot ? currentSoundBinding(this.connection.snapshot.library, settings) : settings;
  }
  protected override sound(settings: ActionSettings) {
    return this.connection.snapshot ? resolveSound(this.connection.snapshot.library, settings) : undefined;
  }
}
