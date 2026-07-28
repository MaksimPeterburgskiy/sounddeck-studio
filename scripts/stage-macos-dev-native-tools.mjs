import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultDestinationRoot = path.join(repoRoot, "tmp", "development-native-tools");

// Signing rewrites each binary, so development copies are staged under a unique
// directory and swapped in atomically — the verified cache is never mutated.
// A hard kill can leak one staging directory under gitignored tmp/; that is
// cheaper to tolerate than to collect safely across concurrent runs.
export async function stageMacosDevelopmentNativeTools({
  prepared,
  destinationRoot = defaultDestinationRoot,
  signFile = signAndVerify
}) {
  if (prepared?.target !== "darwin") {
    throw new Error("macOS development tools require a verified Darwin preparation result.");
  }

  const targetDir = path.join(destinationRoot, "darwin");
  const stagingDir = path.join(destinationRoot, `.darwin-${randomUUID()}`);
  const staged = {};
  await mkdir(stagingDir, { recursive: true });

  try {
    for (const [name, source] of Object.entries(prepared.files)) {
      const destination = path.join(stagingDir, path.basename(source));
      await copyFile(source, destination);
      await chmod(destination, 0o755);
      await signFile(destination);
      staged[name] = path.join(targetDir, path.basename(source));
    }

    await rm(targetDir, { recursive: true, force: true });
    await rename(stagingDir, targetDir);
    return { target: prepared.target, files: staged };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function clearMacosDevelopmentNativeTools(
  destinationRoot = defaultDestinationRoot
) {
  await rm(path.join(destinationRoot, "darwin"), { recursive: true, force: true });
}

async function signAndVerify(filePath) {
  await execFileAsync("codesign", ["--force", "--sign", "-", filePath]);
  await execFileAsync("codesign", ["--verify", "--strict", filePath]);
}
