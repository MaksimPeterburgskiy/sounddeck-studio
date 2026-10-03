# SoundDeck Studio Stream Deck plugin

Ten keypad actions: Play sound, Stop all, Switch to board, Cycle boards,
Toggle setting, Board slot, Next page, Previous page, Volume, and Volume mute.
Volume dial supports Stream Deck + and other encoder devices. Requires Stream Deck 7.1+
(including Virtual Stream Deck for keys) and SoundDeck Studio with
**Settings → External control** enabled. Play sound and Board slot use
`sound.press` on key down and `sound.release` on key up. The sound's Tap/Hold
trigger mode in the app decides whether releasing stops playback. Each key has
its own press, so keys bound to the same Hold sound remain independent. Leaving
the key's page releases it; disconnecting releases all presses on that session.

Board slot defaults to **Auto (by position)** and **Follow active board**.
Visible auto slots on each device are grouped by board binding: Follow active
board keys form one group, and keys pinned to the same board form another. Each
group is ordered by row, then column; other actions and fixed-slot keys do not
consume positions. Follow keys and pinned keys remain separate even when they
represent the same board. Choose a fixed slot (1–n) to ignore
paging, or pin a board to keep that key on one board. Auto slots on pinned boards
still page with the other auto slots on their device. Empty slots are blank and
do nothing; a missing board shows a warning.

Next page and Previous page show the current page (for example, **2 / 4**) and
are dimmed at the ends, where pressing does not advance the page. Each device keeps
its own requested page index, including inside folders and on multi-page profiles.
Each group uses its own visible auto-slot count as its page size and advances by
that many sounds.
The device uses the largest page count among its groups, so every represented
board stays fully reachable; shorter groups show empty slots on later pages.
The displayed page is clamped to the currently available pages without changing
the requested index, so restoring a larger board or layout restores that page
regardless of key appearance timing. Pressing either paging key saves a new request
from the displayed page, including at the ends. Switching the active board resets
every device to page 1. Fixed slots never affect page counts.
Board slot, Next page, and Previous page are unavailable in multi-actions because
they depend on the visible device layout. Use Play sound for multi-actions.

Volume and Volume mute select one of four buses: Mic → virtual mic,
Mic → headphones, Soundboard → virtual mic, or Soundboard → headphones.
Keys wrap the bus label (Mic/Board → Virtual/Phones) across two lines and show
the stored percentage above it. Volume offers up/down only, using a 1–25% step
(default 5%) and repeating after 400 ms at 8 Hz while held. Release, page changes,
effective settings changes, and disconnects stop repeating; reading unchanged
settings leaves held-key repeats running. Up/down multi-action steps adjust once.

Volume mute preserves the level and toggles mute. Its two multi-action states
honor the selected Mute or Unmute state. Muted keys show a grey icon and “Muted”
label; up/down keys keep their mode icons, and only the mute key lights its ring.

Volume dial rotates by 2% per tick by default (configurable from 1–25%). Each
dial serializes rotations, presses, and touch taps in input order; only consecutive
same-direction ticks coalesce while an acknowledgement is pending. Reversals
retain their order at volume limits. Pressing the dial or tapping its touch strip
toggles mute. Effective bus/step changes discard pending input; unchanged settings
reads preserve it. Disconnecting or leaving the page discards pending input.
The built-in `$B1` layout shows the bus name (or the user's custom title), percentage,
and level bar; muted buses show “Muted” with the preserved level in grey.
Live app changes update both keys and dials. Offline feedback uses the same
connection labels as keys, with an empty grey bar. Only press/tap launches the app
while offline; rotating does nothing. Dial behavior is unit-tested; hardware
verification is still needed because Virtual Stream Deck provides keys only.

From the repository root:

```sh
pnpm install
pnpm run build:streamdeck
pnpm --filter @sounddeck/streamdeck-plugin validate
pnpm test
```

The root test suite includes this package's tests. Run only plugin tests with
`pnpm --filter @sounddeck/streamdeck-plugin test`. Root app builds stay separate.

For local development, enable Stream Deck developer mode, build, and link:

```sh
cd streamdeck-plugin
pnpm exec streamdeck dev
pnpm build
pnpm run link
pnpm watch
# After a rebuild, in another terminal:
pnpm run restart
```

Create a Virtual Stream Deck in Stream Deck's device selector, drag the actions
onto its canvas, and choose boards/sounds/settings in the property inspector.
Verify a sound's title/image and progress, Stop all lighting, active board
highlighting, and a setting changed from either the app or the key. Re-import a
board and check title fallback. Close the app completely, press a key, and check
that it launches hidden; that first press is intentionally dropped.
Set a sound's trigger mode to Hold and verify release/fade-out, two keys holding
the same sound, changing pages while held, and disconnect/reconnect while held.
Add auto slots around control/fixed keys, page a large board, switch boards, pin
a board, and enter a folder or another Stream Deck page. Check that slot order
uses only visible auto slots and that paging another device stays independent.

Check volume up/down taps and holds, mute from both the key and app, and mute
states in multi-actions. On an encoder device, check rapid rotation in both
directions, press/tap mute, live level feedback, and reconnect feedback.

The committed manifest disables Node debugging. For local development only,
set `Nodejs.Debug` to `"enabled"` in your local manifest and use `pnpm watch`,
which emits source maps. Attach VS Code to the plugin process. Restore that
manifest change before a production build or pack; production builds reject
debugging. Logs persist outside the plugin folder: macOS uses
`~/Library/Logs/SoundDeck Studio/streamdeck`, Windows uses
`%LOCALAPPDATA%/SoundDeck Studio/logs/streamdeck`, and Linux uses
`$XDG_STATE_HOME/SoundDeck Studio/logs/streamdeck` (default `~/.local/state`).
The SDK rotates ten log files. Debug sessions also log to the debugger console.
Property inspectors can be inspected at `http://localhost:23654/` while visible.
For a development Electron app, start the app normally before using the plugin;
its discovered executable path alone cannot select this repository's entrypoint.
Offline launching accepts absolute `.app` paths on macOS and fully qualified
`.exe` paths on Windows. Portable Windows builds persist the original portable
launcher rather than the temporary extracted Electron executable.

The plugin discovers `external-control.json` in both `sounddeck-studio` and
`SoundDeck Studio` user-data folders, choosing the newest file. It uses one
native WebSocket session to `127.0.0.1`, without Origin, and rereads discovery on
retries. It does not follow the app's `SOUNDDECK_USER_DATA` development override;
use its standard user-data folder for manual development checks. Linux/OpenDeck
uses the XDG configuration folder on a best-effort basis.

The property inspectors bundle sdpi-components **v4.0.1**, pinned to upstream
commit `06185f14529f890a35cda283be1ec1b1445c7c58`, in `ui/sdpi-components.js`.
Its MIT license is included as `ui/sdpi-components.LICENSE`; the bundled Lit
license is also included in that file. Inspectors work without internet access.
They receive library summaries and connection labels from the plugin; authentication tokens never go into action
settings or the inspector.

The Rollup setup mirrors Elgato's CLI template. This package uses TypeScript 6
because `@rollup/plugin-typescript` requires the JavaScript compiler API removed
in TypeScript 7; the root app keeps its existing TypeScript version. Releases use
only the root app package version. The committed manifest `Version` is a
development placeholder; builds validate its four-component numeric format
(`x.y.z.n`), without requiring it to match either package version. Builds embed
the root app version in memory, and packing stamps a copy of the manifest under
the ignored `dist/` staging directory. Stable versions map to `x.y.z.99999`, and
betas to `x.y.z.n`; tracked files remain unchanged.

Builds embed `__PLUGIN_DISTRIBUTION__`, defaulting to `"github"` for our packs.
A Marketplace build must set `STREAMDECK_DISTRIBUTION=marketplace` when building
or packing. The plugin reports this marker as optional `client.distribution` in
its protocol-1 hello. App-managed updates require a connected `"github"` plugin;
Marketplace clients and unknown provenance, including manifest-only detection,
receive no update offer. No distribution marker is added to the manifest.

SDK v2 reads the manifest during registration and normally logs to the plugin
folder. Two build-time adaptations embed the manifest metadata and select a
per-user rotating file log target. The running bundle therefore never reads its
manifest or writes inside its plugin folder, including when protected by Marketplace DRM.
Review these adaptations when upgrading the SDK. Generated `bin/` output is
ignored; `pnpm run pack` produces a local `.streamDeckPlugin` for later packaging.

This package is MIT licensed; the app retains its existing license.

References: [Elgato SDK](https://docs.elgato.com/streamdeck/sdk/),
[CLI](https://docs.elgato.com/streamdeck/cli/intro),
[sdpi-components](https://sdpi-components.dev/docs/components/select).
