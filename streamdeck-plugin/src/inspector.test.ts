import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const code = readFileSync(new URL("../com.sounddeck.studio.sdPlugin/ui/inspector.js", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function inspector(initial: Record<string, string>) {
  const elements = Object.fromEntries(["board", "sound", "status"].map((id) => {
    const handlers = new Map<string, () => void>();
    let value = "";
    return [id, { get value() { return value; }, set value(next: string) { value = next; handlers.get("valuechange")?.(); },
      textContent: "", addEventListener: (name: string, handler: () => void) => handlers.set(name, handler) }];
  }));
  let message!: (event: unknown) => void;
  let settings!: (event: unknown) => void;
  const client = {
    getConnectionInfo: async () => ({ actionInfo: { payload: { settings: initial } } }),
    sendToPropertyInspector: { subscribe: (callback: typeof message) => { message = callback; } },
    didReceiveSettings: { subscribe: (callback: typeof settings) => { settings = callback; } },
    setSettings: vi.fn(async (_value: unknown) => {}), send: vi.fn(),
  };
  runInNewContext(code, { SDPIComponents: { streamDeckClient: client }, document: { getElementById: (id: string) => elements[id] } });
  return { elements, client, message: (payload: unknown) => message({ payload }), receive: (value: unknown) => settings({ payload: { settings: value } }) };
}
describe("play sound inspector", () => {
  it.each([{}, { boardId: "a", soundId: "old", title: "Old" }])("keeps a board change and sound selection atomic, including on reopen: %j", async (initial) => {
    const ui = inspector(initial); await flush();
    ui.elements.board.value = "b";
    ui.message({ event: "sounds", items: [{ value: "new", label: "Airhorn" }] });
    ui.elements.sound.value = "new";
    ui.receive(initial); // a delayed echo cannot replace the queued local binding
    await flush();
    expect(JSON.parse(JSON.stringify(ui.client.setSettings.mock.calls))).toEqual([
      [{ boardId: "b", soundId: "", title: "" }], [{ boardId: "b", soundId: "new", title: "Airhorn" }],
    ]);
    const reopened = inspector(ui.client.setSettings.mock.lastCall![0] as Record<string, string>); await flush();
    expect(reopened.elements.board.value).toBe("b");
    expect(reopened.elements.sound.value).toBe("new");
    expect(reopened.client.setSettings).not.toHaveBeenCalled();
    const html = readFileSync(new URL("../com.sounddeck.studio.sdPlugin/ui/play-sound.html", import.meta.url), "utf8");
    expect(html).not.toMatch(/\b(?:setting|label-setting)=/);
  });
});
