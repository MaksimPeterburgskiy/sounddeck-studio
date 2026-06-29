const path = require("node:path");

function normalizeWindowsPath(input) {
  if (!input) return "";
  return path.normalize(String(input).replace(/^"+|"+$/g, "")).toLowerCase();
}

function sameWindowsPath(a, b) {
  const left = normalizeWindowsPath(a);
  const right = normalizeWindowsPath(b);
  return Boolean(left && right && left === right);
}

function findWindowsStartupLaunchItem(settings, { name, executablePath } = {}) {
  if (!Array.isArray(settings?.launchItems)) return null;
  return settings.launchItems.find((item) => {
    if (!item) return false;
    return (name && item.name === name) || sameWindowsPath(item.path, executablePath);
  }) || null;
}

function getWindowsStartupState(settings = {}, options = {}) {
  const launchItem = findWindowsStartupLaunchItem(settings, options);
  const exactEntryRegistered = Boolean(settings.openAtLogin);
  const executableWillLaunch = typeof settings.executableWillLaunchAtLogin === "boolean"
    ? settings.executableWillLaunchAtLogin
    : undefined;
  const registered = Boolean(exactEntryRegistered || launchItem || executableWillLaunch);
  const approved = !registered
    ? false
    : typeof launchItem?.enabled === "boolean"
      ? launchItem.enabled
      : typeof executableWillLaunch === "boolean"
        ? executableWillLaunch
        : exactEntryRegistered;

  return {
    registered,
    approved,
    status: registered && !approved ? "not-approved" : undefined,
    launchItem
  };
}

module.exports = {
  findWindowsStartupLaunchItem,
  getWindowsStartupState
};
