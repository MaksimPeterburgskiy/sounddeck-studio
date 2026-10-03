/* Library summaries and status cross this bridge; never authentication tokens.
 * This controller is the sole owner of settings for all inspectors.
 * Pickers have no sdpi-components setting/label-setting attributes.
 */
const client = SDPIComponents.streamDeckClient;
const board = document.getElementById("board");
const slot = document.getElementById("slot");
const sound = document.getElementById("sound");
const key = document.getElementById("key");
let settings = {};
let initialized = false;
let receiving = false;
let sounds = [];
let queue = Promise.resolve();
let latestRevision = 0;
const revisionOf = (value) => Number.isSafeInteger(value.inspectorRevision) && value.inspectorRevision >= 0
  ? value.inspectorRevision : 0;

const applySettings = (value) => {
  initialized = true;
  settings = { ...value };
  latestRevision = Math.max(latestRevision, revisionOf(settings));
  receiving = true;
  if (board) board.value = settings.boardId || "";
  if (slot) slot.value = String(settings.slot ?? "");
  if (sound) sound.value = settings.soundId || "";
  if (key) key.value = settings.key || "micPassthrough";
  receiving = false;
};
const save = (value) => {
  // Save complete snapshots in order and update our cache before the next change.
  applySettings({ ...value, inspectorRevision: latestRevision + 1 });
  const snapshot = { ...settings };
  queue = queue.then(() => client.setSettings(snapshot)).catch(() => {
    document.getElementById("status").textContent = "Could not save. Please retry.";
  });
};
client.sendToPropertyInspector.subscribe(({ payload }) => {
  if (payload?.event === "status") document.getElementById("status").textContent = payload.label || "";
  if (payload?.event === "sounds") sounds = payload.items || [];
});
if (board || slot || key) {
  // Sending is not acknowledgement. Keep the revision barrier after sends settle
  // and after the latest echo, so an older plugin snapshot can never roll us back.
  client.didReceiveSettings.subscribe(({ payload }) => {
    if (revisionOf(payload.settings) >= latestRevision) applySettings(payload.settings);
  });
  client.getConnectionInfo().then(({ actionInfo }) => {
    if (!initialized) applySettings(actionInfo.payload.settings);
  });
  board?.addEventListener("valuechange", () => {
    if (!initialized || receiving || board.value === settings.boardId) return;
    sounds = [];
    save(sound ? { ...settings, boardId: board.value, soundId: "", title: "" }
      : { ...settings, boardId: board.value });
  });
  slot?.addEventListener("valuechange", () => {
    if (!initialized || receiving || slot.value === String(settings.slot ?? "")) return;
    save({ ...settings, slot: slot.value });
  });
  sound?.addEventListener("valuechange", () => {
    if (!initialized || receiving || sound.value === settings.soundId) return;
    const selected = sounds.find((item) => item.value === sound.value);
    if (!selected) return;
    save({ ...settings, soundId: selected.value, title: selected.label });
  });
  key?.addEventListener("valuechange", () => {
    if (!initialized || receiving || key.value === (settings.key || "micPassthrough")) return;
    save({ ...settings, key: key.value });
  });
}
client.send("sendToPlugin", { event: "status" });
