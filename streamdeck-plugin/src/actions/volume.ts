import streamDeck, { action, type KeyDownEvent, type KeyUpEvent, type WillDisappearEvent, type DidReceiveSettingsEvent } from "@elgato/streamdeck";
import type { Connection } from "../connection";
import type { ActionSettings } from "../settings";
import { volumeBus, volumeStep, volumeVisual } from "../volume";
import { LiveAction } from "./liveAction";

type Repeat = { settings: ActionSettings; session: object; timer?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval> };

@action({ UUID: "com.sounddeck.studio.volume" })
export class Volume extends LiveAction {
  private readonly held = new Map<string, Repeat>();

  constructor(connection: Connection) {
    super(connection);
    connection.subscribe(() => {
      for (const [id, repeat] of this.held) {
        if (connection.session !== repeat.session) this.stopRepeat(id);
      }
    });
  }

  protected override visual(settings: ActionSettings) { return volumeVisual(this.connection, settings); }

  protected override async press(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    this.stopRepeat(ev.action.id);
    const bus = volumeBus(ev.payload.settings);
    const mode = ev.payload.settings.mode ?? "up";
    if (!bus || !["up", "down"].includes(mode)) { await ev.action.showAlert(); return; }
    const delta = volumeStep(ev.payload.settings, 5) * (mode === "down" ? -1 : 1);
    const session = this.connection.session;
    const repeat: Repeat | undefined = session && !ev.payload.isInMultiAction ? { session, settings: ev.payload.settings } : undefined;
    const adjust = async (repeating = false) => {
      if (repeat && (this.held.get(ev.action.id) !== repeat || this.connection.session !== session)) return;
      const value = this.connection.snapshot?.volumes[bus]?.value;
      if (repeating && value !== undefined && (delta > 0 ? value >= 1 : value <= 0)) return;
      try {
        const result = await this.connection.command("volume.adjust", { bus, delta });
        if (!result.ok && this.held.get(ev.action.id) === repeat) this.stopRepeat(ev.action.id);
        await this.reportResult(ev.action, "volume.adjust", result);
      } catch (error) {
        if (this.held.get(ev.action.id) === repeat) this.stopRepeat(ev.action.id);
        streamDeck.logger.error(error);
      }
    };
    if (repeat) {
      this.held.set(ev.action.id, repeat);
      // Arm before awaiting the first acknowledgement so an early up cancels it.
      repeat.timer = setTimeout(() => {
        repeat.interval = setInterval(() => { void adjust(true); }, 125);
        repeat.interval.unref?.();
        void adjust(true);
      }, 400);
      repeat.timer.unref?.();
    }
    await adjust();
  }

  override onKeyUp(ev: KeyUpEvent<ActionSettings>): void { this.stopRepeat(ev.action.id); }
  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    this.stopRepeat(ev.action.id);
    super.onWillDisappear(ev);
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ActionSettings>): void {
    const repeat = this.held.get(ev.action.id);
    if (repeat && (volumeBus(repeat.settings) !== volumeBus(ev.payload.settings)
      || (repeat.settings.mode ?? "up") !== (ev.payload.settings.mode ?? "up")
      || volumeStep(repeat.settings, 5) !== volumeStep(ev.payload.settings, 5))) this.stopRepeat(ev.action.id);
    super.onDidReceiveSettings(ev);
  }
  private stopRepeat(id: string): void {
    const repeat = this.held.get(id);
    if (!repeat) return;
    clearTimeout(repeat.timer);
    clearInterval(repeat.interval);
    this.held.delete(id);
  }
}
