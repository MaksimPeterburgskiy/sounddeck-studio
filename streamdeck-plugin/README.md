# SoundDeck Studio Stream Deck plugin

Five keypad actions: Play sound, Stop all, Switch to board, Cycle boards, and
Toggle setting. Requires Stream Deck 7.1+ (including Virtual Stream Deck) and
SoundDeck Studio with **Settings → External control** enabled. Play sound uses
`sound.play` on key down; key up does nothing until the separate hold feature.

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

Node debugging is enabled in the manifest. Use VS Code's **Debug: Attach to Node
Process**, selecting the plugin process. Stream Deck assigns an available Node
inspector port; for a fixed Chrome/VS Code target, locally set `Nodejs.Debug` to
`--inspect=127.0.0.1:12345` and attach to that port. Logs use the debugger console.
Property inspectors can be inspected at `http://localhost:23654/` while visible.
For a development Electron app, start the app normally before using the plugin;
its discovered executable path alone cannot select this repository's entrypoint.

The plugin discovers `external-control.json` in both `sounddeck-studio` and
`SoundDeck Studio` user-data folders, choosing the newest file. It uses one
native WebSocket session to `127.0.0.1`, without Origin, and rereads discovery on
retries. It does not follow the app's `SOUNDDECK_USER_DATA` development override;
use its standard user-data folder for manual development checks. Linux/OpenDeck
uses the XDG configuration folder on a best-effort basis.

The property inspectors use the official template's sdpi-components v4 CDN;
they need internet access on initial load. They receive library summaries and
connection labels from the plugin; authentication tokens never go into action
settings or the inspector.

The Rollup setup mirrors Elgato's CLI template. This package uses TypeScript 6
because `@rollup/plugin-typescript` requires the JavaScript compiler API removed
in TypeScript 7; the root app keeps its existing TypeScript version. Plugin and
app package versions currently match; update both when versioning this plugin.
Build-time version injection also updates the numeric manifest version.

SDK v2 reads the manifest during registration and normally logs to the plugin
folder. Two build-time adaptations embed the manifest metadata and select a
console log target. The running bundle therefore never reads its manifest or
writes inside its plugin folder, including when protected by Marketplace DRM.
Review these adaptations when upgrading the SDK. Generated `bin/` output is
ignored; `pnpm run pack` produces a local `.streamDeckPlugin` for later packaging.

This package is MIT licensed; the app retains its existing license.

References: [Elgato SDK](https://docs.elgato.com/streamdeck/sdk/),
[CLI](https://docs.elgato.com/streamdeck/cli/intro),
[sdpi-components](https://sdpi-components.dev/docs/components/select).
