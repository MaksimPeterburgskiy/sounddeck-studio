import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import typescript from "@rollup/plugin-typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const plugin = "com.sounddeck.studio.sdPlugin";
const adaptedSdkModules = new Set();
// Build-time only: the running plugin never reads its manifest.
const manifestPath = new URL(`./${plugin}/manifest.json`, import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const [core, beta] = pkg.version.split("-beta.");
manifest.Version = `${core}.${beta ?? 99999}`;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

export default {
  input: "src/plugin.ts",
  output: { file: `${plugin}/bin/plugin.js`, format: "es", sourcemap: !!process.env.ROLLUP_WATCH },
  external: (id) => id.startsWith("node:") || builtinModules.includes(id),
  plugins: [
    replace({ preventAssignment: true, __PLUGIN_VERSION__: JSON.stringify(pkg.version) }),
    {
      name: "sdk-v2-drm-safe-runtime",
      // SDK v2 otherwise reads manifest.json during registration and logs in
      // cwd()/logs. Embed the already-read metadata and keep logs on stdout.
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
          if (!source.includes('dest: path.join(cwd(), "logs")')) {
            throw new Error("SDK logging changed; review the DRM-safe build adaptation.");
          }
          return { code: `import { ConsoleTarget, Logger } from "@elgato/utils/logging";
            import { isDebugMode } from "../common/utils.js";
            export const logger = new Logger({
              level: isDebugMode() ? "debug" : "info",
              minimumLevel: isDebugMode() ? "trace" : "debug",
              targets: [new ConsoleTarget()]
            });
            process.once("uncaughtException", (err) => logger.error("Process encountered uncaught exception", err));`, map: null };
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
