const path = require("node:path");
const { pathToFileURL } = require("node:url");

function rendererPolicy({ isPackaged, builtIndex, devServerUrl }) {
  return {
    isPackaged: Boolean(isPackaged),
    builtIndex: path.resolve(builtIndex),
    devServerUrl: String(devServerUrl)
  };
}

function isTrustedRendererUrl(value, policy) {
  try {
    const candidate = new URL(value);
    if (!policy?.isPackaged) {
      const expected = new URL(policy.devServerUrl);
      return (
        (expected.protocol === "http:" || expected.protocol === "https:") &&
        candidate.origin === expected.origin
      );
    }

    const expected = new URL(pathToFileURL(policy.builtIndex).href);
    candidate.hash = "";
    candidate.search = "";
    return candidate.href === expected.href;
  } catch {
    return false;
  }
}

function isTrustedIpcSender(event, trustedWebContents, policy) {
  if (!event || !trustedWebContents || trustedWebContents.isDestroyed?.()) return false;
  if (event.sender !== trustedWebContents) return false;
  if (!event.senderFrame || event.senderFrame !== trustedWebContents.mainFrame) return false;
  return isTrustedRendererUrl(event.senderFrame.url, policy);
}

function installNavigationGuards(webContents, policy) {
  const guardNavigation = (event, detailsOrUrl) => {
    const navigationUrl = event?.url || (typeof detailsOrUrl === "string"
      ? detailsOrUrl
      : detailsOrUrl?.url);
    if (!isTrustedRendererUrl(navigationUrl, policy)) event.preventDefault();
  };
  webContents.on("will-navigate", guardNavigation);
  webContents.on("will-redirect", guardNavigation);
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function isAllowedExternalUrl(value) {
  const allowed = new Set([
    "https://github.com/MaksimPeterburgskiy/sounddeck-studio/releases/latest",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
  ]);
  try {
    const candidate = new URL(value);
    return allowed.has(candidate.href);
  } catch {
    return false;
  }
}

module.exports = {
  rendererPolicy,
  isTrustedRendererUrl,
  isTrustedIpcSender,
  installNavigationGuards,
  isAllowedExternalUrl
};
