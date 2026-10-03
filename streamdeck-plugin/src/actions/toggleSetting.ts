import { action, type KeyDownEvent } from "@elgato/streamdeck";
import { settingKey, settingLabels, type ActionSettings } from "../settings";
import { LiveAction } from "./liveAction";

@action({ UUID: "com.sounddeck.studio.toggle-setting" })
export class ToggleSetting extends LiveAction {
  protected override visual(settings: ActionSettings) {
    const key = settingKey(settings.key ?? "micPassthrough");
    const enabled = key && this.connection.snapshot?.settings?.[key];
    return key ? { title: settingLabels[key], icon: enabled ? "toggle-on" as const : "toggle-off" as const, iconOn: !!enabled, active: !!enabled, state: enabled ? 1 as const : 0 as const }
      : { title: "Missing", warning: true, dimmed: true, state: 0 as const };
  }
  protected override async press(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    const key = settingKey(ev.payload.settings.key ?? "micPassthrough");
    if (!key) { await ev.action.showAlert(); return; }
    if (ev.payload.isInMultiAction && ev.payload.userDesiredState !== undefined) {
      await this.command(ev, "setting.set", { key, value: ev.payload.userDesiredState === 1 });
    } else {
      await this.command(ev, "setting.toggle", { key });
    }
  }
}
