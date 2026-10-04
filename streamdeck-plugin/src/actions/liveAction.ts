import streamDeck, {
  SingletonAction, type KeyAction, type DialAction, type FeedbackPayload, type WillAppearEvent, type WillDisappearEvent,
  type DidReceiveSettingsEvent, type KeyDownEvent, type PropertyInspectorDidAppearEvent,
  type PropertyInspectorDidDisappearEvent, type SendToPluginEvent, type TitleParametersDidChangeEvent,
} from "@elgato/streamdeck";
import type { ControlCommandArgs, ControlCommandName, ControlLibrary, ControlResult } from "../../../src/lib/controlProtocol";
import type { Connection } from "../connection";
import { keyTitle } from "../render/keyTitle";
import { keyImage, type KeyTitleLayout } from "../render/keyImage";
import type { ActionSettings } from "../settings";

type Visual = Parameters<typeof keyImage>[0] & { state?: 0 | 1; blank?: boolean };
type VisibleKey = {
  action: KeyAction<ActionSettings> | DialAction<ActionSettings>;
  settings: ActionSettings;
  titleLayouts: Map<number, KeyTitleLayout>;
  initialState: number;
  image?: string;
  title?: string;
  state?: 0 | 1;
  rendering: boolean;
  dirty: boolean;
  feedback?: string;
  updateAppSession?: object;
};

/** Keeps subscriptions, animation, and SDK writes scoped to visible keys and dials. */
export abstract class LiveAction extends SingletonAction<ActionSettings> {
  private readonly visible = new Map<string, VisibleKey>();
  private timer?: ReturnType<typeof setInterval>;
  private inspectorId?: string;
  private inspectorSettings?: ActionSettings;
  private inspectorPayload = "";
  private inspectorGeneration = 0;
  private inspectorSettingsGeneration = 0;

  constructor(protected readonly connection: Connection) {
    super();
    connection.subscribe(() => {
      this.refresh();
      void this.sendInspector().catch((error) => streamDeck.logger.error(error));
    });
  }

  protected syncSettings(settings: ActionSettings): ActionSettings { return settings; }

  protected abstract visual(settings: ActionSettings, action: KeyAction<ActionSettings> | DialAction<ActionSettings>): Visual;
  protected abstract press(ev: KeyDownEvent<ActionSettings>): Promise<void>;
  protected feedback(_settings: ActionSettings, _action: DialAction<ActionSettings>): FeedbackPayload | undefined { return undefined; }

  protected updateAppRequired(action: KeyAction<ActionSettings> | DialAction<ActionSettings>): boolean {
    const session = this.connection.session;
    return !!session && this.visible.get(action.id)?.updateAppSession === session;
  }

  protected inspectorItems(_settings: ActionSettings, _library?: ControlLibrary): Record<string, Array<{ label: string; value: string }>> { return {}; }

  override onWillAppear(ev: WillAppearEvent<ActionSettings>): void {
    if (!ev.action.isKey() && !ev.action.isDial()) return;
    this.visible.set(ev.action.id, { action: ev.action, settings: ev.payload.settings, titleLayouts: new Map(), initialState: ev.payload.state ?? 0, rendering: false, dirty: false });
    this.refresh();
  }
  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    this.visible.delete(ev.action.id);
    this.updateTimer();
  }
  override onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<ActionSettings>): void {
    const entry = this.visible.get(ev.action.id);
    if (!entry) return;
    entry.titleLayouts.set(ev.payload.state ?? 0, { title: ev.payload.title, ...ev.payload.titleParameters });
    this.render(entry);
  }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ActionSettings>): void {
    const entry = this.visible.get(ev.action.id);
    if (entry) entry.settings = ev.payload.settings;
    if (this.inspectorId === ev.action.id) {
      ++this.inspectorSettingsGeneration;
      this.inspectorSettings = ev.payload.settings;
      void this.sendInspector().catch((error) => streamDeck.logger.error(error));
    }
    this.refresh();
  }
  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    if (this.connection.status !== "connected") {
      this.connection.handleDisconnectedPress();
      await ev.action.showAlert();
      return;
    }
    await this.press(ev);
  }

  protected async command<Name extends ControlCommandName>(ev: { action: KeyAction<ActionSettings> | DialAction<ActionSettings> }, name: Name, args: ControlCommandArgs[Name]): Promise<void> {
    const session = this.connection.session;
    const result = await this.connection.command(name, args);
    await this.reportResult(ev.action, name, result, session);
  }

  protected async reportResult(action: KeyAction<ActionSettings> | DialAction<ActionSettings>, name: ControlCommandName, result: ControlResult | undefined, session = this.connection.session): Promise<void> {
    if (result && !result.ok) {
      const entry = this.visible.get(action.id);
      if (result.code === "unknown-command" && entry && session && session === this.connection.session) {
        entry.updateAppSession = session;
        this.refresh();
      }
      streamDeck.logger.warn(`SoundDeck command ${name} failed: ${result.code}`);
      await action.showAlert();
    }
  }

  private view(settings: ActionSettings, action: KeyAction<ActionSettings>): Visual {
    const visual = this.visual(settings, action);
    if (visual.blank) return visual;
    const updateApp = this.updateAppRequired(action);
    return this.connection.status === "connected" && !updateApp ? visual : {
      ...visual, badge: undefined, playing: undefined, playingRing: false, active: false, state: visual.state === undefined ? undefined : 0,
      dimmed: true, warning: updateApp || this.connection.status !== "offline", title: updateApp ? "Update\napp" : this.connection.statusLabel,
    };
  }
  protected refresh(): void {
    for (const entry of this.visible.values()) this.render(entry);
    this.updateTimer();
  }
  private updateTimer(): void {
    const animate = this.connection.status === "connected"
      && [...this.visible.values()].some((entry) => entry.action.isKey() && !!this.visual(entry.settings, entry.action).playing);
    if (animate && !this.timer) {
      this.timer = setInterval(() => {
        for (const entry of this.visible.values()) {
          if (entry.action.isKey() && this.visual(entry.settings, entry.action).playing) this.render(entry);
        }
      }, 125);
      this.timer.unref();
    } else if (!animate && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  private render(entry: VisibleKey): void {
    entry.dirty = true;
    if (entry.rendering) return;
    entry.rendering = true;
    void (async () => {
      while (entry.dirty && this.visible.get(entry.action.id) === entry) {
        entry.dirty = false;
        const previous = entry.settings;
        let settings = this.syncSettings(previous);
        if (settings !== previous) {
          // Inspector edits can be persisted before their settings echo reaches us.
          // Recompute from the current snapshot, preserving its binding and revision.
          const current = await entry.action.getSettings();
          if (this.visible.get(entry.action.id) !== entry) return;
          // getSettings may itself emit didReceiveSettings with this snapshot.
          // Any other settings event during the read supersedes it.
          if (entry.settings !== previous && entry.settings !== current) { entry.dirty = true; continue; }
          settings = this.syncSettings(current);
          if (settings !== current) await entry.action.setSettings(settings);
          if (this.visible.get(entry.action.id) !== entry) return;
          if (entry.settings !== previous && entry.settings !== current) { entry.dirty = true; continue; }
          // Publish synced metadata only after it has been sent for persistence.
          entry.settings = settings;
          if (this.inspectorId === entry.action.id) {
            ++this.inspectorSettingsGeneration;
            this.inspectorSettings = settings;
            await this.sendInspector();
          }
        }
        if (this.visible.get(entry.action.id) !== entry) return;
        if (entry.dirty) continue;
        if (entry.action.isDial()) {
          const title = this.visual(entry.settings, entry.action).title;
          if (entry.title !== title) {
            await entry.action.setTitle(title);
            entry.title = title;
            if (this.visible.get(entry.action.id) !== entry) return;
            if (entry.dirty) continue;
          }
          const feedback = this.feedback(entry.settings, entry.action);
          const serialized = JSON.stringify(feedback);
          if (feedback && entry.feedback !== serialized) {
            await entry.action.setFeedback(feedback);
            entry.feedback = serialized;
          }
          continue;
        }
        if (!entry.action.isKey()) return;
        const visual = this.view(entry.settings, entry.action);
        const title = keyTitle(visual.title);
        const layout = entry.titleLayouts.get(visual.state ?? entry.initialState);
        const image = keyImage({ ...visual, titleLayout: layout });
        // Both states receive the same live title/image, so a state transition
        // cannot flash an old title or default icon.
        if (visual.state !== undefined && entry.state !== visual.state) {
          await entry.action.setState(visual.state);
          entry.state = visual.state;
          if (this.visible.get(entry.action.id) !== entry) return;
          if (entry.dirty) continue;
        }
        if (entry.image !== image) {
          await entry.action.setImage(image);
          entry.image = image;
          if (this.visible.get(entry.action.id) !== entry) return;
          if (entry.dirty) continue;
        }
        if (entry.title !== title) {
          await entry.action.setTitle(title);
          entry.title = title;
        }
      }
    })().catch((error) => streamDeck.logger.error(error)).finally(() => {
      entry.rendering = false;
      // An unchanged render can exit synchronously while a following event
      // queues a change before this promise's finalizer runs.
      if (entry.dirty && this.visible.get(entry.action.id) === entry) this.render(entry);
    });
  }

  override async onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<ActionSettings>): Promise<void> {
    this.inspectorId = ev.action.id;
    this.inspectorSettings = undefined;
    this.inspectorPayload = "";
    ++this.inspectorGeneration;
    const generation = ++this.inspectorSettingsGeneration;
    const settings = await ev.action.getSettings();
    if (generation !== this.inspectorSettingsGeneration || this.inspectorId !== ev.action.id || streamDeck.ui.action?.id !== ev.action.id) return;
    this.inspectorSettings = settings;
    await this.sendInspector();
  }
  override onPropertyInspectorDidDisappear(ev: PropertyInspectorDidDisappearEvent<ActionSettings>): void {
    if (this.inspectorId !== ev.action.id || streamDeck.ui.action?.id === ev.action.id) return;
    this.inspectorId = undefined;
    this.inspectorSettings = undefined;
    this.inspectorPayload = "";
    ++this.inspectorGeneration;
    ++this.inspectorSettingsGeneration;
  }
  override async onSendToPlugin(ev: SendToPluginEvent<unknown & { event: string }, ActionSettings>): Promise<void> {
    if (!ev.payload || typeof ev.payload !== "object" || !["boards", "sounds", "slots", "status"].includes(ev.payload.event)) return;
    if (streamDeck.ui.action?.id !== ev.action.id) return;
    this.inspectorId = ev.action.id;
    this.inspectorPayload = "";
    ++this.inspectorGeneration;
    const generation = ++this.inspectorSettingsGeneration;
    const settings = await ev.action.getSettings();
    if (generation !== this.inspectorSettingsGeneration || this.inspectorId !== ev.action.id || streamDeck.ui.action?.id !== ev.action.id) return;
    this.inspectorSettings = settings;
    this.inspectorPayload = "";
    await this.sendInspector();
  }
  private async sendInspector(): Promise<void> {
    if (!this.inspectorId || streamDeck.ui.action?.id !== this.inspectorId) return;
    const library = this.connection.status === "connected" ? this.connection.snapshot?.library : undefined;
    const board = library?.boards.find((item) => item.id === this.inspectorSettings?.boardId);
    const boards = library?.boards.map((item) => ({ label: item.name, value: item.id })) ?? [];
    const sounds = board?.sounds.map((item) => ({ label: item.title, value: item.id })) ?? [];
    const label = this.connection.status === "connected" ? "" : this.connection.statusLabel;
    const items = { boards, sounds, ...this.inspectorItems(this.inspectorSettings ?? {}, library) };
    const payload = JSON.stringify({ ...items, label });
    if (payload === this.inspectorPayload) return;
    this.inspectorPayload = payload;
    const generation = ++this.inspectorGeneration;
    const inspectorId = this.inspectorId;
    for (const message of [
      ...Object.entries(items).map(([event, items]) => ({ event, items })),
      { event: "status", label },
    ]) {
      if (generation !== this.inspectorGeneration || streamDeck.ui.action?.id !== inspectorId || this.inspectorId !== inspectorId) return;
      await streamDeck.ui.sendToPropertyInspector(message);
    }
  }
}
