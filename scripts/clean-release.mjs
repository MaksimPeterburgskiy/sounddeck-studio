import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";

try {
  await rm("release", { recursive: true, force: true });
} catch (error) {
  if (process.platform !== "darwin" || error?.code !== "EACCES") {
    throw error;
  }

  console.warn("release/ contains files owned by another user; retrying cleanup with sudo.");
  await run("sudo", ["rm", "-rf", "release"]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}
