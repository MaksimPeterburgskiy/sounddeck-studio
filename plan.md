# Cross-Platform Plan

This plan describes how to move SoundDeck Studio from a Windows-first Electron
app to a supported Windows, macOS, and Linux app. It focuses on virtual
microphone routing, packaging, hotkeys, release infrastructure, permissions,
and product/documentation work.

## Executive Decision

Keep the current Web Audio architecture. The app already routes monitor and
virtual buses with `AudioContext.setSinkId()` in `src/lib/audioEngine.ts`, which
is the right cross-platform seam as long as the OS exposes a suitable virtual
output device.

Use these default virtual microphone strategies and make them seamless inside
each platform build:

| Platform | Recommended default | Why |
| --- | --- | --- |
| Windows | Existing VB-CABLE installer path | Already implemented and gives a paired `CABLE Input` output plus `CABLE Output` input. |
| macOS | Signed/notarized SoundDeck installer package that bundles BlackHole 2ch | Gives the closest Windows-like experience: install SoundDeck, get a ready virtual mic, auto-select it in the app. This assumes SoundDeck is GPL-3.0 compatible or has a separate BlackHole license. |
| Linux | Installed `.deb`/`.rpm` builds with a managed SoundDeck virtual mic helper | The package installs SoundDeck and the helper; the app creates/selects `SoundDeck Sink` and `SoundDeck Mic` automatically in the user's PipeWire/PulseAudio session. |

The app should not show cross-OS setup recipes in normal product UI. Each build
should know its platform, ship only the relevant virtual-audio integration, show
only that platform's device instructions, and automatically select the right
virtual output after install or first launch. Corsair/iCUE support should be
disabled from Linux builds and hidden from Linux UI because Corsair states iCUE
is not supported on Linux.

## Current App Constraints

The current app has these platform assumptions:

- `package.json` has one `dist` script that deletes `release`, fetches VB-CABLE,
  generates NSIS artwork, builds the renderer, and runs `electron-builder --win`.
- `package.json` build config only declares `win` and `nsis`, and global
  `extraResources` includes `build/vbcable` and `build/icon.ico`.
- `.github/workflows/ci.yml` runs only on `windows-latest`.
- `.github/workflows/release.yml` runs only on `windows-latest` and publishes
  only Windows `.exe` artifacts.
- `src/lib/devices.ts` detects only audio outputs matching `/cable input/i`.
- `src/main.tsx` says the virtual mic sink is always VB-CABLE and the setup copy
  is Windows-specific.
- `electron/main.cjs` uses `.ico` for the tray icon on every platform.
- `electron/main.cjs` treats auto-update as an NSIS-only installed-app feature.
- `electron/hotkeys.cjs` depends on `uiohook-napi`, which needs macOS
  permission UX and Linux X11/Wayland validation.
- `electron/corsair.cjs` gracefully handles missing `cue-sdk`, but the product
  currently presents Corsair G-keys as a general capability.

## Virtual Microphone Model

SoundDeck does not need to become a kernel/audio-driver project for v1. The app
should keep this architecture:

1. SoundDeck renders soundboard and passthrough audio through Web Audio.
2. The monitor bus targets the user's headphones.
3. The virtual bus targets an OS virtual output device with
   `AudioContext.setSinkId(deviceId)`.
4. Other apps select the paired virtual input/source as their microphone.

Important terminology:

- SoundDeck selects an `audiooutput` device as the virtual output/sink.
- Discord, OBS, games, and meeting apps select an `audioinput` device as the
  virtual microphone/source.
- Most virtual cable products expose a paired output/input, but labels differ by
  OS and tool.

## macOS Virtual Mic Options

| Option | Ease of implementation | Customization and integration | License permissiveness | Install/distribution friction | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Bundled BlackHole 2ch | Medium. Build or vendor BlackHole 2ch, sign the HAL driver, install it from the SoundDeck `.pkg`, detect it on first launch, and route Web Audio with `setSinkId`. | Medium. 2ch is enough for SoundDeck's virtual mic path and works well with simple monitoring. Deeper customization is possible only by maintaining a BlackHole fork. | Low unless SoundDeck is GPL-3.0 compatible or gets a separate license from Existential Audio. If bundled under GPL-3.0, publish corresponding source, notices, and build/install scripts. | Medium-high. Requires admin installer, `/Library/Audio/Plug-Ins/HAL`, Developer ID signing, installer signing, notarization, and update discipline. | Chosen macOS path. This is the macOS equivalent of bundling VB-CABLE on Windows. |
| VB-CABLE for macOS | Low to medium once installed and visible to Chromium. | Low. Simple cable model, proprietary labels, extra cables are separate products. | Low for bundling because it is proprietary/donationware unless we obtain permission. | Medium to high. External installer and redistribution uncertainty. | Do not use in SoundDeck's default macOS build. |
| Loopback | Low if already installed. | Very high for user-managed complex routing. | Low for bundling because it is commercial proprietary. | High. Paid app and admin install. | Do not use in SoundDeck's default macOS build. |
| Background Music | Medium to high. More of a system/app volume utility than a clean SoundDeck virtual cable. | Low to medium. Built around system audio capture and app volume, not SoundDeck-owned routing. | Low to medium. GPL-2.0-or-later plus Apple sample-code components. | Medium. Extra app/driver behavior and support burden. | Do not use. |
| Soundflower | Low once installed, but high support burden. | Low. Legacy fixed virtual devices. | High because it is MIT. | High. Legacy macOS/Apple Silicon/kext-era issues. | Do not use. |
| Native Aggregate Device | Medium if created manually; high if created automatically through a native helper. | Medium. Good for combining a physical mic and virtual source into one input, but it still needs BlackHole as the loopback member. | High because it is native macOS functionality. | Medium if automated; manual Audio MIDI Setup is not acceptable for the seamless target. | Optional later enhancement only. Not the default virtual mic. |
| Native Multi-Output Device | Medium if created manually; high if created automatically through a native helper. | Low to medium. Mirrors audio to speakers and BlackHole for monitoring, but it still needs BlackHole. | High because it is native macOS functionality. | Medium if automated; manual Audio MIDI Setup is not acceptable for the seamless target. | Optional later enhancement only. Not the default virtual mic. |
| First-party CoreAudio virtual driver | Very high. Requires native driver/plugin work, installer, signing, notarization, and OS-version QA. | Very high. Best branded zero-config future. | Depends on implementation. | Very high. Driver distribution and macOS security requirements. | Later-stage product investment only. |

macOS decision: the SoundDeck macOS installer bundles BlackHole 2ch, installs it
system-wide, and the app auto-selects it as the virtual output. The normal
macOS UI should not ask users to install BlackHole, Loopback, VB-CABLE, or
Soundflower themselves. If BlackHole is missing or broken, show a SoundDeck
repair/reinstall action, not generic third-party setup instructions.

### Can SoundDeck Use Aggregate Or Multi-Output Devices Directly?

Yes, but they do not replace BlackHole, VB-CABLE, Loopback, or another virtual
audio driver.

Aggregate Devices and Multi-Output Devices are CoreAudio composite devices. They
combine devices that already exist; they do not create a new loopback input by
themselves. That means:

- A Multi-Output Device can duplicate SoundDeck output to headphones and
  BlackHole at the same time. It is useful for monitoring.
- An Aggregate Device can expose one combined device made from a physical mic
  and BlackHole. It is useful when an app wants one input device containing both
  voice and soundboard channels.
- Neither one creates the missing virtual microphone. If the aggregate or
  multi-output device does not include BlackHole, VB-CABLE, Loopback, or another
  loopback-capable device, Discord/OBS/games still have no SoundDeck microphone
  input to select.

There is no stable Apple-provided command-line tool equivalent to "create this
Aggregate Device / Multi-Output Device with these members." Audio MIDI Setup is
the user-facing tool. Programmatic creation is possible through CoreAudio APIs
such as `AudioHardwareCreateAggregateDevice`, so SoundDeck can later ship a
small native macOS helper to create/remove a named SoundDeck Aggregate Device or
SoundDeck Multi-Output Device. That helper still needs BlackHole as a member.
For the seamless v1 target, SoundDeck should route directly to bundled
BlackHole 2ch and use the app's existing monitor bus for local monitoring.

## Linux Virtual Mic Options

| Option | Ease of implementation | Customization and integration | License permissiveness | Install/distribution friction | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Managed PipeWire/PulseAudio helper using `pactl` | High. Package SoundDeck with a helper that runs in the user session, creates `SoundDeck Sink` and `SoundDeck Mic`, and auto-selects the sink in SoundDeck. | Medium. Good enough for seamless soundboard-to-mic routing. Works with PipeWire-Pulse and classic PulseAudio. | High to medium-high. Shelling out to host tools avoids linking/distribution concerns. | Medium. Installed packages can include dependencies and app code, but the actual audio nodes must be created in the user's session, usually on first launch. | Chosen Linux v1 path. |
| Native PipeWire loopback / virtual nodes | Medium. Use `pw-loopback`, `libpipewire-module-loopback`, or WirePlumber/user config. | Very high. Best graph-native long-term option with metadata, channel maps, routing policy, and latency control. | High to medium-high. PipeWire is mostly MIT with documented LGPL/GPL exceptions. CLI/config use is low risk. | Medium. Common on modern distros, but not universal on older installs. | Phase 2 backend after the `pactl` helper is stable. |
| Classic PulseAudio null sink/remap source | High through the same helper. | Medium. Mature and scriptable, but less modern. | Medium-high. PulseAudio is LGPL; CLI use is straightforward. | Low on older Ubuntu/Mint/Debian systems. | Compatibility mode inside the chosen helper. |
| JACK / PipeWire-JACK | Low to medium. Powerful but too specialized for mainstream users. | Very high for pro audio users. | Medium. JACK server is GPL, library is LGPL. | High. Requires JACK graph mental model and packages. | Not part of the default app. |
| ALSA `snd-aloop` | Low for app integration, high for user setup. Kernel module creates loopback card. | Low. Primitive format/channel/rate behavior. | Medium. Kernel driver GPL, `alsa-lib` LGPL. | High. Often needs `modprobe`, persistent config, and admin/root setup. | Not part of the default app. |
| Flatpak package | Medium for normal playback, high for creating host virtual devices. | Medium. Sandbox makes host audio graph management awkward. | Depends on backend. | High for virtual mic management. Broad audio socket permissions and host helper needs make the seamless target harder. | Not a first release target. |
| Installed `.deb`/`.rpm` packages | Medium. Install SoundDeck, desktop integration, helper files, and dependencies; app creates user-session audio nodes on launch. | Good. Best fit for an Electron app that needs host audio integration and an installed auto-updating build. | Depends on bundled code. | Medium. Requires distro QA and update metadata. | Chosen Linux packaging path. |

Linux decision: the SoundDeck Linux package installs the app plus a managed
audio helper. On first launch, or when virtual mic is enabled, SoundDeck creates
`SoundDeck Sink` and `SoundDeck Mic` in the current user's PipeWire/PulseAudio
session, auto-selects `SoundDeck Sink` as the virtual output, and verifies that
`SoundDeck Mic` is visible as the target-app microphone. Users should not need
to copy `pactl`, `pw-loopback`, JACK, or ALSA commands from docs for the normal
path.

## Required Product Changes

### Routing Settings

Add a stored setting:

- `virtualOutputDeviceId`: selected `audiooutput` device id for the virtual mic
  bus.
- `virtualOutputMode`: `managed` by default for installed Windows, macOS, and
  Linux builds.
- `virtualBackend`: `windows-vbcable`, `macos-bundled-blackhole`,
  `linux-managed-pactl`, or `linux-managed-pipewire`.

Migration:

- Existing libraries have no virtual output setting.
- On Windows, continue auto-detecting `CABLE Input` and write the selected id at
  runtime if found.
- On macOS, auto-detect bundled `BlackHole 2ch` and select it. If missing, show
  a SoundDeck repair/reinstall path.
- On Linux, create or detect `SoundDeck Sink` and select it. If creation fails,
  show a platform-specific diagnostic and retry path.

### Device Detection

Replace `findCableInputDeviceId()` with a platform-aware detector:

- Windows labels: `CABLE Input`, `VB-Audio Virtual Cable`.
- macOS labels: bundled `BlackHole 2ch` only for the managed path.
- Linux labels: managed `SoundDeck Sink` output and managed `SoundDeck Mic`
  input.

Return structured candidates:

```ts
interface VirtualAudioCandidate {
  platform: "win32" | "darwin" | "linux";
  backend: string;
  outputDeviceId: string;
  outputLabel: string;
  expectedInputLabel: string;
  confidence: "managed" | "known" | "possible";
  recommended: boolean;
}
```

The detector can still log other virtual devices for diagnostics, but the
normal UI should prefer the platform-managed SoundDeck device and avoid showing
unrelated third-party choices unless an advanced troubleshooting mode is added.

### Setup UX

The Devices panel should be platform-specific and mostly automatic:

- Windows build: show VB-CABLE status and Windows-only repair guidance.
- macOS build: show bundled BlackHole status, installer/repair status, and the
  selected `BlackHole 2ch` route.
- Linux build: show `SoundDeck Sink` / `SoundDeck Mic` status and a retry/repair
  action for the managed helper.
- All platforms: show health checks for output selected, `setSinkId` succeeded,
  paired input visible, mic passthrough permission granted, and target app
  instruction using that platform's device name.

Do not show BlackHole instructions in Windows/Linux builds, VB-CABLE
instructions in macOS/Linux builds, or PipeWire/PulseAudio command instructions
in Windows/macOS builds. The app should detect its OS/build and display only the
relevant managed integration.

### Linux Managed Helper

Add an Electron main-process module, for example `electron/linuxAudio.cjs`, with
automatic managed creation, detection, repair, and removal:

- Detect backend:
  - `pactl info` and `Server Name` for PulseAudio versus PipeWire-Pulse.
  - `pw-cli --version` or `pw-loopback --version` for native PipeWire support.
  - `XDG_CURRENT_DESKTOP`, `XDG_SESSION_TYPE`, and package availability only for
    diagnostics, not hard requirements.
- MVP create flow:
  - `pactl load-module module-null-sink sink_name=sounddeck_sink sink_properties=device.description=SoundDeck Sink`
  - load `module-remap-source` so target apps see a clean `SoundDeck Mic`
    instead of asking users to pick `Monitor of SoundDeck Sink`.
  - optionally load `module-loopback` from the user's physical mic into the sink
    only if we decide to move mic mixing out of Web Audio. For v1, keep mic
    mixing inside SoundDeck's Web Audio graph.
- Track module ids returned by `pactl load-module` in user data so "Remove
  SoundDeck virtual mic" can unload only modules SoundDeck created.
- Never run commands with elevated privileges.
- The package postinstall should not try to create per-user audio nodes from a
  root context. The installed app should create/repair them from the user's
  session on first launch or when virtual mic is enabled.
- The normal path should be automatic and reversible: if `SoundDeck Sink` or
  `SoundDeck Mic` is missing on launch, recreate it; if the user disables
  virtual mic integration, unload only SoundDeck-created modules.

### Hotkeys

Keep `uiohook-napi` for current advanced combos, but add platform fallbacks and
permission UX:

- Windows: keep current engine.
- macOS: detect `uiohook` start failure and show a direct explanation for
  Accessibility/Input Monitoring permission. Provide a "retry hotkeys" action
  after permission changes.
- Linux X11: validate `uiohook-napi` support in CI/manual QA.
- Linux Wayland: add fallback to Electron `globalShortcut` for simple
  accelerators, and start the app with Electron's `GlobalShortcutsPortal`
  feature flag where appropriate.
- Surface per-hotkey capability status: `advanced-hook`, `globalShortcut`,
  `unsupported-on-this-session`.

### Corsair/iCUE

- Windows: keep current feature.
- macOS: keep optional only if `cue-sdk` and iCUE actually work in packaged app
  testing.
- Linux: do not include Corsair in the build surface. Hide G-key binding UI and
  do not start the bridge. Corsair states iCUE is not supported on Linux.

Implementation detail:

- Add `isCorsairSupportedPlatform()` in `electron/corsair.cjs` or main process.
- Treat Linux G-key accelerators as invalid/unavailable with a clear reason.
- Consider moving `cue-sdk` to an optional dependency or platform-gated dynamic
  dependency if Linux install/build friction appears.

## Packaging And Release Plan

### Build Scripts

Split package scripts:

```json
{
  "dist": "pnpm run dist:win",
  "dist:win": "node -e \"fs.rmSync('release', { recursive: true, force: true })\" && node scripts/fetch-vbcable.mjs && node scripts/make-installer-art.mjs && pnpm run build && electron-builder --win",
  "dist:mac": "node -e \"fs.rmSync('release', { recursive: true, force: true })\" && node scripts/build-blackhole.mjs && pnpm run build && electron-builder --mac",
  "dist:linux": "node -e \"fs.rmSync('release', { recursive: true, force: true })\" && pnpm run build && electron-builder --linux"
}
```

Later, replace the inline `node -e` cleanup with a small cross-platform script.

### electron-builder Config

Move platform resources into platform-only config:

- VB-CABLE resource only for Windows installer builds.
- BlackHole 2ch driver/package resources only for macOS `.pkg` builds.
- Linux helper files only for Linux `.deb`/`.rpm` builds.
- `.ico` only for Windows, `.icns` for macOS, and PNG icon directory for Linux.

Recommended targets:

- Windows: `nsis` and `portable` as today.
- macOS: signed/notarized `pkg` for the installed build because BlackHole must
  install outside `/Applications`; signed `dmg` can wrap/distribute the pkg if
  desired. Do not call macOS stable until the app, driver, and installer are
  signed/notarized.
- Linux: installed `deb` and `rpm` builds with electron-updater metadata enabled.
  Avoid Snap/Flatpak for the first version because managed virtual audio needs
  host session integration.

### macOS Bundled BlackHole Installer

The macOS release must be one installer flow:

1. Build or vendor the exact BlackHole 2ch source release used by SoundDeck.
2. Sign `BlackHole2ch.driver`.
3. Include GPL-3.0 notices, BlackHole copyright notices, corresponding source,
   and build/install scripts in the release.
4. Build a SoundDeck `.pkg` that installs:
   - `SoundDeck.app` into `/Applications`.
   - `BlackHole2ch.driver` into `/Library/Audio/Plug-Ins/HAL`.
5. Run postinstall repair steps only as needed, such as refreshing CoreAudio or
   telling the user when a restart is required.
6. Sign and notarize the installer package.
7. On first launch, SoundDeck detects `BlackHole 2ch`, selects it as
   `virtualOutputDeviceId`, and verifies `setSinkId()`.

If SoundDeck remains MIT or any other non-GPL-compatible distribution, obtain a
separate license from Existential Audio before bundling BlackHole. If the
project accepts GPL-3.0 distribution, make the app license and release artifacts
match that decision.

### CI

Change `.github/workflows/ci.yml` to a matrix:

- `windows-latest`
- `macos-latest`
- `ubuntu-latest`

Run:

- `pnpm install --frozen-lockfile`
- `pnpm run build`
- `pnpm test`

Add package smoke jobs after build config lands:

- Windows: `pnpm run dist:win -- --publish never` or direct
  `electron-builder --win --publish never`.
- macOS: unsigned packaging smoke on PRs; signed/notarized `.pkg` in release.
- Linux: package smoke for `.deb` and `.rpm`; install smoke on Ubuntu/Fedora
  containers or VMs where practical.

### Release Workflow

Use separate jobs per OS:

1. Version/tag job on one runner.
2. Windows package job on `windows-latest`.
3. macOS package job on `macos-latest`.
4. Linux package job on `ubuntu-latest`.
5. Release notes job that lists platform-specific artifacts and known
   limitations.

Auto-update policy:

- Windows: keep NSIS auto-update.
- macOS: installed build must auto-update after Developer ID signing and
  notarization are in place. Electron-builder notes macOS apps must be signed
  for auto-update.
- Linux: installed `.deb` and `.rpm` builds must auto-update through
  electron-updater release metadata. Validate this end-to-end before calling
  Linux stable.

## Step-By-Step Implementation Plan

### Phase 0: Baseline And Risk Removal

1. Add this plan and open tracking issues for packaging, audio routing, hotkeys,
   Linux helper, macOS setup, docs, and QA.
2. Add platform CI matrix for install/build/test.
3. Make `pnpm install` pass on macOS and Linux. If `cue-sdk` or `uiohook-napi`
   blocks Linux, move the problematic dependency to optional/platform-gated
   loading.
4. Split `dist:win`, `dist:mac`, and `dist:linux`.
5. Move platform-specific resources out of global `extraResources`.
6. Decide and document the GPL-3.0 or separate-license path for bundled
   BlackHole before shipping macOS artifacts.

Exit criteria:

- CI passes on Windows, macOS, and Ubuntu for build/test.
- Windows packaging still produces the same installer/portable artifacts.
- macOS packaging uses BlackHole resources and does not try to fetch VB-CABLE or
  run NSIS.
- Linux packaging includes Linux helper resources and does not include VB-CABLE,
  BlackHole, or Corsair integration.

### Phase 1: OS-Specific Device Management

1. Add platform IPC, for example `app:getPlatform`, so renderer copy and
   capabilities can branch cleanly.
2. Add `virtualOutputDeviceId` and migration logic to the library settings.
3. Replace `findCableInputDeviceId()` with structured virtual audio candidate
   detection.
4. Update `AudioEngine.configure()` calls to use the chosen
   `virtualOutputDeviceId`, not just auto VB-CABLE detection.
5. Make Devices render one OS-specific managed route:
   - Windows: VB-CABLE.
   - macOS: bundled BlackHole 2ch.
   - Linux: managed `SoundDeck Sink` / `SoundDeck Mic`.
6. Add automatic selection logic after device enumeration and after helper
   repair/install actions.
7. Hide third-party/manual device pickers from normal UI. Keep any manual picker
   behind an advanced troubleshooting affordance only if needed.

Exit criteria:

- On Windows, existing VB-CABLE flow still works.
- On macOS, a user who installs SoundDeck gets BlackHole 2ch installed, selected
  automatically, and usable as the virtual mic route.
- On Linux, a user who installs SoundDeck gets `SoundDeck Sink` / `SoundDeck Mic`
  created automatically from the app and selected automatically.

### Phase 2: Linux Managed Virtual Mic MVP

1. Add `electron/linuxAudio.cjs`.
2. Add IPC:
   - `linuxAudio:getStatus`
   - `linuxAudio:createVirtualMic`
   - `linuxAudio:removeVirtualMic`
   - `linuxAudio:listModules`
3. Implement `pactl` detection with timeout and clear error handling.
4. Implement create/remove for `SoundDeck Sink` and `SoundDeck Mic`.
5. Store only module ids created by SoundDeck.
6. Add UI repair action to recreate/remove the Linux virtual mic if health
   checks fail.
7. Add tests around command parsing and generated command arguments. Mock
   process spawning; do not run host audio commands in unit tests.

Exit criteria:

- On PipeWire-Pulse and classic PulseAudio, SoundDeck can create a virtual mic
  without root.
- SoundDeck can remove only its own modules.
- App restart detects existing SoundDeck-created devices and reuses them.
- If the nodes are missing after a PulseAudio/PipeWire restart, SoundDeck
  recreates them and reselects `SoundDeck Sink`.

### Phase 3: macOS Bundled BlackHole Installer

1. Add `scripts/build-blackhole.mjs` or equivalent release script that produces
   the chosen BlackHole 2ch driver artifact from a pinned source version.
2. Add GPL/source/notice artifacts to macOS release output.
3. Configure a macOS `.pkg` build that installs `SoundDeck.app` and
   `BlackHole2ch.driver`.
4. Sign the app, driver, and installer; notarize and staple the installer.
5. Add first-launch detection and repair:
   - If `BlackHole 2ch` is present, select it automatically.
   - If missing, show "Repair SoundDeck audio driver" and route users to the
     SoundDeck installer/repair path.
6. Add a "test virtual mic" action that plays a short generated tone through the
   virtual bus and shows whether `setSinkId` succeeded.

Exit criteria:

- A fresh macOS tester installs one SoundDeck package and sees the virtual mic
  ready in the app without manual BlackHole setup.
- The installed app auto-selects BlackHole 2ch.
- Missing or damaged BlackHole is handled through SoundDeck repair guidance.
- Auto-update works on the signed installed app.

### Phase 4: Hotkeys And Platform Capabilities

1. Add capability reporting from the main process:
   - hotkey engine available
   - advanced combo support
   - Electron `globalShortcut` fallback available
   - Corsair available
   - managed virtual mic available
2. Add `globalShortcut` fallback engine for simple accelerators.
3. Add macOS permission UX for accessibility/input monitoring failures.
4. Add Linux Wayland guidance and portal fallback where available.
5. Hide Corsair G-key UI on Linux.

Exit criteria:

- Hotkeys fail with actionable platform-specific reasons instead of generic
  `hotkey-engine-unavailable`.
- Simple hotkeys work on macOS and at least one Linux desktop session.
- Advanced combinations remain available where `uiohook-napi` works.

### Phase 5: Native PipeWire Backend

1. Add native PipeWire option behind a feature flag.
2. Detect `pw-loopback` and PipeWire version.
3. Create a named virtual sink/source using PipeWire-native loopback.
4. Compare latency and reliability against the `pactl` backend.
5. Promote native PipeWire to preferred backend only after it beats `pactl` in
   reliability across Fedora, Ubuntu, Debian, Arch, and Linux Mint.

Exit criteria:

- Native PipeWire is better documented and lower latency than the MVP backend.
- Fallback to `pactl` remains intact.

### Phase 6: Release Hardening And Auto-Update

1. Add macOS icons, app category, entitlements, hardened runtime, signing, and
   notarization configuration.
2. Add Linux `.desktop` metadata, category, icons, maintainer/vendor fields,
   and package descriptions.
3. Make tray/menu behavior platform-specific:
   - Windows/Linux: close-to-tray can stay.
   - macOS: normal menu bar behavior and Dock expectations should be reviewed.
4. Verify `youtube-dl-exec` unpack paths on macOS/Linux.
5. Verify auto-update end-to-end for Windows NSIS, macOS signed installed build,
   Linux `.deb`, and Linux `.rpm`.
6. Update README, CONTRIBUTING, and release notes with support matrix that
   describes the seamless installed path per OS, not manual third-party setup.

Exit criteria:

- Public artifacts exist for Windows, macOS, and Linux.
- macOS build is signed/notarized and auto-updates before being called stable.
- Linux `.deb` and `.rpm` install, auto-update, and recreate/select managed
  audio devices on supported distros.
- Release notes list feature parity and known platform limitations.

## QA Matrix

Minimum human QA matrix before public beta:

| Area | Windows | macOS | Linux |
| --- | --- | --- | --- |
| App starts packaged | Windows 10, Windows 11 | Intel and Apple Silicon if possible | Ubuntu LTS, Fedora current, Linux Mint/Debian-family |
| Import/play sounds | Required | Required | Required |
| Monitor output selection | Required | Required | Required |
| Virtual mic output | Bundled VB-CABLE | Bundled BlackHole 2ch | Managed `SoundDeck Sink` / `SoundDeck Mic` |
| Mic passthrough | Required | Required | Required |
| Global hotkeys | `uiohook-napi` | permission flow plus working hotkey | X11 and Wayland/fallback behavior |
| Tray/menu behavior | Required | macOS menu/Dock reviewed | common GNOME/KDE trays reviewed |
| URL download | `yt-dlp.exe` | `yt-dlp` binary/path | `yt-dlp` binary/path |
| Auto-update | NSIS installed app | signed/notarized installed build | installed `.deb` and `.rpm` builds |
| Device page copy | Windows-only | macOS-only | Linux-only |

## Open Decisions

- Whether SoundDeck will be distributed under GPL-3.0 for macOS builds that
  bundle BlackHole, or whether to obtain a separate BlackHole license.
- Whether to keep `cue-sdk` as a normal dependency on Windows/macOS or move it to
  optional platform-specific handling. It should not ship as a Linux feature.
- Whether Linux should add native PipeWire as the preferred backend after the
  `pactl` managed helper is stable.
- Whether to add AppImage after installed `.deb`/`.rpm` auto-updating builds are
  stable. AppImage is not part of the initial seamless installed target.
- Whether a future first-party CoreAudio virtual driver is worth the maintenance
  burden after bundled BlackHole ships.

## Research Sources

- Electron-builder overview and targets: https://www.electron.build/docs/
- Electron-builder CLI target behavior: https://www.electron.build/docs/cli/
- Electron-builder Linux targets: https://www.electron.build/docs/linux/
- Electron-builder auto-update targets and macOS signing requirement:
  https://www.electron.build/docs/features/auto-update/
- Electron-builder macOS pkg target:
  https://www.electron.build/docs/pkg/
- Electron `globalShortcut`: https://www.electronjs.org/docs/latest/api/global-shortcut
- Electron `autoUpdater` platform notes:
  https://electronjs.org/docs/latest/api/auto-updater
- MDN `AudioContext.setSinkId()`:
  https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/setSinkId
- Chrome Web Audio output routing:
  https://developer.chrome.com/blog/audiocontext-setsinkid
- BlackHole: https://github.com/ExistentialAudio/BlackHole
- VB-Audio Virtual Cable: https://vb-audio.com/Cable/
- Rogue Amoeba Loopback: https://rogueamoeba.com/loopback/
- Background Music: https://github.com/kyleneideck/BackgroundMusic
- Soundflower: https://github.com/mattingalls/Soundflower
- Apple Aggregate Device setup: https://support.apple.com/en-us/102171
- Apple Multi-Output Device setup:
  https://support.apple.com/guide/audio-midi-setup/play-audio-through-multiple-devices-at-once-ams7c093f372/mac
- Apple CoreAudio server driver plugin:
  https://developer.apple.com/documentation/coreaudio/creating-an-audio-server-driver-plug-in
- PipeWire loopback module: https://docs.pipewire.org/page_module_loopback.html
- PipeWire PulseAudio modules:
  https://docs.pipewire.org/page_man_pipewire-pulse-modules_7.html
- PulseAudio modules:
  https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/User/Modules/
- PipeWire license: https://github.com/PipeWire/pipewire/blob/master/LICENSE
- PulseAudio license: https://github.com/pulseaudio/pulseaudio/blob/master/LICENSE
- JACK API/license: https://jackaudio.org/api/
- ALSA loopback: https://www.alsa-project.org/wiki/Matrix%3AModule-aloop
- ALSA library license: https://github.com/alsa-project/alsa-lib/blob/master/COPYING
- Flatpak sandbox permissions: https://docs.flatpak.org/en/latest/sandbox-permissions.html
- AppImage Electron sandboxing:
  https://docs.appimage.org/user-guide/troubleshooting/electron-sandboxing.html
- Corsair iCUE compatibility:
  https://help.corsair.com/hc/en-us/articles/360040957051-iCUE-Compatibility-and-installation-requirements
