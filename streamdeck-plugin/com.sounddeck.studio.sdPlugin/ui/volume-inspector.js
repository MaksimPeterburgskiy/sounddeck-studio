// sdpi-components persists these independent settings; this only hides Step.
const mode = document.getElementById("mode");
const stepItem = document.getElementById("step-item");
const showStep = (value) => { stepItem.hidden = value === "mute"; };
let receivedSettings = false;
SDPIComponents.streamDeckClient.didReceiveSettings.subscribe(({ payload }) => {
  receivedSettings = true;
  showStep(payload.settings.mode);
});
SDPIComponents.streamDeckClient.getConnectionInfo().then(({ actionInfo }) => {
  if (!receivedSettings) showStep(actionInfo.payload.settings.mode);
});
mode.addEventListener("valuechange", () => showStep(mode.value));
