import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const build = path.join(root, "tmp", "cable-probe-build");
  const destination = path.join(root, "tmp", "native-tools", "win32-x64");
  const cmake = (...args) => execFileSync("cmake", args, { stdio: "inherit", windowsHide: true });
  try {
    cmake("-S", path.join(root, "native"), "-B", build, "-DCMAKE_BUILD_TYPE=Release");
    cmake("--build", build, "--config", "Release");
    cmake("--install", build, "--config", "Release", "--prefix", destination);
  } catch (error) {
    rmSync(path.join(destination, "audio-cable-capture-demand.exe"), { force: true });
    if (process.argv.includes("--required")) throw error;
    console.warn("Windows cable detection is unavailable. To build the optional development helper, install CMake and a Windows C++ toolchain.");
  }
}
