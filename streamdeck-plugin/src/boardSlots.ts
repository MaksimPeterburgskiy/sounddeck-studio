import type { ControlLibrary } from "../../src/lib/controlProtocol";
import type { LibrarySound } from "./resolveSound";
import type { ActionSettings } from "./settings";

export const BOARD_SLOT = "com.sounddeck.studio.board-slot";
export interface VisibleSlotKey {
  id: string;
  deviceId: string;
  manifestId: string;
  coordinates?: { row: number; column: number };
  settings: ActionSettings;
}

export function isAutoSlot(settings: ActionSettings): boolean {
  return settings.slot === undefined || settings.slot === "" || settings.slot === "auto";
}
export function fixedSlot(settings: ActionSettings): number | undefined {
  if (isAutoSlot(settings)) return;
  const number = Number(settings.slot);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}
export function autoSlots(keys: Iterable<VisibleSlotKey>, deviceId: string): VisibleSlotKey[] {
  return [...keys].filter((key) => key.deviceId === deviceId && key.manifestId === BOARD_SLOT
    && isAutoSlot(key.settings) && key.coordinates)
    .sort((a, b) => a.coordinates!.row - b.coordinates!.row || a.coordinates!.column - b.coordinates!.column || a.id.localeCompare(b.id));
}
export function slotBoard(library: ControlLibrary | undefined, settings: ActionSettings) {
  return library?.boards.find((board) => board.id === (settings.boardId || library.activeBoardId));
}

/** Visible keys alone describe the current page/folder; SDK coordinates are per device.
 * Page state is local and shared by auto slots, including pinned boards.
 */
export class BoardSlots {
  private readonly keys = new Map<string, VisibleSlotKey>();
  private readonly pages = new Map<string, number>();
  private readonly layoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private library?: ControlLibrary;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(): void { for (const listener of this.listeners) listener(); }

  private clamp(deviceId: string): boolean {
    const page = this.page(deviceId);
    if (!page.size || !this.pages.has(deviceId) || this.pages.get(deviceId) === page.index) return false;
    this.pages.set(deviceId, page.index);
    return true;
  }
  private settleLayout(deviceId: string): void {
    clearTimeout(this.layoutTimers.get(deviceId));
    // Page/folder switches arrive as a burst of disappear/appear events. Render
    // the current layout immediately, but only save clamps after it settles.
    const timer = setTimeout(() => {
      this.layoutTimers.delete(deviceId);
      if (this.clamp(deviceId)) this.notify();
    }, 100);
    timer.unref();
    this.layoutTimers.set(deviceId, timer);
  }

  updateLibrary(library: ControlLibrary): void {
    if (this.library === library) return;
    if (this.library?.activeBoardId !== library.activeBoardId) this.pages.clear();
    this.library = library;
    for (const deviceId of this.pages.keys()) {
      if (!this.layoutTimers.has(deviceId)) this.clamp(deviceId);
    }
    this.notify();
  }
  appear(key: VisibleSlotKey): void {
    this.keys.set(key.id, key);
    this.settleLayout(key.deviceId);
    this.notify();
  }
  disappear(id: string): void {
    const key = this.keys.get(id);
    if (!key) return;
    this.keys.delete(id);
    this.settleLayout(key.deviceId);
    this.notify();
  }
  settings(id: string, settings: ActionSettings): void {
    const key = this.keys.get(id);
    if (!key) return;
    this.keys.set(id, { ...key, settings });
    this.settleLayout(key.deviceId);
    this.notify();
  }
  page(deviceId: string) {
    const keys = autoSlots(this.keys.values(), deviceId);
    const size = keys.length;
    // Mixed pinned/follow keys use the longest represented board, so paging
    // can reach every board. Fixed keys cannot increase the page count.
    const length = Math.max(0, ...keys.map((key) => slotBoard(this.library, key.settings)?.sounds.length ?? 0));
    const count = size ? Math.max(1, Math.ceil(length / size)) : 1;
    const index = Math.min(this.pages.get(deviceId) ?? 0, count - 1);
    return { size, index, count, offset: index * size, label: `${index + 1} / ${count}`, previous: index > 0, next: index < count - 1 };
  }
  move(deviceId: string, direction: 1 | -1): void {
    const page = this.page(deviceId);
    const next = Math.max(0, Math.min(page.count - 1, page.index + direction));
    if (next === page.index) return;
    this.pages.set(deviceId, next);
    this.notify();
  }
  board(id: string) {
    const key = this.keys.get(id);
    return key ? slotBoard(this.library, key.settings) : undefined;
  }
  /** null is an empty slot; undefined is a missing board or invalid binding. */
  sound(id: string): LibrarySound | null | undefined {
    const key = this.keys.get(id);
    const board = this.board(id);
    if (!key || !board) return undefined;
    const settings = key.settings;
    let index: number;
    if (isAutoSlot(settings)) {
      const auto = autoSlots(this.keys.values(), key.deviceId);
      const position = auto.findIndex((item) => item.id === id);
      if (position < 0) return null;
      index = this.page(key.deviceId).offset + position;
    } else {
      const slot = fixedSlot(settings);
      if (!slot) return undefined;
      index = slot - 1;
    }
    return board.sounds[index] ?? null;
  }
}
