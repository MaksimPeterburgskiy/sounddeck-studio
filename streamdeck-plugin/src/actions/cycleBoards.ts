import { action, type KeyDownEvent } from "@elgato/streamdeck";
import type { ActionSettings } from "../settings";
import { LiveAction } from "./liveAction";

@action({ UUID: "com.sounddeck.studio.cycle-boards" })
export class CycleBoards extends LiveAction {
  protected override visual() {
    const board = this.connection.snapshot?.library.boards.find((item) => item.id === this.connection.snapshot?.activeBoardId);
    return { title: board?.name ?? "Cycle boards", color: board?.color, symbol: "↻" };
  }
  protected override async press(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    await this.command(ev, "board.cycle", {});
  }
}
