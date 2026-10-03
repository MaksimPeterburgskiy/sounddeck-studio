import streamDeck, { action, type KeyAction, type KeyDownEvent, type KeyUpEvent, type WillDisappearEvent, type DidReceiveSettingsEvent } from "@elgato/streamdeck";
import type { ControlVolumeBus } from "../../../src/lib/controlProtocol";
import type { Connection } from "../connection";
import type { ActionSettings } from "../settings";
import { volumeBus, volumeStep, volumeVisual } from "../volume";
import { LiveAction } from "./liveAction";

// Keep at most one second of repeat ticks while an acknowledgement is pending.
const MAX_REPEAT_TICKS = 8;
type Repeat = {
  action: KeyAction<ActionSettings>; settings: ActionSettings; session: object;
  bus: ControlVolumeBus; delta: number; ticks: number; once: boolean;
  timer?: ReturnType<typeof setTimeout>; interval?: ReturnType<typeof setInterval>;
};

@action({ UUID: "com.sounddeck.studio.volume" })
export class Volume extends LiveAction {
  private readonly held = new Map<string, Repeat>();
  // Initial presses survive repeat cancellation and retain their own adjustment.
  private readonly presses = new Map<string, Repeat[]>();
  // Cancellation cannot free an already-sent command.
  private readonly pending = new Set<string>();

  constructor(connection: Connection) {
    super(connection);
    connection.subscribe(() => {
      for (const [id, repeat] of this.held) {
        if (connection.session !== repeat.session) this.stopRepeat(id);
      }
      if (connection.session) {
        for (const id of this.presses.keys()) void this.drain(id);
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
    if (!session) return;
    const repeat: Repeat = {
      action: ev.action, session, settings: ev.payload.settings, bus, delta,
      ticks: 0, once: !!ev.payload.isInMultiAction,
    };
    const presses = this.presses.get(ev.action.id) ?? [];
    presses.push(repeat);
    this.presses.set(ev.action.id, presses);
    this.held.set(ev.action.id, repeat);
    if (!repeat.once) {
      const tick = () => {
        if (this.held.get(ev.action.id) !== repeat || this.connection.session !== session) return;
        if (this.atLimit(repeat)) { repeat.ticks = 0; return; }
        repeat.ticks = Math.min(MAX_REPEAT_TICKS, repeat.ticks + 1);
        void this.drain(ev.action.id);
      };
      // Arm before awaiting the first acknowledgement so an early up cancels it.
      repeat.timer = setTimeout(() => {
        repeat.interval = setInterval(tick, 125);
        repeat.interval.unref?.();
        tick();
      }, 400);
      repeat.timer.unref?.();
    }
    await this.drain(ev.action.id);
  }

  private atLimit(repeat: Repeat): boolean {
    const level = this.connection.snapshot?.volumes?.[repeat.bus];
    return level !== undefined && !level.muted && (repeat.delta > 0 ? level.value >= 1 : level.value <= 0);
  }

  private async drain(id: string): Promise<void> {
    if (this.pending.has(id)) return;
    this.pending.add(id);
    try {
      while (this.connection.session) {
        const presses = this.presses.get(id);
        const initial = presses?.shift();
        if (!presses?.length) this.presses.delete(id);
        const repeat = initial ?? this.held.get(id);
        if (!repeat) break;
        if (!initial && this.connection.session !== repeat.session) break;
        if (!initial && this.atLimit(repeat)) repeat.ticks = 0;
        if (!initial && !repeat.ticks) break;
        const ticks = initial ? 1 : repeat.ticks;
        if (!initial) repeat.ticks = 0;
        const session = this.connection.session;
        try {
          const result = await this.connection.command("volume.adjust", { bus: repeat.bus, delta: repeat.delta * ticks });
          if ((!result.ok || repeat.once) && this.held.get(id) === repeat) this.stopRepeat(id);
          await this.reportResult(repeat.action, "volume.adjust", result, session);
        } catch (error) {
          if (this.held.get(id) === repeat) this.stopRepeat(id);
          streamDeck.logger.error(error);
        }
      }
    } finally {
      this.pending.delete(id);
    }
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
