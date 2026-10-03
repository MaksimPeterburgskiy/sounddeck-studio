import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { ActionSettings } from "../settings";
import { LiveAction } from "./liveAction";

@action({ UUID: "com.sounddeck.studio.switch-board" })
export class SwitchBoard extends LiveAction {
  protected override visual(settings: ActionSettings) {
    const board = this.connection.snapshot?.library.boards.find((item) => item.id === settings.boardId);
    return board ? { title: board.name, color: board.color, active: board.id === this.connection.snapshot?.activeBoardId }
      : { title: "⚠ Missing", warning: true, dimmed: true };
  }
  protected override async press(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    const board = this.connection.snapshot?.library.boards.find((item) => item.id === ev.payload.settings.boardId);
    if (!board) { await ev.action.showAlert(); return; }
    await this.command(ev, "board.activate", { boardId: board.id });
  }
}
