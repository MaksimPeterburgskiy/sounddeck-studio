import { rm } from "node:fs/promises";
try {
  await rm("release", { recursive: true, force: true });
} catch (error) {
  if (process.platform !== "darwin" || error?.code !== "EACCES") {
    throw error;
  }

  throw new Error("release/ contains files owned by another user. Please run 'sudo rm -rf release' manually or fix permissions.");
}
