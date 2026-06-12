import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Download,
  FolderOpen,
  Headphones,
  Keyboard,
  Mic,
  Pencil,
  Play,
  Plus,
  Radio,
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
import { acceleratorLooksReserved, formatBytes, formatDuration, makeBoard, normalizeLibrary, now, soundFromImport } from "./lib/model";
import { eventToAccelerator } from "./lib/hotkeys";
import { makeWaveform } from "./lib/waveform";
import { installDevBridge } from "./lib/devBridge";
import type { CorsairState, HotkeyBinding, HotkeyResult, SoundBoard, SoundLibrary, SoundSlot } from "./types";
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
  const [dropActive, setDropActive] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [corsairState, setCorsairState] = useState<CorsairState>("unavailable");
  const engineRef = useRef<AudioEngine | null>(null);

  useEffect(() => {
    void window.sounddeck.getCorsairStatus().then(setCorsairState);
    return window.sounddeck.onCorsairStatus(setCorsairState);
  }, []);

  useEffect(() => {
    window.sounddeck.loadLibrary().then((loaded) => setLibrary(normalizeLibrary(loaded)));
  }, []);

  useEffect(() => {
    if (!library) return;
    void window.sounddeck.saveLibrary(library);
  }, [library]);

  useEffect(() => {
    if (!library) return;
    if (!engineRef.current) engineRef.current = new AudioEngine(library.settings, (status, activeIds) => {
      setEngineStatus(status);
      setPlayingIds(activeIds);
    });
    void engineRef.current.configure(library.settings);
  }, [library?.settings]);

  const activeBoard = useMemo(() => {
    if (!library) return null;
    return library.boards.find((board) => board.id === library.activeBoardId) || library.boards[0];
  }, [library]);

  const selectedSound = useMemo(() => activeBoard?.sounds.find((sound) => sound.id === selectedSoundId) || null, [activeBoard, selectedSoundId]);
  const editingClipSound = useMemo(() => activeBoard?.sounds.find((sound) => sound.id === editingClipId) || null, [activeBoard, editingClipId]);

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

  const registerHotkeys = useCallback(async (current: SoundLibrary) => {
    const bindings: HotkeyBinding[] = [];
    if (current.settings.stopAllHotkey) bindings.push({ type: "stop-all", accelerator: current.settings.stopAllHotkey });
    for (const board of current.boards) {
      for (const sound of board.sounds) {
        if (sound.hotkey) bindings.push({ type: "sound", boardId: board.id, soundId: sound.id, accelerator: sound.hotkey });
      }
    }
    const results = await window.sounddeck.registerHotkeys(bindings);
    setHotkeyResults(results);
  }, []);

  const corsairConnected = corsairState === "connected";
  useEffect(() => {
    if (!library) return;
    void registerHotkeys(library);
  }, [library, registerHotkeys, corsairConnected]);

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
    updateLibrary((current) => ({
      ...current,
      boards: current.boards.map((board) => ({
        ...board,
        sounds: board.sounds.map((sound) => sound.id === soundId ? { ...sound, ...patch, updatedAt: now() } : sound)
      }))
    }));
  }

  async function importFiles(files: File[]) {
    if (!activeBoard) return;
    const paths = files.map((file) => window.sounddeck.getPathForFile(file)).filter(Boolean);
    if (!paths.length) return;
    const results = await window.sounddeck.importMedia(paths);
    const imported = results.map((result, index) => soundFromImport(result, activeBoard.sounds.length + index, "both")).filter(Boolean) as SoundSlot[];
    updateLibrary((current) => ({
      ...current,
      boards: current.boards.map((board) => board.id === activeBoard.id ? { ...board, sounds: [...board.sounds, ...imported], updatedAt: now() } : board)
    }));
    setMessage(imported.length ? `Imported ${imported.length} sound${imported.length === 1 ? "" : "s"}` : "No supported audio files found");
    for (const sound of imported) {
      engineRef.current?.preload(sound).then((buffer) => updateSound(sound.id, { duration: buffer.duration, waveform: makeWaveform(buffer) })).catch(() => undefined);
    }
  }

  function addBoard() {
    updateLibrary((current) => {
      const board = makeBoard(current.boards.length + 1);
      return { ...current, activeBoardId: board.id, boards: [...current.boards, board] };
    });
  }

  function deleteSound(soundId: string) {
    engineRef.current?.stop(soundId);
    updateLibrary((current) => ({
      ...current,
      boards: current.boards.map((board) => board.id === current.activeBoardId ? { ...board, sounds: board.sounds.filter((sound) => sound.id !== soundId), updatedAt: now() } : board)
    }));
    if (selectedSoundId === soundId) setSelectedSoundId("");
    if (editingClipId === soundId) setEditingClipId("");
  }

  function deleteBoard(boardId: string) {
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

  function changeSettings(patch: Partial<SoundLibrary["settings"]>) {
    updateLibrary((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  }

  if (!library || !activeBoard) return <div className="boot">Loading SoundDeck Studio...</div>;

  const outputDevices = devices.filter((device) => device.kind === "audiooutput");
  const inputDevices = devices.filter((device) => device.kind === "audioinput");

  return (
    <main
      className="app"
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
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
              className={board.id === activeBoard.id ? "boardButton active" : "boardButton"}
              role="button"
              tabIndex={0}
              onClick={() => updateLibrary((current) => ({ ...current, activeBoardId: board.id }))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") updateLibrary((current) => ({ ...current, activeBoardId: board.id }));
              }}
            >
              <span className="dot" style={{ background: board.color }} />
              <span className="boardName">{board.name}</span>
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
        <div className="sideLabel">Studio</div>
        <div className="sideNav">
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}><Wand2 size={18} /> Board</button>
          <button className={view === "devices" ? "active" : ""} onClick={() => setView("devices")}><Settings size={18} /> Devices</button>
          <button className={view === "hotkeys" ? "active" : ""} onClick={() => setView("hotkeys")}><Keyboard size={18} /> Hotkeys</button>
          <button className={view === "recorder" ? "active" : ""} onClick={() => setView("recorder")}><Mic size={18} /> Recorder</button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <BoardTitle key={activeBoard.id} name={activeBoard.name} onRename={(name) => updateBoard(activeBoard.id, { name })} />
            <p>{activeBoard.sounds.length} sounds · {message}</p>
          </div>
          <div className="topActions">
            <button onClick={() => void window.sounddeck.revealLibrary()}><FolderOpen size={16} /> Library</button>
            <button onClick={() => void window.sounddeck.exportLibrary(library)}><Download size={16} /> Backup</button>
            <button onClick={async () => {
              const result = await window.sounddeck.importBackup();
              if (result.ok && result.library) setLibrary(normalizeLibrary(result.library));
            }}><Upload size={16} /> Restore</button>
          </div>
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
            <div className="soundGrid">
              {activeBoard.sounds.map((sound) => (
                <SoundPad
                  key={sound.id}
                  sound={sound}
                  selected={selectedSoundId === sound.id}
                  playing={playingIds.includes(sound.id)}
                  hotkeyProblem={hotkeyResults.some((result) => result.soundId === sound.id && !result.ok)}
                  onPlay={() => void triggerSound(sound)}
                  onStop={() => engineRef.current?.stop(sound.id)}
                  onEditClip={() => setEditingClipId(sound.id)}
                  onSelect={() => setSelectedSoundId(sound.id)}
                  onDelete={() => deleteSound(sound.id)}
                  onChange={(patch) => updateSound(sound.id, patch)}
                />
              ))}
              {!activeBoard.sounds.length && <div className="empty">Drop sounds to build this board.</div>}
            </div>
            {selectedSound && <SoundEditor sound={selectedSound} onChange={(patch) => updateSound(selectedSound.id, patch)} onClose={() => setSelectedSoundId("")} />}
            {editingClipSound && (
              <ClipEditor
                sound={editingClipSound}
                engine={engineRef.current}
                playing={playingIds.includes(editingClipSound.id)}
                onPlay={() => void triggerSound(editingClipSound)}
                onStop={() => engineRef.current?.stop(editingClipSound.id)}
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
            onRefresh={refreshDevices}
            onChange={changeSettings}
            onExternal={(url) => void window.sounddeck.openExternal(url)}
          />
        )}

        {view === "hotkeys" && (
          <HotkeyPanel
            library={library}
            results={hotkeyResults}
            corsairState={corsairState}
            onChangeSettings={changeSettings}
            onChangeSound={updateSound}
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
    </main>
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
  selected: boolean;
  playing: boolean;
  hotkeyProblem: boolean;
  onPlay: () => void;
  onStop: () => void;
  onEditClip: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onChange: (patch: Partial<SoundSlot>) => void;
}) {
  const { sound } = props;
  const clipDuration = Number.isFinite(sound.duration)
    ? Math.max(0, Math.min(sound.trimEndSec ?? sound.duration!, sound.duration!) - Math.max(0, sound.trimStartSec ?? 0))
    : sound.duration;
  return (
    <article
      className={`pad${props.selected ? " selected" : ""}${props.playing ? " playing" : ""}`}
      style={{ "--pad": sound.color } as React.CSSProperties}
    >
      <button className="padMain" onClick={props.onPlay} onDoubleClick={props.onSelect}>
        <span className="padIcon" style={{ background: sound.color }}>{sound.title.slice(0, 1).toUpperCase()}</span>
        <strong>{sound.title}</strong>
        <span>{formatDuration(clipDuration)} · {formatBytes(sound.size)}</span>
        <Wave peaks={sound.waveform} color={sound.color} />
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
        <span className={props.hotkeyProblem ? "problem" : ""}>{sound.hotkey || "No hotkey"}</span>
        <span>{sound.outputTarget}</span>
      </div>
    </article>
  );
}

function Wave({ peaks, color }: { peaks?: number[]; color: string }) {
  return <div className="wave">{(peaks?.length ? peaks : Array.from({ length: 36 }, (_, index) => (index % 5) / 5 + 0.15)).map((peak, index) => <i key={index} style={{ height: `${Math.max(10, peak * 100)}%`, background: color }} />)}</div>;
}

function SoundEditor({ sound, onChange, onClose }: { sound: SoundSlot; onChange: (patch: Partial<SoundSlot>) => void; onClose: () => void }) {
  return (
    <aside className="inspector">
      <header><strong>Edit sound</strong><button onClick={onClose}><X size={16} /></button></header>
      <label>Title<input value={sound.title} onChange={(event) => onChange({ title: event.target.value })} /></label>
      <label>Color<input type="color" value={sound.color} onChange={(event) => onChange({ color: event.target.value })} /></label>
      <label>Volume <span>{Math.round(sound.volume * 100)}%</span><input type="range" min="0" max="1" step="0.01" value={sound.volume} onChange={(event) => onChange({ volume: Number(event.target.value) })} /></label>
      <label>Fade in ms<input type="number" min="0" value={sound.fadeInMs} onChange={(event) => onChange({ fadeInMs: Number(event.target.value) })} /></label>
      <label>Fade out ms<input type="number" min="0" value={sound.fadeOutMs} onChange={(event) => onChange({ fadeOutMs: Number(event.target.value) })} /></label>
      <label>Output<select value={sound.outputTarget} onChange={(event) => onChange({ outputTarget: event.target.value as SoundSlot["outputTarget"] })}><option value="both">Headphones + virtual mic</option><option value="monitor">Headphones</option><option value="virtual">Virtual mic</option></select></label>
      <label>Retrigger<select value={sound.retriggerMode} onChange={(event) => onChange({ retriggerMode: event.target.value as SoundSlot["retriggerMode"] })}><option value="restart">Stop then restart</option><option value="overlap">Overlap</option><option value="stop">Play / stop toggle</option></select></label>
      <label className="check"><input type="checkbox" checked={sound.loop} onChange={(event) => onChange({ loop: event.target.checked })} /> Loop</label>
      <HotkeyCapture value={sound.hotkey} onChange={(hotkey) => onChange({ hotkey })} />
    </aside>
  );
}

function ClipEditor({ sound, engine, playing, onPlay, onStop, onChange, onClose }: {
  sound: SoundSlot;
  engine: AudioEngine | null;
  playing: boolean;
  onPlay: () => void;
  onStop: () => void;
  onChange: (patch: Partial<SoundSlot>) => void;
  onClose: () => void;
}) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [loadError, setLoadError] = useState(false);
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
  }, [engine, sound.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const duration = buffer?.duration ?? sound.duration ?? 0;
  const peaks = useMemo(() => buffer ? makeWaveform(buffer, 120) : sound.waveform || [], [buffer, sound.waveform]);
  const start = Math.min(Math.max(0, sound.trimStartSec ?? 0), duration);
  const end = Math.min(Math.max(start, sound.trimEndSec ?? duration), duration) || duration;
  const trimRef = useRef({ start, end });
  trimRef.current = { start, end };
  const trimmed = start > 0.005 || end < duration - 0.005;

  function dragHandle(which: "start" | "end") {
    return (event: React.PointerEvent) => {
      if (!duration) return;
      event.preventDefault();
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

  const startPct = duration ? (start / duration) * 100 : 0;
  const endPct = duration ? (end / duration) * 100 : 100;

  return (
    <div
      className="modalOverlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="clipEditor">
        <header>
          <strong>Clip editor</strong>
          <span className="clipTitle">{sound.title}</span>
          <button onClick={onClose}><X size={16} /></button>
        </header>
        {loadError && <p className="clipError">Could not load audio for this clip.</p>}
        <div className={`clipTrack${buffer ? "" : " loading"}`} ref={trackRef}>
          <div className="clipWave">
            {(peaks.length ? peaks : Array.from({ length: 120 }, () => 0.2)).map((peak, index, all) => {
              const position = (index + 0.5) / all.length;
              const inside = duration ? position * duration >= start && position * duration <= end : true;
              return <i key={index} className={inside ? "" : "outside"} style={{ height: `${Math.max(8, peak * 100)}%`, background: sound.color }} />;
            })}
          </div>
          <div className="clipRegion" style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }} />
          <div className="clipHandle start" style={{ left: `${startPct}%` }} onPointerDown={dragHandle("start")} role="slider" aria-label="Clip start" aria-valuenow={start} aria-valuemin={0} aria-valuemax={duration} tabIndex={0} />
          <div className="clipHandle end" style={{ left: `${endPct}%` }} onPointerDown={dragHandle("end")} role="slider" aria-label="Clip end" aria-valuenow={end} aria-valuemin={0} aria-valuemax={duration} tabIndex={0} />
        </div>
        <div className="clipTimes">
          <span>Start <em>{start.toFixed(2)}s</em></span>
          <span>End <em>{end.toFixed(2)}s</em></span>
          <span>Length <em>{Math.max(0, end - start).toFixed(2)}s</em></span>
          <span>Source <em>{duration.toFixed(2)}s</em></span>
        </div>
        <div className="clipActions">
          <button className="clipPreview" onClick={playing ? onStop : onPlay} disabled={!duration}>
            {playing ? <Square size={15} /> : <Play size={15} />}{playing ? "Stop" : "Preview"}
          </button>
          <button onClick={() => onChange({ trimStartSec: 0, trimEndSec: undefined })} disabled={!trimmed}><RotateCcw size={15} /> Reset trim</button>
          <button onClick={onClose}><Save size={15} /> Done</button>
        </div>
      </div>
    </div>
  );
}

function DevicePanel({ library, inputDevices, outputDevices, onRefresh, onChange, onExternal }: {
  library: SoundLibrary;
  inputDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
  onRefresh: () => void;
  onChange: (patch: Partial<SoundLibrary["settings"]>) => void;
  onExternal: (url: string) => void;
}) {
  const settings = library.settings;
  return (
    <div className="panel">
      <section>
        <h2>Audio Routing</h2>
        <div className="toggleRow"><label><input type="checkbox" checked={settings.micPassthrough} onChange={(event) => onChange({ micPassthrough: event.target.checked })} /> Mic passthrough</label><label><input type="checkbox" checked={settings.soundboardToVirtualMic} onChange={(event) => onChange({ soundboardToVirtualMic: event.target.checked })} /> Soundboard to virtual mic</label><label><input type="checkbox" checked={settings.monitorToHeadphones} onChange={(event) => onChange({ monitorToHeadphones: event.target.checked })} /> Monitor soundboard</label><label><input type="checkbox" checked={settings.monitorMicToHeadphones} onChange={(event) => onChange({ monitorMicToHeadphones: event.target.checked })} /> Monitor microphone</label></div>
        <label><Mic size={16} /> Microphone<select value={settings.microphoneDeviceId} onChange={(event) => onChange({ microphoneDeviceId: event.target.value })}><option value="">System default</option>{inputDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Input ${device.deviceId.slice(0, 6)}`}</option>)}</select></label>
        <label><Headphones size={16} /> Headphones / monitor<select value={settings.monitorDeviceId} onChange={(event) => onChange({ monitorDeviceId: event.target.value })}><option value="">System default</option>{outputDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Output ${device.deviceId.slice(0, 6)}`}</option>)}</select></label>
        <label><Radio size={16} /> Virtual cable playback device<select value={settings.virtualMicDeviceId} onChange={(event) => onChange({ virtualMicDeviceId: event.target.value })}><option value="">System default</option>{outputDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Output ${device.deviceId.slice(0, 6)}`}</option>)}</select></label>
        <label>Mic volume <input type="range" min="0" max="1" step="0.01" value={settings.micVolume} onChange={(event) => onChange({ micVolume: Number(event.target.value) })} /></label>
        <label>Soundboard volume <input type="range" min="0" max="1" step="0.01" value={settings.soundboardVolume} onChange={(event) => onChange({ soundboardVolume: Number(event.target.value) })} /></label>
        <label>Monitor volume <input type="range" min="0" max="1" step="0.01" value={settings.monitorVolume} onChange={(event) => onChange({ monitorVolume: Number(event.target.value) })} /></label>
        <div className="buttonLine"><button onClick={onRefresh}><Settings size={16} /> Refresh devices</button><button onClick={() => onExternal("https://vb-audio.com/Cable/")}><Download size={16} /> VB-CABLE</button></div>
      </section>
      <section className="routingGuide">
        <h2>Virtual Mic Setup</h2>
        <p>Install a signed virtual cable, select its playback side here, then choose the matching recording side as the microphone in Discord, OBS, or your game.</p>
        <ol>
          <li>Install VB-CABLE or another signed Windows virtual audio cable.</li>
          <li>Set virtual cable playback to <strong>CABLE Input</strong> in this app.</li>
          <li>Set Discord or OBS microphone to <strong>CABLE Output</strong>.</li>
          <li>Keep monitor output on headphones to avoid feedback.</li>
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

function HotkeyPanel({ library, results, corsairState, onChangeSettings, onChangeSound }: {
  library: SoundLibrary;
  results: HotkeyResult[];
  corsairState: CorsairState;
  onChangeSettings: (patch: Partial<SoundLibrary["settings"]>) => void;
  onChangeSound: (id: string, patch: Partial<SoundSlot>) => void;
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
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCapturing(false);
        return;
      }
      const next = eventToAccelerator(event);
      if (!next) return;
      onChange(next);
      setCapturing(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    const offCorsair = window.sounddeck.onCorsairKey((key) => {
      onChange(key);
      setCapturing(false);
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      offCorsair();
    };
  }, [capturing, onChange]);

  return (
    <div className={capturing ? "hotkeyCapture active" : "hotkeyCapture"}>
      <button onClick={() => setCapturing(true)}>{capturing ? "Press keys..." : value || "Bind"}</button>
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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true });
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
