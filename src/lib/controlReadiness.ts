// Settings changes and device retries can overlap, including work that restores
// the latest sinks after an older operation finishes. Retain all pending work.
export function trackAudioConfiguration(configuration: { current: Promise<void> | null }, work: Promise<void>): Promise<void> {
  const pending = Promise.allSettled([configuration.current, work]).then(([, result]) => {
    if (result.status === "rejected") throw result.reason;
  });
  configuration.current = pending;
  return pending;
}

// Reserve readiness at the point a change is requested, then complete it with
// the actual work once that work can start (for example, after a React render).
export function beginAudioConfiguration(configuration: { current: Promise<void> | null }) {
  let complete!: (work: Promise<void>) => void;
  const work = new Promise<void>((resolve, reject) => {
    complete = (pending) => { void pending.then(resolve, reject); };
  });
  void trackAudioConfiguration(configuration, work).catch(() => undefined);
  return complete;
}

// The debounce itself owns routing readiness, before enumeration or sink work
// starts. Repeated events extend that wait; cleanup releases a cancelled timer.
export function watchAudioDeviceChanges(
  mediaDevices: Pick<MediaDevices, "addEventListener" | "removeEventListener">,
  configuration: { current: Promise<void> | null },
  retry: () => Promise<void>
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduled: ReturnType<typeof beginAudioConfiguration> | null = null;
  const changed = () => {
    if (timer !== null) clearTimeout(timer);
    if (!scheduled) {
      scheduled = beginAudioConfiguration(configuration);
    }
    const work = scheduled;
    timer = setTimeout(() => {
      timer = null;
      scheduled = null;
      work(Promise.resolve().then(retry));
    }, 600);
  };
  mediaDevices.addEventListener("devicechange", changed);
  return () => {
    mediaDevices.removeEventListener("devicechange", changed);
    if (timer !== null) clearTimeout(timer);
    scheduled?.(Promise.resolve());
    timer = null;
    scheduled = null;
  };
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
