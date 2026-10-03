import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { toStreamDeckVersion } from "../../electron/streamdeckVersion.cjs";

export { toStreamDeckVersion };

export function stampManifest(manifest, version) {
  return { ...manifest, Version: toStreamDeckVersion(version) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packagePath = new URL("../package.json", import.meta.url);
  const manifestPath = new URL("../com.sounddeck.studio.sdPlugin/manifest.json", import.meta.url);
  const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const stamped = stampManifest(manifest, version);
  if (manifest.Version !== stamped.Version) writeFileSync(manifestPath, `${JSON.stringify(stamped, null, 2)}\n`);
}
