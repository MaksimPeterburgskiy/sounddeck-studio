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

Five failed authentication attempts from one remote address trigger a 30-second cooldown, shared across HTTP and WebSocket. Messages and HTTP bodies are limited to 64 KiB. WebSocket input must be text JSON. At most 64 WebSocket sessions, including unauthenticated sessions, are admitted. Unknown fields, commands and invalid argument types are rejected. IDs contain only letters, digits, `_` and `-`, up to 128 characters. Titles are nonempty strings up to 256 characters. No command accepts file paths.

## WebSocket

Connect to `ws://127.0.0.1:41730/` and send a valid hello within **5 seconds**:

```json
{"type":"hello","protocol":1,"token":"YOUR_TOKEN","client":{"name":"My controller","version":"1.0"}}
```

`protocol` must be an integer. Client name (up to 128 characters) and version (up to 64 characters) are required and appear in Settings. Strings must not contain control characters.

The server replies:

```json
{"type":"welcome","protocol":1,"app":{"version":"0.1.22"},"state":{"activeBoardId":"board-a","playback":[],"library":{"activeBoardId":"board-a","boards":[]}}}
```

A snapshot contains `activeBoardId`, `playback`, and `library`. Library data is:

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

A successful playback/board result acknowledges dispatch to the app, not audio completion. Commands respect the sound's existing tap/retrigger behavior. Trigger commands return `busy` while a hotkey is being captured and `unavailable` if the renderer is absent; cached library/image queries still work.

| Command | Args | Result data |
| --- | --- | --- |
| `sound.play` | `soundId`, optional `boardId`, `title` | — |
| `sound.stop` | `soundId` | — |
| `playback.stopAll` | `{}` | — |
| `board.activate` | `boardId` | — |
| `board.cycle` | Optional `direction`: `1` (default) or `-1` | — |
| `library.get` | `{}` | Library summary in `data` |
| `sound.image` | `soundId` | `data: {"image":"data:image/png;base64,..."}`; `image: null` if no custom image |

`sound.play` resolves the sound ID first. If it is missing, an exact title match within the supplied board is used; the first matching sound in board order wins. This lets saved bindings survive a board re-import. If neither resolves, the result is `not-found`. `sound.stop` stops every voice for that ID; it does not use fallback lookup. Cycling wraps around in either direction.

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

Each playback entry represents a voice, so overlapping voices can repeat a sound ID. `startedAt` is epoch milliseconds; `duration` is effective clip length in seconds, accounting for trim, playback rate and pitch. Clients can animate progress locally without polling. Live pitch changes adjust duration and the time origin to preserve progress. Loops repeat over this duration. Fade-out tails follow the app's existing stopped-state behavior.

## HTTP

Every endpoint requires `Authorization: Bearer <token>`. GET responses are the snapshot/library directly. POST responses are `{ok:true}` or `{ok:false,code}`. JSON bodies may be omitted for commands with no body arguments.

| Method | Path | JSON body |
| --- | --- | --- |
| GET | `/v1/state` | — |
| GET | `/v1/library` | — |
| POST | `/v1/sounds/{id}/play` | Optional `{boardId,title}` fallback |
| POST | `/v1/sounds/{id}/stop` | `{}` |
| POST | `/v1/stop-all` | `{}` |
| POST | `/v1/boards/{id}/activate` | `{}` |
| POST | `/v1/boards/cycle` | Optional `{direction:1}` or `{direction:-1}` |

```sh
TOKEN='paste-token-from-settings'
BASE='http://127.0.0.1:41730'
curl -H "Authorization: Bearer $TOKEN" "$BASE/v1/state"
curl -H "Authorization: Bearer $TOKEN" "$BASE/v1/library"
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/sounds/sound-a/play"
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/sounds/sound-a/stop"
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/stop-all"
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/v1/boards/board-a/activate"
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"direction":-1}' "$BASE/v1/boards/cycle"
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
| `busy` | Hotkey capture active, or session capacity reached / 503 |
| `unavailable` | Renderer unavailable / 503 |
| `internal-error` | Command could not be dispatched / 500 |

There is **no stability promise**. Additive changes retain the integer protocol number; breaking changes bump it. The server supports exactly one version. A mismatch includes the server's `protocol` so a client can report which side needs updating. HTTP paths carry the same version (`/v1`). Shared TypeScript definitions live in `src/lib/controlProtocol.ts` and have no Electron or React dependency.
