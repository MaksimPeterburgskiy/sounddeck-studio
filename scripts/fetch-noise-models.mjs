// Verified, platform-independent resources. Model weights never enter git or ASAR.
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "noise-models");
const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function prepareNoiseModels() {
  await mkdir(directory, { recursive: true });
  for (const asset of [...manifest.models, manifest.ort]) {
    const target = resolve(directory, asset.file);
    try { if (hash(await readFile(target)) === asset.sha256) continue; } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = `${target}.download-${randomUUID()}`;
    try {
      if (asset === manifest.ort) {
        const packageRoot = resolve(root, "node_modules/onnxruntime-web");
        const installed = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
        if (installed.version !== asset.version) throw new Error(`Expected ONNX Runtime Web ${asset.version}, found ${installed.version}`);
        await copyFile(resolve(packageRoot, "dist", asset.file), temporary);
      } else {
        const response = await fetch(asset.url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`Download ${asset.file}: HTTP ${response.status}`);
        await writeFile(temporary, new Uint8Array(await response.arrayBuffer()));
      }
      if (hash(await readFile(temporary)) !== asset.sha256) throw new Error(`SHA-256 mismatch: ${asset.file}`);
      await rename(temporary, target);
      console.log(`Prepared verified noise suppression asset: ${asset.file}`);
    } finally { await rm(temporary, { force: true }); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareNoiseModels();
