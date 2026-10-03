import { readFileSync, writeFileSync } from "node:fs";
const packagePath = new URL("../package.json", import.meta.url);
const manifestPath = new URL("../com.sounddeck.studio.sdPlugin/manifest.json", import.meta.url);
const { version } = JSON.parse(readFileSync(packagePath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const [core, beta] = version.split("-beta.");
const expected = `${core}.${beta ?? 99999}`;
if (manifest.Version !== expected) {
  manifest.Version = expected;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
