import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPreparedPayload, loadManifest } from "./vbcable-provenance.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await loadManifest(path.join(repoRoot, "build", "vbcable-provenance.json"));
const payloadDir = path.join(repoRoot, "build", "vbcable");
const result = await assertPreparedPayload(payloadDir, manifest);

console.log(`Prepared ${manifest.package} payload reverified.`);
console.log(`Setup SHA-256: ${result.setupSha256}`);
