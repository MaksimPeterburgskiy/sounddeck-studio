import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import electronPath from "electron";
import runtimeHelpers from "./ytDlpRuntime.cjs";

const { ytDlpRuntimeOptions } = runtimeHelpers;

describe("yt-dlp bundled JavaScript runtime", () => {
  it.each([
    "C:\\Program Files\\SoundDeck Studio\\SoundDeck Studio.exe",
    "C:\\Users\\Listener\\AppData\\Local\\Temp\\portable app\\SoundDeck Studio.exe",
    "/Applications/SoundDeck Studio.app/Contents/MacOS/SoundDeck Studio",
    "/opt/SoundDeck Studio/sounddeck"
  ])("selects the app executable without shell quoting: %s", (execPath) => {
    const env = { PATH: "/host-tools", ELECTRON_RUN_AS_NODE: "0", TEMP: "/downloads" };
    const runtime = ytDlpRuntimeOptions(execPath, env);
    expect(runtime.args).toEqual(["--no-js-runtimes", "--js-runtimes", `node:${execPath}`]);
    expect(runtime.env).toEqual({ ...env, ELECTRON_RUN_AS_NODE: "1" });
    expect(env.ELECTRON_RUN_AS_NODE).toBe("0");
  });

  it("executes piped JavaScript in Electron with yt-dlp's permission flag and no host runtime", async () => {
    const runtime = ytDlpRuntimeOptions(electronPath);
    for (const key of Object.keys(runtime.env)) {
      if (key.toLowerCase() === "path") delete runtime.env[key];
    }
    runtime.env.PATH = "";
    const result = await new Promise((resolve, reject) => {
      const child = execFile(electronPath, ["--permission", "-"], {
        env: runtime.env, windowsHide: true, timeout: 15_000
      }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
      child.stdin.on("error", () => {});
      child.stdin.end('console.log(JSON.stringify({electron:process.versions.electron,result:6*7}))');
    });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ electron: expect.any(String), result: 42 });
  }, 20_000);
});
