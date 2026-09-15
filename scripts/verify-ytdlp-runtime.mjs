import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import runtimeHelpers from "../electron/ytDlpRuntime.cjs";

const { ytDlpRuntimeOptions } = runtimeHelpers;

export async function verifyYtDlpRuntime(electronPath, ytDlpPath) {
  const runtime = ytDlpRuntimeOptions(path.resolve(electronPath));
  // A developer's installed Node/Deno must not hide a missing bundled runtime.
  for (const key of Object.keys(runtime.env)) {
    if (key.toLowerCase() === "path") delete runtime.env[key];
  }
  runtime.env.PATH = "";
  const cwd = await mkdtemp(path.join(os.tmpdir(), "sounddeck-runtime-check-"));
  try {
    // Match yt-dlp's Node invocation: permission restrictions and piped stdin.
    const probe = await run(path.resolve(electronPath), ["--permission", "-"], {
      cwd,
      env: runtime.env
    }, 'console.log(JSON.stringify({node:process.versions.node,electron:process.versions.electron,result:6*7}))');
    const info = JSON.parse(probe.stdout);
    assert.ok(info.electron, "The packaged Electron executable must run as Node.");
    assert.ok(Number(info.node?.split(".")[0]) >= 22, "yt-dlp requires Node 22 or newer.");
    assert.equal(info.result, 42, "The runtime must execute JavaScript from stdin.");

    // Simulate a download from local metadata: no YouTube requests, media
    // downloads, or user configuration. yt-dlp still probes its JS runtimes.
    const metadataPath = path.join(cwd, "probe.info.json");
    await writeFile(metadataPath, JSON.stringify({
      id: "runtime-check",
      title: "Runtime check",
      extractor: "generic",
      webpage_url: "https://example.invalid/runtime-check",
      url: "https://example.invalid/runtime-check.mp3",
      ext: "mp3"
    }));
    const result = await run(path.resolve(ytDlpPath), [
      "--ignore-config", ...runtime.args, "--verbose", "--simulate",
      "--load-info-json", metadataPath
    ], { cwd, env: runtime.env });
    const runtimes = result.stderr.split(/\r?\n/).find((line) => line.startsWith("[debug] JS runtimes:"));
    assert.ok(runtimes?.includes(`node-${info.node}`), `yt-dlp did not detect bundled Node: ${result.stderr}`);
    assert.ok(!runtimes.includes("unsupported"), `yt-dlp rejected bundled Node: ${runtimes}`);
    console.log(`Verified yt-dlp with bundled Node ${info.node} (no system runtime on PATH).`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function run(command, args, options, input = "") {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      ...options, timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command}: ${error.message}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
    child.stdin.on("error", () => {}); // execFile reports early exits/spawn errors.
    child.stdin.end(input);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [electronPath, ytDlpPath] = process.argv.slice(2);
  if (!electronPath || !ytDlpPath) throw new Error("Usage: node scripts/verify-ytdlp-runtime.mjs <electron-executable> <yt-dlp-executable>");
  await verifyYtDlpRuntime(electronPath, ytDlpPath);
}
