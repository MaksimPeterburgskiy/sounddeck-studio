import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import typescript from "@rollup/plugin-typescript";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const plugin = "com.sounddeck.studio.sdPlugin";
const adaptedSdkModules = new Set();
// Build-time only: the running plugin never reads its manifest.
const manifestPath = new URL(`./${plugin}/manifest.json`, import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const [core, beta] = pkg.version.split("-beta.");
const expectedVersion = `${core}.${beta ?? 99999}`;
if (manifest.Version !== expectedVersion) {
  throw new Error(`Manifest Version must be ${expectedVersion}; run pnpm run version:streamdeck.`);
}
if (manifest.Nodejs.Debug !== undefined && !process.env.ROLLUP_WATCH) throw new Error("Committed manifest must not enable Node debugging.");

export default {
  input: "src/plugin.ts",
  output: { file: `${plugin}/bin/plugin.js`, format: "es", sourcemap: !!process.env.ROLLUP_WATCH },
  external: (id) => id.startsWith("node:") || builtinModules.includes(id),
  plugins: [
    replace({ preventAssignment: true, __PLUGIN_VERSION__: JSON.stringify(pkg.version) }),
    {
      name: "sdk-v2-drm-safe-runtime",
      // SDK v2 otherwise reads manifest.json during registration and logs in
      // cwd()/logs. Embed metadata and redirect the existing rotating file target.
      transform(source, id) {
        if (id.endsWith("/@elgato/streamdeck/dist/plugin/manifest.js")) {
          adaptedSdkModules.add("manifest");
          return { code: `import { Version } from "./common/version.js";
            const manifest = ${JSON.stringify(manifest)};
            export function getManifest() { return manifest; }
            export function getSDKVersion() { return manifest.SDKVersion; }
            export function getSoftwareMinimumVersion() { return new Version(manifest.Software.MinimumVersion); }`, map: null };
        }
        if (id.endsWith("/@elgato/streamdeck/dist/plugin/logging/index.js")) {
          adaptedSdkModules.add("logging");
          if (!source.includes('dest: path.join(cwd(), "logs")')
            || !source.includes('import { cwd } from "node:process";')
            || !source.includes("new FileTarget(")) {
            throw new Error("SDK logging changed; review the DRM-safe build adaptation.");
          }
          return { code: source
            .replace('import { cwd } from "node:process";', 'import os from "node:os";')
            .replace('path.join(cwd(), "logs")', `process.platform === "darwin"
              ? path.join(os.homedir(), "Library", "Logs", "SoundDeck Studio", "streamdeck")
              : process.platform === "win32"
                ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "SoundDeck Studio", "logs", "streamdeck")
                : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "SoundDeck Studio", "logs", "streamdeck")`), map: null };
        }
        return null;
      }
    },
    typescript({ filterRoot: false, tsconfig: "./tsconfig.json", sourceMap: !!process.env.ROLLUP_WATCH }),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
    {
      name: "emit-module-package-file",
      generateBundle() {
        if (adaptedSdkModules.size !== 2) throw new Error("SDK runtime modules changed; review DRM-safe build adaptations.");
        this.emitFile({ fileName: "package.json", source: '{ "type": "module" }\n', type: "asset" });
      }
    }
  ]
};
