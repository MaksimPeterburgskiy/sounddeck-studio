/* Only library summaries and status cross the inspector bridge; never tokens. */
const client = SDPIComponents.streamDeckClient;
client.sendToPropertyInspector.subscribe(({ payload }) => {
  if (payload?.event === "status") {
    document.getElementById("status").textContent = payload.label || "";
  }
});

const board = document.getElementById("board");
if (board) {
  // The dependent board/sound/title binding is saved atomically on a board
  // selection. Library refreshes retain the stored title for import fallback.
  let settings = {};
  let initialized = false;
  let receiving = false;
  const applySettings = (value) => {
    initialized = true;
    settings = value;
    receiving = true;
    board.value = settings.boardId;
    receiving = false;
  };
  client.didReceiveSettings.subscribe(({ payload }) => applySettings(payload.settings));
  client.getConnectionInfo().then(({ actionInfo }) => {
    if (!initialized) applySettings(actionInfo.payload.settings);
  });
  board.addEventListener("valuechange", () => {
    if (receiving || board.value === settings.boardId) return;
    settings = { ...settings, boardId: board.value, soundId: "", title: "" };
    client.setSettings(settings);
  });
}
client.send("sendToPlugin", { event: "status" });
