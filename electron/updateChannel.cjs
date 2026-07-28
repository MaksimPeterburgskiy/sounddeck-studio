const UPDATE_CHANNELS = ["stable", "beta"];

function normalizeChannelPreference(value) {
  return UPDATE_CHANNELS.includes(value) ? value : null;
}

// The channel a build tracks with no explicit preference: electron-updater
// derives it from the installed version's semver prerelease tag.
function installedChannel(version) {
  return /-/.test(version || "") ? "beta" : "stable";
}

// Maps the persisted channel preference to electron-updater settings. null
// means "don't touch the updater": the installed version decides (a beta
// install tracks betas, a stable install tracks stable). An explicit
// preference sets every field so switching back and forth in one session
// can't leave stale state behind. channel names the feed file the GitHub
// provider requests (latest.yml vs beta.yml) and must override the channel
// baked into the build's app-update.yml: a beta build ships channel=beta, so
// without the override a stable switch asks the stable release for beta.yml
// and 404s instead of downgrading. stable grants allowDowngrade only while
// the running build is itself a beta — that's the downgrade onto the current
// stable release, which is semver-older than any beta of the next version.
// Once a stable build is installed the permission drops, so a withdrawn or
// re-pointed latest release can never downgrade stable users.
function resolveUpdaterFlags(preference, currentVersion) {
  const channel = normalizeChannelPreference(preference);
  if (channel === "beta") return { channel: "beta", allowPrerelease: true, allowDowngrade: false };
  if (channel === "stable") {
    return { channel: "latest", allowPrerelease: false, allowDowngrade: installedChannel(currentVersion) === "beta" };
  }
  return null;
}

// Numeric compare of the major.minor.patch part, ignoring any prerelease
// suffix. Returns -1, 0, or 1.
function compareBaseVersions(a, b) {
  const parse = (version) => String(version || "").split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// A download begun before a channel switch can complete after it; decides
// whether that payload may still be offered under the current preference.
// Stable preference never accepts a beta payload. Beta preference accepts a
// stable payload only when it is a genuinely newer release, not the remnant
// of a downgrade the user abandoned by switching back. No preference accepts
// everything: the updater was never pointed anywhere it shouldn't have been.
function isStalePayload(preference, payloadVersion, currentVersion) {
  const channel = normalizeChannelPreference(preference);
  const payloadChannel = installedChannel(payloadVersion);
  if (channel === "stable") return payloadChannel === "beta";
  if (channel === "beta") return payloadChannel === "stable" && compareBaseVersions(payloadVersion, currentVersion) < 0;
  return false;
}

module.exports = { UPDATE_CHANNELS, normalizeChannelPreference, installedChannel, resolveUpdaterFlags, isStalePayload };
