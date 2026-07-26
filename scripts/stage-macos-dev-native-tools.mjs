import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultDestinationRoot = path.join(repoRoot, "tmp", "development-native-tools");

export async function stageMacosDevelopmentNativeTools({
  prepared,
  destinationRoot = defaultDestinationRoot,
  signFile = signAndVerify
}) {
  if (prepared?.target !== "darwin") {
    throw new Error("macOS development tools require a verified Darwin preparation result.");
  }

  const targetDir = path.join(destinationRoot, "darwin");
  const stagingDir = path.join(destinationRoot, `.darwin-${process.pid}-${randomUUID()}`);
  const staged = {};
  await pruneAbandonedStagingDirectories(destinationRoot);
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
  await pruneAbandonedStagingDirectories(destinationRoot);
}

async function signAndVerify(filePath) {
  await execFileAsync("codesign", ["--force", "--sign", "-", filePath]);
  await execFileAsync("codesign", ["--verify", "--strict", filePath]);
}

async function pruneAbandonedStagingDirectories(destinationRoot) {
  const entries = await readdir(destinationRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const oldestActiveStagingMs = Date.now() - 24 * 60 * 60 * 1_000;

  await Promise.all(entries.map(async (entry) => {
    const match = /^\.darwin-(\d+)-/.exec(entry.name);
    if (!entry.isDirectory() || !match) return;

    const directory = path.join(destinationRoot, entry.name);
    const processId = Number(match[1]);
    const directoryStat = await stat(directory).catch(() => null);
    if (
      processId !== process.pid &&
      isProcessRunning(processId) &&
      directoryStat?.mtimeMs >= oldestActiveStagingMs
    ) {
      return;
    }
    await rm(directory, { recursive: true, force: true });
  }));
}

function isProcessRunning(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
