<div align="center">

<img src="docs/icon.png" alt="SoundDeck Studio" width="96" height="96" />

# SoundDeck Studio

**Free, open-source soundboard for Windows with global hotkeys, virtual mic routing, and Corsair G-keys.**

[![Latest release](https://img.shields.io/github/v/release/MaksimPeterburgskiy/sounddeck-studio?label=download&color=1db7a6)](https://github.com/MaksimPeterburgskiy/sounddeck-studio/releases/latest)
[![CI](https://github.com/MaksimPeterburgskiy/sounddeck-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/MaksimPeterburgskiy/sounddeck-studio/actions/workflows/ci.yml)
[![Latest downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FMaksimPeterburgskiy%2Fsounddeck-studio%2Fmain%2Fdocs%2Fdownloads-badge.json)](https://github.com/MaksimPeterburgskiy/sounddeck-studio/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Play sounds into Discord, OBS, or any game as if they came from your microphone, with your boards, your hotkeys, and no subscription.

<img src="docs/screenshot.png" alt="SoundDeck Studio main window" width="800" />

</div>

---

## Download

**[Download the latest release](https://github.com/MaksimPeterburgskiy/sounddeck-studio/releases/latest)** and grab the `SoundDeck-Studio-Setup-x.y.z.exe` installer.

The installer sets up the [VB-CABLE](https://vb-audio.com/Cable/) virtual audio driver automatically (skipped if you already have it), so the virtual microphone works out of the box. A portable `.exe` is also available if you prefer no installation, but the portable build does not auto-update.

The app updates itself: when a new release is published, the installed app downloads it in the background and applies it on restart.

> **Windows SmartScreen:** builds are currently unsigned, so the first install may show a SmartScreen warning. Click *More info -> Run anyway*.

## Features

### Soundboard
- Unlimited boards and sound pads, each with its own title, color, icon, volume, and hotkey
- Drag-and-drop import of `.wav`, `.mp3`, `.ogg`, `.flac`, `.m4a`, `.aac`, and `.webm`
- Sounds are copied into the app library, so they keep working if you move the originals
- Loop, fade in/out, play/stop toggle, and retrigger modes (restart, overlap, stop)
- Multiple sounds at once, with decoded-buffer caching for instant retriggers
- Waveform previews and a clip editor with trim support

### Virtual microphone & routing
- Route the soundboard into a virtual mic that Discord, OBS, and games see as a real input device
- Mix your physical microphone into the virtual mic (passthrough)
- Independent volume controls for mic, soundboard, and headphone monitoring
- Pick exactly which device each bus plays to

### Hotkeys
- Global OS-level hotkeys that work while you're in-game
- Corsair G-key support (`G1`-`G20`) via the iCUE SDK
- Per-board switch hotkeys and an emergency stop-all (default `Ctrl+Alt+Space`)
- Inline hotkey capture: click a pad and press the combo

### Workflow
- Minimize to system tray; single-instance (relaunching focuses the existing window)
- Built-in recorder: capture a mic clip, trim it, drop it on the active board
- Export/import boards as `.sdboard` files with embedded audio to share boards with friends

## Quick start: virtual mic in Discord/OBS

1. Install SoundDeck Studio (the installer adds VB-CABLE if needed; reboot if the driver asks).
2. Open **Devices** and set **Virtual cable playback device** to `CABLE Input`.
3. Enable **Soundboard to virtual mic** (and **Mic passthrough** if you want your voice mixed in).
4. In Discord/OBS/your game, set the input device to `CABLE Output`.
5. Keep **Monitor soundboard** pointed at your real headphones so you hear what you play.

## Development

Requires Windows 10/11, Node.js 22.12+, and pnpm 11.6+ via Corepack.

```bash
git clone https://github.com/MaksimPeterburgskiy/sounddeck-studio.git
cd sounddeck-studio
corepack enable
pnpm install
pnpm start          # dev server + Electron with hot reload
```

| Command | Description |
| --- | --- |
| `pnpm start` | Run the app in development (Vite + Electron) |
| `pnpm test` | Run unit tests (Vitest) |
| `pnpm run build` | Type-check and bundle the renderer |
| `pnpm run dist` | Build the Windows installer + portable exe into `release/` |

Tech stack: Electron, React 19, TypeScript, Vite, Web Audio API, and electron-builder.

```
electron/   Main process - window, tray, global hotkeys, library storage, Corsair, auto-update
src/        Renderer - React UI
src/lib/    Pure logic - board model, audio engine, hotkey parsing, waveforms (unit-tested)
build/      Packaging resources - icon, NSIS installer script
scripts/    Build helpers (VB-CABLE is downloaded at package time, not committed)
```

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. In short: open an issue before large changes, target the `main` branch, keep PRs focused, and make sure `pnpm run build` and `pnpm test` pass.

Releases are cut from the `prod` branch by maintainers via the [Release workflow](.github/workflows/release.yml).

## License

[MIT](LICENSE) © Maksim Peterburgskiy

