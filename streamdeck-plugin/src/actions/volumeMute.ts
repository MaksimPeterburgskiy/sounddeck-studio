import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { ActionSettings } from "../settings";
import { volumeBus, volumeVisual } from "../volume";
import { LiveAction } from "./liveAction";

@action({ UUID: "com.sounddeck.studio.volume-mute" })
export class VolumeMute extends LiveAction {
  protected override visual(settings: ActionSettings) { return volumeVisual(this.connection, settings, true); }

  protected override async press(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    const bus = volumeBus(ev.payload.settings);
    if (!bus) { await ev.action.showAlert(); return; }
    await this.command(ev, "volume.mute", {
      bus, ...(ev.payload.isInMultiAction && ev.payload.userDesiredState !== undefined && { muted: ev.payload.userDesiredState === 1 }),
    });
  }
}
