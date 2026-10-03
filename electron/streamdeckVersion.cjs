// Stable builds sort above every beta of the same app version.
function toStreamDeckVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(version);
  if (!match || match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))
    || (match[4] !== undefined && (!Number.isSafeInteger(Number(match[4])) || Number(match[4]) >= 99999))) {
    throw new Error(`Unsupported Stream Deck app version: ${version}`);
  }
  return `${match[1]}.${match[2]}.${match[3]}.${match[4] ?? 99999}`;
}

module.exports = { toStreamDeckVersion };
