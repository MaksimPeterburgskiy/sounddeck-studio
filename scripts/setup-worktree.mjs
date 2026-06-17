import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

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

function getWorktrees() {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  if (result.error || result.status !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const worktree = {};

      for (const line of block.split(/\r?\n/)) {
        const [key, ...valueParts] = line.split(" ");
        worktree[key] = valueParts.join(" ");
      }

      return worktree;
    });
}

function getMainWorktreePath(cwd) {
  const worktrees = getWorktrees();
  const mainWorktree =
    worktrees.find((worktree) => worktree.branch === "refs/heads/main") ??
    worktrees[0];

  if (!mainWorktree?.worktree) {
    return null;
  }

  if (resolve(mainWorktree.worktree) === resolve(cwd)) {
    return null;
  }

  return mainWorktree.worktree;
}

function ensureMacosLocalEnv() {
  const cwd = process.cwd();
  const examplePath = join(cwd, ".env.macos.example");
  const localPath = join(cwd, ".env.macos.local");
  const mainWorktreePath = getMainWorktreePath(cwd);
  const mainLocalPath = mainWorktreePath
    ? join(mainWorktreePath, ".env.macos.local")
    : null;

  if (existsSync(localPath)) {
    console.log("> .env.macos.local already exists; leaving it unchanged");
    return;
  }

  if (mainLocalPath && existsSync(mainLocalPath)) {
    copyFileSync(mainLocalPath, localPath);
    console.log("> created .env.macos.local from main worktree");
    return;
  }

  if (!existsSync(examplePath)) {
    return;
  }

  copyFileSync(examplePath, localPath);
  console.log("> created .env.macos.local from .env.macos.example");
}

ensureMacosLocalEnv();
run(["pnpm", "install", "--frozen-lockfile"]);
run(["pnpm", "run", "build"]);
