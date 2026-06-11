# SoundDeck Studio

SoundDeck Studio is an original Windows-first desktop soundboard for streamers, gamers, Discord users, and voice-chat workflows. It is inspired by the general soundboard workflow common in voice apps, but it does not use Voicemod branding, assets, names, or proprietary UI.

## Research Notes

Current implementation choices are based on current public documentation and examples:

- Microsoft WASAPI/Core Audio is the native Windows path for render, capture, and loopback. WASAPI loopback captures what is playing through a render endpoint, and the broader Core Audio API manages endpoint device flow.
- Microsoft SysVAD is the documented sample path for building a real virtual audio endpoint driver, but shipping one requires Windows Driver Kit work, signing, installer elevation, and long-term driver maintenance.
- VB-CABLE provides a practical signed virtual audio cable: audio sent to `CABLE Input` is exposed from `CABLE Output`, which Discord/OBS/games can select as a microphone.
- Electron exposes `globalShortcut` for OS-level hotkeys. On Windows it maps to system hotkey registration behavior and reports registration failure when another app or the OS owns a shortcut.
- Chromium/Electron Web Audio gives low-latency decoded-buffer playback and mixing. `AudioContext.setSinkId()`/media output device selection is the practical way to route Web Audio to headphones or a virtual cable when available.
- FFmpeg remains the robust production answer for broad transcoding; this prototype uses Chromium decoders for `.wav`, `.mp3`, `.ogg`, `.flac`, `.m4a`, `.aac`, and `.webm`, then stores the original media in the app library.

Sources used:

- [Microsoft WASAPI overview](https://learn.microsoft.com/en-us/windows/win32/coreaudio/wasapi)
- [Microsoft WASAPI loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)
- [Microsoft low latency audio on Windows](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/low-latency-audio)
- [Microsoft SysVAD virtual audio driver sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-driver-samples/sysvad-virtual-audio-device-driver-sample/)
- [Microsoft RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)
- [Electron globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)
- [MDN HTMLMediaElement.setSinkId](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId)
- [Chrome AudioContext.setSinkId](https://developer.chrome.com/blog/audiocontext-setsinkid)
- [VB-Audio Virtual Cable](https://vb-audio.com/Cable/)
- [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html)

## Features

- Unlimited local soundboards and sound slots, constrained by storage and playback performance.
- Drag-and-drop sound import into the active board.
- App-managed media library under Electron `userData`.
- Per-sound title, color, volume, fade, loop, retrigger behavior, play/stop toggle mode, hotkey, and output target.
- Web Audio decoded-buffer caching for fast repeated triggers.
- Multiple simultaneous sounds.
- Stop all, pause, resume, per-sound stop.
- Global hotkeys through Electron.
- Device settings for microphone passthrough, soundboard-to-virtual-cable, soundboard headphone monitoring, optional microphone headphone monitoring, and independent volumes.
- Recorder screen that records a microphone clip and imports it into the active board.
- Backup/export and restore/import of metadata.

## Run

```powershell
npm install
npm start
```

For a renderer-only development server:

```powershell
npm run dev
```

For verification:

```powershell
npm test
npm run build
```

## Virtual Microphone Setup on Windows

The app does not install a kernel audio driver. The recommended route is a signed virtual audio cable:

1. Install [VB-CABLE](https://vb-audio.com/Cable/) or another trusted signed Windows virtual audio cable.
2. Reboot if the driver installer requests it.
3. Open SoundDeck Studio and go to **Devices**.
4. Set **Virtual cable playback device** to `CABLE Input`.
5. Enable **Soundboard to virtual mic**.
6. In Discord, OBS, or your game, set the microphone/input device to `CABLE Output`.
7. Keep **Monitor soundboard** pointed at your real headphones. Leave **Monitor microphone** off if you want to hear soundboard clips without hearing your own mic. Do not point monitor output back into the same virtual cable unless you intentionally want a loop.
8. Enable **Mic passthrough** if you want your physical mic mixed with the soundboard into the virtual cable.

## Manual Verification Checklist

- Launch with `npm start`.
- Create at least two boards and switch between them.
- Drag in `.wav` and `.mp3` files; optionally test `.ogg`, `.flac`, `.m4a`, or `.webm`.
- Confirm imported sounds keep playing after moving the original source file.
- Click a pad and confirm immediate playback.
- Trigger two pads at once and confirm overlap.
- Toggle loop on a pad, play it, then stop it.
- Set a pad to `overlap`, retrigger it, and confirm layered playback.
- Set a pad to `Play / stop toggle`, trigger it once to play, then trigger it again while it is still playing and confirm it stops.
- Bind a hotkey to a sound and trigger it while another app has focus.
- Bind the emergency stop hotkey and confirm it stops all active sounds.
- Install VB-CABLE, set `CABLE Input` as the virtual playback device, set Discord/OBS input to `CABLE Output`, and confirm soundboard audio appears as microphone input.
- Enable mic passthrough and verify the physical mic is mixed into the virtual input.
- Record a clip in the Recorder screen and confirm it appears on the current board.
- Export a backup, restore it, and confirm boards and sound metadata return.

## Production Driver Path

A built-in virtual microphone driver would require a separate WDK project based on SysVAD or a commercial driver partnership. That path needs driver signing, elevated installation, crash-safe kernel development, and update infrastructure. This prototype uses the more practical Windows desktop approach: route to an existing signed virtual audio cable and expose clear setup controls.
