const path = require("node:path");
const { writeFile } = require("node:fs/promises");

const MAC_TRAY_ICON_FILENAME = "trayTemplate.png";
const MAC_TRAY_ICON_2X_FILENAME = "trayTemplate@2x.png";
const MAC_TRAY_ICON_1X_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAX0lEQVR42mNgoDFoYGBguM/AwKBArgH7GRgY/kMNIhoEMDAwnIfaimwAsjhBZ8M0IRvQgM816xkYGN5DTSfGAAcouwDdrw5EGoDhmmFgAMWBSHE0UjUhUZyUqZqZCAIAASNZoSEUn4QAAAAASUVORK5CYII=";
const MAC_TRAY_ICON_2X_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAo0lEQVR42u2XzQnAIAxG3wiO0BEcwREcwVG6iaM4QkfpCC2FHqRUL7VGJAFPYvLkC/kBtW+2AgmIgOkdPABHdqLE73OANDWAf9G6BuBb5oYpaF0CMK1zwxUClQDcF2nM7eBPgCuGfQu+APv9aMu0awnga9I8HYYfANLjztYA1g4ATgEUQAGGBuheiMRLsXgzGqIdDzmQiI9kOhUPu5iIr2Zz2AkMlmLaLvjF6QAAAABJRU5ErkJggg==";

function createMacTrayTemplateImage(nativeImage) {
  const icon = nativeImage.createEmpty();
  icon.addRepresentation({ scaleFactor: 1, dataURL: MAC_TRAY_ICON_1X_DATA_URL });
  icon.addRepresentation({ scaleFactor: 2, dataURL: MAC_TRAY_ICON_2X_DATA_URL });
  icon.setTemplateImage(true);
  return icon;
}

async function writeMacTrayTemplateFiles(outputDir) {
  await writeFile(path.join(outputDir, MAC_TRAY_ICON_FILENAME), dataUrlToBuffer(MAC_TRAY_ICON_1X_DATA_URL));
  await writeFile(path.join(outputDir, MAC_TRAY_ICON_2X_FILENAME), dataUrlToBuffer(MAC_TRAY_ICON_2X_DATA_URL));
}

function dataUrlToBuffer(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

module.exports = {
  createMacTrayTemplateImage,
  MAC_TRAY_ICON_FILENAME,
  MAC_TRAY_ICON_2X_FILENAME,
  writeMacTrayTemplateFiles
};
