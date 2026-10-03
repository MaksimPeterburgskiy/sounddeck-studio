import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toStreamDeckVersion, stampManifest } from "../streamdeck-plugin/scripts/version.mjs";
import { packStreamDeck, pluginFileName, stageStreamDeckPlugin } from "./pack-streamdeck.mjs";
import { verifyStreamDeckResource } from "./verify-streamdeck-resource.mjs";

const tempDirs = [];
async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sounddeck-streamdeck-pack-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Stream Deck version mapping", () => {
  it.each([["1.2.3", "1.2.3.99999"], ["1.2.3-beta.0", "1.2.3.0"], ["1.2.3-beta.28", "1.2.3.28"]])("maps %s", (input, output) => {
    expect(toStreamDeckVersion(input)).toBe(output);
  });
  it.each(["1.2", "1.2.3-rc.1", "1.2.3-beta.-1", "1.2.3-beta.99999", "1.2.3-beta.9007199254740993", "01.2.3"])("rejects %s", (input) => {
    expect(() => toStreamDeckVersion(input)).toThrow(/Unsupported/);
  });
});

describe("pack staging", () => {
  it("stamps the app version in a copied manifest without changing the input", async () => {
    const dir = await makeTempDir();
    const sourceDir = path.join(dir, "source");
    const stageDir = path.join(dir, "stage");
    await mkdir(sourceDir);
    const manifest = { Version: "0.1.22.99999", UUID: "com.sounddeck.studio", Actions: [] };
    const original = `${JSON.stringify(manifest)}\n`;
    await writeFile(path.join(sourceDir, "manifest.json"), original);
    await writeFile(path.join(sourceDir, "plugin.js"), "runtime");
    await stageStreamDeckPlugin({ sourceDir, stageDir, version: "0.1.23-beta.4" });
    expect(JSON.parse(await readFile(path.join(stageDir, "manifest.json"), "utf8"))).toEqual(stampManifest(manifest, "0.1.23-beta.4"));
    expect(await readFile(path.join(stageDir, "plugin.js"), "utf8")).toBe("runtime");
    expect(await readFile(path.join(sourceDir, "manifest.json"), "utf8")).toBe(original);
  });

  it("builds before packing, creates a versioned asset, and removes staging", async () => {
    const repoRoot = await makeTempDir();
    const pluginRoot = path.join(repoRoot, "streamdeck-plugin");
    const sourceDir = path.join(pluginRoot, "com.sounddeck.studio.sdPlugin");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ version: "2.0.1-beta.2" }));
    await writeFile(path.join(sourceDir, "manifest.json"), JSON.stringify({ Version: "1.0.0.99999" }));
    const steps = [];
    const run = async (command, args) => {
      steps.push([command, args]);
      if (args.includes("pack")) {
        const stage = args[args.indexOf("pack") + 1];
        expect(JSON.parse(await readFile(path.join(stage, "manifest.json"), "utf8")).Version).toBe("2.0.1.2");
        await writeFile(path.join(pluginRoot, "dist", pluginFileName), "packed");
      }
    };
    expect(await packStreamDeck({ repoRoot, run })).toBe(path.join(pluginRoot, "dist", pluginFileName));
    expect(steps[0]).toEqual(["pnpm", ["run", "build:streamdeck"]]);
    expect(steps[1][1]).toContain("--no-update-check");
    expect(await readFile(path.join(pluginRoot, "dist", "SoundDeck-Studio-StreamDeck-2.0.1-beta.2.streamDeckPlugin"), "utf8")).toBe("packed");
    await expect(readFile(path.join(pluginRoot, "dist", ".pack", "com.sounddeck.studio.sdPlugin", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes staging when the CLI fails", async () => {
    const repoRoot = await makeTempDir();
    const pluginRoot = path.join(repoRoot, "streamdeck-plugin");
    const sourceDir = path.join(pluginRoot, "com.sounddeck.studio.sdPlugin");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ version: "2.0.1" }));
    await writeFile(path.join(sourceDir, "manifest.json"), JSON.stringify({ Version: "1.0.0.99999" }));
    const run = async (_command, args) => {
      if (args.includes("pack")) throw new Error("Validation failed");
    };
    await expect(packStreamDeck({ repoRoot, run })).rejects.toThrow("Validation failed");
    await expect(readFile(path.join(pluginRoot, "dist", ".pack", "com.sounddeck.studio.sdPlugin", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("packaged resource verification", () => {
  it("rejects absent, empty, and directory resources and accepts a nonempty file", async () => {
    const resources = await makeTempDir();
    const file = path.join(resources, "streamdeck", pluginFileName);
    await expect(verifyStreamDeckResource(resources)).rejects.toThrow(/must include/);
    await mkdir(file, { recursive: true });
    await expect(verifyStreamDeckResource(resources)).rejects.toThrow(/nonempty file/);
    await rm(file, { recursive: true });
    await writeFile(file, "");
    await expect(verifyStreamDeckResource(resources)).rejects.toThrow(/nonempty file/);
    await writeFile(file, "installer");
    expect(await verifyStreamDeckResource(resources)).toBe(file);
  });
});
