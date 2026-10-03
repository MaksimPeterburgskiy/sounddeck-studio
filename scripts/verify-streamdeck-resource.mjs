import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pluginFileName } from "./pack-streamdeck.mjs";

export async function verifyStreamDeckResource(resourcesDir) {
  const filePath = path.join(resourcesDir, "streamdeck", pluginFileName);
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`App payload must include the Stream Deck plugin: ${filePath}`);
    throw error;
  }
  if (!info.isFile() || info.size === 0) throw new Error(`Stream Deck plugin must be a nonempty file: ${filePath}`);
  return filePath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/verify-streamdeck-resource.mjs <resources-directory>");
  console.log(`Verified bundled Stream Deck plugin: ${await verifyStreamDeckResource(process.argv[2])}`);
}
