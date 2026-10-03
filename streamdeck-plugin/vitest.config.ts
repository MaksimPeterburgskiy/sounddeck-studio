import { defineConfig } from "vitest/config";
import { streamDeckTestTransform } from "./testTransform.mjs";
export default defineConfig({ plugins: [streamDeckTestTransform()], test: { environment: "node", include: ["src/**/*.test.ts"] } });
