import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { ActionSettings } from "../settings";
import { LiveAction } from "./liveAction";

@action({ UUID: "com.sounddeck.studio.stop-all" })
export class StopAll extends LiveAction {
  protected override visual() {
    return { title: "Stop all", icon: "stop-all" as const, iconOn: !!this.connection.snapshot?.playback.length, playingRing: !!this.connection.snapshot?.playback.length };
  }
  protected override async press(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    await this.command(ev, "playback.stopAll", {});
  }
}
