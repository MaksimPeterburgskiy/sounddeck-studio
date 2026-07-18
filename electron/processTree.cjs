const { spawn } = require("node:child_process");

function terminateProcessTree(child, {
  platform = process.platform,
  killProcessGroup = process.kill,
  runTaskkill = spawn
} = {}) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return child?.kill?.() ?? false;

  if (platform === "win32") {
    try {
      const killer = runTaskkill(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
          shell: false
        }
      );
      let fallbackRan = false;
      const fallback = () => {
        if (fallbackRan) return;
        fallbackRan = true;
        try {
          child.kill();
        } catch {
          // The direct process may already have exited with its tree.
        }
      };
      killer.once?.("error", fallback);
      killer.once?.("close", (code) => {
        if (code !== 0) fallback();
      });
      killer.unref?.();
      return true;
    } catch {
      // Fall back to the ChildProcess handle if taskkill cannot be started.
    }
    return child.kill();
  }

  try {
    // yt-dlp is spawned as a process-group leader, so a negative PID reaches
    // its ffmpeg and runtime descendants as well as yt-dlp itself.
    killProcessGroup(-pid, "SIGKILL");
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return child.kill();
  }
}

function shouldDetachProcessTree(platform = process.platform) {
  return platform !== "win32";
}

module.exports = { terminateProcessTree, shouldDetachProcessTree };
