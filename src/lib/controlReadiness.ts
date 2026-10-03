// Settings can change while the initial routes are opening. Wait for the
// latest configuration before accepting commands from external clients.
export async function waitForAudioConfiguration(getConfiguration: () => Promise<void> | null) {
  let configuration;
  do {
    configuration = getConfiguration();
    await configuration;
  } while (configuration !== getConfiguration());
}
