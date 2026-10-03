/* Library summaries and status cross this bridge; never authentication tokens.
 * This controller is the sole owner of the dependent board/sound/title binding.
 * Neither picker has sdpi-components setting/label-setting attributes.
 */
const client = SDPIComponents.streamDeckClient;
const board = document.getElementById("board");
const sound = document.getElementById("sound");
let settings = {};
let initialized = false;
let receiving = false;
let sounds = [];
let queue = Promise.resolve();
let pendingWrites = 0;

const applySettings = (value) => {
  initialized = true;
  settings = { ...value };
  receiving = true;
  if (board) board.value = settings.boardId || "";
  if (sound) sound.value = settings.soundId || "";
  receiving = false;
};
const save = (value) => {
  // Save complete snapshots in order and update our cache before the next change.
  applySettings(value);
  const snapshot = { ...settings };
  pendingWrites++;
  queue = queue.then(() => client.setSettings(snapshot)).catch(() => {
    document.getElementById("status").textContent = "Could not save. Please retry.";
  }).finally(() => { pendingWrites--; });
};
client.sendToPropertyInspector.subscribe(({ payload }) => {
  if (payload?.event === "status") document.getElementById("status").textContent = payload.label || "";
  if (payload?.event === "sounds") sounds = payload.items || [];
});
if (board) {
  // An echo of an older write must not roll back a newer local selection.
  client.didReceiveSettings.subscribe(({ payload }) => {
    if (!pendingWrites) applySettings(payload.settings);
  });
  client.getConnectionInfo().then(({ actionInfo }) => {
    if (!initialized) applySettings(actionInfo.payload.settings);
  });
  board.addEventListener("valuechange", () => {
    if (!initialized || receiving || board.value === settings.boardId) return;
    sounds = [];
    save({ ...settings, boardId: board.value, soundId: "", title: "" });
  });
  sound?.addEventListener("valuechange", () => {
    if (!initialized || receiving || sound.value === settings.soundId) return;
    const selected = sounds.find((item) => item.value === sound.value);
    if (!selected) return;
    save({ ...settings, soundId: selected.value, title: selected.label });
  });
}
client.send("sendToPlugin", { event: "status" });
