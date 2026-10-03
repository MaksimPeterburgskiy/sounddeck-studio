// Settings changes and device retries can overlap, including work that restores
// the latest sinks after an older operation finishes. Retain all pending work.
export function trackAudioConfiguration(configuration: { current: Promise<void> | null }, work: Promise<void>): Promise<void> {
  const pending = Promise.allSettled([configuration.current, work]).then(([, result]) => {
    if (result.status === "rejected") throw result.reason;
  });
  configuration.current = pending;
  return pending;
}

// Wait for the latest configuration at startup and before every external play.
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
