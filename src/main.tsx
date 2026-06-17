import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Download,
  FolderOpen,
  GripVertical,
  Headphones,
  Image as ImageIcon,
  Keyboard,
  Link,
  Mic,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCcw,
  RotateCcw,
  Save,
  Scissors,
  Settings,
  Square,
  Trash2,
  Upload,
  Volume2,
  Wand2,
  X
} from "lucide-react";
import { AudioEngine } from "./lib/audioEngine";
import { findCableInputDeviceId, getDefaultDeviceLabel, isSelectableMediaDevice, makeMicrophoneConstraints, normalizeSelectableDeviceId } from "./lib/devices";
import { acceleratorLooksReserved, formatBytes, formatDuration, makeBoard, normalizeLibrary, now, soundFromImport } from "./lib/model";
import { claimCaptureSlot, eventToToken, formatAccelerator, MODIFIER_TOKENS, normalizeAccelerator, orderTokens } from "./lib/hotkeys";
import { makeWaveform } from "./lib/waveform";
import { installDevBridge } from "./lib/devBridge";
import type { CorsairState, HotkeyBinding, HotkeyResult, MediaImportResult, SoundBoard, SoundLibrary, SoundSlot, UpdateStatus } from "./types";
import "./styles.css";

installDevBridge();

type View = "board" | "devices" | "hotkeys" | "recorder";
type EngineStatus = "idle" | "playing" | "paused";

function App() {
  const [library, setLibrary] = useState<SoundLibrary | null>(null);
  const [view, setView] = useState<View>("board");
  const [selectedSoundId, setSelectedSoundId] = useState<string>("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [hotkeyResults, setHotkeyResults] = useState<HotkeyResult[]>([]);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("idle");
  const [playingIds, setPlayingIds] = useState<string[]>([]);
  const [editingClipId, setEditingClipId] = useState<string>("");
  const [urlImportOpen, setUrlImportOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [draggingSoundId, setDraggingSoundId] = useState<string>("");
  const [dragOverBoardId, setDragOverBoardId] = useState<string>("");
  const [message, setMessage] = useState("Ready");
  const gridRef = useRef<HTMLDivElement>(null);
  const padRectsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const flipAnimsRef = useRef<Map<string, Animation>>(new Map());
  // Tears down an in-flight pad drag (listeners, ghost, capture) if the
  // component unmounts mid-drag so global listeners never leak.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [corsairState, setCorsairState] = useState<CorsairState>("unavailable");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const engineRef = useRef<AudioEngine | null>(null);

  useEffect(() => {
    void window.sounddeck.getVersion().then(setAppVersion).catch(() => undefined);
  }, []);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  useEffect(() => {
    return window.sounddeck.onUpdateStatus((status) => {
      setUpdateStatus(status);
      // A hidden download toast should still resurface once the update is ready.
      if (status.state === "ready") setUpdateDismissed(false);
    });
  }, []);

  useEffect(() => {
    void window.sounddeck.getCorsairStatus().then(setCorsairState);
    return window.sounddeck.onCorsairStatus(setCorsairState);
  }, []);

  useEffect(() => {
    window.sounddeck.loadLibrary().then((loaded) => setLibrary(normalizeLibrary(loaded)));
  }, []);

  useEffect(() => {
    // Hold persistence while a pad drag is live: the order mutates many times
    // per drag, and saving each transient step risks an out-of-order write
    // landing last. The final drop/cancel state saves once when the drag ends.
    if (!library || draggingSoundId) return;
    void window.sounddeck.saveLibrary(library);
  }, [library, draggingSoundId]);

  // The virtual mic sink is always the VB-CABLE playback device; detected by label, never user-picked.
  const cableDeviceId = useMemo(() => findCableInputDeviceId(devices), [devices]);

  useEffect(() => {
    if (!library) return;
    if (!engineRef.current) engineRef.current = new AudioEngine(library.settings, (status, activeIds) => {
      setEngineStatus(status);
      setPlayingIds(activeIds);
    });
    void engineRef.current.configure(library.settings, cableDeviceId);
  }, [library?.settings, cableDeviceId]);

  const activeBoard = useMemo(() => {
    if (!library) return null;
    return library.boards.find((board) => board.id === library.activeBoardId) || library.boards[0];
  }, [library]);

  const previousBoardRef = useRef<{ id: string; soundIds: string[] } | null>(null);

  useEffect(() => {
    const previous = previousBoardRef.current;
    if (activeBoard) previousBoardRef.current = { id: activeBoard.id, soundIds: activeBoard.sounds.map((sound) => sound.id) };
    if (!previous || !activeBoard || previous.id === activeBoard.id) return;
    for (const soundId of previous.soundIds) {
      if (engineRef.current?.isPlaying(soundId)) engineRef.current.stop(soundId);
    }
  }, [activeBoard]);

  const selectedSound = useMemo(() => activeBoard?.sounds.find((sound) => sound.id === selectedSoundId) || null, [activeBoard, selectedSoundId]);
  const editingClipSound = useMemo(() => activeBoard?.sounds.find((sound) => sound.id === editingClipId) || null, [activeBoard, editingClipId]);

  // FLIP: smoothly slide pads to their new slots whenever the order changes.
  // Positions are read from offsetLeft/offsetTop (layout coords, immune to any
  // in-flight transform) so rapid reorders don't compound into jumpy deltas,
  // and each slide is a fresh Web-Animations tween that replaces the last.
  const padOrderKey = activeBoard ? `${activeBoard.id}:${activeBoard.sounds.map((sound) => sound.id).join(",")}` : "";
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const previous = padRectsRef.current;
    const anims = flipAnimsRef.current;
    const next = new Map<string, { x: number; y: number }>();
    const pads = grid.querySelectorAll<HTMLElement>(".pad");
    pads.forEach((el) => {
      const id = el.dataset.soundId;
      if (!id) return;
      const pos = { x: el.offsetLeft, y: el.offsetTop };
      next.set(id, pos);
      const old = previous.get(id);
      if (!old) return;
      const dx = old.x - pos.x;
      const dy = old.y - pos.y;
      if (!dx && !dy) return;
      anims.get(id)?.cancel();
      const anim = el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
        { duration: 260, easing: "cubic-bezier(0.25, 0.8, 0.25, 1)" }
      );
      anims.set(id, anim);
      anim.onfinish = () => {
        if (anims.get(id) === anim) anims.delete(id);
      };
    });
    padRectsRef.current = next;
  }, [padOrderKey]);

  const refreshDevices = useCallback(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => stream.getTracks().forEach((track) => track.stop())).catch(() => undefined);
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const handleDeviceChange = () => void refreshDevices();
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [refreshDevices]);

  const registerHotkeys = useCallback(async (current: SoundLibrary) => {
    const bindings: HotkeyBinding[] = [];
    if (current.settings.stopAllHotkey) bindings.push({ type: "stop-all", accelerator: normalizeAccelerator(current.settings.stopAllHotkey) });
    if (current.settings.cycleBoardsHotkey) bindings.push({ type: "cycle-board", accelerator: normalizeAccelerator(current.settings.cycleBoardsHotkey) });
    for (const board of current.boards) {
      if (board.switchHotkey) bindings.push({ type: "board", boardId: board.id, accelerator: normalizeAccelerator(board.switchHotkey) });
    }
    // Only the active board's sound hotkeys are live, so boards can reuse the same keys.
    const active = current.boards.find((board) => board.id === current.activeBoardId) || current.boards[0];
    for (const sound of active?.sounds || []) {
      if (sound.hotkey) bindings.push({ type: "sound", boardId: active.id, soundId: sound.id, accelerator: normalizeAccelerator(sound.hotkey) });
    }
    const results = await window.sounddeck.registerHotkeys(bindings);
    setHotkeyResults(results);
  }, []);

  const corsairConnected = corsairState === "connected";
  useEffect(() => {
    // Reordering doesn't change bindings; skip re-registration during a drag
    // and let it run once on the settled order when the drag ends.
    if (!library || draggingSoundId) return;
    void registerHotkeys(library);
  }, [library, draggingSoundId, registerHotkeys, corsairConnected]);

  const triggerSound = useCallback(async (sound: SoundSlot) => {
    try {
      if (sound.retriggerMode === "stop" && engineRef.current?.isPlaying(sound.id)) {
        engineRef.current.stop(sound.id);
        setMessage(`Stopped ${sound.title}`);
        return;
      }
      await engineRef.current?.play(sound);
      setMessage(`Triggered ${sound.title}`);
      if (!sound.duration || !sound.waveform) {
        const buffer = await engineRef.current?.preload(sound);
        if (buffer) updateSound(sound.id, { duration: buffer.duration, waveform: makeWaveform(buffer), updatedAt: now() });
      }
    } catch (error) {
      setMessage(`Could not play ${sound.title}`);
      console.error(error);
    }
  }, [activeBoard?.id]);

  useEffect(() => {
    return window.sounddeck.onHotkeyTrigger((binding) => {
      if (binding.type === "stop-all") {
        engineRef.current?.stopAll();
        setMessage("Stopped all sounds");
        return;
      }
      if (binding.type === "board") {
        const board = library?.boards.find((candidate) => candidate.id === binding.boardId);
        if (board) {
          updateLibrary((current) => ({ ...current, activeBoardId: board.id }));
          setMessage(`Switched to ${board.name}`);
        }
        return;
      }
      if (binding.type === "cycle-board") {
        if (!library || library.boards.length < 2) return;
        const index = library.boards.findIndex((board) => board.id === library.activeBoardId);
        const next = library.boards[(index + 1) % library.boards.length];
        updateLibrary((current) => ({ ...current, activeBoardId: next.id }));
        setMessage(`Switched to ${next.name}`);
        return;
      }
      const sound = library?.boards.flatMap((board) => board.sounds).find((candidate) => candidate.id === binding.soundId);
      if (sound) void triggerSound(sound);
    });
  }, [library, triggerSound]);

  function updateLibrary(updater: (current: SoundLibrary) => SoundLibrary) {
    setLibrary((current) => current ? updater(current) : current);
  }

  function updateBoard(boardId: string, patch: Partial<SoundBoard>) {
    updateLibrary((current) => ({
      ...current,
      boards: current.boards.map((board) => board.id === boardId ? { ...board, ...patch, updatedAt: now() } : board)
    }));
  }

  function updateSound(soundId: string, patch: Partial<SoundSlot>) {
    if (patch.volume !== undefined) engineRef.current?.setSoundVolume(soundId, patch.volume);
    updateLibrary((current) => ({
      ...current,
      boards: current.boards.map((board) => ({
        ...board,
        sounds: board.sounds.map((sound) => sound.id === soundId ? { ...sound, ...patch, updatedAt: now() } : sound)
      }))
    }));
  }

  function addImportedSounds(results: MediaImportResult[], emptyMessage: string) {
    if (!activeBoard) return;
    const successful = results.filter((result) => result.ok);
    const imported = successful.map((result, index) => soundFromImport(result, activeBoard.sounds.length + index, "both")).filter(Boolean) as SoundSlot[];
    updateLibrary((current) => ({
      ...current,
      boards: current.boards.map((board) => board.id === activeBoard.id ? { ...board, sounds: [...board.sounds, ...imported], updatedAt: now() } : board)
    }));
    setMessage(imported.length ? `Imported ${imported.length} sound${imported.length === 1 ? "" : "s"}` : emptyMessage);
    for (const sound of imported) {
      engineRef.current?.preload(sound).then((buffer) => updateSound(sound.id, { duration: buffer.duration, waveform: makeWaveform(buffer) })).catch(() => undefined);
    }
  }

  async function importFiles(files: File[]) {
    const paths = files.map((file) => window.sounddeck.getPathForFile(file)).filter(Boolean);
    if (!paths.length) return;
    addImportedSounds(await window.sounddeck.importMedia(paths), "No supported audio files found");
  }

  async function importUrls(urls: string[]) {
    setMessage(`Importing ${urls.length} URL${urls.length === 1 ? "" : "s"}...`);
    const results = await window.sounddeck.downloadMedia(urls);
    addImportedSounds(results, "No downloadable audio found");
    return results;
  }

  function selectBoard(boardId: string) {
    updateLibrary((current) => ({ ...current, activeBoardId: boardId }));
    setView("board");
  }

  function addBoard() {
    updateLibrary((current) => {
      const board = makeBoard(current.boards.length + 1);
      return { ...current, activeBoardId: board.id, boards: [...current.boards, board] };
    });
    setView("board");
  }

  function deleteMediaFiles(removedSounds: SoundSlot[], remainingBoards: SoundBoard[]) {
    const stillReferenced = new Set(remainingBoards.flatMap((board) => board.sounds.map((sound) => sound.mediaPath)));
    const mediaPaths = new Set(removedSounds.map((sound) => sound.mediaPath).filter((mediaPath) => mediaPath && !stillReferenced.has(mediaPath)));
    for (const mediaPath of mediaPaths) {
      void window.sounddeck.deleteMedia(mediaPath).catch(() => undefined);
    }
  }

  function deleteSound(soundId: string) {
    engineRef.current?.stop(soundId);
    if (library) {
      const board = library.boards.find((candidate) => candidate.id === library.activeBoardId);
      const removed = board?.sounds.filter((sound) => sound.id === soundId) || [];
      const remaining = library.boards.map((candidate) => ({ ...candidate, sounds: candidate.sounds.filter((sound) => sound.id !== soundId) }));
      deleteMediaFiles(removed, remaining);
    }
    updateLibrary((current) => ({
      ...current,
      boards: current.boards.map((board) => board.id === current.activeBoardId ? { ...board, sounds: board.sounds.filter((sound) => sound.id !== soundId), updatedAt: now() } : board)
    }));
    if (selectedSoundId === soundId) setSelectedSoundId("");
    if (editingClipId === soundId) setEditingClipId("");
  }

  function moveSound(soundId: string, targetBoardId: string) {
    engineRef.current?.stop(soundId);
    updateLibrary((current) => {
      const sourceBoard = current.boards.find((board) => board.sounds.some((sound) => sound.id === soundId));
      const targetBoard = current.boards.find((board) => board.id === targetBoardId);
      if (!sourceBoard || !targetBoard || sourceBoard.id === targetBoard.id) return current;
      const sound = sourceBoard.sounds.find((candidate) => candidate.id === soundId)!;
      return {
        ...current,
        boards: current.boards.map((board) => {
          if (board.id === sourceBoard.id) return { ...board, sounds: board.sounds.filter((candidate) => candidate.id !== soundId), updatedAt: now() };
          if (board.id === targetBoard.id) return { ...board, sounds: [...board.sounds, { ...sound, updatedAt: now() }], updatedAt: now() };
          return board;
        })
      };
    });
    const movedSound = library?.boards.flatMap((board) => board.sounds).find((sound) => sound.id === soundId);
    const targetBoard = library?.boards.find((board) => board.id === targetBoardId);
    if (movedSound && targetBoard) setMessage(`Moved ${movedSound.title} to ${targetBoard.name}`);
    if (selectedSoundId === soundId) setSelectedSoundId("");
    if (editingClipId === soundId) setEditingClipId("");
  }

  // Live reorder while dragging: move the grabbed sound to a target slot
  // (index among the other pads) so the grid reflows under the cursor. Acts on
  // the board the drag started from (boardId), not whatever is active now, and
  // returns the unchanged library when the slot is the same so a stationary
  // drag doesn't spam saves / hotkey re-registration.
  function movePadToIndex(boardId: string, sourceId: string, index: number) {
    updateLibrary((current) => {
      const board = current.boards.find((candidate) => candidate.id === boardId);
      if (!board) return current;
      const from = board.sounds.findIndex((sound) => sound.id === sourceId);
      if (from < 0) return current;
      const sounds = [...board.sounds];
      const [moved] = sounds.splice(from, 1);
      const dest = Math.max(0, Math.min(index, sounds.length));
      if (dest === from) return current;
      sounds.splice(dest, 0, moved);
      return {
        ...current,
        boards: current.boards.map((candidate) => (candidate.id === boardId ? { ...candidate, sounds, updatedAt: now() } : candidate))
      };
    });
  }

  // Restore a specific order on a board (used when a drag is cancelled).
  function restorePadOrder(boardId: string, orderedIds: string[]) {
    updateLibrary((current) => {
      const board = current.boards.find((candidate) => candidate.id === boardId);
      if (!board) return current;
      const byId = new Map(board.sounds.map((sound) => [sound.id, sound]));
      const sounds = orderedIds.map((id) => byId.get(id)).filter(Boolean) as SoundSlot[];
      if (sounds.length !== board.sounds.length) return current;
      return {
        ...current,
        boards: current.boards.map((candidate) => (candidate.id === boardId ? { ...candidate, sounds } : candidate))
      };
    });
  }

  // Pointer-driven drag (not native HTML5 DnD, which fires too coarsely to
  // follow the cursor smoothly). A clone floats under the pointer at 60fps,
  // the grid reorders live, and dropping on a sidebar board moves the sound.
  function startPadDrag(soundId: string, event: React.PointerEvent) {
    if (event.button !== 0) return;
    const grid = gridRef.current;
    const pad = grid?.querySelector(`.pad[data-sound-id="${CSS.escape(soundId)}"]`) as HTMLElement | null;
    if (!pad || !library) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    handle.setPointerCapture?.(pointerId);
    const startBoardId = library.activeBoardId;
    const originalOrder = activeBoard ? activeBoard.sounds.map((sound) => sound.id) : [];
    const rect = pad.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;

    // Cache sidebar board rects instead of hit-testing via elementFromPoint
    // each frame (which would force a synchronous layout after the ghost
    // transform write). The board list is a 300px scroller, so capture its
    // viewport, drop buttons scrolled out of view, and re-read on scroll so a
    // board revealed mid-drag becomes targetable and stale rects never match.
    const boardsEl = document.querySelector<HTMLElement>(".boards");
    let boardsViewport = boardsEl?.getBoundingClientRect() ?? null;
    let boardRects: { id: string; rect: DOMRect }[] = [];
    const refreshBoardRects = () => {
      boardsViewport = boardsEl?.getBoundingClientRect() ?? null;
      boardRects = Array.from(document.querySelectorAll<HTMLElement>(".boardButton[data-board-id]"))
        .map((button) => ({ id: button.dataset.boardId as string, rect: button.getBoundingClientRect() }))
        .filter(({ rect }) => !boardsViewport || (rect.bottom > boardsViewport.top && rect.top < boardsViewport.bottom));
    };
    refreshBoardRects();
    boardsEl?.addEventListener("scroll", refreshBoardRects, { passive: true });

    const ghost = pad.cloneNode(true) as HTMLElement;
    ghost.className = "pad padDragImage";
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
    document.body.appendChild(ghost);
    document.body.classList.add("draggingPad");
    setDraggingSoundId(soundId);

    let lastX = event.clientX;
    let lastY = event.clientY;
    let frame = 0;
    let lastReorder = 0;

    const boardUnderPointer = () => {
      // Only inside the visible scroller — keeps clipped/off-screen rows out.
      if (boardsViewport && (lastY < boardsViewport.top || lastY > boardsViewport.bottom)) return "";
      const hit = boardRects.find(({ rect: box }) => lastX >= box.left && lastX <= box.right && lastY >= box.top && lastY <= box.bottom);
      return hit && hit.id !== startBoardId ? hit.id : "";
    };

    // Move the dragged pad to the grid cell its centre currently overlaps.
    const placeAtPointer = () => {
      const grid = gridRef.current;
      if (!grid) return;
      // Treat the whole grid (including the dragged pad's own cell) as a
      // uniform row x column matrix and resolve the card to a target cell,
      // then move the pad there. Including the dragged cell keeps the grid
      // hole-free, so "end of a row" is a real cell and the corners are stable.
      // Layout coords (offset*) are used so in-flight slide animations don't
      // skew the boxes.
      const pads = Array.from(grid.querySelectorAll<HTMLElement>(".pad[data-sound-id]"));
      if (!pads.length) return;
      const origin = (pads[0].offsetParent ?? document.body).getBoundingClientRect();
      const boxes = pads.map((padEl) => ({
        top: origin.top + padEl.offsetTop,
        bottom: origin.top + padEl.offsetTop + padEl.offsetHeight,
        right: origin.left + padEl.offsetLeft + padEl.offsetWidth
      }));
      const total = boxes.length;
      // Resolve placement from the dragged card's centre (not the grab point,
      // which sits in a corner) — it tracks where the card visually sits.
      const pointX = lastX - offsetX + rect.width / 2;
      const pointY = lastY - offsetY + rect.height / 2;
      // Column count = pads sharing the first row's top.
      let cols = 0;
      while (cols < total && boxes[cols].top <= boxes[0].top + 4) cols += 1;
      cols = Math.max(1, cols);
      const colRights = boxes.slice(0, cols).map((box) => box.right);
      // Distinct rows, top to bottom.
      const rows: { top: number; bottom: number }[] = [];
      for (const box of boxes) {
        const last = rows[rows.length - 1];
        if (!last || box.top > last.top + 4) rows.push({ top: box.top, bottom: box.bottom });
        else last.bottom = Math.max(last.bottom, box.bottom);
      }
      let target: number;
      if (pointY > rows[rows.length - 1].bottom) {
        target = total - 1; // below everything → end of the list
      } else {
        // Both axes use the cell's far edge (bottom / right) so the card's
        // centre maps into whichever cell it visually overlaps.
        let rowIdx = rows.findIndex((row) => pointY <= row.bottom);
        if (rowIdx < 0) rowIdx = 0; // above the grid → first row
        let col = colRights.findIndex((right) => pointX <= right);
        if (col < 0) col = cols - 1; // right of the last column
        target = Math.min(rowIdx * cols + col, total - 1);
      }
      movePadToIndex(startBoardId, soundId, target);
    };

    const apply = () => {
      frame = 0;
      ghost.style.transform = `translate(${lastX - offsetX}px, ${lastY - offsetY}px)`;
      const boardId = boardUnderPointer();
      if (boardId) {
        setDragOverBoardId(boardId);
        return;
      }
      setDragOverBoardId("");
      // Throttle reorders so a fast sweep resolves in calm steps.
      const stamp = performance.now();
      if (stamp - lastReorder < 70) return;
      lastReorder = stamp;
      placeAtPointer();
    };

    const onMove = (moveEvent: PointerEvent) => {
      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const teardown = () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      boardsEl?.removeEventListener("scroll", refreshBoardRects);
      try {
        handle.releasePointerCapture?.(pointerId);
      } catch {
        // pointer already released
      }
      ghost.remove();
      document.body.classList.remove("draggingPad");
      dragCleanupRef.current = null;
    };

    const finish = (commit: boolean, dropBoardId?: string) => {
      teardown();
      setDraggingSoundId("");
      setDragOverBoardId("");
      if (!commit) restorePadOrder(startBoardId, originalOrder);
      else if (dropBoardId) moveSound(soundId, dropBoardId);
    };

    const onUp = (upEvent: PointerEvent) => {
      lastX = upEvent.clientX;
      lastY = upEvent.clientY;
      const boardId = boardUnderPointer();
      if (boardId) {
        finish(true, boardId);
        return;
      }
      // Flush a final placement: a quick release can land before the next
      // throttled/animation-frame reorder, leaving the pad a slot behind.
      placeAtPointer();
      finish(true);
    };
    const onCancel = () => finish(false);
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") finish(false);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    dragCleanupRef.current = teardown;
  }

  function deleteBoard(boardId: string) {
    if (library && library.boards.length > 1) {
      const boardToDelete = library.boards.find((board) => board.id === boardId);
      if (boardToDelete) deleteMediaFiles(boardToDelete.sounds, library.boards.filter((board) => board.id !== boardId));
    }
    updateLibrary((current) => {
      if (current.boards.length <= 1) {
        setMessage("Keep at least one board");
        return current;
      }

      const boardToDelete = current.boards.find((board) => board.id === boardId);
      boardToDelete?.sounds.forEach((sound) => engineRef.current?.stop(sound.id));
      const remaining = current.boards.filter((board) => board.id !== boardId);
      const deletedIndex = current.boards.findIndex((board) => board.id === boardId);
      const fallback = remaining[Math.max(0, Math.min(deletedIndex, remaining.length - 1))];
      setMessage(`Deleted ${boardToDelete?.name || "board"}`);
      return {
        ...current,
        activeBoardId: current.activeBoardId === boardId ? fallback.id : current.activeBoardId,
        boards: remaining
      };
    });
  }

  async function restoreBoard() {
    const result = await window.sounddeck.importBoard();
    if (!result.ok || !result.board) {
      if (!result.canceled) setMessage("Could not read that board file");
      return;
    }
    const imported = result.board;
    if (library) {
      const boardId = library.activeBoardId;
      const current = library.boards.find((board) => board.id === boardId);
      current?.sounds.forEach((sound) => engineRef.current?.stop(sound.id));
      if (current) deleteMediaFiles(current.sounds, library.boards.map((board) => board.id === boardId ? { ...imported, id: boardId } : board));
    }
    updateLibrary((current) => ({
      ...current,
      boards: current.boards.map((board) => board.id === current.activeBoardId ? { ...imported, id: board.id, createdAt: board.createdAt, updatedAt: now() } : board)
    }));
    setSelectedSoundId("");
    setEditingClipId("");
    setMessage(`Imported "${imported.name}" onto this board`);
  }

  function changeSettings(patch: Partial<SoundLibrary["settings"]>) {
    const normalizedPatch = { ...patch };
    if ("microphoneDeviceId" in normalizedPatch) normalizedPatch.microphoneDeviceId = normalizeSelectableDeviceId(normalizedPatch.microphoneDeviceId);
    if ("monitorDeviceId" in normalizedPatch) normalizedPatch.monitorDeviceId = normalizeSelectableDeviceId(normalizedPatch.monitorDeviceId);
    updateLibrary((current) => ({ ...current, settings: { ...current.settings, ...normalizedPatch } }));
  }

  if (!library || !activeBoard) return <div className="boot">Loading SoundDeck Studio...</div>;

  const outputDevices = devices.filter((device) => device.kind === "audiooutput" && isSelectableMediaDevice(device));
  const inputDevices = devices.filter((device) => device.kind === "audioinput" && isSelectableMediaDevice(device));
  const defaultInputLabel = getDefaultDeviceLabel(devices, "audioinput");
  const defaultOutputLabel = getDefaultDeviceLabel(devices, "audiooutput");

  return (
    <main
      className="app"
      onDragOver={(event) => {
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        setDropActive(false);
        void importFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <aside className="sidebar">
        <div className="brand" data-status={engineStatus}>
          <Radio size={24} />
          <div>
            <strong>SoundDeck</strong>
            <span>{engineStatus}</span>
          </div>
        </div>
        <div className="sideLabel">Boards</div>
        <nav className="boards">
          {library.boards.map((board) => (
            <div
              key={board.id}
              data-board-id={board.id}
              className={`${board.id === activeBoard.id ? "boardButton active" : "boardButton"}${dragOverBoardId === board.id && board.id !== activeBoard.id ? " dropTarget" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => selectBoard(board.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") selectBoard(board.id);
              }}
            >
              <span className="dot" style={{ background: board.color }} />
              <span className="boardName">{board.name}</span>
              {board.switchHotkey && <kbd className="boardHotkey" title={`Switch with ${board.switchHotkey}`}>{formatAccelerator(board.switchHotkey)}</kbd>}
              <button
                className="deleteBoardButton"
                title={library.boards.length <= 1 ? "Keep at least one board" : `Delete ${board.name}`}
                aria-label={library.boards.length <= 1 ? "Keep at least one board" : `Delete ${board.name}`}
                disabled={library.boards.length <= 1}
                onClick={(event) => {
                  event.stopPropagation();
                  deleteBoard(board.id);
                }}
              >
                <X size={15} />
              </button>
            </div>
          ))}
        </nav>
        <button className="wideButton" onClick={addBoard}><Plus size={16} /> New board</button>
        <div className="sideNav">
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}><Wand2 size={18} /> Board</button>
          <button className={view === "recorder" ? "active" : ""} onClick={() => setView("recorder")}><Mic size={18} /> Recorder</button>
          <div className="sideNavDivider" />
          <div className="sideNavLabel">Global settings</div>
          <button className={view === "devices" ? "active" : ""} onClick={() => setView("devices")}><Settings size={18} /> Devices</button>
          <button className={view === "hotkeys" ? "active" : ""} onClick={() => setView("hotkeys")}><Keyboard size={18} /> Hotkeys</button>
        </div>
        {appVersion && <div className="appVersion">v{appVersion}</div>}
      </aside>

      <section className="workspace">
        <header className="topbar">
          {view === "devices" || view === "hotkeys" ? (
            <div>
              <div className="boardTitle"><h1>{view === "devices" ? "Devices" : "Hotkeys"}</h1></div>
              <p>Global settings · applies to every board · {message}</p>
            </div>
          ) : (
            <>
              <div>
                <BoardTitle key={activeBoard.id} name={activeBoard.name} onRename={(name) => updateBoard(activeBoard.id, { name })} />
                <p>{activeBoard.sounds.length} sounds · {message}</p>
              </div>
              {view === "board" && (
                <div className="boardHotkeyControl" title="Global hotkey that switches to this board">
                  <Keyboard size={15} />
                  <span>Switch key</span>
                  <HotkeyCapture value={activeBoard.switchHotkey || ""} onChange={(switchHotkey) => updateBoard(activeBoard.id, { switchHotkey })} />
                </div>
              )}
            </>
          )}
          {view === "board" && (
            <div className="topActions">
              <button onClick={() => void window.sounddeck.revealLibrary()}><FolderOpen size={16} /> Library</button>
              <button title="Import audio from a web URL" onClick={() => setUrlImportOpen(true)}><Link size={16} /> Import URL</button>
              <button title={`Save "${activeBoard.name}" with its sounds to a file`} onClick={() => void window.sounddeck.exportBoard(activeBoard)}><Upload size={16} /> Export</button>
              <button title="Replace this board with an exported board file" onClick={() => void restoreBoard()}><Download size={16} /> Import</button>
            </div>
          )}
        </header>

        {view === "board" && (
          <div className="boardView">
            <div className={dropActive ? "dropZone active" : "dropZone"}>
              <Upload size={19} />
              <span>Drop audio here</span>
              <label>
                Browse
                <input type="file" multiple accept=".wav,.mp3,.ogg,.flac,.m4a,.aac,.webm,audio/*" onChange={(event) => void importFiles(Array.from(event.currentTarget.files || []))} />
              </label>
            </div>
            <div className="soundGrid" ref={gridRef}>
              {activeBoard.sounds.map((sound) => (
                <SoundPad
                  key={sound.id}
                  sound={sound}
                  engine={engineRef.current}
                  selected={selectedSoundId === sound.id}
                  playing={playingIds.includes(sound.id)}
                  hotkeyProblem={hotkeyResults.some((result) => result.soundId === sound.id && !result.ok)}
                  onPlay={() => void triggerSound(sound)}
                  onStop={() => engineRef.current?.stop(sound.id)}
                  onEditClip={() => setEditingClipId(sound.id)}
                  onSelect={() => setSelectedSoundId(sound.id)}
                  onDelete={() => deleteSound(sound.id)}
                  onChange={(patch) => updateSound(sound.id, patch)}
                  dragging={draggingSoundId === sound.id}
                  onGrabStart={(event) => startPadDrag(sound.id, event)}
                />
              ))}
              {!activeBoard.sounds.length && <div className="empty">Drop sounds to build this board.</div>}
            </div>
            {selectedSound && <SoundEditor sound={selectedSound} onChange={(patch) => updateSound(selectedSound.id, patch)} onClose={() => setSelectedSoundId("")} />}
            {editingClipSound && (
              <ClipEditor
                sound={editingClipSound}
                engine={engineRef.current}
                onChange={(patch) => updateSound(editingClipSound.id, patch)}
                onClose={() => setEditingClipId("")}
              />
            )}
          </div>
        )}

        {view === "devices" && (
          <DevicePanel
            library={library}
            inputDevices={inputDevices}
            outputDevices={outputDevices}
            defaultInputLabel={defaultInputLabel}
            defaultOutputLabel={defaultOutputLabel}
            onRefresh={refreshDevices}
            onChange={changeSettings}
          />
        )}

        {view === "hotkeys" && (
          <HotkeyPanel
            library={library}
            results={hotkeyResults}
            corsairState={corsairState}
            onChangeSettings={changeSettings}
            onChangeSound={updateSound}
            onChangeBoard={updateBoard}
          />
        )}

        {view === "recorder" && (
          <RecorderPanel
            inputDevices={inputDevices}
            micDeviceId={library.settings.microphoneDeviceId}
            onImport={async (result) => {
              const sound = soundFromImport(result, activeBoard.sounds.length, "both");
              if (!sound) return;
              updateLibrary((current) => ({
                ...current,
                boards: current.boards.map((board) => board.id === activeBoard.id ? { ...board, sounds: [...board.sounds, sound], updatedAt: now() } : board)
              }));
              setView("board");
            }}
          />
        )}
      </section>

      {updateStatus && !updateDismissed && (
        <UpdateToast
          status={updateStatus}
          onInstall={() => void window.sounddeck.installUpdate()}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}

      {urlImportOpen && (
        <UrlImportModal
          onClose={() => setUrlImportOpen(false)}
          onImport={importUrls}
        />
      )}
    </main>
  );
}

function UrlImportModal({ onClose, onImport }: { onClose: () => void; onImport: (urls: string[]) => Promise<MediaImportResult[]> }) {
  const [urls, setUrls] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [results, setResults] = useState<MediaImportResult[]>([]);
  const parsedUrls = urls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  const failures = results.filter((result) => !result.ok);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!parsedUrls.length || busy) return;
    setBusy(true);
    setStatus("Importing audio...");
    setResults([]);
    try {
      const imported = await onImport(parsedUrls);
      setResults(imported);
      const importedCount = imported.filter((result) => result.ok).length;
      const failedCount = imported.filter((result) => !result.ok).length;
      setStatus(importedCount
        ? `Imported ${importedCount} sound${importedCount === 1 ? "" : "s"}${failedCount ? `, ${failedCount} failed` : ""}.`
        : "No sounds were imported.");
      if (importedCount && !failedCount) setUrls("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalOverlay" role="presentation">
      <form className="urlImportDialog" onSubmit={submit}>
        <header>
          <strong>Import URL</strong>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close URL import"><X size={16} /></button>
        </header>
        <label>
          URLs
          <textarea
            value={urls}
            disabled={busy}
            placeholder="https://..."
            onChange={(event) => setUrls(event.target.value)}
            autoFocus
          />
        </label>
        <div className="urlImportFooter">
          <span>{status || "One URL per line."}</span>
          <button type="submit" disabled={!parsedUrls.length || busy}><Download size={16} /> {busy ? "Importing" : "Import"}</button>
        </div>
        {failures.length > 0 && (
          <div className="urlImportErrors">
            {failures.map((result) => (
              <p key={`${result.sourceUrl || result.sourcePath}-${result.reason}`}>{result.sourceUrl || result.sourcePath}: {result.reason}</p>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}

function UpdateToast({ status, onInstall, onDismiss }: { status: UpdateStatus; onInstall: () => void; onDismiss: () => void }) {
  const percent = Math.max(0, Math.min(100, Math.round(status.state === "downloading" ? status.percent ?? 0 : 100)));
  return (
    <aside className="updateToast" role="status" data-state={status.state}>
      <div className="updateToastIcon">
        {status.state === "downloading" ? <Download size={17} /> : <RotateCcw size={17} />}
      </div>
      <div className="updateToastBody">
        {status.state === "downloading" ? (
          <>
            <strong>Downloading update{status.version ? ` ${status.version}` : ""}</strong>
            <div className="updateProgress"><span style={{ width: `${percent}%` }} /></div>
            <small>{percent}%</small>
          </>
        ) : (
          <>
            <strong>Update {status.version} ready</strong>
            <small>Restarts and installs automatically.</small>
            <div className="updateToastActions">
              <button className="updatePrimary" onClick={onInstall}>Restart to Update</button>
              <button className="updateLater" onClick={onDismiss}>Later</button>
            </div>
          </>
        )}
      </div>
      {status.state === "downloading" && (
        <button className="updateToastClose" title="Hide" aria-label="Hide update notification" onClick={onDismiss}><X size={14} /></button>
      )}
    </aside>
  );
}

function BoardTitle({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="boardTitleInput"
        style={{ width: `${Math.min(Math.max(draft.length + 3, 12), 42)}ch` }}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            setDraft(name);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <div className="boardTitle">
      <h1>{name}</h1>
      <button
        className="boardTitleEdit"
        title="Rename board"
        aria-label="Rename board"
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
      >
        <Pencil size={15} />
      </button>
    </div>
  );
}

function SoundPad(props: {
  sound: SoundSlot;
  engine: AudioEngine | null;
  selected: boolean;
  playing: boolean;
  hotkeyProblem: boolean;
  onPlay: () => void;
  onStop: () => void;
  onEditClip: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onChange: (patch: Partial<SoundSlot>) => void;
  dragging: boolean;
  onGrabStart: (event: React.PointerEvent) => void;
}) {
  const { sound } = props;
  const clipDuration = Number.isFinite(sound.duration)
    ? Math.max(0, Math.min(sound.trimEndSec ?? sound.duration!, sound.duration!) - Math.max(0, sound.trimStartSec ?? 0))
    : sound.duration;
  return (
    <article
      className={`pad${props.selected ? " selected" : ""}${props.playing ? " playing" : ""}${props.dragging ? " dragging" : ""}`}
      data-sound-id={sound.id}
      style={{ "--pad": sound.color } as React.CSSProperties}
    >
      <div
        className="padDrag"
        title="Drag to reorder, or onto a board to move it"
        aria-label="Drag to reorder, or onto a board to move it"
        onPointerDown={props.onGrabStart}
      >
        <GripVertical size={15} />
      </div>
      <button className="padMain" onClick={props.onSelect}>
        <PadIcon sound={sound} />
        <strong>{sound.title}</strong>
        <span>{formatDuration(clipDuration)} · {formatBytes(sound.size)}</span>
        <div className="waveWrap">
          <Wave peaks={sound.waveform} color={sound.color} />
          <Playhead engine={props.engine} soundId={sound.id} duration={sound.duration} active={props.playing} />
        </div>
      </button>
      <div className="padControls">
        <button title={props.playing ? "Stop" : "Play"} onClick={props.playing ? props.onStop : props.onPlay}>
          {props.playing ? <Square size={15} /> : <Play size={15} />}
        </button>
        <button title="Edit clip" onClick={props.onEditClip}><Scissors size={15} /></button>
        <button title="Loop" className={sound.loop ? "toggled" : ""} onClick={() => props.onChange({ loop: !sound.loop })}>∞</button>
        <button title="Settings" onClick={props.onSelect}><Settings size={15} /></button>
        <button title="Delete" onClick={props.onDelete}><Trash2 size={15} /></button>
      </div>
      <div className="padMeta">
        <PadHotkey value={sound.hotkey} problem={props.hotkeyProblem} onChange={(hotkey) => props.onChange({ hotkey })} />
        <span className="padVolume"><Volume2 size={11} /> {Math.round(sound.volume * 100)}%</span>
        <span className="padOutput">{sound.outputTarget}</span>
      </div>
    </article>
  );
}

// Captures a key combo: keys accumulate while held and the combo commits once
// everything is released, so any combination of keys can be bound. Only one
// capture can be active app-wide (starting a new one cancels the previous),
// and the global hotkey engine is suspended while capturing.
function useHotkeyCapture(onChange: (value: string) => void) {
  const [capturing, setCapturing] = useState(false);
  const [preview, setPreview] = useState("");
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!capturing) return;
    const stop = () => setCapturing(false);
    const release = claimCaptureSlot(stop);
    void window.sounddeck.setHotkeyCapture(true);
    const held = new Set<string>();
    const combo: string[] = [];
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        stop();
        return;
      }
      const token = eventToToken(event);
      if (!token) return;
      held.add(event.code);
      if (!combo.includes(token)) combo.push(token);
      setPreview(orderTokens(combo).join("+"));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      held.delete(event.code);
      if (held.size || !combo.length) return;
      // A lone modifier is almost always a mistake; reset and keep listening.
      if (combo.length === 1 && MODIFIER_TOKENS.includes(combo[0])) {
        combo.length = 0;
        setPreview("");
        return;
      }
      onChangeRef.current(orderTokens(combo).join("+"));
      stop();
    };
    const onPointerDown = () => stop();
    const onBlur = () => stop();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onBlur);
    const offCorsair = window.sounddeck.onCorsairKey((key) => {
      onChangeRef.current(key);
      stop();
    });
    return () => {
      // If a newer capture claimed the slot it has already re-enabled
      // suspension; sending false here would resume global hotkeys under it.
      if (release()) void window.sounddeck.setHotkeyCapture(false);
      setPreview("");
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onBlur);
      offCorsair();
    };
  }, [capturing]);

  return { capturing, preview, start: () => setCapturing(true) };
}

function PadHotkey({ value, problem, onChange }: { value: string; problem: boolean; onChange: (value: string) => void }) {
  const { capturing, preview, start } = useHotkeyCapture(onChange);

  return (
    <button
      className={`padHotkey${capturing ? " capturing" : ""}${problem ? " problem" : ""}`}
      title={capturing ? "Press a key combo, Escape to cancel" : "Click to set hotkey"}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={start}
    >
      {capturing ? (preview ? formatAccelerator(preview) : "Press keys...") : value ? formatAccelerator(value) : "No hotkey"}
    </button>
  );
}

function PadIcon({ sound }: { sound: SoundSlot }) {
  return (
    <span className="padIcon" style={{ background: sound.color }}>
      {sound.image ? <img src={sound.image} alt="" draggable={false} /> : sound.title.slice(0, 1).toUpperCase()}
    </span>
  );
}

const PAD_ICON_IMAGE_SIZE = 96;

async function fileToIconDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.max(PAD_ICON_IMAGE_SIZE / bitmap.width, PAD_ICON_IMAGE_SIZE / bitmap.height);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = PAD_ICON_IMAGE_SIZE;
  canvas.height = PAD_ICON_IMAGE_SIZE;
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, (PAD_ICON_IMAGE_SIZE - width) / 2, (PAD_ICON_IMAGE_SIZE - height) / 2, width, height);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

function Wave({ peaks, color }: { peaks?: number[]; color: string }) {
  return <div className="wave">{(peaks?.length ? peaks : Array.from({ length: 36 }, (_, index) => (index % 5) / 5 + 0.15)).map((peak, index) => <i key={index} style={{ height: `${Math.max(10, peak * 100)}%`, background: color }} />)}</div>;
}

function Playhead({ engine, soundId, duration, active }: { engine: AudioEngine | null; soundId: string; duration?: number; active: boolean }) {
  const lineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || !engine || !duration) return;
    let frame = 0;
    const tick = () => {
      const position = engine.getPosition(soundId);
      if (lineRef.current) {
        if (position === null) {
          lineRef.current.style.opacity = "0";
        } else {
          lineRef.current.style.opacity = "1";
          lineRef.current.style.left = `${Math.min(100, (position / duration) * 100)}%`;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [engine, soundId, duration, active]);

  if (!active || !duration) return null;
  return <div className="playhead" ref={lineRef} />;
}

function VolumeField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="volumeField">
      {label}
      <div className="volumeRow">
        <input type="range" min="0" max="1" step="0.01" value={value} onChange={(event) => onChange(Number(event.target.value))} />
        <input
          type="number"
          min="0"
          max="100"
          value={Math.round(value * 100)}
          onChange={(event) => {
            const percent = Number(event.target.value);
            if (Number.isFinite(percent)) onChange(Math.min(100, Math.max(0, percent)) / 100);
          }}
        />
        <span className="volumeUnit">%</span>
      </div>
    </label>
  );
}

function SoundEditor({ sound, onChange, onClose }: { sound: SoundSlot; onChange: (patch: Partial<SoundSlot>) => void; onClose: () => void }) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  async function pickImage(file: File | undefined) {
    if (!file) return;
    try {
      onChange({ image: await fileToIconDataUrl(file) });
    } catch (error) {
      console.error("Could not load icon image", error);
    }
  }

  return (
    <aside className="inspector" ref={panelRef}>
      <header><strong>Edit sound</strong><button onClick={onClose}><X size={16} /></button></header>
      <label>Title<input value={sound.title} onChange={(event) => onChange({ title: event.target.value })} /></label>
      <label>Color<input type="color" value={sound.color} onChange={(event) => onChange({ color: event.target.value })} /></label>
      <div className="iconField">
        <span>Icon</span>
        <div className="iconImageRow">
          <PadIcon sound={sound} />
          <button onClick={() => imageInputRef.current?.click()}><ImageIcon size={15} /> {sound.image ? "Replace image" : "Use image"}</button>
          {sound.image && <button onClick={() => onChange({ image: undefined })}><X size={15} /> Remove</button>}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              void pickImage(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
        </div>
      </div>
      <VolumeField label="Volume" value={sound.volume} onChange={(volume) => onChange({ volume })} />
      <label>Fade in ms<input type="number" min="0" value={sound.fadeInMs} onChange={(event) => onChange({ fadeInMs: Number(event.target.value) })} /></label>
      <label>Fade out ms<input type="number" min="0" value={sound.fadeOutMs} onChange={(event) => onChange({ fadeOutMs: Number(event.target.value) })} /></label>
      <label>Output<select value={sound.outputTarget} onChange={(event) => onChange({ outputTarget: event.target.value as SoundSlot["outputTarget"] })}><option value="both">Headphones + virtual mic</option><option value="monitor">Headphones</option><option value="virtual">Virtual mic</option></select></label>
      <label>Retrigger<select value={sound.retriggerMode} onChange={(event) => onChange({ retriggerMode: event.target.value as SoundSlot["retriggerMode"] })}><option value="restart">Stop then restart</option><option value="overlap">Overlap</option><option value="stop">Play / stop toggle</option></select></label>
      <label className="check"><input type="checkbox" checked={sound.loop} onChange={(event) => onChange({ loop: event.target.checked })} /> Loop</label>
      <label className="check"><input type="checkbox" checked={sound.soloPlay} onChange={(event) => onChange({ soloPlay: event.target.checked })} /> Stop other sounds when played</label>
      <HotkeyCapture value={sound.hotkey} onChange={(hotkey) => onChange({ hotkey })} />
    </aside>
  );
}

function TrimInput({ label, value, min, max, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(value.toFixed(2));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(value.toFixed(2));
  }, [value, focused]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "") {
      setText(value.toFixed(2));
      return;
    }
    const v = Number(trimmed);
    if (Number.isFinite(v)) onChange(Math.min(Math.max(min, v), max));
    else setText(value.toFixed(2));
  };

  return (
    <label>{label}
      <input
        type="number"
        min={min}
        max={max}
        step={0.01}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
      />
      <span className="clipTimeUnit">s</span>
    </label>
  );
}

function SpeedInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(value.toFixed(2));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(value.toFixed(2));
  }, [value, focused]);

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "") {
      setText(value.toFixed(2));
      return;
    }
    const v = Number(trimmed);
    if (Number.isFinite(v) && v > 0) onChange(Math.min(Math.max(min, v), max));
    else setText(value.toFixed(2));
  };

  return (
    <label>Speed
      <input
        type="number"
        min={min}
        max={max}
        step={0.25}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
      />
      <span className="clipTimeUnit">×</span>
    </label>
  );
}

function ClipEditor({ sound, engine, onChange, onClose }: {
  sound: SoundSlot;
  engine: AudioEngine | null;
  onChange: (patch: Partial<SoundSlot>) => void;
  onClose: () => void;
}) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [previewState, setPreviewState] = useState<"stopped" | "playing" | "paused">("stopped");
  const [playheadSec, setPlayheadSec] = useState(0);
  const [showDone, setShowDone] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [cropError, setCropError] = useState("");
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setBuffer(null);
    setLoadError(false);
    engine?.preload(sound).then((decoded) => {
      if (alive) setBuffer(decoded);
    }).catch(() => {
      if (alive) setLoadError(true);
    });
    return () => {
      alive = false;
    };
  }, [engine, sound.id, sound.mediaPath]);

  // Stop preview playback when leaving the editor.
  useEffect(() => () => { engine?.previewStop(); }, [engine]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        if (showDone) setShowDone(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, showDone]);

  const duration = buffer?.duration ?? sound.duration ?? 0;
  const peaks = useMemo(() => buffer ? makeWaveform(buffer, 120) : sound.waveform || [], [buffer, sound.waveform]);
  const start = Math.min(Math.max(0, sound.trimStartSec ?? 0), duration);
  const end = Math.min(Math.max(start, sound.trimEndSec ?? duration), duration) || duration;
  const rate = sound.playbackRate ?? 1;
  const trimRef = useRef({ start, end });
  trimRef.current = { start, end };
  const trimmed = start > 0.005 || end < duration - 0.005;
  const edited = trimmed || Math.abs(rate - 1) > 0.001;

  // Keep the playhead inside the trimmed region as it (or the trim) changes.
  useEffect(() => {
    setPlayheadSec((current) => Math.min(Math.max(current, start), end));
  }, [start, end]);

  // Drive the playhead from the engine while previewing.
  useEffect(() => {
    if (previewState !== "playing" || !engine) return;
    let frame = 0;
    const tick = () => {
      const pos = engine.getPreviewPosition();
      if (pos !== null) setPlayheadSec(Math.min(pos, end));
      if (!engine.isPreviewing()) {
        setPreviewState("stopped");
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [previewState, engine, end]);

  function playPreview() {
    if (!engine || !duration) return;
    const from = playheadSec >= end - 0.01 || playheadSec < start ? start : playheadSec;
    void engine.previewPlay(sound, from, rate);
    setPlayheadSec(from);
    setPreviewState("playing");
  }

  function pausePreview() {
    if (!engine) return;
    engine.previewPause();
    const pos = engine.getPreviewPosition();
    if (pos !== null) setPlayheadSec(Math.min(Math.max(pos, start), end));
    setPreviewState("paused");
  }

  function restartPreview() {
    if (!engine || !duration) return;
    void engine.previewRestart(sound, rate);
    setPlayheadSec(start);
    setPreviewState("playing");
  }

  function changeRate(v: number) {
    onChange({ playbackRate: v });
    if (previewState === "playing" && engine) {
      void engine.previewPlay(sound, playheadSec, v);
    }
  }

  function dragHandle(which: "start" | "end") {
    return (event: React.PointerEvent) => {
      if (!duration) return;
      event.preventDefault();
      event.stopPropagation();
      const move = (moveEvent: PointerEvent) => {
        const rect = trackRef.current?.getBoundingClientRect();
        if (!rect || !rect.width) return;
        const time = Math.min(Math.max(0, ((moveEvent.clientX - rect.left) / rect.width) * duration), duration);
        if (which === "start") onChange({ trimStartSec: Math.min(time, trimRef.current.end - 0.05) });
        else onChange({ trimEndSec: Math.max(time, trimRef.current.start + 0.05) });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      move(event.nativeEvent);
    };
  }

  function seekFromClientX(clientX: number) {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !duration) return start;
    return Math.min(Math.max(((clientX - rect.left) / rect.width) * duration, start), end);
  }

  function scrub(event: React.PointerEvent) {
    if (!duration || !engine) return;
    event.preventDefault();
    event.stopPropagation();
    const resume = previewState === "playing";
    if (resume) {
      engine.previewPause();
      setPreviewState("paused");
    }
    const move = (moveEvent: PointerEvent) => {
      const time = seekFromClientX(moveEvent.clientX);
      setPlayheadSec(time);
      engine.previewSeek(sound, time, false, rate);
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const time = seekFromClientX(upEvent.clientX);
      setPlayheadSec(time);
      if (resume) {
        void engine.previewPlay(sound, time, rate);
        setPreviewState("playing");
      } else {
        engine.previewSeek(sound, time, false, rate);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    move(event.nativeEvent);
  }

  async function cutPermanently() {
    if (!engine || cropping) return;
    setCropping(true);
    setCropError("");
    const oldPath = sound.mediaPath;
    try {
      const result = await window.sounddeck.cropMedia({ mediaPath: sound.mediaPath, ext: sound.ext, startSec: start, endSec: end, rate });
      if (!result.ok || !result.mediaPath) {
        setCropError(result.reason || "Could not cut clip.");
        setCropping(false);
        return;
      }
      engine.invalidate(sound.id);
      let nextDuration: number | undefined;
      let nextWaveform: number[] | undefined;
      try {
        const decoded = await engine.preload({ ...sound, mediaPath: result.mediaPath, trimStartSec: 0, trimEndSec: undefined });
        nextDuration = decoded.duration;
        nextWaveform = makeWaveform(decoded);
      } catch {
        // Keep going even if we cannot recompute the waveform/duration.
      }
      onChange({
        mediaPath: result.mediaPath,
        storedName: result.storedName,
        size: result.size,
        ext: result.ext,
        mime: result.mime,
        trimStartSec: 0,
        trimEndSec: undefined,
        playbackRate: 1,
        duration: nextDuration,
        waveform: nextWaveform
      });
      if (oldPath && oldPath !== result.mediaPath) await window.sounddeck.deleteMedia(oldPath).catch(() => undefined);
      onClose();
    } catch (error) {
      setCropError(error instanceof Error ? error.message : "Could not cut clip.");
      setCropping(false);
    }
  }

  function openDone() {
    engine?.previewStop();
    setPreviewState("stopped");
    setCropError("");
    setShowDone(true);
  }

  const startPct = duration ? (start / duration) * 100 : 0;
  const endPct = duration ? (end / duration) * 100 : 100;
  const playheadPct = duration ? (Math.min(Math.max(playheadSec, 0), duration) / duration) * 100 : 0;
  const relPlayhead = Math.max(0, playheadSec - start);
  const clipLength = Math.max(0, end - start);

  return (
    <div
      className="modalOverlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          onClose();
        }
      }}
    >
      <div className="clipEditor">
        <header>
          <strong>Clip editor</strong>
          <span className="clipTitle">{sound.title}</span>
          <button onClick={onClose}><X size={16} /></button>
        </header>
        {loadError && <p className="clipError">Could not load audio for this clip.</p>}
        <div className={`clipTrack${buffer ? "" : " loading"}`} ref={trackRef} onPointerDown={scrub}>
          <div className="clipWave">
            {(peaks.length ? peaks : Array.from({ length: 120 }, () => 0.2)).map((peak, index, all) => {
              const position = (index + 0.5) / all.length;
              const inside = duration ? position * duration >= start && position * duration <= end : true;
              return <i key={index} className={inside ? "" : "outside"} style={{ height: `${Math.max(8, peak * 100)}%`, background: sound.color }} />;
            })}
          </div>
          <div className="clipRegion" style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }} />
          {duration > 0 && <div className="clipPlayhead" style={{ left: `${playheadPct}%` }} onPointerDown={scrub} role="slider" aria-label="Playhead" aria-valuenow={playheadSec} aria-valuemin={start} aria-valuemax={end} tabIndex={0} />}
          <div className="clipHandle start" style={{ left: `${startPct}%` }} onPointerDown={dragHandle("start")} role="slider" aria-label="Clip start" aria-valuenow={start} aria-valuemin={0} aria-valuemax={duration} tabIndex={0} />
          <div className="clipHandle end" style={{ left: `${endPct}%` }} onPointerDown={dragHandle("end")} role="slider" aria-label="Clip end" aria-valuenow={end} aria-valuemin={0} aria-valuemax={duration} tabIndex={0} />
        </div>
        <div className="clipTimes">
          <TrimInput label="Start" value={start} min={0} max={Math.max(0, end - 0.05)} onChange={(v) => onChange({ trimStartSec: v })} />
          <TrimInput label="End" value={end} min={Math.min(start + 0.05, duration)} max={duration} onChange={(v) => onChange({ trimEndSec: v })} />
          <TrimInput label="Length" value={clipLength} min={Math.min(0.05, duration - start)} max={Math.max(0, duration - start)} onChange={(v) => onChange({ trimEndSec: Math.min(start + v, duration) })} />
          <SpeedInput value={rate} min={0.25} max={4} onChange={changeRate} />
          <span className="clipPlayheadTime">Playhead <em>{relPlayhead.toFixed(2)}s</em> / {clipLength.toFixed(2)}s</span>
        </div>
        <div className="clipActions">
          <button className="clipPreview" onClick={previewState === "playing" ? pausePreview : playPreview} disabled={!duration}>
            {previewState === "playing" ? <Pause size={15} /> : <Play size={15} />}{previewState === "playing" ? "Pause" : previewState === "paused" ? "Resume" : "Play"}
          </button>
          <button onClick={restartPreview} disabled={!duration}><RotateCcw size={15} /> Restart</button>
          <button onClick={() => onChange({ trimStartSec: 0, trimEndSec: undefined, playbackRate: 1 })} disabled={!edited}><RefreshCcw size={15} /> Reset</button>
          <button className="clipDone" onClick={openDone} disabled={!duration}><Save size={15} /> Done</button>
        </div>
      </div>
      {showDone && (
        <div className="modalOverlay clipDoneOverlay" onPointerDown={(event) => { if (event.target === event.currentTarget && !cropping) setShowDone(false); }}>
          <div className="clipDoneDialog">
            <header>
              <strong>Finish editing</strong>
              <button onClick={() => setShowDone(false)} disabled={cropping} aria-label="Close"><X size={16} /></button>
            </header>
            <p>Keep the original file and just remember your trim and speed, or cut the file down on disk to bake them in permanently?</p>
            {cropError && <p className="clipError">{cropError}</p>}
            <div className="clipDoneActions">
              <button onClick={onClose} disabled={cropping}>Save timestamps</button>
              <button className="danger" onClick={() => void cutPermanently()} disabled={cropping}>
                <Scissors size={15} /> {cropping ? "Cutting…" : "Cut clip permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DevicePanel({ library, inputDevices, outputDevices, defaultInputLabel, defaultOutputLabel, onRefresh, onChange }: {
  library: SoundLibrary;
  inputDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
  defaultInputLabel: string;
  defaultOutputLabel: string;
  onRefresh: () => void;
  onChange: (patch: Partial<SoundLibrary["settings"]>) => void;
}) {
  const settings = library.settings;
  const defaultInputOption = defaultInputLabel ? `System default (${defaultInputLabel})` : "System default";
  const defaultOutputOption = defaultOutputLabel ? `System default (${defaultOutputLabel})` : "System default";
  return (
    <div className="panel">
      <section>
        <h2>Audio Routing</h2>
        <div className="toggleRow"><label><input type="checkbox" checked={settings.micPassthrough} onChange={(event) => onChange({ micPassthrough: event.target.checked })} /> Mic passthrough</label><label><input type="checkbox" checked={settings.soundboardToVirtualMic} onChange={(event) => onChange({ soundboardToVirtualMic: event.target.checked })} /> Soundboard to virtual mic</label><label><input type="checkbox" checked={settings.monitorToHeadphones} onChange={(event) => onChange({ monitorToHeadphones: event.target.checked })} /> Monitor soundboard</label><label><input type="checkbox" checked={settings.monitorMicToHeadphones} onChange={(event) => onChange({ monitorMicToHeadphones: event.target.checked })} /> Monitor microphone</label></div>
        <label><Mic size={16} /> Microphone<select value={settings.microphoneDeviceId} onChange={(event) => onChange({ microphoneDeviceId: event.target.value })}><option value="">{defaultInputOption}</option>{inputDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Input ${device.deviceId.slice(0, 6)}`}</option>)}</select></label>
        <label><Headphones size={16} /> Headphones / monitor<select value={settings.monitorDeviceId} onChange={(event) => onChange({ monitorDeviceId: event.target.value })}><option value="">{defaultOutputOption}</option>{outputDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Output ${device.deviceId.slice(0, 6)}`}</option>)}</select></label>
        <VolumeField label="Mic volume (virtual mic)" value={settings.micVirtualVolume} onChange={(micVirtualVolume) => onChange({ micVirtualVolume })} />
        <VolumeField label="Mic volume (monitoring)" value={settings.micMonitorVolume} onChange={(micMonitorVolume) => onChange({ micMonitorVolume })} />
        <VolumeField label="Soundboard volume (virtual mic)" value={settings.soundboardVirtualVolume} onChange={(soundboardVirtualVolume) => onChange({ soundboardVirtualVolume })} />
        <VolumeField label="Soundboard volume (monitoring)" value={settings.soundboardMonitorVolume} onChange={(soundboardMonitorVolume) => onChange({ soundboardMonitorVolume })} />
        <div className="buttonLine"><button onClick={onRefresh}><Settings size={16} /> Refresh devices</button></div>
      </section>
      <section className="routingGuide">
        <h2>Virtual Mic Setup</h2>
        <p>VB-CABLE is installed automatically with this app and the soundboard always plays into its <strong>CABLE Input</strong> speaker — no setup needed here. Everything comes back out of the <strong>CABLE Output</strong> microphone: that virtual output is where the sound comes from for other apps.</p>
        <ol>
          <li>In Discord, OBS, or your game, pick <strong>CABLE Output (VB-Audio Virtual Cable)</strong> as the microphone.</li>
          <li>Enable <strong>Soundboard to virtual mic</strong>, plus <strong>Mic passthrough</strong> if your voice should be mixed in with the sounds.</li>
          <li>Keep the headphones / monitor device above on your real headphones so you hear the soundboard without echo or feedback.</li>
        </ol>
      </section>
    </div>
  );
}

const corsairStateLabels: Record<CorsairState, string> = {
  unavailable: "Corsair iCUE SDK not available on this system.",
  idle: "Connecting to Corsair iCUE...",
  connecting: "Connecting to Corsair iCUE...",
  connected: "Corsair iCUE connected — press a G-key while binding to use it.",
  disconnected: "Corsair iCUE not detected. Start iCUE and enable the SDK (Settings > Software and Games) to bind G-keys."
};

function HotkeyPanel({ library, results, corsairState, onChangeSettings, onChangeSound, onChangeBoard }: {
  library: SoundLibrary;
  results: HotkeyResult[];
  corsairState: CorsairState;
  onChangeSettings: (patch: Partial<SoundLibrary["settings"]>) => void;
  onChangeSound: (id: string, patch: Partial<SoundSlot>) => void;
  onChangeBoard: (id: string, patch: Partial<SoundBoard>) => void;
}) {
  const allSounds = library.boards.flatMap((board) => board.sounds.map((sound) => ({ board, sound })));
  return (
    <div className="panel hotkeysPanel">
      <section className="hotkeysSection">
        <h2>Hotkeys</h2>
        <p className={corsairState === "connected" ? "corsairStatus connected" : "corsairStatus"}>
          {corsairStateLabels[corsairState]}
        </p>
        <div className="hotkeyList">
          <div className="hotkeyRow emergency">
            <span className="dot stopDot" />
            <strong>Emergency Stop</strong>
            <small>Global</small>
            <HotkeyCapture value={library.settings.stopAllHotkey} onChange={(hotkey) => onChangeSettings({ stopAllHotkey: hotkey })} />
          </div>
          <div className="hotkeyRow">
            <span className="dot" />
            <strong>Next Board</strong>
            <small>Cycles through boards</small>
            <HotkeyCapture value={library.settings.cycleBoardsHotkey} onChange={(hotkey) => onChangeSettings({ cycleBoardsHotkey: hotkey })} />
            {(() => {
              const result = results.find((candidate) => candidate.type === "cycle-board");
              return result && !result.ok ? <em>{result.reason}</em> : null;
            })()}
          </div>
          {library.boards.map((board) => {
            const result = results.find((candidate) => candidate.type === "board" && candidate.boardId === board.id);
            return (
              <div key={board.id} className="hotkeyRow">
                <span className="dot" style={{ background: board.color }} />
                <strong>Switch to {board.name}</strong>
                <small>Board</small>
                <HotkeyCapture value={board.switchHotkey || ""} onChange={(switchHotkey) => onChangeBoard(board.id, { switchHotkey })} />
                {result && !result.ok && <em>{result.reason}</em>}
              </div>
            );
          })}
          {allSounds.map(({ board, sound }) => {
            const result = results.find((candidate) => candidate.soundId === sound.id);
            return <div key={sound.id} className="hotkeyRow"><span className="dot" style={{ background: board.color }} /><strong>{sound.title}</strong><small>{board.name}</small><HotkeyCapture value={sound.hotkey} onChange={(hotkey) => onChangeSound(sound.id, { hotkey })} />{result && !result.ok && <em>{result.reason}</em>}{acceleratorLooksReserved(sound.hotkey) && <em>reserved-looking</em>}</div>;
          })}
          {!allSounds.length && <div className="emptyHotkeys">Add sounds to bind sound hotkeys.</div>}
        </div>
      </section>
    </div>
  );
}

function HotkeyCapture({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { capturing, preview, start } = useHotkeyCapture(onChange);

  return (
    <div className={capturing ? "hotkeyCapture active" : "hotkeyCapture"}>
      <button onPointerDown={(event) => event.stopPropagation()} onClick={start}>
        {capturing ? (preview ? formatAccelerator(preview) : "Press keys...") : value ? formatAccelerator(value) : "Bind"}
      </button>
      {value && <button title="Clear" onClick={() => onChange("")}><X size={14} /></button>}
    </div>
  );
}

function RecorderPanel({ inputDevices, micDeviceId, onImport }: { inputDevices: MediaDeviceInfo[]; micDeviceId: string; onImport: (result: Awaited<ReturnType<typeof window.sounddeck.saveRecording>>) => void }) {
  const [recording, setRecording] = useState(false);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);

  async function start() {
    chunks.current = [];
    const selectedMicId = normalizeSelectableDeviceId(micDeviceId);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: makeMicrophoneConstraints(selectedMicId) });
    } catch (error) {
      if (!selectedMicId) throw error;
      console.warn("Selected recording microphone failed; retrying with system default", error);
      stream = await navigator.mediaDevices.getUserMedia({ audio: makeMicrophoneConstraints("") });
    }
    const next = new MediaRecorder(stream, { mimeType: "audio/webm" });
    next.ondataavailable = (event) => chunks.current.push(event.data);
    next.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks.current, { type: "audio/webm" });
      const bytes = await blob.arrayBuffer();
      const result = await window.sounddeck.saveRecording({ title: `Recording ${new Date().toLocaleTimeString()}`, ext: ".webm", bytes });
      onImport(result);
    };
    next.start();
    setRecorder(next);
    setRecording(true);
  }

  function stop() {
    recorder?.stop();
    setRecorder(null);
    setRecording(false);
  }

  return (
    <div className="panel recorderPanel">
      <section>
        <h2>Recorder</h2>
        <p>{inputDevices.length ? "Record a quick clip from the selected microphone and add it to the current board." : "Microphone permission may be needed before devices appear."}</p>
        <button className={recording ? "recording" : ""} onClick={recording ? stop : () => void start()}>{recording ? <Square size={18} /> : <Mic size={18} />}{recording ? "Stop recording" : "Start recording"}</button>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
