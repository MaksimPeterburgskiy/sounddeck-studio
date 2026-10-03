import streamDeck, {
  action, type DialAction, type DialRotateEvent, type DialDownEvent, type TouchTapEvent,
  type WillDisappearEvent, type DidReceiveSettingsEvent,
} from "@elgato/streamdeck";
import type { ControlVolumeBus } from "../../../src/lib/controlProtocol";
import type { Connection } from "../connection";
import type { ActionSettings } from "../settings";
import { volumeBus, volumeBuses, volumeStep, volumeFeedback } from "../volume";
import { LiveAction } from "./liveAction";

type Input = { name: "volume.adjust"; bus: ControlVolumeBus; delta: number } | { name: "volume.mute"; bus: ControlVolumeBus };
type Queue = { bus: ControlVolumeBus | undefined; step: number; session: object; inputs: Input[]; pending: boolean };

@action({ UUID: "com.sounddeck.studio.volume-dial" })
export class VolumeDial extends LiveAction {
  private readonly queues = new Map<string, Queue>();

  constructor(connection: Connection) {
    super(connection);
    connection.subscribe(() => {
      for (const [id, queue] of this.queues) {
        if (connection.session !== queue.session) this.queues.delete(id);
      }
    });
  }

  protected override visual(settings: ActionSettings) {
    const bus = volumeBus(settings);
    return { title: bus ? volumeBuses[bus].name : "Missing" };
  }
  protected override feedback(settings: ActionSettings) { return volumeFeedback(this.connection, settings); }
  protected override async press(): Promise<void> {}

  override async onDialRotate(ev: DialRotateEvent<ActionSettings>): Promise<void> {
    if (this.connection.status !== "connected") return;
    const bus = volumeBus(ev.payload.settings);
    if (!bus) { await ev.action.showAlert(); return; }
    if (!Number.isFinite(ev.payload.ticks) || !ev.payload.ticks) return;
    await this.enqueue(ev.action, ev.payload.settings, { name: "volume.adjust", bus, delta: ev.payload.ticks * volumeStep(ev.payload.settings, 2) });
  }

  // Toggle once on down. The SDK's corresponding dialUp needs no handler.
  override async onDialDown(ev: DialDownEvent<ActionSettings>): Promise<void> { await this.toggleMute(ev); }
  override async onTouchTap(ev: TouchTapEvent<ActionSettings>): Promise<void> { await this.toggleMute(ev); }

  private async toggleMute(ev: { action: DialAction<ActionSettings>; payload: { settings: ActionSettings } }): Promise<void> {
    if (this.connection.status !== "connected") {
      this.connection.handleDisconnectedPress();
      await ev.action.showAlert();
      return;
    }
    const bus = volumeBus(ev.payload.settings);
    if (!bus) { await ev.action.showAlert(); return; }
    await this.enqueue(ev.action, ev.payload.settings, { name: "volume.mute", bus });
  }

  private updateSettings(queue: Queue, settings: ActionSettings): void {
    const bus = volumeBus(settings);
    const step = volumeStep(settings, 2);
    if (queue.bus !== bus || queue.step !== step) {
      queue.inputs = [];
      queue.bus = bus;
      queue.step = step;
    }
  }

  private async enqueue(action: DialAction<ActionSettings>, settings: ActionSettings, input: Input): Promise<void> {
    const session = this.connection.session;
    if (!session) return;
    let queue = this.queues.get(action.id);
    if (!queue || queue.session !== session) {
      queue = { bus: volumeBus(settings), step: volumeStep(settings, 2), session, inputs: [], pending: false };
      this.queues.set(action.id, queue);
    }
    this.updateSettings(queue, settings);
    const last = queue.inputs.at(-1);
    // Clamp-sensitive direction changes and mute gestures must retain their order.
    if (last?.name === "volume.adjust" && input.name === "volume.adjust" && Math.sign(last.delta) === Math.sign(input.delta)) {
      last.delta += input.delta;
    } else {
      queue.inputs.push(input);
    }
    if (queue.pending) return;
    queue.pending = true;
    try {
      while (this.queues.get(action.id) === queue && this.connection.session === session && queue.inputs.length) {
        const next = queue.inputs.shift()!;
        const result = next.name === "volume.adjust"
          ? await this.connection.command(next.name, { bus: next.bus, delta: next.delta })
          : await this.connection.command(next.name, { bus: next.bus });
        if (this.queues.get(action.id) !== queue || this.connection.session !== session) return;
        await this.reportResult(action, next.name, result);
        if (!result.ok) { queue.inputs = []; break; }
      }
    } catch (error) {
      queue.inputs = [];
      streamDeck.logger.error(error);
    } finally {
      queue.pending = false;
    }
  }

  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    this.queues.delete(ev.action.id);
    super.onWillDisappear(ev);
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ActionSettings>): void {
    const queue = this.queues.get(ev.action.id);
    if (queue) this.updateSettings(queue, ev.payload.settings);
    super.onDidReceiveSettings(ev);
  }
}
