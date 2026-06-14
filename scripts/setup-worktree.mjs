import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
const env = {
  ...process.env,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0"
};

function run(args) {
  console.log(`> corepack ${args.join(" ")}`);
  const result = isWindows
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", `corepack ${args.join(" ")}`], {
        cwd: process.cwd(),
        env,
        stdio: "inherit"
      })
    : spawnSync("corepack", args, {
        cwd: process.cwd(),
        env,
        stdio: "inherit"
      });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(["pnpm", "install", "--frozen-lockfile"]);
run(["pnpm", "run", "build"]);
