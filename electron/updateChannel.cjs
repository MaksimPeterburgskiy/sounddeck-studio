const UPDATE_CHANNELS = ["stable", "beta"];

function normalizeChannelPreference(value) {
  return UPDATE_CHANNELS.includes(value) ? value : null;
}

// The channel a build tracks with no explicit preference: electron-updater
// derives it from the installed version's semver prerelease tag.
function installedChannel(version) {
  return /-/.test(version || "") ? "beta" : "stable";
}

// Maps the persisted channel preference to electron-updater flags. null means
// "don't touch the updater": the installed version decides (a beta install
// tracks betas, a stable install tracks stable). An explicit preference sets
// both flags so switching back and forth in one session can't leave a stale
// allowDowngrade behind. stable needs allowDowngrade because the current
// stable release is semver-older than any installed beta of the next version.
function resolveUpdaterFlags(preference) {
  const channel = normalizeChannelPreference(preference);
  if (channel === "beta") return { allowPrerelease: true, allowDowngrade: false };
  if (channel === "stable") return { allowPrerelease: false, allowDowngrade: true };
  return null;
}

module.exports = { UPDATE_CHANNELS, normalizeChannelPreference, installedChannel, resolveUpdaterFlags };
