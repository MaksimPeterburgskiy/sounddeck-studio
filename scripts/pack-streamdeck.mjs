import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stampManifest } from "../streamdeck-plugin/scripts/version.mjs";
import { runStep } from "./spawn-command.mjs";

export const pluginFileName = "com.sounddeck.studio.streamDeckPlugin";

export async function stageStreamDeckPlugin({ sourceDir, stageDir, version }) {
  await rm(stageDir, { recursive: true, force: true });
  await cp(sourceDir, stageDir, { recursive: true });
  const manifestPath = path.join(stageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, `${JSON.stringify(stampManifest(manifest, version), null, 2)}\n`);
}

export async function packStreamDeck({ repoRoot = fileURLToPath(new URL("../", import.meta.url)), run = runStep } = {}) {
  const { version } = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const pluginRoot = path.join(repoRoot, "streamdeck-plugin");
  const outputDir = path.join(pluginRoot, "dist");
  const stageRoot = path.join(outputDir, ".pack");
  const stageDir = path.join(stageRoot, "com.sounddeck.studio.sdPlugin");
  await run("pnpm", ["run", "build:streamdeck"], process.env);
  await mkdir(outputDir, { recursive: true });
  try {
    await stageStreamDeckPlugin({ sourceDir: path.join(pluginRoot, "com.sounddeck.studio.sdPlugin"), stageDir, version });
    await run("pnpm", ["--filter", "@sounddeck/streamdeck-plugin", "exec", "streamdeck", "pack", stageDir,
      "--output", outputDir, "--force", "--no-update-check", "--no-file-list"], process.env);
    const outputFile = path.join(outputDir, pluginFileName);
    // Keep the bundled path stable, and provide a versioned download for releases.
    await cp(outputFile, path.join(outputDir, `SoundDeck-Studio-StreamDeck-${version}.streamDeckPlugin`));
    return outputFile;
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packStreamDeck();
}
