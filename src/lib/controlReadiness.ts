// Settings can change while routes are opening. Wait for the latest
// configuration at startup and before every external play command.
export async function waitForAudioConfiguration(getConfiguration: () => Promise<void> | null) {
  let configuration;
  do {
    configuration = getConfiguration();
    try {
      await configuration;
    } catch (error) {
      if (configuration === getConfiguration()) throw error;
    }
  } while (configuration !== getConfiguration());
}
