# External control API v1

Enable **External control** in Settings. The API is off by default; no server listens while disabled. HTTP and WebSocket share port **41730**, configurable in Settings. An occupied or invalid port shows an error there. The default listener binds only to `127.0.0.1`.

Copy the persistent token from Settings. **Regenerate** replaces it and disconnects all WebSocket clients. Enabling **Allow connections from other devices** binds to `0.0.0.0`; HTTP and WebSocket traffic, including the token, travels unencrypted on the network.

## Discovery file

The app writes `<userData>/external-control.json` at startup and whenever external control settings change. POSIX permissions are `0600`; Windows uses the user's application-data directory and its ACLs. Tokens are separate from the sound library and board exports.

The current package's Electron application name is `sounddeck-studio`, so default locations are:

| OS | File |
| --- | --- |
| macOS | `~/Library/Application Support/sounddeck-studio/external-control.json` |
| Windows | `%APPDATA%\sounddeck-studio\external-control.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/sounddeck-studio/external-control.json` |

The directory follows [Electron's userData application-name rules](https://www.electronjs.org/docs/latest/api/app#appgetpathname). A build using `SoundDeck Studio` as its application name uses that folder instead. Development can override the directory with `SOUNDDECK_USER_DATA`.

```json
{
  "enabled": false,
  "protocol": 1,
  "host": "127.0.0.1",
  "port": 41730,
  "token": "<32 random bytes, base64url>",
  "allowLan": false,
  "appVersion": "0.1.22",
  "appPath": "/Applications/SoundDeck Studio.app"
}
```

`appPath` is the installed `.app` bundle on macOS or executable on Windows (the Electron executable in development). `host` is the bind address; when it is `0.0.0.0`, local clients connect to `127.0.0.1` and remote clients use the computer's network address. `enabled` records the preference, not listener health: a port conflict can leave an enabled installation offline. Read this file for discovery; change settings through the app.

## Security and limits

Native clients must omit `Origin`: every HTTP request or WebSocket upgrade carrying that header is rejected, even an empty header or `null`. In local mode, `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>`. Browser pages cannot use this API.

Five failed authentication attempts with nonempty credentials from one remote address trigger a 30-second cooldown, shared across HTTP and WebSocket. Missing credentials and hello timeouts do not count toward the cooldown. Messages and HTTP bodies are limited to 64 KiB. WebSocket input must be text JSON. At most 64 WebSocket sessions, including unauthenticated sessions, are admitted. Unknown fields, commands and invalid argument types are rejected. At most 4096 unreleased presses are admitted. IDs, including press IDs, contain only letters, digits, `_` and `-`, up to 128 characters. Titles are nonempty strings up to 256 characters. No command accepts file paths.

Each authenticated WebSocket session admits at most **32 pending commands**. HTTP admits at most **32 pending POST commands per remote client address**, shared across connections and including requests still receiving their bodies. Additional commands return `busy` without being queued or dispatched: WebSocket replies use the command's correlation ID and leave the session open; HTTP replies use status **503** and `{ok:false,code:"busy"}`. Capacity is restored when pending work settles, including failed or cancelled commands. `sound.press` shares this limit while its command is pending; a successfully started press does not consume pending-command capacity while held. HTTP GET snapshots remain available at the limit.

## WebSocket

Connect to `ws://127.0.0.1:41730/` and send a valid hello within **5 seconds**:

```json
{"type":"hello","protocol":1,"token":"YOUR_TOKEN","client":{"name":"My controller","version":"1.0"}}
```

`protocol` must be an integer. Client name (up to 128 characters) and version (up to 64 characters) are required and appear in Settings. Strings must not contain control characters.

The server replies:

```json
{"type":"welcome","protocol":1,"app":{"version":"0.1.22"},"state":{"activeBoardId":"board-a","playback":[],"library":{"activeBoardId":"board-a","boards":[]},"settings":{"micPassthrough":false,"soundboardToVirtualMic":false,"noiseSuppressionEnabled":false,"echoCancellationEnabled":false,"monitorToHeadphones":true},"volumes":{"micVirtual":{"value":1,"muted":false},"micMonitor":{"value":1,"muted":false},"soundboardVirtual":{"value":1,"muted":false},"soundboardMonitor":{"value":1,"muted":false}}}}
```

A snapshot contains `activeBoardId`, `playback`, `library`, `settings` (the five audio toggles), and `volumes` (each bus's stored level and mute state). Library data is:

```json
{"activeBoardId":"board-a","boards":[{"id":"board-a","name":"Main","color":"#1db7a6","sounds":[{"id":"sound-a","title":"Airhorn","color":"#1db7a6","hasImage":true}]}]}
```

Send commands with a correlation ID (same character/length limits as other IDs) and an `args` object, including `{}` for commands without arguments:

```json
{"type":"command","id":"c7","command":"sound.play","args":{"soundId":"sound-a","boardId":"board-a","title":"Airhorn"}}
```

Responses carry the same ID:

```json
{"type":"result","id":"c7","ok":true}
{"type":"result","id":"c7","ok":false,"code":"not-found"}
```

A successful `sound.play` or `sound.press` result confirms the sound's tap/retrigger action after the latest tracked audio route configuration, including device refresh and preferred-device retries, settles, not audio completion. If no output route is enabled for the sound, it returns `unavailable`. Disconnecting cancels that client’s plays that have not started; tap voices already started continue, while held voices are released. Stops cancel earlier queued plays, while later plays remain queued. Other playback/board results acknowledge dispatch to the app. `sound.play` respects tap/retrigger behavior; `sound.press` additionally honors Hold trigger mode.

Setting/volume mutations run in renderer receipt order, one at a time. Results include the values applied and saved by the renderer and wait for tracked audio configuration, including device refresh and preferred-device retries, to settle. Setting/volume commands, `sound.play`, and `sound.press` have a five-second receipt timeout: a late delivery returns `unavailable` without being applied. Once received, they have no completion timeout; renderer loss or reset fails pending requests. Disconnecting cancels that client’s queued mutations that have not been applied; an applied mutation finishes saving and configuring audio even if its client disconnects.

Commands that change app state return `busy` while a hotkey is being captured (except releases) and `unavailable` if the renderer is absent or still initializing, including during a reload; cached library/image queries still work.

| Command | Args | Result data |
| --- | --- | --- |
| `sound.play` | `soundId`, optional `boardId`, `title` | — |
| `sound.press` | `soundId`, `pressId`, optional `boardId`, `title` | — |
| `sound.release` | `pressId` | — |
| `sound.stop` | `soundId` | — |
| `playback.stopAll` | `{}` | — |
| `board.activate` | `boardId` | — |
| `board.cycle` | Optional `direction`: `1` (default) or `-1` | — |
| `library.get` | `{}` | Library summary in `data` |
| `sound.image` | `soundId` | `data: {"image":"data:image/png;base64,..."}`; `image: null` if no custom image |
| `setting.set` | `key`, `value`: boolean | `data: {key,value}` |
| `setting.toggle` | `key` | `data: {key,value}` |
| `volume.set` | `bus`, `value`: number from 0 to 1 | `data: {bus,value,muted}` |
| `volume.adjust` | `bus`, `delta`: finite number | `data: {bus,value,muted}` |
| `volume.mute` | `bus`, optional `muted`: boolean | `data: {bus,value,muted}` |

`sound.play` and `sound.press` resolve the sound ID first. If it is missing, an exact title match within the supplied board is used; the first matching sound in board order wins. This lets saved bindings survive a board re-import. If neither resolves, the result is `not-found`. `sound.stop` stops every voice for that ID; it does not use fallback lookup. Cycling wraps around in either direction.

For a Hold sound, `sound.press` always starts a fresh voice, ignoring Retrigger while honoring Solo play. Its matching `sound.release` stops only that press's voice with the sound's fade-out; overlapping presses remain independent. A release received while queued, configuring routes, or decoding cancels the press before its voice starts. Loops sustain while held. For a Tap sound, press behaves exactly like `sound.play`, and release has no playback effect. Unknown or already released press IDs succeed without doing anything.

WebSocket press IDs belong to their session: clients may use the same ID independently, but reusing an unreleased ID within a session returns `invalid-args`. Send release on the same connection; all its unreleased presses are released when it disconnects. Disabling or reconfiguring the listener, regenerating the token, and app shutdown also release outstanding presses.

```json
{"type":"command","id":"down","command":"sound.press","args":{"soundId":"sound-a","pressId":"key-1"}}
{"type":"command","id":"up","command":"sound.release","args":{"pressId":"key-1"}}
```

Setting keys are `micPassthrough`, `soundboardToVirtualMic`, `noiseSuppressionEnabled`, `echoCancellationEnabled`, and `monitorToHeadphones`. Volume buses map to the app's controls as follows:

| Bus | App control |
| --- | --- |
| `micVirtual` | Microphone volume sent to the virtual mic |
| `micMonitor` | Microphone volume sent to headphones |
| `soundboardVirtual` | Soundboard volume sent to the virtual mic |
| `soundboardMonitor` | Soundboard volume sent to headphones |

`volume.adjust` adds `delta` to the stored level and clamps the result to 0–1; `volume.set` rejects values outside that range. Setting or adjusting a muted bus's volume unmutes it, including a zero delta. Mute preserves the stored level and applies zero gain; `volume.mute` toggles mute when `muted` is omitted. Changes persist and update the app UI and audio routing through the same settings path as in-app controls.

```json
{"type":"command","id":"c8","command":"setting.toggle","args":{"key":"micPassthrough"}}
{"type":"result","id":"c8","ok":true,"data":{"key":"micPassthrough","value":true}}
{"type":"command","id":"c9","command":"volume.adjust","args":{"bus":"soundboardVirtual","delta":-0.05}}
{"type":"result","id":"c9","ok":true,"data":{"bus":"soundboardVirtual","value":0.95,"muted":false}}
```

Events go to every authenticated WebSocket client:

```json
{"type":"event","event":"board.changed","data":{"activeBoardId":"board-b"}}
{"type":"event","event":"playback.changed","data":[{"soundId":"sound-a","startedAt":1700000000000,"duration":2.5,"loop":false}]}
```

| Event | `data` |
| --- | --- |
| `library.changed` | Full library summary; also sent when an image changes, so clients can invalidate image caches |
| `board.changed` | `{activeBoardId}` |
| `playback.changed` | Array of `{soundId, startedAt, duration, loop}`; an empty array means playback stopped |
| `settings.changed` | Full object of the five audio toggle values, matching snapshot `settings` |
| `volumes.changed` | Full object of the four buses, each `{value,muted}`, matching snapshot `volumes` |

Audio settings and volume events are emitted whenever their values change through the API, app UI, or library load. Unchanged values do not emit duplicate events. Clients should use command correlation IDs independently of events; an event can arrive before the corresponding result.

Each playback entry represents a voice, so overlapping voices can repeat a sound ID. `startedAt` is epoch milliseconds; `duration` is effective clip length in seconds, accounting for trim, playback rate and pitch. Clients can animate progress locally without polling. Live pitch changes adjust duration and the time origin to preserve progress. Loops repeat over this duration. Fade-out tails follow the app's existing stopped-state behavior.

## HTTP

Every endpoint requires `Authorization: Bearer <token>`. GET responses are the snapshot/library directly. POST responses are `{ok:true}`, `{ok:true,data}` for setting/volume changes and sound presses, or `{ok:false,code}`. A successful sound press returns `{ok:true,data:{pressId}}` with a server-generated ID. JSON bodies may be omitted for commands with no body arguments. Headers and bodies have a 10-second receive deadline; a fully received command has no socket inactivity timeout while playback preparation or an audio mutation is pending.

| Method | Path | JSON body |
| --- | --- | --- |
| GET | `/v1/state` | — |
| GET | `/v1/library` | — |
| POST | `/v1/sounds/{id}/play` | Optional `{boardId,title}` fallback |
| POST | `/v1/sounds/{id}/press` | Optional `{boardId,title}` fallback; returns `{ok:true,data:{pressId}}` |
| POST | `/v1/presses/{pressId}/release` | `{}` |
| POST | `/v1/sounds/{id}/stop` | `{}` |
| POST | `/v1/stop-all` | `{}` |
| POST | `/v1/boards/{id}/activate` | `{}` |
| POST | `/v1/boards/cycle` | Optional `{direction:1}` or `{direction:-1}` |
| POST | `/v1/settings/{key}` | Exactly one of `{value:true}`, `{value:false}`, or `{toggle:true}` |
| POST | `/v1/volumes/{bus}` | Exactly one of `{value:number}`, `{delta:number}`, `{muted:true}`, `{muted:false}`, or `{toggleMute:true}` |

Settings and volume bodies require exactly one field; empty bodies, extra fields, and combinations are rejected. `toggle` and `toggleMute` accept only `true`. All argument validation and result data are shared with WebSocket commands.

Release an HTTP press using the returned ID. HTTP presses survive normal request/connection completion so release can use a separate request. An abandoned press response is released immediately. Any HTTP press left unreleased is automatically released after **5 minutes**, including its fade-out. Use WebSocket for holds longer than this or for automatic release when a controller disconnects. HTTP releases cannot release WebSocket presses, and WebSocket releases cannot release HTTP presses.

```sh
TOKEN='paste-token-from-settings'
BASE='http://127.0.0.1:41730'
curl -H "Authorization: Bearer $TOKEN" "$BASE/v1/state"
curl -H "Authorization: Bearer $TOKEN" "$BASE/v1/library"
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/sounds/sound-a/play"
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/sounds/sound-a/press"
# Replace PRESS_ID with the press response's ID.
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/presses/PRESS_ID/release"
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/sounds/sound-a/stop"
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/stop-all"
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/boards/board-a/activate"
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"direction":-1}' "$BASE/v1/boards/cycle"
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":true}' "$BASE/v1/settings/micPassthrough"
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"toggle":true}' "$BASE/v1/settings/monitorToHeadphones"
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":0.75}' "$BASE/v1/volumes/soundboardVirtual"
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"delta":-0.05}' "$BASE/v1/volumes/micMonitor"
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"muted":true}' "$BASE/v1/volumes/micVirtual"
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"toggleMute":true}' "$BASE/v1/volumes/soundboardMonitor"
```

## Errors and versioning

Session/HTTP errors use `{type:"error",code,message,protocol:1}`; WebSocket command failures use the correlated `result` shape. Failed authentication, malformed session messages, handshake timeout and version mismatch close the WebSocket. Invalid command arguments return a failed result and leave an authenticated session open.

| Code | Meaning / HTTP status |
| --- | --- |
| `unauthorized` | Missing or invalid token / 401 |
| `forbidden` | Origin present or local Host invalid / 403 |
| `rate-limited` | Authentication cooldown / 429 |
| `disabled` | External control disabled / no listener, or 503 for an in-flight request |
| `protocol-mismatch` | Unsupported protocol or HTTP version / 400, server version included |
| `invalid-message` | Malformed WebSocket envelope, hello, binary or invalid JSON message |
| `invalid-args` | Invalid command arguments or HTTP JSON / 400 |
| `unknown-command` | Command not recognized |
| `not-found` | Sound, board or endpoint missing / 404 |
| `payload-too-large` | Body exceeds 64 KiB / 413; oversized WS frames close with code 1009 |
| `busy` | Hotkey capture active, session capacity reached, or pending command limit reached / 503 |
| `unavailable` | Renderer unavailable or still initializing / 503 |
| `internal-error` | Command could not be dispatched / 500 |

There is **no stability promise**. Additive changes retain the integer protocol number; breaking changes bump it. The server supports exactly one version. A hello with a different integer protocol is rejected before validating that version's fields or credentials, without counting an authentication failure. A mismatch includes the server's `protocol` so a client can report which side needs updating. HTTP paths carry the same version (`/v1`). Shared TypeScript definitions live in `src/lib/controlProtocol.ts` and have no Electron or React dependency.
