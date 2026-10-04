import WebSocket from "ws";
import {
  CONTROL_PROTOCOL_VERSION, type ControlCommandArgs, type ControlCommandName, type ControlDiscovery,
  type ControlEvent, type ControlHello, type ControlResult, type ControlServerMessage, type ControlSnapshot,
} from "../../src/lib/controlProtocol";
import { discover, discoveryStatus, protocolLabel, type ConnectionStatus, type DiscoveryFile } from "./discovery";
import { LaunchThrottle } from "./launch";

export type { ConnectionStatus } from "./discovery";
export interface ConnectionOptions {
  discover?: () => Promise<DiscoveryFile | null>;
  launch?: (appPath: string) => void;
  now?: () => number;
  retryMinMs?: number;
  retryMaxMs?: number;
  handshakeTimeoutMs?: number;
}
interface PendingCommand { resolve: (result: ControlResult) => void }

/** One native, loopback session is shared by every visible action and inspector. */
export class Connection {
  status: ConnectionStatus = "not-installed";
  snapshot: ControlSnapshot | null = null;
  private serverProtocol = CONTROL_PROTOCOL_VERSION;
  private discovery: ControlDiscovery | null = null;
  private readonly readDiscovery: () => Promise<DiscoveryFile | null>;
  private readonly launcher: LaunchThrottle;
  private readonly retryMin: number;
  private readonly retryMax: number;
  private retryDelay: number;
  private running = false;
  private generation = 0;
  private socket: WebSocket | null = null;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, PendingCommand>();
  private nextCommand = 0;
  private imageGeneration = 0;
  private readonly images = new Map<string, string | null>();
  private readonly imageRequests = new Map<string, Promise<string | null>>();
  private readonly oversizedImages = new Set<string>();
  private imageQueue: Promise<void> = Promise.resolve();
  private activeImage?: { soundId: string };

  constructor(private readonly version: string, private readonly options: ConnectionOptions = {}) {
    this.readDiscovery = options.discover ?? discover;
    this.launcher = new LaunchThrottle(options.launch, options.now);
    this.retryMin = options.retryMinMs ?? 500;
    this.retryMax = options.retryMaxMs ?? 10_000;
    this.retryDelay = this.retryMin;
  }

  get statusLabel(): string {
    switch (this.status) {
      case "not-installed": return "Not\ninstalled";
      case "disabled": return "Enable\nin app";
      case "offline": return "Offline";
      case "auth-error": return "Re-pair";
      case "protocol-mismatch": return protocolLabel(this.serverProtocol);
      case "connected": return "Connected";
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.notify();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.retryDelay = this.retryMin;
    void this.connect(++this.generation);
  }
  stop(): void {
    this.running = false;
    ++this.generation;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.handshakeTimer);
    clearInterval(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    this.failPending();
    this.invalidateImages(true);
    if (this.status === "connected") this.setStatus("offline");
  }

  private schedule(generation: number): void {
    if (!this.running || generation !== this.generation || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(generation);
    }, this.retryDelay);
    this.reconnectTimer.unref?.();
    this.retryDelay = Math.min(this.retryDelay * 2, this.retryMax);
  }

  private async connect(generation: number): Promise<void> {
    let file: DiscoveryFile | null;
    try { file = await this.readDiscovery(); }
    catch { file = { path: "", state: null }; }
    if (!this.running || generation !== this.generation) return;
    const previous = this.discovery;
    this.discovery = file?.state ?? null;
    const status = discoveryStatus(file);
    this.serverProtocol = file?.state?.protocol ?? CONTROL_PROTOCOL_VERSION;
    if ((status !== "offline" && status !== "protocol-mismatch") || !file?.state) {
      this.setStatus(status);
      this.schedule(generation);
      return;
    }
    // Keep a useful authentication error visible while retrying the same token.
    if (!(status === "offline" && this.status === "auth-error" && previous?.token === file.state.token && previous.port === file.state.port)) {
      this.setStatus(status);
    }
    // Persisted protocol metadata may predate an upgrade. Let the listener
    // establish compatibility, or allow a press to launch it if it is stopped.
    // ws is a native client: no origin option or Origin header is supplied.
    // The discovery bind host is deliberately ignored, including LAN mode.
    const socket = new WebSocket(`ws://127.0.0.1:${file.state.port}/`, {
      perMessageDeflate: false,
      handshakeTimeout: this.options.handshakeTimeoutMs ?? 5000,
      maxPayload: 16 * 1024 * 1024,
    });
    this.socket = socket;
    const current = () => this.running && generation === this.generation && this.socket === socket;
    let alive = true;
    socket.on("pong", () => { alive = true; });
    socket.on("open", () => {
      if (!current()) return socket.terminate();
      const hello: ControlHello = {
        type: "hello", protocol: CONTROL_PROTOCOL_VERSION, token: file.state!.token,
        client: { name: "SoundDeck Stream Deck plugin", version: this.version },
      };
      socket.send(JSON.stringify(hello));
      this.handshakeTimer = setTimeout(() => socket.terminate(), this.options.handshakeTimeoutMs ?? 5000);
      this.handshakeTimer.unref?.();
      // Bound unresponsive sessions without imposing a deadline on media
      // decoding or accepted audio-routing operations.
      this.heartbeatTimer = setInterval(() => {
        if (!current()) return;
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, 30_000);
      this.heartbeatTimer.unref?.();
    });
    socket.on("message", (data, binary) => {
      if (!current()) return;
      try {
        if (binary) return socket.terminate();
        const message = JSON.parse(data.toString()) as ControlServerMessage;
        this.receive(message, socket);
      } catch { socket.terminate(); }
    });
    socket.on("unexpected-response", (_request, response) => {
      // Authentication cooldown and disabled listeners can reject the HTTP
      // upgrade before a WebSocket error message is possible.
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= 64 * 1024) chunks.push(chunk);
        else socket.terminate();
      });
      response.on("error", () => socket.terminate());
      response.on("end", () => {
        if (!current()) return;
        try {
          const message = JSON.parse(Buffer.concat(chunks).toString()) as ControlServerMessage;
          if (message.type === "error") this.receive(message, socket);
        } catch {
          if (response.statusCode === 401 || response.statusCode === 429) this.setStatus("auth-error");
        }
        socket.terminate();
      });
    });
    socket.on("error", (error) => {
      if (!current()) return;
      if ((error as NodeJS.ErrnoException).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") this.rejectPendingImages();
      // A stopped listener supersedes authentication or protocol errors from
      // an earlier attempt, even when discovery still has the same token/port.
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") this.setStatus("offline");
      // Close schedules the next discovery attempt.
    });
    socket.on("close", (code) => {
      if (!current()) return;
      if (code === 1009) this.rejectPendingImages();
      clearTimeout(this.handshakeTimer);
      clearInterval(this.heartbeatTimer);
      this.socket = null;
      this.failPending();
      this.invalidateImages(true);
      if (this.status === "connected") this.setStatus("offline");
      this.schedule(generation);
    });
  }

  private receive(message: ControlServerMessage, socket: WebSocket): void {
    if (message.type === "error") {
      this.serverProtocol = message.protocol;
      this.setStatus(message.code === "protocol-mismatch" ? "protocol-mismatch"
        : message.code === "unauthorized" || message.code === "rate-limited" ? "auth-error"
          : message.code === "disabled" ? "disabled" : "offline");
      socket.close();
    } else if (message.type === "welcome") {
      this.serverProtocol = message.protocol;
      if (message.protocol !== CONTROL_PROTOCOL_VERSION) {
        this.setStatus("protocol-mismatch");
        socket.close();
        return;
      }
      clearTimeout(this.handshakeTimer);
      this.retryDelay = this.retryMin;
      this.invalidateImages(true);
      this.snapshot = message.state;
      this.status = "connected";
      this.notify();
    } else if (message.type === "result") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message);
    } else if (message.type === "event" && this.status === "connected" && this.snapshot) {
      this.applyEvent(message);
      this.notify();
    }
  }

  private applyEvent(event: ControlEvent): void {
    const snapshot = this.snapshot!;
    switch (event.event) {
      case "library.changed":
        this.oversizedImages.clear();
        this.invalidateImages();
        this.snapshot = { ...snapshot, library: event.data, activeBoardId: event.data.activeBoardId };
        break;
      case "board.changed":
        this.snapshot = { ...snapshot, activeBoardId: event.data.activeBoardId, library: { ...snapshot.library, activeBoardId: event.data.activeBoardId } };
        break;
      case "playback.changed": this.snapshot = { ...snapshot, playback: event.data }; break;
      case "settings.changed": this.snapshot = { ...snapshot, settings: event.data }; break;
      case "volumes.changed": this.snapshot = { ...snapshot, volumes: event.data }; break;
    }
  }

  command<Name extends ControlCommandName>(command: Name, args: ControlCommandArgs[Name]): Promise<ControlResult> {
    const id = `c${++this.nextCommand}`;
    if (this.status !== "connected" || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ type: "result", id, ok: false, code: "unavailable" });
    }
    return new Promise((resolve) => {
      // Accepted playback and routing can take longer than five seconds. Only
      // the server can report their outcome; a disconnect fails pending requests
      // and cancels the session's work before the connection is retried.
      this.pending.set(id, { resolve });
      this.socket!.send(JSON.stringify({ type: "command", id, command, args }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.resolve({ type: "result", id, ok: false, code: "unavailable" });
      });
    });
  }

  private failPending(): void {
    for (const [id, pending] of this.pending) {
      pending.resolve({ type: "result", id, ok: false, code: "unavailable" });
    }
    this.pending.clear();
  }
  private invalidateImages(newSession = false): void {
    if (newSession) {
      this.imageQueue = Promise.resolve();
      this.activeImage = undefined;
    }
    ++this.imageGeneration;
    this.images.clear();
    this.imageRequests.clear();
  }
  private rejectPendingImages(): void {
    // Older servers may send an oversized frame before we can read its id.
    // Suppress the in-flight artwork across reconnects, leaving unsent queued
    // images eligible. A library.changed event permits a retry.
    if (this.activeImage) this.oversizedImages.add(this.activeImage.soundId);
  }
  peekImage(soundId: string): string | null | undefined {
    return this.oversizedImages.has(soundId) ? null : this.images.get(soundId);
  }
  getImage(soundId: string): Promise<string | null> {
    if (this.oversizedImages.has(soundId)) return Promise.resolve(null);
    if (this.images.has(soundId)) return Promise.resolve(this.images.get(soundId)!);
    const pending = this.imageRequests.get(soundId);
    if (pending) return pending;
    const generation = this.imageGeneration;
    const active = { soundId };
    // Wait for the previous reply before sending another image on this session.
    // Library invalidation skips obsolete queued work without starting a second
    // reply alongside an image that is still in flight.
    const request = this.imageQueue.then(async () => {
      if (generation !== this.imageGeneration) return null;
      this.activeImage = active;
      const result = await this.command("sound.image", { soundId });
      if (generation !== this.imageGeneration) return null;
      if (!result.ok) {
        if (result.code === "payload-too-large") {
          this.oversizedImages.add(soundId);
          this.notify();
        }
        return null;
      }
      if (!result.data || !("image" in result.data)) return null;
      const image = result.data.image;
      this.images.set(soundId, image);
      this.notify();
      return image;
    }).finally(() => {
      if (this.activeImage === active) this.activeImage = undefined;
      if (this.imageRequests.get(soundId) === request) this.imageRequests.delete(soundId);
    });
    this.imageQueue = request.then(() => undefined, () => undefined);
    this.imageRequests.set(soundId, request);
    return request;
  }
  handleDisconnectedPress(): void {
    if (this.status === "offline" && this.discovery?.appPath) this.launcher.attempt(this.discovery.appPath);
  }
}
