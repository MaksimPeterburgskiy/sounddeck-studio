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
 * Page index is local to each device; each follow/pinned group has its own size.
 */
export class BoardSlots {
  private readonly keys = new Map<string, VisibleSlotKey>();
  private readonly requestedPages = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private library?: ControlLibrary;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(): void { for (const listener of this.listeners) listener(); }

  updateLibrary(library: ControlLibrary): void {
    if (this.library === library) return;
    if (this.library?.activeBoardId !== library.activeBoardId) this.requestedPages.clear();
    this.library = library;
    this.notify();
  }
  appear(key: VisibleSlotKey): void {
    this.keys.set(key.id, key);
    this.notify();
  }
  disappear(id: string): void {
    const key = this.keys.get(id);
    if (!key) return;
    this.keys.delete(id);
    this.notify();
  }
  settings(id: string, settings: ActionSettings): void {
    const key = this.keys.get(id);
    if (!key) return;
    this.keys.set(id, { ...key, settings });
    this.notify();
  }
  private groups(deviceId: string): Map<string, VisibleSlotKey[]> {
    const groups = new Map<string, VisibleSlotKey[]>();
    for (const key of autoSlots(this.keys.values(), deviceId)) {
      // Follow keys stay separate from pins even when they resolve to the same board.
      const binding = key.settings.boardId || "";
      const group = groups.get(binding);
      if (group) group.push(key);
      else groups.set(binding, [key]);
    }
    return groups;
  }
  page(deviceId: string) {
    const groups = [...this.groups(deviceId).values()];
    const size = groups.reduce((total, group) => total + group.length, 0);
    // The device advances every group together, using enough pages to reach
    // every represented board. Fixed keys cannot increase the page count.
    const count = Math.max(1, ...groups.map((group) =>
      Math.ceil((slotBoard(this.library, group[0].settings)?.sounds.length ?? 0) / group.length)));
    // Derive the effective page without overwriting the request: visible groups
    // can be incomplete during page/folder transitions, regardless of timing.
    const index = Math.min(this.requestedPages.get(deviceId) ?? 0, count - 1);
    return { size, index, count, label: `${index + 1} / ${count}`, previous: index > 0, next: index < count - 1 };
  }
  move(deviceId: string, direction: 1 | -1): void {
    const page = this.page(deviceId);
    const next = Math.max(0, Math.min(page.count - 1, page.index + direction));
    // Explicit paging starts from the effective page, even at a boundary.
    if (next === (this.requestedPages.get(deviceId) ?? 0)) return;
    this.requestedPages.set(deviceId, next);
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
      const auto = this.groups(key.deviceId).get(settings.boardId || "") ?? [];
      const position = auto.findIndex((item) => item.id === id);
      if (position < 0) return null;
      index = this.page(key.deviceId).index * auto.length + position;
    } else {
      const slot = fixedSlot(settings);
      if (!slot) return undefined;
      index = slot - 1;
    }
    return board.sounds[index] ?? null;
  }
}
