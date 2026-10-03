import { action, type KeyAction, type KeyDownEvent } from "@elgato/streamdeck";
import type { BoardSlots } from "../boardSlots";
import type { Connection } from "../connection";
import type { ActionSettings } from "../settings";
import { LiveAction } from "./liveAction";

abstract class Page extends LiveAction {
  protected abstract readonly direction: 1 | -1;
  constructor(connection: Connection, private readonly slots: BoardSlots) {
    super(connection);
    slots.subscribe(() => this.refresh());
  }
  protected override visual(_settings: ActionSettings, action: KeyAction<ActionSettings>) {
    const page = this.slots.page(action.device.id);
    const enabled = this.direction === 1 ? page.next : page.previous;
    return { title: page.label, icon: this.direction === 1 ? "page-next" as const : "page-previous" as const,
      iconOn: enabled, dimmed: !enabled };
  }
  protected override async press(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    this.slots.move(ev.action.device.id, this.direction);
  }
}
@action({ UUID: "com.sounddeck.studio.page-next" })
export class NextPage extends Page { protected readonly direction = 1; }
@action({ UUID: "com.sounddeck.studio.page-previous" })
export class PreviousPage extends Page { protected readonly direction = -1; }
