import streamDeck, {
  action, type DialAction, type DialRotateEvent, type DialDownEvent, type TouchTapEvent,
  type KeyDownEvent, type WillDisappearEvent, type DidReceiveSettingsEvent,
} from "@elgato/streamdeck";
import type { ControlVolumeBus } from "../../../src/lib/controlProtocol";
import type { Connection } from "../connection";
import type { ActionSettings } from "../settings";
import { volumeBus, volumeStep, volumeVisual, volumeFeedback } from "../volume";
import { LiveAction } from "./liveAction";

type Rotation = { bus: ControlVolumeBus; session: object; delta: number; pending: boolean };

@action({ UUID: "com.sounddeck.studio.volume-dial" })
export class VolumeDial extends LiveAction {
  private readonly rotations = new Map<string, Rotation>();

  constructor(connection: Connection) {
    super(connection);
    connection.subscribe(() => {
      for (const [id, rotation] of this.rotations) {
        if (connection.session !== rotation.session) this.rotations.delete(id);
      }
    });
  }

  protected override visual(settings: ActionSettings) { return volumeVisual(this.connection, settings); }
  protected override feedback(settings: ActionSettings) { return volumeFeedback(this.connection, settings); }
  protected override async press(ev: KeyDownEvent<ActionSettings>): Promise<void> { await this.toggleMute(ev); }

  override async onDialRotate(ev: DialRotateEvent<ActionSettings>): Promise<void> {
    if (!this.ready(ev.action)) return;
    const bus = volumeBus(ev.payload.settings);
    if (!bus) { await ev.action.showAlert(); return; }
    if (!Number.isFinite(ev.payload.ticks) || !ev.payload.ticks) return;
    const session = this.connection.session;
    if (!session) return;
    let rotation = this.rotations.get(ev.action.id);
    if (!rotation || rotation.session !== session) {
      rotation = { bus, session, delta: 0, pending: false };
      this.rotations.set(ev.action.id, rotation);
    }
    if (rotation.bus !== bus) { rotation.delta = 0; rotation.bus = bus; }
    rotation.delta += ev.payload.ticks * volumeStep(ev.payload.settings, 2);
    if (rotation.pending) return;
    rotation.pending = true;
    // Yield one microtask to combine synchronous tick bursts as well as ticks
    // arriving while the API acknowledgement is pending.
    await Promise.resolve();
    try {
      while (this.rotations.get(ev.action.id) === rotation && this.connection.session === session && rotation.delta !== 0) {
        const delta = rotation.delta;
        rotation.delta = 0;
        const result = await this.connection.command("volume.adjust", { bus: rotation.bus, delta });
        if (this.rotations.get(ev.action.id) !== rotation || this.connection.session !== session) return;
        await this.reportResult(ev.action, "volume.adjust", result);
        if (!result.ok) { rotation.delta = 0; break; }
      }
    } catch (error) {
      rotation.delta = 0;
      streamDeck.logger.error(error);
    } finally {
      rotation.pending = false;
    }
  }

  // Toggle once on down. The SDK's corresponding dialUp needs no handler.
  override async onDialDown(ev: DialDownEvent<ActionSettings>): Promise<void> { await this.toggleMute(ev); }
  override async onTouchTap(ev: TouchTapEvent<ActionSettings>): Promise<void> { await this.toggleMute(ev); }

  private ready(action: DialAction<ActionSettings> | KeyDownEvent<ActionSettings>["action"]): boolean {
    if (this.connection.status === "connected") return true;
    this.connection.handleDisconnectedPress();
    void action.showAlert().catch((error) => streamDeck.logger.error(error));
    return false;
  }
  private async toggleMute(ev: { action: DialAction<ActionSettings> | KeyDownEvent<ActionSettings>["action"]; payload: { settings: ActionSettings } }): Promise<void> {
    if (!this.ready(ev.action)) return;
    const bus = volumeBus(ev.payload.settings);
    if (!bus) { await ev.action.showAlert(); return; }
    await this.command(ev, "volume.mute", { bus });
  }

  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    this.rotations.delete(ev.action.id);
    super.onWillDisappear(ev);
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ActionSettings>): void {
    // Keep the in-flight slot occupied while discarding ticks for old settings.
    const rotation = this.rotations.get(ev.action.id);
    if (rotation) rotation.delta = 0;
    super.onDidReceiveSettings(ev);
  }
}
