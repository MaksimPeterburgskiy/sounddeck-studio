import { CONTROL_MAX_TITLE_LENGTH, type ControlLibrary } from "../../src/lib/controlProtocol";

export type SoundBinding = { soundId?: string; boardId?: string; title?: string };
export type LibrarySound = ControlLibrary["boards"][number]["sounds"][number];

/** Match the server's sound.play lookup, including re-imported sound fallback. */
export function resolveSound(library: ControlLibrary, binding: SoundBinding): LibrarySound | undefined {
  const byId = library.boards.flatMap((board) => board.sounds).find((sound) => sound.id === binding.soundId);
  if (byId) return byId;
  if (library.incomplete || !binding.boardId || !binding.title) return undefined;
  // Older bindings can contain the full title from before summaries were bounded.
  const sounds = library.boards.find((board) => board.id === binding.boardId)?.sounds ?? [];
  let title = binding.title;
  let matches = sounds.filter((sound) => sound.title === title);
  if (!matches.length && title.length > CONTROL_MAX_TITLE_LENGTH) {
    title = title.slice(0, CONTROL_MAX_TITLE_LENGTH);
    matches = sounds.filter((sound) => sound.title === title);
  }
  return title.length === CONTROL_MAX_TITLE_LENGTH && matches.length > 1 ? undefined : matches[0];
}

/** Keep import fallback metadata current while the stable id still resolves. */
export function currentSoundBinding<T extends SoundBinding>(library: ControlLibrary, binding: T): T {
  const sound = resolveSound(library, binding);
  if (!sound) return binding;
  const board = library.boards.find((item) => item.sounds.includes(sound))!;
  return binding.soundId === sound.id && binding.boardId === board.id && binding.title === sound.title
    ? binding : { ...binding, soundId: sound.id, boardId: board.id, title: sound.title };
}
