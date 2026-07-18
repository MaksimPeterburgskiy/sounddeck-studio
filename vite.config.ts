import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "electron/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      // Coverage is scoped to the tested library and electron helper modules;
      // main.tsx and main.cjs join once they have direct suites of their own.
      include: [
        "src/lib/**/*.ts",
        "electron/ffmpegArgs.cjs",
        "electron/startupSettings.cjs",
        "electron/hotkeys.cjs",
        "electron/mediaFiles.cjs",
        "electron/processTree.cjs",
        "electron/shutdownLifecycle.cjs",
        "electron/updateInstallLifecycle.cjs"
      ],
      // devBridge is the browser-only stub bridge; its API surface is pinned
      // by the preload contract test, but its placeholder bodies never run.
      exclude: ["src/lib/testing/**", "src/**/*.test.ts", "src/lib/devBridge.ts"],
      thresholds: {
        // Ratchet: raise these as coverage grows; never lower them.
        // (Measured July 2026: 91.5 / 83.7 / 95.5 / 93.9.)
        statements: 90,
        branches: 82,
        functions: 93,
        lines: 92
      }
    }
  }
});
