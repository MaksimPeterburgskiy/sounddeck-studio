import { action, type KeyAction, type WillAppearEvent, type WillDisappearEvent, type DidReceiveSettingsEvent } from "@elgato/streamdeck";
import type { ControlLibrary } from "../../../src/lib/controlProtocol";
import { BoardSlots, fixedSlot, slotBoard } from "../boardSlots";
import type { Connection } from "../connection";
import type { ActionSettings } from "../settings";
import { SoundAction } from "./soundAction";

@action({ UUID: "com.sounddeck.studio.board-slot" })
export class BoardSlot extends SoundAction {
  constructor(connection: Connection, private readonly slots: BoardSlots) {
    super(connection);
    slots.subscribe(() => this.refresh());
  }
  protected override sound(settings: ActionSettings, action: KeyAction<ActionSettings>) {
    return this.slots.sound(action.id, settings);
  }
  override onWillAppear(ev: WillAppearEvent<ActionSettings>): void {
    if (!ev.action.isKey()) return;
    this.slots.appear({ id: ev.action.id, deviceId: ev.action.device.id, manifestId: ev.action.manifestId,
      coordinates: "coordinates" in ev.payload ? ev.payload.coordinates : undefined, settings: ev.payload.settings });
    super.onWillAppear(ev);
  }
  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    super.onWillDisappear(ev);
    this.slots.disappear(ev.action.id);
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ActionSettings>): void {
    this.slots.settings(ev.action.id, ev.payload.settings);
    super.onDidReceiveSettings(ev);
  }
  protected override inspectorItems(settings: ActionSettings, library?: ControlLibrary) {
    const board = slotBoard(library, settings);
    const boards = [{ label: "Follow active board", value: "" },
      ...(library?.boards.map((item) => ({ label: item.name, value: item.id })) ?? [])];
    if (settings.boardId && !boards.some((item) => item.value === settings.boardId)) {
      boards.push({ label: "Missing board", value: settings.boardId });
    }
    const slots = [{ label: "Auto (by position)", value: "" },
      ...Array.from({ length: board?.sounds.length ?? 0 }, (_, index) => ({ label: String(index + 1), value: String(index + 1) }))];
    const selected = fixedSlot(settings);
    if (selected && selected > (board?.sounds.length ?? 0)) slots.push({ label: `${selected} (empty)`, value: String(selected) });
    return { boards, slots };
  }
}
