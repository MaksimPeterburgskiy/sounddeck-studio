import { toStreamDeckVersion } from "../../electron/streamdeckVersion.cjs";

export function stampManifest(manifest, version) {
  return { ...manifest, Version: toStreamDeckVersion(version) };
}
