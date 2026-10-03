const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");

const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 41730;
const MAX_PAYLOAD = 64 * 1024;
const MAX_CLIENTS = 64;
const MAX_PENDING_COMMANDS = 32;
const MAX_BUFFERED = 8 * 1024 * 1024;
const SETTING_KEYS = ["micPassthrough", "soundboardToVirtualMic", "noiseSuppressionEnabled", "echoCancellationEnabled", "monitorToHeadphones"];
const VOLUME_BUSES = ["micVirtual", "micMonitor", "soundboardVirtual", "soundboardMonitor"];

function audioState(value) {
  const settings = Object.fromEntries(SETTING_KEYS.map((key) => [key, typeof value?.[key] === "boolean" ? value[key] : key === "monitorToHeadphones"]));
  const volumes = Object.fromEntries(VOLUME_BUSES.map((bus) => [bus, {
    value: Number.isFinite(value?.[`${bus}Volume`]) ? value[`${bus}Volume`] : 1,
    muted: value?.[`${bus}Muted`] === true
  }]));
  return { settings, volumes };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value, allowed) {
  return object(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function text(value, limit = 256) {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}

function id(value) {
  return text(value, 128) && /^[a-zA-Z0-9_-]+$/.test(value);
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function validateCommand(command, args) {
  if (!object(args)) return "invalid-args";
  switch (command) {
    case "sound.play":
      return fields(args, ["soundId", "boardId", "title"]) && id(args.soundId)
        && (args.boardId === undefined || id(args.boardId))
        && (args.title === undefined || text(args.title)) ? null : "invalid-args";
    case "sound.stop":
    case "sound.image":
      return fields(args, ["soundId"]) && id(args.soundId) ? null : "invalid-args";
    case "board.activate":
      return fields(args, ["boardId"]) && id(args.boardId) ? null : "invalid-args";
    case "board.cycle":
      return fields(args, ["direction"]) && (args.direction === undefined || args.direction === 1 || args.direction === -1) ? null : "invalid-args";
    case "setting.set":
      return fields(args, ["key", "value"]) && SETTING_KEYS.includes(args.key) && typeof args.value === "boolean" ? null : "invalid-args";
    case "setting.toggle":
      return fields(args, ["key"]) && SETTING_KEYS.includes(args.key) ? null : "invalid-args";
    case "volume.set":
      return fields(args, ["bus", "value"]) && VOLUME_BUSES.includes(args.bus) && Number.isFinite(args.value) && args.value >= 0 && args.value <= 1 ? null : "invalid-args";
    case "volume.adjust":
      return fields(args, ["bus", "delta"]) && VOLUME_BUSES.includes(args.bus) && Number.isFinite(args.delta) ? null : "invalid-args";
    case "volume.mute":
      return fields(args, ["bus", "muted"]) && VOLUME_BUSES.includes(args.bus) && (args.muted === undefined || typeof args.muted === "boolean") ? null : "invalid-args";
    case "playback.stopAll":
    case "library.get":
      return fields(args, []) ? null : "invalid-args";
    default:
      return "unknown-command";
  }
}

function launcherPath(execPath, platform = process.platform, packaged = false, env = process.env) {
  // Portable Electron runs from a temporary extraction that disappears on exit.
  const portable = env.PORTABLE_EXECUTABLE_FILE;
  if (platform === "win32" && typeof portable === "string"
    && path.win32.isAbsolute(portable) && /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(portable) && /\.exe$/i.test(portable)
    && !/[\x00-\x1f\x7f]/.test(portable)) return portable;
  if (packaged && platform === "darwin") {
    const bundle = execPath.match(/^(.+\.app)\/Contents\/MacOS\/[^/]+$/);
    if (bundle) return bundle[1];
  }
  return execPath;
}

function createExternalControlBridge({
  userData, appVersion, appPath,
  onCommand = () => ({ ok: false, code: "unavailable" }),
  onStateChange = () => {},
  createServer = http.createServer,
  createWebSocketServer = (options) => new WebSocketServer(options),
  fileSystem = fs,
  randomBytes = crypto.randomBytes,
  now = Date.now,
  defaultPort = DEFAULT_PORT,
  helloTimeoutMs = 5000,
  cooldownMs = 30000
}) {
  const stateFile = path.join(userData, "external-control.json");
  let settings = { enabled: false, port: defaultPort, token: "", allowLan: false };
  let error = null;
  let server = null;
  let webSockets = null;
  let initialized = false;
  let stopped = false;
  let queue = Promise.resolve();
  let library = { boards: [] };
  let imageFingerprint = "";
  let libraryPublished = false;
  let documentToken = null;
  let generation = 0;
  let appliedGeneration = 0;

  // Capture ownership when work is requested, before any asynchronous reads.
  function beginUpdate(token = documentToken) {
    if (token !== documentToken) return null;
    return { token, generation: ++generation };
  }

  function ownsDocument(owner) {
    return Boolean(owner && owner.token === documentToken);
  }

  function currentUpdate(owner) {
    return ownsDocument(owner) && owner.generation >= appliedGeneration;
  }

  function setDocument(token) {
    documentToken = token;
    updateLiveState({ playback: [] }, beginUpdate());
  }
  let live = { activeBoardId: "", playback: [] };
  let audio = audioState();
  const images = new Map();
  const clients = new Map();
  const failures = new Map();
  const pendingHttpCommands = new Map();
  const httpControllers = new Set();
  const sessionControllers = new Map();

  function abortCommands(controllers) {
    for (const cancellation of [...(controllers || [])]) cancellation.abort();
  }

  function revokeSession(ws) {
    abortCommands(sessionControllers.get(ws));
    if (clients.delete(ws)) notify();
  }

  function getState() {
    return { ...settings, listening: Boolean(server?.listening), error, clients: [...clients.values()] };
  }

  function notify() {
    onStateChange(getState());
  }

  function getLibrary() {
    return { boards: library.boards, activeBoardId: live.activeBoardId };
  }

  function getSnapshot() {
    return { ...live, library: getLibrary(), ...audio };
  }

  function send(ws, message) {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      revokeSession(ws);
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(message));
  }

  function event(name, data) {
    for (const ws of clients.keys()) send(ws, { type: "event", event: name, data });
  }

  function updateLiveState(state, owner = beginUpdate()) {
    if (!currentUpdate(owner)) return false;
    if (!fields(state, ["activeBoardId", "playback"]) || (state.activeBoardId !== undefined && (typeof state.activeBoardId !== "string"
      || (state.activeBoardId !== "" && !id(state.activeBoardId)))) || !Array.isArray(state.playback)
      || state.playback.length > 4096 || !state.playback.every((voice) => fields(voice, ["soundId", "startedAt", "duration", "loop"])
        && id(voice.soundId) && Number.isFinite(voice.startedAt) && voice.startedAt >= 0
        && Number.isFinite(voice.duration) && voice.duration > 0 && typeof voice.loop === "boolean")) {
      throw new Error("Invalid control state");
    }
    const activeBoardId = state.activeBoardId ?? live.activeBoardId;
    const boardChanged = live.activeBoardId !== activeBoardId;
    const playbackChanged = JSON.stringify(live.playback) !== JSON.stringify(state.playback);
    appliedGeneration = owner.generation;
    live = { activeBoardId, playback: state.playback.map((voice) => ({ ...voice })) };
    if (boardChanged) event("board.changed", { activeBoardId: live.activeBoardId });
    if (playbackChanged) event("playback.changed", live.playback);
    return true;
  }

  function updateLibrary(value, owner = beginUpdate()) {
    if (!currentUpdate(owner)) return false;
    const requestedBoardId = value?.activeBoardId ?? "";
    if (typeof requestedBoardId !== "string" || (requestedBoardId !== "" && !id(requestedBoardId))) throw new Error("Invalid active board");
    const nextAudio = audioState(value?.settings);
    const settingsChanged = JSON.stringify(audio.settings) !== JSON.stringify(nextAudio.settings);
    const volumesChanged = JSON.stringify(audio.volumes) !== JSON.stringify(nextAudio.volumes);
    const boards = (Array.isArray(value?.boards) ? value.boards : []).map((board) => ({
      id: board.id, name: board.name, color: board.color,
      sounds: (Array.isArray(board.sounds) ? board.sounds : []).map((sound) => ({
        id: sound.id, title: sound.title, color: sound.color, hasImage: Boolean(sound.image)
      }))
    }));
    images.clear();
    for (const board of value?.boards || []) {
      for (const sound of board.sounds || []) {
        if (typeof sound.image === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(sound.image)) images.set(sound.id, sound.image);
      }
    }
    const changed = JSON.stringify(library.boards) !== JSON.stringify(boards);
    const activeBoardId = boards.find((board) => board.id === requestedBoardId)?.id || boards[0]?.id || "";
    const boardChanged = live.activeBoardId !== activeBoardId;
    // Images are fetched separately, but replacing one must invalidate client caches.
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify([...images])).digest("hex");
    const imageChanged = imageFingerprint !== fingerprint;
    imageFingerprint = fingerprint;
    appliedGeneration = owner.generation;
    libraryPublished = true;
    library = { boards };
    live = { ...live, activeBoardId };
    audio = nextAudio;
    if (changed || imageChanged) event("library.changed", getLibrary());
    if (boardChanged) event("board.changed", { activeBoardId });
    if (settingsChanged) event("settings.changed", audio.settings);
    if (volumesChanged) event("volumes.changed", audio.volumes);
    return true;
  }

  async function dispatch(command, args, signal) {
    const invalid = validateCommand(command, args);
    if (invalid) return { ok: false, code: invalid };
    if (!settings.enabled || stopped) return { ok: false, code: "disabled" };
    const sounds = library.boards.flatMap((board) => board.sounds);
    if (command === "library.get") return { ok: true, data: getLibrary() };
    if (command.startsWith("sound.")) {
      let sound = sounds.find((candidate) => candidate.id === args.soundId);
      if (!sound && command === "sound.play" && args.boardId && args.title) {
        sound = library.boards.find((board) => board.id === args.boardId)?.sounds.find((candidate) => candidate.title === args.title);
      }
      if (!sound) return { ok: false, code: "not-found" };
      if (command === "sound.image") return { ok: true, data: { image: images.get(sound.id) || null } };
      args = { soundId: sound.id };
    }
    if (command === "board.activate" && !library.boards.some((board) => board.id === args.boardId)) return { ok: false, code: "not-found" };
    try {
      return await onCommand({ command, args }, signal);
    } catch {
      return { ok: false, code: "internal-error" };
    }
  }

  function serial(operation) {
    const pending = queue.then(operation).catch(async (caught) => {
      await closeServer();
      error = { code: caught.code || "initialization-error", message: "Could not initialize or save external control. Check your app data folder." };
      notify();
      return getState();
    });
    queue = pending.catch(() => {});
    return pending;
  }

  async function persist(next = settings) {
    const data = { enabled: next.enabled, protocol: PROTOCOL_VERSION, host: next.allowLan ? "0.0.0.0" : "127.0.0.1",
      port: next.port, token: next.token, allowLan: next.allowLan, appVersion, appPath };
    await fileSystem.mkdir(userData, { recursive: true });
    const temporary = `${stateFile}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fileSystem.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      if (process.platform !== "win32") await fileSystem.chmod(temporary, 0o600);
      await fileSystem.rename(temporary, stateFile);
    } finally {
      await fileSystem.unlink(temporary).catch(() => {});
    }
  }

  async function initialize() {
    if (initialized) return;
    let stored;
    try {
      stored = JSON.parse(await fileSystem.readFile(stateFile, "utf8"));
    } catch (caught) {
      if (caught.code !== "ENOENT" && !(caught instanceof SyntaxError)) throw caught;
    }
    settings = {
      enabled: stored?.enabled === true,
      allowLan: stored?.allowLan === true,
      port: validPort(stored?.port) ? stored.port : defaultPort,
      token: typeof stored?.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(stored.token) ? stored.token : randomBytes(32).toString("base64url")
    };
    await persist();
    initialized = true;
  }

  function isThrottled(address) {
    const record = failures.get(address);
    if (!record) return false;
    if (record.until > now()) return true;
    if (now() - record.at > 60000 || record.until) failures.delete(address);
    return false;
  }

  function authFailure(address) {
    isThrottled(address);
    const record = failures.get(address) || { count: 0, until: 0 };
    record.count += 1;
    record.at = now();
    if (record.count >= 5) record.until = now() + cooldownMs;
    if (failures.size >= 1024 && !failures.has(address)) failures.delete(failures.keys().next().value);
    failures.set(address, record);
  }

  function authenticated(token) {
    // Compare fixed-length digests, including for malformed or missing tokens.
    const expected = crypto.createHash("sha256").update(settings.token).digest();
    const supplied = crypto.createHash("sha256").update(typeof token === "string" ? token : "").digest();
    return crypto.timingSafeEqual(expected, supplied);
  }

  function requestError(req) {
    if (!settings.enabled || stopped) return [503, "disabled"];
    if (Object.hasOwn(req.headers, "origin")) return [403, "forbidden"];
    const port = server?.address()?.port || settings.port;
    if (!settings.allowLan && ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return [403, "forbidden"];
    if (isThrottled(req.socket.remoteAddress)) return [429, "rate-limited"];
    return null;
  }

  function errorMessage(code) {
    return { type: "error", code, message: code, protocol: PROTOCOL_VERSION };
  }

  function respond(res, status, body) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...(status >= 400 ? { Connection: "close" } : {}) });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let bytes = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_PAYLOAD) {
          chunks.length = 0;
          reject(new Error("payload-too-large"));
        } else chunks.push(chunk);
      });
      req.on("error", () => reject(new Error("invalid-args")));
      req.on("aborted", () => reject(new Error("invalid-args")));
      req.on("end", () => {
        if (bytes > MAX_PAYLOAD) return;
        try {
          resolve(bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          reject(new Error("invalid-args"));
        }
      });
    });
  }

  async function handleHttp(req, res) {
    const rejected = requestError(req);
    if (rejected) return respond(res, rejected[0], errorMessage(rejected[1]));
    const authorization = req.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!authenticated(token)) {
      if (token.length > 0) authFailure(req.socket.remoteAddress);
      return respond(res, 401, errorMessage("unauthorized"));
    }
    if (Number(req.headers["content-length"]) > MAX_PAYLOAD) return respond(res, 413, errorMessage("payload-too-large"));
    if (req.method === "GET" && (Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"])) return respond(res, 400, errorMessage("invalid-args"));
    const url = req.url;
    if (/^\/v\d+(?:\/|$)/.test(url) && !url.startsWith("/v1/")) return respond(res, 400, errorMessage("protocol-mismatch"));
    if (req.method === "GET" && url === "/v1/state") return respond(res, 200, getSnapshot());
    if (req.method === "GET" && url === "/v1/library") return respond(res, 200, getLibrary());
    if (req.method !== "POST") return respond(res, 404, errorMessage("not-found"));
    let command;
    let routeArgs = {};
    let allowedBody = [];
    const sound = url.match(/^\/v1\/sounds\/([^/]+)\/(play|stop)$/);
    const board = url.match(/^\/v1\/boards\/([^/]+)\/activate$/);
    const setting = url.match(/^\/v1\/settings\/([^/]+)$/);
    const volume = url.match(/^\/v1\/volumes\/([^/]+)$/);
    if (sound) {
      command = `sound.${sound[2]}`;
      routeArgs = { soundId: sound[1] };
      if (sound[2] === "play") allowedBody = ["boardId", "title"];
    } else if (board) {
      command = "board.activate";
      routeArgs = { boardId: board[1] };
    } else if (url === "/v1/boards/cycle") {
      command = "board.cycle";
      allowedBody = ["direction"];
    } else if (setting) {
      routeArgs = { key: setting[1] };
      allowedBody = ["value", "toggle"];
    } else if (volume) {
      routeArgs = { bus: volume[1] };
      allowedBody = ["value", "delta", "muted", "toggleMute"];
    } else if (url === "/v1/stop-all") command = "playback.stopAll";
    else return respond(res, 404, errorMessage("not-found"));
    const address = req.socket.remoteAddress;
    if ((pendingHttpCommands.get(address) || 0) >= MAX_PENDING_COMMANDS) {
      return respond(res, 503, { ok: false, code: "busy" });
    }
    // Reserve before reading the body so streaming requests share the same bound.
    pendingHttpCommands.set(address, (pendingHttpCommands.get(address) || 0) + 1);
    try {
      const body = await readBody(req);
      if (!fields(body, allowedBody)) return respond(res, 400, errorMessage("invalid-args"));
      let args = { ...body, ...routeArgs };
      if (setting || volume) {
        if (Object.keys(body).length !== 1) return respond(res, 400, errorMessage("invalid-args"));
        if (setting) {
          if (Object.hasOwn(body, "toggle")) {
            if (body.toggle !== true) return respond(res, 400, errorMessage("invalid-args"));
            command = "setting.toggle";
            args = routeArgs;
          } else command = "setting.set";
        } else if (Object.hasOwn(body, "toggleMute")) {
          if (body.toggleMute !== true) return respond(res, 400, errorMessage("invalid-args"));
          command = "volume.mute";
          args = routeArgs;
        } else command = Object.hasOwn(body, "value") ? "volume.set" : Object.hasOwn(body, "delta") ? "volume.adjust" : "volume.mute";
      }
      // Recheck after body receipt: settings/token may change while a request streams.
      if (!settings.enabled || stopped) return respond(res, 503, errorMessage("disabled"));
      if (!authenticated(authorization.slice(7))) return respond(res, 401, errorMessage("unauthorized"));
      // Body/header deadlines still apply; decoding/routing owns the response
      // lifetime once an authenticated command has been fully received.
      res.setTimeout(0);
      const cancellation = new AbortController();
      httpControllers.add(cancellation);
      const disconnected = () => { if (!res.writableFinished) cancellation.abort(); };
      res.once("close", disconnected);
      if (res.destroyed) cancellation.abort();
      let result;
      try {
        result = await dispatch(command, args, cancellation.signal);
      } finally {
        httpControllers.delete(cancellation);
        res.removeListener("close", disconnected);
      }
      const status = result.ok ? 200 : result.code === "not-found" ? 404 : result.code === "busy" || result.code === "unavailable" || result.code === "disabled" ? 503 : result.code === "internal-error" ? 500 : 400;
      respond(res, status, result);
    } catch (caught) {
      respond(res, caught.message === "payload-too-large" ? 413 : 400, errorMessage(caught.message));
    } finally {
      const remaining = pendingHttpCommands.get(address) - 1;
      if (remaining) pendingHttpCommands.set(address, remaining);
      else pendingHttpCommands.delete(address);
    }
  }

  function rejectSocket(ws, code) {
    revokeSession(ws);
    send(ws, errorMessage(code));
    ws.close(1008, code);
    const timer = setTimeout(() => ws.terminate(), 250);
    timer.unref?.();
    ws.once("close", () => clearTimeout(timer));
  }

  function connect(ws, req) {
    const address = req.socket.remoteAddress;
    const pendingCommands = new Set();
    sessionControllers.set(ws, pendingCommands);
    const timer = setTimeout(() => rejectSocket(ws, "unauthorized"), helloTimeoutMs);
    timer.unref?.();
    ws.on("error", () => revokeSession(ws));
    ws.on("close", () => {
      clearTimeout(timer);
      revokeSession(ws);
      sessionControllers.delete(ws);
    });
    ws.on("message", async (data, binary) => {
      if (ws.readyState !== 1) return;
      let message;
      try {
        if (binary) throw new Error();
        message = JSON.parse(data.toString());
      } catch {
        clearTimeout(timer);
        rejectSocket(ws, "invalid-message");
        return;
      }
      if (!clients.has(ws)) {
        clearTimeout(timer);
        if (isThrottled(address)) return rejectSocket(ws, "rate-limited");
        if (message?.type !== "hello") return rejectSocket(ws, "invalid-message");
        if (Number.isInteger(message.protocol) && message.protocol !== PROTOCOL_VERSION) return rejectSocket(ws, "protocol-mismatch");
        const hasToken = typeof message.token === "string" && message.token.length > 0;
        if (!fields(message, ["type", "protocol", "token", "client"])
          || !Number.isInteger(message.protocol) || (message.token !== undefined && (typeof message.token !== "string" || message.token.length > 256))
          || !fields(message.client, ["name", "version"]) || !text(message.client.name, 128) || !text(message.client.version, 64)) {
          if (hasToken) authFailure(address);
          return rejectSocket(ws, "invalid-message");
        }
        if (!authenticated(message.token)) {
          if (hasToken) authFailure(address);
          return rejectSocket(ws, "unauthorized");
        }
        clients.set(ws, { name: message.client.name, version: message.client.version });
        send(ws, { type: "welcome", protocol: PROTOCOL_VERSION, app: { version: appVersion }, state: getSnapshot() });
        notify();
        return;
      }
      if (!fields(message, ["type", "id", "command", "args"]) || message.type !== "command" || !id(message.id) || typeof message.command !== "string") {
        return rejectSocket(ws, "invalid-message");
      }
      if (pendingCommands.size >= MAX_PENDING_COMMANDS) {
        send(ws, { type: "result", id: message.id, ok: false, code: "busy" });
        return;
      }
      const cancellation = new AbortController();
      pendingCommands.add(cancellation);
      try {
        const result = await dispatch(message.command, message.args, cancellation.signal);
        send(ws, { type: "result", id: message.id, ...result });
      } finally {
        pendingCommands.delete(cancellation);
      }
    });
  }

  async function closeServer(code = "disabled") {
    const oldServer = server;
    const oldSockets = webSockets;
    server = null;
    webSockets = null;
    abortCommands(httpControllers);
    for (const ws of oldSockets?.clients || []) {
      revokeSession(ws);
      send(ws, errorMessage(code));
      ws.terminate();
    }
    clients.clear();
    oldSockets?.close();
    if (oldServer) {
      const closed = new Promise((resolve) => oldServer.close(resolve));
      oldServer.closeAllConnections?.();
      await closed;
    }
    notify();
  }

  async function listen() {
    if (!settings.enabled || stopped || server) return;
    error = null;
    const listener = createServer((req, res) => { void handleHttp(req, res); });
    const sockets = createWebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    server = listener;
    webSockets = sockets;
    listener.requestTimeout = 10000;
    listener.headersTimeout = 10000;
    listener.setTimeout(10000, (socket) => socket.destroy());
    listener.on("upgrade", (req, socket, head) => {
      // HTTP no longer handles socket errors once an upgrade reaches us.
      socket.on("error", () => socket.destroy());
      const rejected = requestError(req) || (req.url !== "/" ? [404, "not-found"] : null)
        || (sockets.clients.size >= MAX_CLIENTS ? [503, "busy"] : null);
      if (rejected) {
        const body = JSON.stringify(errorMessage(rejected[1]));
        socket.end(`HTTP/1.1 ${rejected[0]} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => socket.destroy());
        return;
      }
      sockets.handleUpgrade(req, socket, head, (ws) => {
        sockets.emit("connection", ws, req);
      });
    });
    sockets.on("connection", connect);
    sockets.on("error", () => {});
    try {
      await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(settings.port, settings.allowLan ? "0.0.0.0" : "127.0.0.1", () => {
          listener.removeListener("error", reject);
          resolve();
        });
      });
      listener.on("error", () => { error = { code: "listen-error", message: "External control listener failed." }; void closeServer(); });
      if (stopped) return closeServer();
      if (settings.port === 0) {
        settings.port = listener.address().port;
        await persist();
      }
    } catch (caught) {
      await closeServer();
      error = { code: caught.code || "listen-error", message: caught.code === "EADDRINUSE" ? "Port is already in use. Choose another port." : "Could not start external control." };
    }
    notify();
  }

  function start(loadLibrary) {
    stopped = false;
    const owner = { token: documentToken, generation };
    const hadLibrary = libraryPublished;
    return serial(async () => {
      await initialize();
      if (loadLibrary && !hadLibrary) {
        try {
          const value = await loadLibrary();
          updateLibrary(value, owner);
        } catch (caught) {
          // A failed obsolete read cannot take a newer renderer cache offline.
          if (currentUpdate(owner)) throw caught;
        }
      }
      error = null;
      await listen();
      notify();
      return getState();
    });
  }

  function stop() {
    stopped = true;
    return closeServer();
  }

  function getSettings() {
    return serial(async () => {
      await initialize();
      return getState();
    });
  }

  function setSettings(patch) {
    return serial(async () => {
      await initialize();
      if (!fields(patch, ["enabled", "port", "allowLan"]) || (patch.port !== undefined && !validPort(patch.port))
        || (patch.enabled !== undefined && typeof patch.enabled !== "boolean") || (patch.allowLan !== undefined && typeof patch.allowLan !== "boolean")) {
        return { ...getState(), error: { code: "invalid-settings", message: "Enter a port from 1 to 65535." } };
      }
      const next = { ...settings, ...patch };
      await persist(next);
      settings = next;
      await closeServer();
      error = null;
      await listen();
      notify();
      return getState();
    });
  }

  function regenerateToken() {
    return serial(async () => {
      await initialize();
      const next = { ...settings, token: randomBytes(32).toString("base64url") };
      await persist(next);
      settings = next;
      abortCommands(httpControllers);
      for (const ws of webSockets?.clients || []) rejectSocket(ws, "unauthorized");
      clients.clear();
      notify();
      return getState();
    });
  }

  return { start, stop, getState, getSettings, setSettings, regenerateToken, beginUpdate, setDocument, updateLibrary, updateLiveState, getSnapshot };
}

module.exports = { createExternalControlBridge, launcherPath, PROTOCOL_VERSION, DEFAULT_PORT };
