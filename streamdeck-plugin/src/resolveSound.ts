import type { ControlLibrary } from "../../src/lib/controlProtocol";

export type SoundBinding = { soundId?: string; boardId?: string; title?: string };
export type LibrarySound = ControlLibrary["boards"][number]["sounds"][number];

/** Match the server's sound.play lookup, including re-imported sound fallback. */
export function resolveSound(library: ControlLibrary, binding: SoundBinding): LibrarySound | undefined {
  const byId = library.boards.flatMap((board) => board.sounds).find((sound) => sound.id === binding.soundId);
  if (byId) return byId;
  if (!binding.boardId || !binding.title) return undefined;
  return library.boards.find((board) => board.id === binding.boardId)?.sounds.find((sound) => sound.title === binding.title);
}
