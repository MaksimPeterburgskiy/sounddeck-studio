const path = require("node:path");
const { spawn } = require("node:child_process");

function cableCaptureDemandExecutablePath({
  appIsPackaged, resourcesPath, platform = process.platform, arch = process.arch,
  repoRoot = path.join(__dirname, "..")
} = {}) {
  if (platform !== "win32" || arch !== "x64") return "";
  const dir = appIsPackaged ? resourcesPath && path.join(resourcesPath, "native-tools")
    : path.join(repoRoot, "tmp", "native-tools", "win32-x64");
  return dir ? path.join(dir, "audio-cable-capture-demand.exe") : "";
}

function createCableCaptureDemandSupervisor({ onDemand, trackChild, spawnFn = spawn, ...options }) {
  const exe = cableCaptureDemandExecutablePath(options);
  let wanted = "";
  let child = null;
  let retryTimer;
  let retryDelay = 1000;

  function retry() {
    if (!wanted || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      start();
    }, retryDelay);
    retryTimer.unref();
    retryDelay = Math.min(30_000, retryDelay * 2);
  }

  function start() {
    if (!wanted || child || retryTimer) return;
    const label = wanted;
    let running;
    try {
      running = spawnFn(exe, [label], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      onDemand(label, null);
      retry();
      return;
    }
    child = running;
    trackChild(running);
    const started = Date.now();
    let failed = false;
    let partial = "";
    function fail() {
      if (running !== child || wanted !== label || running.killed || failed) return;
      failed = true;
      onDemand(label, null);
      if (Date.now() - started > 30_000) retryDelay = 1000;
      retry();
      running.kill();
    }
    running.stdout.setEncoding("utf8");
    running.stdout.on("data", (chunk) => {
      if (running !== child || wanted !== label || running.killed || failed) return;
      const lines = (partial + chunk).split("\n");
      partial = lines.pop();
      for (const line of lines) {
        const value = line.trim();
        if (value !== "true" && value !== "false" && value !== "null") return fail();
        onDemand(label, value === "null" ? null : value === "true");
      }
      if (partial.length > 8) fail();
    });
    running.stdout.on("error", fail);
    running.stdout.on("end", fail);
    running.on("error", fail);
    running.once("close", () => {
      if (child !== running) return;
      fail();
      child = null;
      // A setting change or an elapsed retry can be waiting on the old PID.
      start();
    });
  }

  function setEndpoint(value) {
    const label = typeof value === "string" ? value.trim() : "";
    const next = exe && label.length <= 256 && /\(VB-Audio (?:Virtual Cable|Cable [A-D])\)$/i.test(label) ? label : "";
    if (wanted === next) return;
    wanted = next;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    retryDelay = 1000;
    if (child) child.kill();
    if (wanted) onDemand(wanted, null);
    start();
  }

  return { setEndpoint };
}

module.exports = { cableCaptureDemandExecutablePath, createCableCaptureDemandSupervisor };
